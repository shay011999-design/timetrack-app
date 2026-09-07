"""Tests for the fuel calculation.

The central risk here is a number that looks measured but is really a guess,
so most of these pin down which basis a given set of inputs produces.
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from vehicle_maintenance import fuel as F  # noqa: E402

CONFIG = json.loads((ROOT / "data" / "config.json").read_text(encoding="utf-8"))["fuel"]
TODAY = date(2026, 9, 7)


def fill(day, odo, litres=None, ppl=None, total=None, full=True, trip=None, computer=None):
    return F.Fillup(
        date=date(2026, *day), odometer=odo, litres=litres,
        price_per_litre=ppl, total=total, full_tank=full,
        km_since_last_fill=trip, computer_l_per_100km=computer,
    )


# ── receipt arithmetic ───────────────────────────────────────────────────────

def test_total_derived_from_litres_and_price():
    assert fill((7, 1), 158000, litres=40.0, ppl=8.10).total == pytest.approx(324.0)


def test_litres_derived_from_total_and_price():
    assert fill((7, 1), 158000, ppl=8.0, total=320.0).litres == pytest.approx(40.0)


def test_price_derived_from_total_and_litres():
    assert fill((7, 1), 158000, litres=35.2, total=290.40).price_per_litre == pytest.approx(8.25)


# ── price history ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("when,expected", [
    (date(2026, 9, 10), 7.75),   # after the latest change
    (date(2026, 9, 7), 7.75),    # on the day it takes effect
    (date(2026, 9, 3), 8.25),    # between changes
])
def test_price_at(when, expected):
    assert F.price_at(CONFIG, when) == expected


# ── estimated basis ──────────────────────────────────────────────────────────

def test_no_fillups_gives_an_estimate_that_says_so():
    r = F.analyse([], CONFIG, km_per_year=8410, today=TODAY)
    assert r["basis"] == F.ESTIMATED
    assert r["consumption_source"]                      # the guess is attributed
    expected = CONFIG["consumption_l_per_100km"] / 100 * 7.75
    assert r["cost_per_km"] == pytest.approx(expected, abs=0.001)
    assert r["cost_per_year"] == pytest.approx(expected * 8410, rel=0.01)


def test_fillups_without_odometer_cannot_measure_consumption():
    r = F.analyse(
        [fill((7, 1), None, litres=40.0, ppl=8.1), fill((7, 20), None, litres=38.5, ppl=8.1)],
        CONFIG, km_per_year=8410, today=TODAY,
    )
    assert r["basis"] == F.ESTIMATED


# ── measured basis ───────────────────────────────────────────────────────────

def test_two_full_tanks_measure_real_consumption():
    r = F.analyse(
        [fill((7, 1), 158000, litres=40.0, ppl=8.10),
         fill((7, 20), 158620, litres=38.5, ppl=8.10)],
        CONFIG, km_per_year=8410, today=TODAY,
    )
    assert r["basis"] == F.MEASURED
    # 38.5 L over 620 km
    assert r["consumption_l_per_100km"] == pytest.approx(6.21, abs=0.01)
    assert r["consumption_km_per_litre"] == pytest.approx(16.1, abs=0.05)


def test_partial_fill_breaks_the_consumption_window():
    """A partial fill leaves the tank level unknown, so no window spans it."""
    fills = [
        fill((7, 1), 158000, litres=40.0, ppl=8.10),
        fill((7, 20), 158620, litres=38.5, ppl=8.10),
        fill((8, 5), 159100, litres=20.0, ppl=8.25, full=False),
        fill((8, 24), 159480, litres=35.2, total=290.40),
    ]
    r = F.analyse(fills, CONFIG, km_per_year=8410, today=TODAY)
    assert len(r["legs"]) == 1
    assert r["legs"][0]["km"] == 620


def test_partial_fill_still_counts_toward_spend():
    fills = [
        fill((7, 1), 158000, litres=40.0, ppl=8.10),
        fill((7, 20), 158620, litres=38.5, ppl=8.10),
        fill((8, 5), 159100, litres=20.0, ppl=8.25, full=False),
    ]
    r = F.analyse(fills, CONFIG, km_per_year=8410, today=TODAY)
    assert r["recorded_spend"] == pytest.approx(324.0 + 311.85 + 165.0, abs=0.01)


def test_historical_cost_per_km_excludes_the_opening_receipt():
    """Same rule as servicing: the first fill bounds the span, it is not in it."""
    fills = [
        fill((7, 1), 158000, litres=40.0, ppl=8.0),    # 320, outside the span
        fill((7, 20), 158620, litres=38.5, ppl=8.0),   # 308, inside
    ]
    r = F.analyse(fills, CONFIG, km_per_year=8410, today=TODAY)
    assert r["spend_span_km"] == 620
    assert r["historical_cost_per_km"] == pytest.approx(308.0 / 620, abs=0.001)


def test_headline_cost_per_km_uses_todays_price():
    """The headline figure answers "what does a km cost now", so it prices the
    measured consumption at today's pump rate rather than at what was paid."""
    fills = [
        fill((7, 1), 158000, litres=40.0, ppl=8.0),
        fill((7, 20), 158620, litres=38.5, ppl=8.0),
    ]
    r = F.analyse(fills, CONFIG, km_per_year=8410, today=TODAY)
    assert r["cost_per_km"] == pytest.approx(r["consumption_l_per_100km"] / 100 * 7.75, abs=0.001)


