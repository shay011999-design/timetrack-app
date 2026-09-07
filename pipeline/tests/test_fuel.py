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


def fill(day, odo, litres=None, ppl=None, total=None, full=True):
    return F.Fillup(
        date=date(2026, *day), odometer=odo, litres=litres,
        price_per_litre=ppl, total=total, full_tank=full,
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
    assert r["cost_per_km"] == pytest.approx(6.5 / 100 * 7.75, abs=0.001)
    assert r["cost_per_year"] == pytest.approx(0.504 * 8410, rel=0.01)


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


def test_cost_per_km_excludes_the_opening_receipt():
    """Same rule as servicing: the first fill bounds the span, it is not in it."""
    fills = [
        fill((7, 1), 158000, litres=40.0, ppl=8.0),    # 320, outside the span
        fill((7, 20), 158620, litres=38.5, ppl=8.0),   # 308, inside
    ]
    r = F.analyse(fills, CONFIG, km_per_year=8410, today=TODAY)
    assert r["spend_span_km"] == 620
    assert r["cost_per_km"] == pytest.approx(308.0 / 620, abs=0.001)


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
    assert r["total_per_km"] == pytest.approx(0.592, abs=0.001)
    assert r["fuel_share_pct"] == 85
    assert r["total_per_month"] == pytest.approx(415, abs=1)


def test_running_costs_degrade_without_servicing_data():
    fuel = F.analyse([], CONFIG, km_per_year=8410, today=TODAY)
    r = F.running_costs(fuel, maintenance_per_km=None)
    assert "total_per_km" not in r
    assert r["fuel_per_km"] is not None
