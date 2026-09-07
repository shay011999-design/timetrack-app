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
