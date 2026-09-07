"""Fuel cost, from real fill-ups when they exist and an estimate when they don't.

Two modes, and the distinction matters enough that the output always says which
one produced a number:

  * **measured** — two or more full-tank fill-ups with odometer readings. The
    distance between them divided by the litres of the later one is the real
    consumption, and the receipts give the real spend.
  * **estimated** — no usable fill-ups. Spend is projected from the car's
    mileage, a configured consumption figure, and the pump price.

An estimate is not a measurement, and a fuel figure that silently switches
between the two would be worse than none.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any

MEASURED = "measured"
ESTIMATED = "estimated"


@dataclass
class Fillup:
    date: date
    odometer: int | None = None
    litres: float | None = None
    price_per_litre: float | None = None
    total: float | None = None
    station: str | None = None
    full_tank: bool = True
    document: str | None = None
    source: str = "manual"

    def __post_init__(self) -> None:
        # Receipts vary in which two of the three numbers they print; the third
        # is always recoverable.
        if self.total is None and self.litres and self.price_per_litre:
            self.total = round(self.litres * self.price_per_litre, 2)
        elif self.litres is None and self.total and self.price_per_litre:
            self.litres = round(self.total / self.price_per_litre, 2)
        elif self.price_per_litre is None and self.total and self.litres:
            self.price_per_litre = round(self.total / self.litres, 3)

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["date"] = self.date.isoformat()
        return d


@dataclass
class Leg:
    """Distance covered on one full tank, between two full-tank fill-ups."""

    from_date: date
    to_date: date
    km: int
    litres: float
    cost: float

    @property
    def l_per_100km(self) -> float:
        return self.litres / self.km * 100

    @property
    def km_per_litre(self) -> float:
        return self.km / self.litres


def load_fillups(fuel_dir: str | Path) -> list[Fillup]:
    fuel_dir = Path(fuel_dir)
    if not fuel_dir.exists():
        return []
    out = []
    for path in sorted(fuel_dir.glob("*.json")):
        d = json.loads(path.read_text(encoding="utf-8"))
        d["date"] = datetime.strptime(d["date"], "%Y-%m-%d").date()
        out.append(Fillup(**d))
    return sorted(out, key=lambda f: f.date)


def price_at(config: dict, when: date) -> float | None:
    """Pump price in effect on a given date, from the configured history."""
    history = config.get("price_history") or []
    applicable = [
        h for h in history
        if datetime.strptime(h["from"], "%Y-%m-%d").date() <= when
    ]
    if not applicable:
        # Before the earliest known price; the earliest is the best guess.
        return history[-1]["price_per_litre"] if history else None
    latest = max(applicable, key=lambda h: h["from"])
    return latest["price_per_litre"]


def _legs(fillups: list[Fillup]) -> list[Leg]:
    """Consumption windows between consecutive full-tank fill-ups.

    A partial fill breaks the chain: the tank level at that point is unknown,
    so no window can be closed across it.
    """
    usable = [f for f in fillups if f.odometer and f.litres]
    legs: list[Leg] = []
    for a, b in zip(usable, usable[1:]):
        if not (a.full_tank and b.full_tank):
            continue
        km = b.odometer - a.odometer
        if km <= 0 or not b.litres:
            continue
        legs.append(
            Leg(
                from_date=a.date, to_date=b.date, km=km,
                litres=b.litres, cost=b.total or 0.0,
            )
        )
    return legs


def analyse(
    fillups: list[Fillup],
    config: dict,
    km_per_year: float | None,
    today: date,
) -> dict[str, Any]:
    """Fuel picture for the dashboard: consumption, spend, and cost per km."""
    price_now = price_at(config, today)
    legs = _legs(fillups)

    result: dict[str, Any] = {
        "fuel_type": config.get("type"),
        "price_per_litre": price_now,
        "price_source": config.get("price_source"),
        "fillup_count": len(fillups),
        "km_per_year": round(km_per_year) if km_per_year else None,
    }

    if legs:
        total_km = sum(l.km for l in legs)
        total_litres = sum(l.litres for l in legs)
        consumption = total_litres / total_km * 100
        result.update(
            basis=MEASURED,
            consumption_l_per_100km=round(consumption, 2),
            consumption_km_per_litre=round(total_km / total_litres, 2),
            measured_km=total_km,
            measured_litres=round(total_litres, 2),
            legs=[
                {
                    "from_date": l.from_date.isoformat(),
                    "to_date": l.to_date.isoformat(),
                    "km": l.km,
                    "litres": round(l.litres, 2),
                    "l_per_100km": round(l.l_per_100km, 2),
                    "cost": round(l.cost, 2),
                }
                for l in legs
            ],
        )
        # Real spend, when the receipts carry it.
        spend = sum(f.total for f in fillups if f.total)
        if spend:
            result["recorded_spend"] = round(spend, 2)
            first, last = fillups[0], fillups[-1]
            if first.odometer and last.odometer and last.odometer > first.odometer:
                span = last.odometer - first.odometer
                # As with servicing costs, the opening receipt bounds the span
                # rather than falling inside it.
                in_span = sum(f.total for f in fillups[1:] if f.total)
                result["spend_span_km"] = span
                result["cost_per_km"] = round(in_span / span, 3)
    else:
        consumption = config.get("consumption_l_per_100km")
        result.update(
            basis=ESTIMATED,
            consumption_l_per_100km=consumption,
            consumption_km_per_litre=round(100 / consumption, 2) if consumption else None,
            consumption_source=config.get("consumption_source"),
        )
        if consumption and price_now:
            result["cost_per_km"] = round(consumption / 100 * price_now, 3)

    cost_per_km = result.get("cost_per_km")
    if cost_per_km and km_per_year:
        result["cost_per_year"] = round(cost_per_km * km_per_year)
        result["cost_per_month"] = round(cost_per_km * km_per_year / 12)
        result["litres_per_year"] = round(
            result["consumption_l_per_100km"] / 100 * km_per_year
        ) if result.get("consumption_l_per_100km") else None

    return result


def running_costs(fuel: dict, maintenance_per_km: float | None) -> dict[str, Any]:
    """Fuel and servicing side by side — what the car actually costs per km."""
    fuel_per_km = fuel.get("cost_per_km")
    out: dict[str, Any] = {
        "fuel_per_km": fuel_per_km,
        "maintenance_per_km": maintenance_per_km,
        "basis": fuel.get("basis"),
    }
    if fuel_per_km is not None and maintenance_per_km is not None:
        total = fuel_per_km + maintenance_per_km
        out["total_per_km"] = round(total, 3)
        out["fuel_share_pct"] = round(100 * fuel_per_km / total)
        if fuel.get("km_per_year"):
            out["total_per_year"] = round(total * fuel["km_per_year"])
            out["total_per_month"] = round(total * fuel["km_per_year"] / 12)
    return out
