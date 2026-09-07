"""Parser for Israeli petrol-station receipts (Paz layout).

A receipt carries the date, the litres, the price per litre and the total —
everything about the money, and nothing about the car's position in time.
There is **no odometer on the receipt**, and without one the fill cannot be
tied to a distance, so it measures spend but not consumption. Records parsed
here therefore come back with ``odometer=None`` and a warning naming what is
missing, rather than quietly contributing a fill that can never close a tank.

Only receipts that carry a text layer are handled. Photographed or scanned
receipts have none, and go through ``data/fuel/*.json`` by hand instead.
"""

from __future__ import annotations

import re
from datetime import datetime

from ..extract import ExtractedDoc
from ..fuel import Fillup

NAME = "fuel_receipt"

# Station chains whose receipts share this layout.
_BRANDS = {
    "פז": "פז",
    "דלק": "דלק",
    "סונול": "סונול",
    "דור אלון": "דור אלון",
    "טן": "טן",
}

_DATETIME = re.compile(r"(\d{2}/\d{2}/\d{2,4})\s+(\d{2}:\d{2})")
_PLATE = re.compile(r"רכב\s*:?\s*(\d{5,8})")
_PUMP = re.compile(r"משאבה\s*:?\s*(\d+)")
_LITRES = re.compile(r"כמות\s*:?\s*([\d,]+\.?\d*)")
_TOTAL = re.compile(r'סה"?כ\s*(?:דלקים|לתשלום)\s*:?\s*([\d,]+\.\d{2})')
_PRICE = re.compile(r"([\d.]+)\s*ש\"?ח\s*לליטר")
_OCTANE = re.compile(r"אוקטן\s*(\d{2})")
_INVOICE = re.compile(r"\b(\d{12,20})\b")


def detect(doc: ExtractedDoc) -> bool:
    text = doc.text
    has_brand = any(b in text for b in _BRANDS)
    has_fuel = "לליטר" in text or "אוקטן" in text or "דלקים" in text
    return has_brand and has_fuel


def _num(m: re.Match | None) -> float | None:
    return float(m.group(1).replace(",", "")) if m else None


def parse(doc: ExtractedDoc) -> tuple[Fillup | None, list[str]]:
    text = doc.text
    warnings: list[str] = []

    m = _DATETIME.search(text)
    if not m:
        return None, [f"{doc.name}: לא נמצא תאריך בקבלה"]
    raw = m.group(1)
    fmt = "%d/%m/%Y" if len(raw.split("/")[-1]) == 4 else "%d/%m/%y"
    when = datetime.strptime(raw, fmt).date()

    litres = _num(_LITRES.search(text))
    price = _num(_PRICE.search(text))
    total = _num(_TOTAL.search(text))
    if litres is None and total is None:
        return None, [f"{doc.name}: לא נמצאו ליטרים או סכום"]

    station = next((name for key, name in _BRANDS.items() if key in text), None)
    if octane := _OCTANE.search(text):
        station = f"{station} {octane.group(1)}" if station else octane.group(1)

    fill = Fillup(
        date=when,
        odometer=None,                 # never printed on a fuel receipt
        litres=litres,
        price_per_litre=price,
        total=total,
        station=station,
        document=doc.name,
        source=NAME,
    )
    if inv := _INVOICE.search(text):
        fill.notes.append(f"חשבונית {inv.group(1)}")
    if pump := _PUMP.search(text):
        fill.notes.append(f"משאבה {pump.group(1)}")
    if plate := _PLATE.search(text):
        fill.notes.append(f"רכב {plate.group(1)}")

    warnings.append(
        f"{doc.name}: אין מד אוץ בקבלה — יש להוסיף אותו ידנית כדי שהתדלוק "
        "ייכנס לחישוב הצריכה ולתחזית הטיפול"
    )
    return fill, warnings