def test_backwards_odometer_is_ignored():
    fills = [
        fill((7, 20), 158620, litres=38.5, ppl=8.1),
        fill((7, 1), 158000, litres=40.0, ppl=8.1),
    ]
    r = F.analyse(sorted(fills, key=lambda f: f.odometer or 0), CONFIG, 8410, TODAY)
    assert all(leg["km"] > 0 for leg in r.get("legs", []))


# ── running costs ────────────────────────────────────────────────────────────

def test_running_costs_combine_fuel_and_servicing():
    fuel = F.analyse([], CONFIG, km_per_year=8410, today=TODAY)
    r = F.running_costs(fuel, maintenance_per_km=0.088)
    expected = fuel["cost_per_km"] + 0.088
    assert r["total_per_km"] == pytest.approx(expected, abs=0.001)
    assert r["fuel_share_pct"] == round(100 * fuel["cost_per_km"] / expected)
    assert r["total_per_month"] == pytest.approx(expected * 8410 / 12, abs=1)


def test_running_costs_degrade_without_servicing_data():
    fuel = F.analyse([], CONFIG, km_per_year=8410, today=TODAY)
    r = F.running_costs(fuel, maintenance_per_km=None)
    assert "total_per_km" not in r
    assert r["fuel_per_km"] is not None


# ── trip-computer distance ───────────────────────────────────────────────────

def test_single_fill_measures_a_tank_from_the_trip_computer():
    """The first logged fill measures nothing on its own — unless the car
    recorded the distance since the previous one."""
    r = F.analyse(
        [fill((9, 2), 162884, litres=43.033, ppl=8.25, trip=329)],
        CONFIG, km_per_year=10422, today=TODAY,
    )
    assert r["basis"] == F.MEASURED
    assert r["consumption_l_per_100km"] == pytest.approx(13.08, abs=0.01)
    assert r["legs"][0]["basis"] == "trip"


def test_single_fill_without_trip_distance_cannot_measure():
    r = F.analyse(
        [fill((9, 2), 162884, litres=43.033, ppl=8.25)],
        CONFIG, km_per_year=10422, today=TODAY,
    )
    assert r["basis"] == F.ESTIMATED


def test_agreeing_sources_use_the_odometer():
    """When both describe the same tank they are interchangeable, and the
    odometer is the more precise of the two."""
    r = F.analyse(
        [fill((7, 1), 158000, litres=40.0, ppl=8.10),
         fill((7, 20), 158620, litres=38.5, ppl=8.10, trip=615)],   # within 15%
        CONFIG, km_per_year=8410, today=TODAY,
    )
    assert len(r["legs"]) == 1
    assert r["legs"][0]["basis"] == "odometer"
    assert r["legs"][0]["km"] == 620
    assert r["warnings"] == []


