"""Normalised data model shared by every parser and by the analysis stage."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import date
from typing import Any


# Event kinds. A vehicle's history is a stream of these.
SERVICE = "service"        # scheduled/periodic maintenance
REPAIR = "repair"          # unscheduled fix
INSPECTION = "inspection"  # annual roadworthiness test (מבחן רישוי)

# Wear-system buckets, used to answer "when did we last touch X?".
SYS_ENGINE = "engine"
SYS_BRAKES = "brakes"
SYS_TIRES = "tires"
SYS_TIMING = "timing"
SYS_FLUIDS = "fluids"
SYS_GENERAL = "general"


@dataclass
class Part:
    """One line item on an invoice."""

    name: str
    qty: float = 1.0
    unit_price: float | None = None
    total: float | None = None
    system: str = SYS_GENERAL


@dataclass
class Job:
    """One thing that was done during a visit."""

    description: str
    system: str = SYS_GENERAL
    category: str | None = None   # the source document's own wording


@dataclass
class Visit:
    """A single garage/dealer visit, the atom of the whole system."""

    date: date
    odometer: int | None
    kind: str = SERVICE
    provider: str | None = None
    document: str | None = None       # source file this came from
    source: str | None = None         # which parser produced it
    invoice_no: str | None = None
    plan_label: str | None = None     # e.g. "120,000" for a scheduled service
    jobs: list[Job] = field(default_factory=list)
    parts: list[Part] = field(default_factory=list)
    labor_total: float | None = None
    parts_total: float | None = None
    total: float | None = None        # final amount incl. VAT
    vat_rate: float | None = None
    notes: list[str] = field(default_factory=list)

    def systems(self) -> set[str]:
        return {j.system for j in self.jobs} | {p.system for p in self.parts}

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["date"] = self.date.isoformat()
        return d


@dataclass
class Vehicle:
    """Identity of the car the visits belong to."""

    plate: str | None = None
    make: str | None = None
    model: str | None = None
    year: int | None = None
    gearbox: str | None = None
    current_odometer: int | None = None
    odometer_as_of: date | None = None

    def merge(self, other: "Vehicle") -> None:
        """Fill in blanks from another source; first non-empty value wins."""
        for f in ("plate", "make", "model", "year", "gearbox"):
            if getattr(self, f) is None:
                setattr(self, f, getattr(other, f))
        # Keep the most recent odometer reading we have seen.
        if other.current_odometer is not None:
            if self.current_odometer is None or (
                other.odometer_as_of
                and self.odometer_as_of
                and other.odometer_as_of > self.odometer_as_of
            ):
                self.current_odometer = other.current_odometer
                self.odometer_as_of = other.odometer_as_of

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["odometer_as_of"] = self.odometer_as_of.isoformat() if self.odometer_as_of else None
        return d


@dataclass
class ParseResult:
    vehicle: Vehicle
    visits: list[Visit]
    warnings: list[str] = field(default_factory=list)
