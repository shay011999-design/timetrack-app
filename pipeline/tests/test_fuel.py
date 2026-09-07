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


def test_odometer_pair_wins_over_the_trip_counter():
    """A trip counter can be reset mid-tank; an odometer cannot, so where both
    describe the same tank the odometer difference is the one used."""
    r = F.analyse(
        [fill((7, 1), 158000, litres=40.0, ppl=8.10),
         fill((7, 20), 158620, litres=38.5, ppl=8.10, trip=999)],
        CONFIG, km_per_year=8410, today=TODAY,
    )
    assert len(r["legs"]) == 1
    assert r["legs"][0]["basis"] == "odometer"
    assert r["legs"][0]["km"] == 620


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