def test_disagreeing_sources_trust_the_trip_counter():
    """The odometer gap measures distance since the last *logged* fill; the trip
    counter measures distance since the last *actual* one, because it resets
    whether or not the fill was written down. A large gap between them means
    fills are missing, and the trip counter is the one describing this tank."""
    r = F.analyse(
        [fill((9, 2), 162884, litres=43.033, ppl=8.25, trip=329),
         fill((9, 20), 163900, litres=41.2, ppl=7.75, trip=380)],
        CONFIG, km_per_year=10422, today=date(2026, 9, 25),
    )
    latest = r["legs"][-1]
    assert latest["basis"] == "trip"
    assert latest["km"] == 380                      # not the 1,016 km odometer gap
    assert latest["l_per_100km"] == pytest.approx(10.84, abs=0.01)
    assert any("שלא נרשמו" in w for w in r["warnings"])


def test_a_plausible_looking_number_from_a_gap_is_still_caught():
    """The danger case: the odometer gap yields 4.06 L/100km, just inside the
    plausible band, so the band alone would let it through and halve the
    measured consumption. The disagreement is what catches it."""
    r = F.analyse(
        [fill((9, 2), 162884, litres=43.033, ppl=8.25, trip=329),
         fill((9, 20), 163900, litres=41.2, ppl=7.75, trip=380)],
        CONFIG, km_per_year=10422, today=date(2026, 9, 25),
    )
    assert all(l["l_per_100km"] > 5 for l in r["legs"])
    assert r["consumption_l_per_100km"] == pytest.approx(11.88, abs=0.01)


def test_one_tank_is_flagged_as_provisional():
    r = F.analyse(
        [fill((9, 2), 162884, litres=43.033, ppl=8.25, trip=329)],
        CONFIG, km_per_year=10422, today=TODAY,
    )
    assert r["tanks_measured"] == 1
    assert r["low_confidence"] is True


def test_trip_computer_is_compared_against_the_pump():
    r = F.analyse(
        [fill((9, 2), 162884, litres=43.033, ppl=8.25, trip=329, computer=13.4)],
        CONFIG, km_per_year=10422, today=TODAY,
    )
    # car reports 13.4, pump-measured is 13.08 -> the computer reads high
    assert r["computer_l_per_100km"] == 13.4
    assert r["computer_vs_pump_pct"] == pytest.approx(2.4, abs=0.2)


def test_computer_comparison_absent_without_a_measurement():
    """Comparing the car's average to an estimate would compare two guesses."""
    r = F.analyse(
        [fill((9, 2), 162884, litres=43.033, ppl=8.25, computer=13.4)],
        CONFIG, km_per_year=10422, today=TODAY,
    )
    assert r["basis"] == F.ESTIMATED
    assert "computer_vs_pump_pct" not in r


def test_price_is_derived_for_receipts_that_omit_it():
    fills = [fill((9, 2), 162884, litres=43.033, trip=329)]
    assert fills[0].total is None
    F.price_fillups(fills, CONFIG)
    assert fills[0].price_per_litre == 8.25          # the rate on 02/09
    assert fills[0].total == pytest.approx(355.02, abs=0.01)


# ── receipts and log gaps ────────────────────────────────────────────────────

PAZ_RECEIPT = '''מסמך ממוחשב
פז קמעונאות ואנרגיה בע"מ
אחוד עוסק 557100641
פז עוזדנת 341
רחוב הרצל 102 נתניה
חשבונית מס/קבלה    מקור
034109901437836
24/07/26  14:38
רכב:38855601
משאבה: 05
אוקטן 95  7.480 ש"ח לליטר
כמות:  42.532 ליטרים
סה"כ דלקים:  318.14 ש"ח
סה"כ לפני מע"מ 269.61 ש"ח
מע"מ לחוץ רכב 48.53 ש"ח
סה"כ לתשלום 318.14 ש"ח כולל מע"מ'''


def _paz_doc():
    from pathlib import Path
    from vehicle_maintenance.extract import ExtractedDoc
    return ExtractedDoc(path=Path("paz.pdf"), pages=[PAZ_RECEIPT], is_scan=False)


