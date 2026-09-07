"""Parser for the Eldan "תעודת זהות לרכב" vehicle-history report.

pypdf flattens the RTL table into one line per row, columns running
date → classification → odometer → general description → detail:

    29/10/2023טיפול136315טיפולים135,000
    כלליתבדיקות לפי הוראות יצרן        <- continuation of the row above

A row that starts with a date opens a visit; the lines after it, which carry
only a category and a detail, are extra jobs done during the same visit.
"""

from __future__ import annotations

import re
from datetime import datetime

from ..classify import plan_label, system_for
from ..extract import ExtractedDoc
from ..models import INSPECTION, REPAIR, SERVICE, Job, ParseResult, Vehicle, Visit

NAME = "eldan"

# Column values Eldan uses in "תאור כללי". Longest first so that "מע' בלמים"
# is not shadowed by a shorter prefix.
CATEGORIES = (
    "טיפולים",
    "מע' בלמים",
    "מע' מנוע",
    "מע' היגוי",
    "מע' חשמל",
    "מע' קירור",
    "מרכב",
    "צמיגים",
    "כללית",
)

_ROW = re.compile(r"^(\d{2}/\d{2}/\d{4})(טיפול|תיקון)(\d+)(.*)$")
_HEADER_ODO = re.compile(r"^(\d+)\s*מד מרחק נוכחי")
_PLATE = re.compile(r"מס'\s*רישוי:\s*\.?(\d+)")
_YEAR = re.compile(r"(\d{4})\s*שנת ייצור")
_REPORT_DATE = re.compile(r"^(\d{2}/\d{2}/\d{4})\s*תאריך הפקת")


def detect(doc: ExtractedDoc) -> bool:
    return "תעודת זהות לרכב" in doc.text or "אלדן" in doc.text


def _split_category(rest: str) -> tuple[str | None, str]:
    for cat in CATEGORIES:
        if rest.startswith(cat):
            return cat, rest[len(cat):].strip()
    return None, rest.strip()


def _kind(classification: str, category: str | None, detail: str) -> str:
    if "מבחן רישוי" in detail:
        return INSPECTION
    return SERVICE if classification == "טיפול" else REPAIR


def parse(doc: ExtractedDoc) -> ParseResult:
    vehicle = Vehicle()
    visits: list[Visit] = []
    warnings: list[str] = []
    current: Visit | None = None
    report_date = None

    for raw in doc.text.splitlines():
        line = raw.strip()
        if not line:
            continue

        if m := _REPORT_DATE.match(line):
            report_date = datetime.strptime(m.group(1), "%d/%m/%Y").date()
            continue
        if m := _PLATE.search(line):
            vehicle.plate = m.group(1)
            continue
        if m := _YEAR.search(line):
            vehicle.year = int(m.group(1))
            continue
        if m := _HEADER_ODO.match(line):
            vehicle.current_odometer = int(m.group(1))
            vehicle.odometer_as_of = report_date
            continue
        if line.endswith("דגם:"):
            vehicle.model = line.replace("דגם:", "").strip()
            continue
        if line.endswith("יצרן:"):
            vehicle.make = line.replace("יצרן:", "").strip()
            continue
        if line.endswith("תיבת הילוכים:"):
            vehicle.gearbox = line.replace("תיבת הילוכים:", "").strip()
            continue

        if m := _ROW.match(line):
            date_s, classification, odo, rest = m.groups()
            category, detail = _split_category(rest)
            current = Visit(
                date=datetime.strptime(date_s, "%d/%m/%Y").date(),
                odometer=int(odo),
                kind=_kind(classification, category, detail),
                provider="אלדן",
                document=doc.name,
                source=NAME,
                plan_label=plan_label(detail) if category == "טיפולים" else None,
            )
            current.jobs.append(
                Job(
                    description=detail or (category or ""),
                    system=system_for(category, detail),
                    category=category,
                )
            )
            visits.append(current)
            continue

        # Continuation line: a category plus its detail, no date.
        category, detail = _split_category(line)
        if category and current is not None:
            current.jobs.append(
                Job(
                    description=detail,
                    system=system_for(category, detail),
                    category=category,
                )
            )

    if not visits:
        warnings.append(f"{doc.name}: Eldan layout recognised but no rows parsed")
    return ParseResult(vehicle=vehicle, visits=visits, warnings=warnings)
