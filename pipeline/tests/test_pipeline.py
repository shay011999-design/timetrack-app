"""Tests over the real source documents in data/.

These are deliberately end-to-end: the value of this pipeline is that it reads
the actual PDFs correctly, and a parser that drifts silently loses history.
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from vehicle_maintenance.analyze import analyze  # noqa: E402
from vehicle_maintenance.classify import plan_label, system_for  # noqa: E402
from vehicle_maintenance.load import load  # noqa: E402

PDFS = ROOT / "data" / "pdfs"
MANUAL = ROOT / "data" / "manual"
TODAY = date(2026, 9, 7)


@pytest.fixture(scope="module")
def result():
    return load(PDFS, MANUAL)


@pytest.fixture(scope="module")
def analysis(result):
    return analyze(result.vehicle, result.visits, today=TODAY)


# ── classification ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("פילטר שמן", "engine"),        # a filter is an engine part…
    ("שמן מנוע", "fluids"),         # …but the oil itself is a fluid
    ("הח' רצועת תזמון", "timing"),
    ("הח' דיסקיות קדמיות", "brakes"),
    ("הח' צמיג עקב נזק", "tires"),
    ("מבחן רישוי", "general"),
])
def test_system_classification(text, expected):
    assert system_for(text) == expected


@pytest.mark.parametrize("text,expected", [
    ("טיפולים135,000", "135,000"),
    ("120,000", "120,000"),
    ("הח' מסנן אויר למנוע", None),   # a description, not a milestone
    ("22491", None),                 # an invoice number, not a milestone
])
def test_plan_label(text, expected):
    assert plan_label(text) == expected


# ── loading ──────────────────────────────────────────────────────────────────

def test_every_document_is_accounted_for(result):
    assert result.warnings == [], f"unparsed documents: {result.warnings}"


def test_vehicle_identified(result):
    v = result.vehicle
    assert (v.plate, v.make, v.model, v.year) == ("38855601", "סקודה", "אוקטביה", 2018)


def test_history_span(result):
    dates = [v.date for v in result.visits]
    assert min(dates) == date(2018, 10, 21)
    assert max(dates) == date(2025, 11, 3)


def test_odometer_is_monotonic(result):
    readings = [(v.date, v.odometer) for v in result.visits if v.odometer]
    for (d1, o1), (d2, o2) in zip(readings, readings[1:]):
        assert o2 >= o1, f"odometer went backwards between {d1} and {d2}"


def test_overlapping_documents_are_merged(result):
    """The Eldan report and the importer printout both record 06/03/2023."""
    same_day = [v for v in result.visits if v.date == date(2023, 3, 6)]
    assert len(same_day) == 1
    visit = same_day[0]
    descriptions = " ".join(j.description for j in visit.jobs)
    assert "רצועת תזמון" in descriptions      # only in the importer printout
    assert visit.plan_label == "120,000"       # only in the Eldan report


def test_scanned_invoices_contribute_costs(result):
    priced = [v for v in result.visits if v.total]
    assert {v.total for v in priced} == {708.0, 830.0}


def test_invoice_totals_reconcile(result):
    """parts + labour + VAT should land on the printed total, within rounding."""
    for v in (v for v in result.visits if v.total and v.vat_rate):
        parts = sum(p.total for p in v.parts if p.total)
        assert parts == pytest.approx(v.parts_total)
        net = parts + (v.labor_total or 0)
        assert net * (1 + v.vat_rate / 100) == pytest.approx(v.total, abs=1.0)


# ── analysis ─────────────────────────────────────────────────────────────────

def test_intervals_are_positive(analysis):
    assert analysis.intervals
    assert all(i.km > 0 and i.days > 0 for i in analysis.intervals)


def test_usage_rate_reflects_current_regime(analysis):
    """The car ran ~20k km/yr on lease and ~9k since; the recent rate must
    track the latter, not the blend."""
    recent = analysis.stats["km_per_year_recent"]
    lifetime = analysis.stats["km_per_year_lifetime"]
    assert recent < lifetime / 2
    assert 6_000 < recent < 11_000


def test_timing_belt_tracked_from_importer_record(analysis):
    row = next(w for w in analysis.wear if w["system"] == "timing")
    assert row["last_date"] == "2023-03-06"
    assert row["last_odometer"] == 118328
    assert row["km_to_go"] > 0        # not due yet


def test_forecast_is_after_last_service(analysis):
    last = analysis.services[-1]
    assert analysis.forecast.due_date > last.date
    assert analysis.forecast.due_km > last.odometer


def test_cost_per_km_excludes_boundary_visit(analysis):
    """Spend is divided by the span it was actually incurred over."""
    c = analysis.costs
    assert c["span_km"] == 9438
    assert c["spend_in_span"] == 830.0
    assert c["per_km"] == pytest.approx(830.0 / 9438, abs=0.001)


def test_inspections_survive_merging(analysis):
    """A test booked next to a service merges into it, but still counts."""
    assert analysis.stats["inspection_count"] == 4


def test_adherence_counts_only_real_intervals(analysis):
    pct = analysis.stats["adherence_pct"]
    within = sum(1 for i in analysis.intervals if i.km <= analysis.plan_km)
    assert pct == round(100 * within / len(analysis.intervals))


# ── odometer readings from outside the service history ───────────────────────

def test_fuel_reading_supersedes_extrapolation(result):
    """A fill-up records the odometer far more recently than the last service.

    Without it the estimate is extrapolated a year forward from the last
    garage visit, which is how the overdue service was missed.
    """
    from vehicle_maintenance.analyze import Reading

    without = analyze(result.vehicle, result.visits, today=TODAY)
    with_fill = analyze(
        result.vehicle, result.visits, today=TODAY,
        readings=[Reading(date(2026, 9, 2), 162884, "fillup")],
    )
    assert with_fill.stats["estimated_odometer_today"] > without.stats["estimated_odometer_today"]
    assert with_fill.stats["latest_reading_source"] == "fillup"
    assert with_fill.stats["latest_reading_odometer"] == 162884


def test_reading_moves_the_service_from_due_soon_to_overdue(result):
    from vehicle_maintenance.analyze import Reading

    a = analyze(
        result.vehicle, result.visits, today=TODAY,
        readings=[Reading(date(2026, 9, 2), 162884, "fillup")],
    )
    assert a.forecast.km_remaining < 0
    assert any(al.level == "due" for al in a.alerts)


def test_overdue_alert_cites_the_real_reading(result):
    from vehicle_maintenance.analyze import Reading

    a = analyze(
        result.vehicle, result.visits, today=TODAY,
        readings=[Reading(date(2026, 9, 2), 162884, "fillup")],
    )
    due = next(al for al in a.alerts if al.level == "due")
    assert "162,884" in due.detail          # states the measurement, not a guess
    assert "02/09/2026" in due.detail


def test_stale_reading_does_not_claim_to_be_measured(result):
    """An old reading is still useful for the rate, but the alert must not
    present a months-old number as if it were current."""
    from vehicle_maintenance.analyze import Reading

    a = analyze(
        result.vehicle, result.visits, today=date(2027, 6, 1),
        readings=[Reading(date(2026, 9, 2), 162884, "fillup")],
    )
    due = [al for al in a.alerts if al.level == "due"]
    assert due and "162,884" not in due[0].detail


def test_repeated_odometer_does_not_drag_the_rate_down(result):
    """The leasing report repeats the last known odometer on follow-up visits;
    the rate is taken across window endpoints so those cannot dilute it."""
    a = analyze(result.vehicle, result.visits, today=TODAY)
    assert a.stats["km_per_year_recent"] > 5_000


# ── every source file is accounted for ───────────────────────────────────────

def test_every_document_gets_a_status(result):
    """Dropping a batch in at once, the failures alone are not enough — a file
    that parsed and a file that was skipped must be distinguishable."""
    from vehicle_maintenance.models import (
        NEEDS_TRANSCRIPTION, PARSED, TRANSCRIBED, UNRECOGNISED,
    )

    pdfs = {p.name for p in PDFS.glob("*.pdf")}
    assert {d.name for d in result.documents} == pdfs
    assert all(
        d.status in (PARSED, TRANSCRIBED, NEEDS_TRANSCRIPTION, UNRECOGNISED)
        for d in result.documents
    )


def test_parsed_documents_report_what_they_produced(result):
    from vehicle_maintenance.models import PARSED

    parsed = [d for d in result.documents if d.status == PARSED]
    assert parsed
    assert all(d.records > 0 and d.parser for d in parsed)


def test_scans_are_marked_transcribed_not_failed(result):
    """These two scans are covered by hand-written records, so they are done —
    not outstanding work."""
    from vehicle_maintenance.models import TRANSCRIBED

    by_name = {d.name: d for d in result.documents}
    assert by_name["טיפול_143823.pdf"].status == TRANSCRIBED
    assert by_name["טיפול_150000.pdf"].status == TRANSCRIBED


def test_an_uncovered_scan_is_reported_as_outstanding(tmp_path):
    """The case a bulk upload creates: a scan lands with nothing covering it."""
    import shutil

    from vehicle_maintenance.load import load
    from vehicle_maintenance.models import NEEDS_TRANSCRIPTION

    shutil.copy(PDFS / "טיפול_143823.pdf", tmp_path / "new_scan.pdf")
    r = load(tmp_path, None)
    assert [(d.name, d.status) for d in r.documents] == [
        ("new_scan.pdf", NEEDS_TRANSCRIPTION)
    ]
    assert r.warnings