def test_receipt_parser_reads_the_money():
    from vehicle_maintenance.parsers import fuel_receipt

    doc = _paz_doc()
    assert fuel_receipt.detect(doc)
    fill, _ = fuel_receipt.parse(doc)
    assert fill.date == date(2026, 7, 24)
    assert fill.litres == pytest.approx(42.532)
    assert fill.price_per_litre == pytest.approx(7.48)
    assert fill.total == pytest.approx(318.14)
    # the printed total must equal litres x price
    assert fill.litres * fill.price_per_litre == pytest.approx(fill.total, abs=0.01)


def test_receipt_has_no_odometer_and_says_so():
    """The one field the forecast needs most is the one no receipt prints."""
    from vehicle_maintenance.parsers import fuel_receipt

    fill, warnings = fuel_receipt.parse(_paz_doc())
    assert fill.odometer is None
    assert any("מד אוץ" in w for w in warnings)


def test_fill_without_odometer_counts_as_spend_but_not_consumption():
    fills = [
        F.Fillup(date=date(2026, 7, 24), litres=42.532, price_per_litre=7.48),
        fill((9, 2), 162884, litres=43.033, ppl=8.25, trip=329),
    ]
    r = F.analyse(fills, CONFIG, km_per_year=10422, today=TODAY)
    assert r["fillups_without_odometer"] == 1
    assert r["recorded_spend"] == pytest.approx(318.14 + 355.02, abs=0.01)
    assert r["measured_km"] == 329          # the July fill contributes no distance
    assert any("ללא מד אוץ" in w for w in r["warnings"])


def test_missing_fill_in_the_log_is_rejected_not_averaged_in():
    """Tank-to-tank assumes consecutive fills. With one missing, the later
    fill's litres cover only part of the distance and imply an impossible
    consumption — that must be caught, not folded into the average."""
    fills = [
        fill((7, 24), 161742, litres=42.532, ppl=7.48),   # ~1,142 km earlier
        fill((9, 2), 162884, litres=43.033, ppl=8.25),
    ]
    r = F.analyse(fills, CONFIG, km_per_year=10422, today=TODAY)
    assert r["basis"] == F.ESTIMATED         # nothing measurable survived
    assert any("חסר תדלוק" in w for w in r["warnings"])


def test_rejected_odometer_leg_does_not_suppress_the_trip_measurement():
    """The odometer pair spans a gap, but the later fill's own trip counter
    still measures its tank correctly."""
    fills = [
        fill((7, 24), 161742, litres=42.532, ppl=7.48),
        fill((9, 2), 162884, litres=43.033, ppl=8.25, trip=329),
    ]
    r = F.analyse(fills, CONFIG, km_per_year=10422, today=TODAY)
    assert r["basis"] == F.MEASURED
    assert [l["basis"] for l in r["legs"]] == ["trip"]
    assert r["consumption_l_per_100km"] == pytest.approx(13.08, abs=0.01)


def test_plausible_consumption_is_still_accepted():
    fills = [
        fill((7, 1), 158000, litres=40.0, ppl=8.0),
        fill((7, 20), 158620, litres=38.5, ppl=8.0),     # 6.2 l/100km
    ]
    r = F.analyse(fills, CONFIG, km_per_year=8410, today=TODAY)
    assert r["basis"] == F.MEASURED
    assert not any("חסר תדלוק" in w for w in r["warnings"])


def test_transcribed_scan_is_not_loaded_twice(tmp_path):
    """A scan entered by hand must not also be reported as unparsed."""
    import json as _json
    import shutil

    (tmp_path / "r.json").write_text(_json.dumps({
        "date": "2026-07-24", "litres": 42.532, "price_per_litre": 7.48,
        "document": "r.pdf",
    }), encoding="utf-8")
    shutil.copy(ROOT / "data" / "fuel" / "paz_2026-07-24.pdf", tmp_path / "r.pdf")

    fills, warnings, documents = F.load_fillups(tmp_path)
    assert len(fills) == 1
    assert warnings == []
    # The PDF is still accounted for, as covered rather than ignored.
    assert [(d.name, d.status) for d in documents] == [("r.pdf", "transcribed")]
