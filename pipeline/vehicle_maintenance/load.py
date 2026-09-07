"""Collect every source document into one de-duplicated history."""

from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path

from . import parsers
from .extract import extract
from .models import (
    NEEDS_TRANSCRIPTION,
    PARSED,
    TRANSCRIBED,
    UNRECOGNISED,
    Document,
    Job,
    Part,
    ParseResult,
    Vehicle,
    Visit,
)

# Two records describe the same visit when they are this close on both axes.
# The importer and the leasing company read the odometer at different moments,
# and invoice dates trail entry dates, so exact equality is too strict.
SAME_VISIT_DAYS = 7
SAME_VISIT_KM = 200


def _visit_from_json(d: dict) -> Visit:
    return Visit(
        date=datetime.strptime(d["date"], "%Y-%m-%d").date(),
        odometer=d.get("odometer"),
        kind=d.get("kind", "service"),
        provider=d.get("provider"),
        document=d.get("document"),
        source=d.get("source", "manual"),
        invoice_no=d.get("invoice_no"),
        plan_label=d.get("plan_label"),
        jobs=[Job(**j) for j in d.get("jobs", [])],
        parts=[Part(**p) for p in d.get("parts", [])],
        labor_total=d.get("labor_total"),
        parts_total=d.get("parts_total"),
        total=d.get("total"),
        vat_rate=d.get("vat_rate"),
        notes=list(d.get("notes", [])),
    )


def _same_visit(a: Visit, b: Visit) -> bool:
    if abs((a.date - b.date).days) > SAME_VISIT_DAYS:
        return False
    if a.odometer is None or b.odometer is None:
        return True
    return abs(a.odometer - b.odometer) <= SAME_VISIT_KM


def _merge_into(target: Visit, extra: Visit) -> None:
    """Fold ``extra`` into ``target``, keeping the richer value on every field."""
    known = {(j.description, j.system) for j in target.jobs}
    for job in extra.jobs:
        if (job.description, job.system) not in known:
            target.jobs.append(job)
            known.add((job.description, job.system))

    known_parts = {p.name for p in target.parts}
    for part in extra.parts:
        if part.name not in known_parts:
            target.parts.append(part)
            known_parts.add(part.name)

    for f in ("invoice_no", "plan_label", "labor_total", "parts_total",
              "total", "vat_rate", "odometer", "provider"):
        if getattr(target, f) is None:
            setattr(target, f, getattr(extra, f))

    # An inspection folded into a service is still, overall, a service.
    if target.kind != "service" and extra.kind == "service":
        target.kind = "service"

    for note in extra.notes:
        if note not in target.notes:
            target.notes.append(note)

    for doc in (extra.document or "").split(" + "):
        if doc and doc not in (target.document or ""):
            target.document = f"{target.document} + {doc}" if target.document else doc


def load(pdf_dir: str | Path, manual_dir: str | Path | None = None) -> ParseResult:
    pdf_dir = Path(pdf_dir)
    vehicle = Vehicle()
    collected: list[Visit] = []
    warnings: list[str] = []
    documents: list[Document] = []

    # Load hand-transcribed records first, so a scan they already cover does
    # not also get reported as missing.
    manual: list[Visit] = []
    if manual_dir:
        for path in sorted(Path(manual_dir).glob("*.json")):
            manual.append(_visit_from_json(json.loads(path.read_text(encoding="utf-8"))))
    transcribed = {v.document for v in manual if v.document}

    for path in sorted(pdf_dir.glob("*.pdf")):
        doc = extract(path)
        parser = parsers.for_doc(doc)
        if parser is None:
            if path.name in transcribed:
                documents.append(Document(
                    path.name, "service", TRANSCRIBED,
                    records=sum(1 for v in manual if v.document == path.name),
                    detail="סריקה שתומללה ידנית",
                ))
            elif doc.is_scan:
                documents.append(Document(
                    path.name, "service", NEEDS_TRANSCRIPTION,
                    detail="סריקה ללא שכבת טקסט",
                ))
                warnings.append(
                    f"{path.name}: סריקה ללא שכבת טקסט — נדרש תמלול ב-data/manual"
                )
            else:
                documents.append(Document(
                    path.name, "service", UNRECOGNISED, detail="פורמט לא מוכר"
                ))
                warnings.append(f"{path.name}: לא זוהה פורמט מוכר")
            continue
        result = parser.parse(doc)
        documents.append(Document(
            path.name, "service", PARSED, parser=parser.NAME,
            records=len(result.visits),
        ))
        vehicle.merge(result.vehicle)
        collected.extend(result.visits)
        warnings.extend(result.warnings)

    collected.extend(manual)

    # De-duplicate: documents overlap, e.g. the importer printout repeats
    # services that also appear in the leasing company's report.
    collected.sort(key=lambda v: (v.date, v.odometer or 0))
    merged: list[Visit] = []
    for visit in collected:
        for existing in merged:
            if _same_visit(existing, visit):
                _merge_into(existing, visit)
                break
        else:
            merged.append(visit)

    merged.sort(key=lambda v: v.date)
    if merged and vehicle.current_odometer is None:
        last = merged[-1]
        vehicle.current_odometer = last.odometer
        vehicle.odometer_as_of = last.date
    elif merged:
        last = merged[-1]
        if last.odometer and (
            vehicle.odometer_as_of is None or last.date > vehicle.odometer_as_of
        ):
            vehicle.current_odometer = last.odometer
            vehicle.odometer_as_of = last.date

    return ParseResult(
        vehicle=vehicle, visits=merged, warnings=warnings, documents=documents
    )
