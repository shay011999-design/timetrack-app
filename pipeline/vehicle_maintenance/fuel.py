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

# Below this many measured tanks the figure is reported as provisional.
MIN_TANKS_FOR_CONFIDENCE = 3

# Consumption a petrol car of this class can actually achieve over a full tank.
# A leg outside this band is not a car that sipped or guzzled — it is a log with
# a fill missing from the middle, which silently breaks tank-to-tank: the litres
# of the later fill then describe only part of the distance being divided into.
PLAUSIBLE_L_PER_100KM = (4.0, 20.0)

# How far the odometer gap and the trip computer may differ before they are
# treated as describing different things rather than the same tank.
DISTANCE_AGREEMENT = 0.15


@dataclass
class Fillup:
    date: date
    odometer: int | None = None
    litres: float | None = None
    price_per_litre: float | None = None
    total: float | None = None
    station: str | None = None
    full_tank: bool = True
    # Distance since the previous fill, read off the trip computer. With it a
    # single receipt closes a consumption window on its own — no second record
    # needed — which matters because the first fill anyone logs otherwise
    # measures nothing.
    km_since_last_fill: int | None = None
    # What the car itself reported, kept only to compare against the pump.
    computer_l_per_100km: float | None = None
    document: str | None = None
    source: str = "manual"
    notes: list[str] = field(default_factory=list)

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
    """Distance covered on one full tank."""

    from_date: date
    to_date: date
    km: int
    litres: float
    cost: float
    # "odometer" when measured between two logged fills, "trip" when the
    # distance came from the car's own since-refuelling counter.
    basis: str = "odometer"

    @property
    def l_per_100km(self) -> float:
        return self.litres / self.km * 100

    @property
    def km_per_litre(self) -> float:
        return self.km / self.litres


def price_fillups(fillups: list[Fillup], config: dict) -> None:
    """Fill in the pump price on receipts that did not record one.

    A litres-only entry still carries the odometer reading, which is the most
    valuable part; pricing it from the history makes it count toward spend too.
    """
    for f in fillups:
        if f.price_per_litre is None and f.litres:
            price = price_at(config, f.date)
            if price:
                f.price_per_litre = price
                f.total = round(f.litres * price, 2)


def load_fillups(fuel_dir: str | Path):
    """Fill-ups from hand-written JSON and from any text-layer receipt PDFs.

    Returns the fill-ups, any warnings, and a status for every PDF seen — so a
    batch of receipts dropped in at once can be accounted for file by file.
    """
    # Imported here: the receipt parser needs Fillup from this module.
    from .extract import extract
    from .models import (
        NEEDS_TRANSCRIPTION, PARSED, TRANSCRIBED, UNRECOGNISED, Document,
    )
    from .parsers import fuel_receipt

    fuel_dir = Path(fuel_dir)
    if not fuel_dir.exists():
        return [], [], []

    out: list[Fillup] = []
    warnings: list[str] = []
    documents: list[Document] = []

    for path in sorted(fuel_dir.glob("*.json")):
        d = json.loads(path.read_text(encoding="utf-8"))
        d["date"] = datetime.strptime(d["date"], "%Y-%m-%d").date()
        out.append(Fillup(**d))
    transcribed = {f.document for f in out if f.document}

    for path in sorted(fuel_dir.glob("*.pdf")):
        if path.name in transcribed:
            documents.append(Document(
                path.name, "fuel", TRANSCRIBED,
                records=sum(1 for f in out if f.document == path.name),
                detail="סריקה שתומללה ידנית",
            ))
            continue                      # already entered by hand
        doc = extract(path)
        if doc.is_scan:
            documents.append(Document(
                path.name, "fuel", NEEDS_TRANSCRIPTION, detail="סריקה ללא שכבת טקסט"
            ))
            warnings.append(
                f"{path.name}: סריקה ללא שכבת טקסט — נדרש תמלול ל-JSON"
            )
            continue
        if not fuel_receipt.detect(doc):
            documents.append(Document(
                path.name, "fuel", UNRECOGNISED, detail="לא זוהה כקבלת דלק"
            ))
            warnings.append(f"{path.name}: לא זוהה כקבלת דלק")
            continue
        fill, warns = fuel_receipt.parse(doc)
        warnings.extend(warns)
        if fill:
            out.append(fill)
            documents.append(Document(
                path.name, "fuel", PARSED, parser=fuel_receipt.NAME, records=1
            ))

    return sorted(out, key=lambda f: f.date), warnings, documents


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


def _plausible(leg: Leg, band: tuple[float, float]) -> bool:
    return band[0] <= leg.l_per_100km <= band[1]


