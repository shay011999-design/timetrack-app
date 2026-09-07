"""Parser for the importer's "הסטורית רכב" service-history printout.

The layout is a stack of per-visit blocks. A block opens with a line holding
the odometer, the service-centre id and the invoice date run together:

    118,328341751 12/03/2023

and is followed by loose lines: the entry date, the invoice number, table
headers, quantities, part codes, and the job descriptions we actually want.

The job rows arrive with their neighbouring columns glued on (status "טופל",
type "שעתון"/"טקסט", origin "בקשה"/"הזמנה"), so those tokens are stripped
rather than parsed positionally — the column order is not recoverable from a
flattened RTL table, and the description is the only part worth keeping.
"""

from __future__ import annotations

import re
from datetime import datetime

from ..classify import system_for
from ..extract import ExtractedDoc
from ..models import SERVICE, Job, ParseResult, Vehicle, Visit

NAME = "dealer_history"

# odometer (optionally comma-grouped) + 6-digit service centre + invoice date
_BLOCK = re.compile(r"^([\d,]*?)(\d{6})\s+(\d{2}/\d{2}/\d{4})\s*$")
_DATE_ONLY = re.compile(r"^(\d{2}/\d{2}/\d{4})\s*$")
_QTY = re.compile(r"^\d+\.\d{2}$")
_PART_CODE = re.compile(r"^[A-Z0-9][A-Z0-9 ]{5,}\d\.\d{2}$")
_NUMERIC = re.compile(r"^[\d,\.]+$")

# Column values that get glued onto a description by the flattening.
_COLUMN_TOKENS = ("טופל", "שעתון", "טקסט", "בקשה", "הזמנה", "בוטל", "ממתין")

# Table headers and boilerplate that are never job descriptions.
_NOISE = (
    "מס' כרטיס",
    "תאריך כניסה",
    "חשבונית",
    "סטטוס",
    "הסטורית רכב",
    "מס' רישוי",
    "עמוד",
    "עדכון החיוב",   # billing footnote, not work done
)

# An odometer this small is a placeholder, not a real reading.
_MIN_PLAUSIBLE_ODO = 1_000


def detect(doc: ExtractedDoc) -> bool:
    return "הסטורית רכב" in doc.text


def _clean(line: str) -> str:
    out = line
    for token in _COLUMN_TOKENS:
        out = out.replace(token, " ")
    return re.sub(r"\s+", " ", out).strip()


def _is_noise(line: str) -> bool:
    return (
        any(n in line for n in _NOISE)
        or _QTY.match(line)
        or _NUMERIC.match(line)
        or _PART_CODE.match(line)
        or not re.search(r"[֐-׿]", line)  # no Hebrew => not a description
    )


def parse(doc: ExtractedDoc) -> ParseResult:
    visits: list[Visit] = []
    warnings: list[str] = []
    current: Visit | None = None
    awaiting_entry_date = False

    for raw in doc.text.splitlines():
        line = raw.strip()
        if not line:
            continue

        if m := _BLOCK.match(line):
            odo_s, _centre, date_s = m.groups()
            odo = int(odo_s.replace(",", "")) if odo_s.replace(",", "").isdigit() else 0
            current = Visit(
                date=datetime.strptime(date_s, "%d/%m/%Y").date(),
                odometer=odo if odo >= _MIN_PLAUSIBLE_ODO else None,
                kind=SERVICE,
                provider="מרכז שירות מורשה",
                document=doc.name,
                source=NAME,
            )
            visits.append(current)
            awaiting_entry_date = True
            continue

        # The first bare date after a block header is the actual entry date,
        # which is what the visit should be dated by (the header date is the
        # invoice date, sometimes days later).
        if awaiting_entry_date and (m := _DATE_ONLY.match(line)):
            if current is not None:
                current.notes.append(f"תאריך חשבונית: {current.date:%d/%m/%Y}")
                current.date = datetime.strptime(m.group(1), "%d/%m/%Y").date()
            awaiting_entry_date = False
            continue

        if current is None or _is_noise(line):
            continue

        desc = _clean(line)
        if len(desc) < 3:
            continue
        if any(j.description == desc for j in current.jobs):
            continue
        current.jobs.append(Job(description=desc, system=system_for(desc)))

    if not visits:
        warnings.append(f"{doc.name}: dealer-history layout recognised but no blocks parsed")
    return ParseResult(vehicle=Vehicle(), visits=visits, warnings=warnings)