def _distance_for(b: Fillup, prev: Fillup | None) -> tuple[int | None, str, str | None]:
    """How far this tank went, and how we know.

    Two sources can answer, and they answer different questions. The odometer
    gap measures distance since the *last logged* fill; the trip computer
    measures distance since the *actual* last fill, because it resets at every
    refuelling whether or not anyone wrote it down.

    So when they disagree the odometer gap is spanning fills missing from the
    log, and the trip counter is the one describing this tank. They are only
    interchangeable when they agree, and there the odometer is preferred as the
    more precise of the two.
    """
    trip = b.km_since_last_fill
    gap = None
    if b.odometer and prev and prev.odometer and b.odometer > prev.odometer:
        gap = b.odometer - prev.odometer

    if gap and trip:
        if abs(gap - trip) <= DISTANCE_AGREEMENT * trip:
            return gap, "odometer", None
        return trip, "trip", (
            f"{b.date:%d/%m/%Y}: מד האוץ מראה {gap:,} ק\"מ מהתדלוק הרשום הקודם, "
            f"אבל מחשב הדרך מדווח {trip:,} ק\"מ מאז התדלוק בפועל — כלומר יש "
            "תדלוקים שלא נרשמו ביניהם. החישוב מסתמך על מחשב הדרך."
        )
    if gap:
        return gap, "odometer", None
    if trip:
        return trip, "trip", None
    return None, "none", None


def _legs(fillups: list[Fillup], band: tuple[float, float] = PLAUSIBLE_L_PER_100KM):
    legs: list[Leg] = []
    notes: list[str] = []
    prev: Fillup | None = None

    for f in fillups:
        if not (f.full_tank and f.litres):
            # A partial fill leaves the tank level unknown, so nothing can be
            # measured across it — and it cannot anchor the next tank either.
            prev = None if not f.full_tank else f
            continue

        dist, basis, note = _distance_for(f, prev)
        prev = f
        if note:
            notes.append(note)
        if not dist:
            continue

        leg = Leg(
            from_date=prev.date if basis == "trip" else f.date,
            to_date=f.date, km=dist, litres=f.litres,
            cost=f.total or 0.0, basis=basis,
        )
        if _plausible(leg, band):
            legs.append(leg)
        else:
            notes.append(
                f"{f.date:%d/%m/%Y}: {leg.km:,} ק\"מ על {leg.litres:.1f} ליטר = "
                f"{leg.l_per_100km:.1f} ל׳/100 ק\"מ, מחוץ לטווח הסביר — "
                "בדקו את הנתונים או שחסר תדלוק ברצף"
            )

    return sorted(legs, key=lambda l: l.to_date), notes


def analyse(
    fillups: list[Fillup],
    config: dict,
    km_per_year: float | None,
    today: date,
) -> dict[str, Any]:
    """Fuel picture for the dashboard: consumption, spend, and cost per km."""
    price_now = price_at(config, today)
    band = tuple(config.get("plausible_l_per_100km") or PLAUSIBLE_L_PER_100KM)
    legs, leg_notes = _legs(fillups, band)

    # A fill with no odometer still counts toward spend, but can never close a
    # tank or anchor the forecast — the single most useful field is the one the
    # receipt does not print.
    missing_odo = [f for f in fillups if f.odometer is None]

    result: dict[str, Any] = {
        "fuel_type": config.get("type"),
        "price_per_litre": price_now,
        "price_source": config.get("price_source"),
        "fillup_count": len(fillups),
        "km_per_year": round(km_per_year) if km_per_year else None,
        "fillups_without_odometer": len(missing_odo),
        # Published so the dashboard's entry form can warn by the same rule the
        # pipeline applies, rather than a hand-copied duplicate of it.
        "plausible_l_per_100km": list(band),
        "fillups": [
            {
                **f.to_json(),
                # Per-fill consumption where this fill closed a tank of its own.
                "l_per_100km": next(
                    (round(l.l_per_100km, 2) for l in legs if l.to_date == f.date),
                    None,
                ),
            }
            for f in fillups
        ],
        "warnings": leg_notes + [
            f"{f.date:%d/%m/%Y}: תדלוק ללא מד אוץ — לא נספר בחישוב הצריכה"
            for f in missing_odo
        ],
    }

    if legs:
        total_km = sum(l.km for l in legs)
        total_litres = sum(l.litres for l in legs)
        consumption = total_litres / total_km * 100
        result.update(
            basis=MEASURED,
            tanks_measured=len(legs),
            # One tank is a data point, not a habit: a single fill that was not
            # quite full, or an unusual week of driving, moves it a long way.
            low_confidence=len(legs) < MIN_TANKS_FOR_CONFIDENCE,
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
                    "basis": l.basis,
                }
                for l in legs
            ],
        )
        # Real spend, when the receipts carry it. This is history; the headline
        # cost per km below is what a kilometre costs at today's pump price.
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
                result["historical_cost_per_km"] = round(in_span / span, 3)

        # What the car itself reported, against what the pump actually took.
        # A persistent gap means the trip computer is optimistic; comparing it
        # to an estimated consumption would be comparing two guesses, so this
        # lives in the measured branch only.
        reported = [f.computer_l_per_100km for f in fillups if f.computer_l_per_100km]
        if reported:
            avg = sum(reported) / len(reported)
            result["computer_l_per_100km"] = round(avg, 2)
            result["computer_vs_pump_pct"] = round(
                100 * (avg - consumption) / consumption, 1
            )
    else:
        consumption = config.get("consumption_l_per_100km")
        result.update(
            basis=ESTIMATED,
            consumption_l_per_100km=consumption,
            consumption_km_per_litre=round(100 / consumption, 2) if consumption else None,
            consumption_source=config.get("consumption_source"),
        )

    # One formula for both modes, so the only thing that changes between them
    # is whether the consumption going in was measured or guessed.
    consumption = result.get("consumption_l_per_100km")
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
