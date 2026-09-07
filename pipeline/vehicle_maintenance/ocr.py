"""Read scanned invoices and receipts with a vision model, then check the reading.

Why a vision model rather than classic OCR: these documents are Hebrew, RTL, and
photocopied. Tesseract with the Hebrew pack was measured on the real files here
and got the layout roughly right while corrupting the figures that matter — it
read the garage invoice's parts total 335.00 as "35.00" and its 708.00 payable
as "20000", and on the fuel receipt it turned 42.532 litres into "22.2" once the
image was upscaled. Wrong-but-plausible numbers are the worst possible failure
for money and odometer readings, because nothing downstream can tell they are
wrong.

So extraction is only half the job. Every receipt carries its own arithmetic —
litres x price = total, parts + labour + VAT = payable — and this module treats
those identities as the check on the model's reading. A document whose numbers
do not reconcile is reported for review instead of being written.

Deliberately NOT part of the build. The build must stay deterministic, free and
offline; this step costs money, is non-deterministic, and produces a record that
gets committed and reviewed like any hand-written one.

    python -m vehicle_maintenance.ocr data/fuel/paz_2026-07-24.pdf --kind fuel
    python -m vehicle_maintenance.ocr <file> --kind service --write
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel, Field

from .extract import extract, page_images

MODEL = "claude-opus-5"

# Money is printed to the agora; allow only rounding-line slack.
MONEY_TOLERANCE = 0.05
# Invoices carry an explicit rounding line ("עיגול"), so the VAT identity is
# looser than the line-item ones.
VAT_TOLERANCE = 1.0


# ── what we ask the model for ────────────────────────────────────────────────

class FuelReceipt(BaseModel):
    date: str = Field(description="Date of the fill-up, YYYY-MM-DD")
    litres: float = Field(description="Litres dispensed, exactly as printed")
    price_per_litre: float = Field(description="Price per litre as printed")
    total: float = Field(description="Total paid including VAT")
    station: str | None = Field(default=None, description="Station chain and branch")
    fuel_type: str | None = Field(default=None, description="Octane grade, e.g. 95")
    vat_rate: float | None = Field(default=None, description="VAT percentage")
    plate: str | None = None
    pump: str | None = None
    invoice_no: str | None = None
    odometer: int | None = Field(
        default=None,
        description="Odometer reading. Fuel receipts almost never print one — "
                    "return null rather than guessing from any other number.",
    )


class ServicePart(BaseModel):
    name: str
    qty: float = 1.0
    unit_price: float | None = None
    total: float | None = None


class ServiceInvoice(BaseModel):
    date: str = Field(description="Invoice date, YYYY-MM-DD")
    total: float = Field(description="Total payable including VAT")
    garage: str | None = None
    invoice_no: str | None = None
    odometer: int | None = Field(
        default=None, description="Odometer / ספידומטר reading if printed"
    )
    labor_total: float | None = None
    parts_total: float | None = None
    subtotal: float | None = Field(default=None, description="Total before VAT")
    vat_rate: float | None = None
    parts: list[ServicePart] = Field(default_factory=list)
    jobs: list[str] = Field(default_factory=list, description="Work described")


PROMPT = """\
זוהי חשבונית או קבלה ישראלית סרוקה. חלץ את השדות במדויק כפי שהם מודפסים.

כללים:
- העתק מספרים בדיוק כפי שמופיעים, כולל כל הספרות אחרי הנקודה. אל תעגל.
- אל תחשב ואל תשלים מספר שאינו מודפס — אם שדה לא מופיע, החזר null.
- במיוחד: אל תנחש קילומטראז׳. אם אין "ספידומטר" או מד אוץ מודפס, החזר null.
- תאריכים בפורמט YYYY-MM-DD. שים לב שהמסמך בפורמט DD/MM/YY או DD/MM/YYYY.
- אם ספרה מטושטשת או לא קריאה, החזר null לשדה כולו ולא ניחוש.
"""


# ── checking the reading ─────────────────────────────────────────────────────

@dataclass
class Check:
    name: str
    ok: bool
    detail: str


def _close(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= tol


def verify_fuel(r: FuelReceipt) -> list[Check]:
    checks: list[Check] = []

    product = r.litres * r.price_per_litre
    checks.append(Check(
        "ליטרים × מחיר = סה\"כ",
        _close(product, r.total, MONEY_TOLERANCE),
        f"{r.litres} × {r.price_per_litre} = {product:.2f} מול {r.total:.2f} מודפס",
    ))

    try:
        datetime.strptime(r.date, "%Y-%m-%d")
        checks.append(Check("תאריך תקין", True, r.date))
    except ValueError:
        checks.append(Check("תאריך תקין", False, f"לא ניתן לפענח: {r.date!r}"))

    checks.append(Check(
        "כמות סבירה", 5 <= r.litres <= 90, f"{r.litres} ליטר"
    ))
    checks.append(Check(
        "מחיר סביר", 3 <= r.price_per_litre <= 15, f"{r.price_per_litre} ש\"ח/ליטר"
    ))
    return checks


def verify_service(r: ServiceInvoice) -> list[Check]:
    checks: list[Check] = []

    priced = [p.total for p in r.parts if p.total is not None]
    if priced and r.parts_total is not None:
        s = sum(priced)
        checks.append(Check(
            "סכום החלפים = סה\"כ חלפים",
            _close(s, r.parts_total, MONEY_TOLERANCE),
            f"{s:.2f} מול {r.parts_total:.2f} מודפס",
        ))

    if r.parts_total is not None and r.labor_total is not None and r.subtotal is not None:
        s = r.parts_total + r.labor_total
        checks.append(Check(
            "חלפים + עבודה = סה\"כ לפני מע\"מ",
            _close(s, r.subtotal, MONEY_TOLERANCE),
            f"{s:.2f} מול {r.subtotal:.2f} מודפס",
        ))

    if r.subtotal is not None and r.vat_rate is not None:
        gross = r.subtotal * (1 + r.vat_rate / 100)
        checks.append(Check(
            "סה\"כ + מע\"מ = לתשלום",
            _close(gross, r.total, VAT_TOLERANCE),
            f"{gross:.2f} מול {r.total:.2f} מודפס (מע\"מ {r.vat_rate}%)",
        ))

    for p in r.parts:
        if p.unit_price is not None and p.total is not None:
            checks.append(Check(
                f"שורת חלף: {p.name}",
                _close(p.qty * p.unit_price, p.total, MONEY_TOLERANCE),
                f"{p.qty} × {p.unit_price} מול {p.total}",
            ))

    if r.odometer is not None:
        checks.append(Check(
            "מד אוץ סביר", 1_000 <= r.odometer <= 1_000_000, f"{r.odometer:,}"
        ))
    return checks


def passed(checks: list[Check]) -> bool:
    return all(c.ok for c in checks)


# ── turning an extraction into a pipeline record ─────────────────────────────

def fuel_record(r: FuelReceipt, document: str) -> dict[str, Any]:
    notes = [f"חולץ אוטומטית מ-{document} ואומת מול החשבון שבקבלה"]
    if r.invoice_no or r.pump or r.plate:
        bits = [b for b in (
            f"חשבונית {r.invoice_no}" if r.invoice_no else None,
            f"משאבה {r.pump}" if r.pump else None,
            f"רכב {r.plate}" if r.plate else None,
        ) if b]
        notes.append(" · ".join(bits))
    if r.odometer is None:
        notes.append("אין מד אוץ בקבלה — יש להוסיף ידנית כדי שהתדלוק ימדוד צריכה")

    station = r.station
    if station and r.fuel_type:
        station = f"{station} ({r.fuel_type})"

    rec: dict[str, Any] = {
        "date": r.date,
        "odometer": r.odometer,
        "litres": r.litres,
        "price_per_litre": r.price_per_litre,
        "total": r.total,
        "full_tank": True,
        "source": "ocr",
        "document": document,
        "notes": notes,
    }
    if station:
        rec["station"] = station
    return rec


def service_record(r: ServiceInvoice, document: str) -> dict[str, Any]:
    from .classify import system_for

    return {
        "date": r.date,
        "odometer": r.odometer,
        "kind": "service",
        "provider": r.garage,
        "document": document,
        "source": "ocr",
        "invoice_no": r.invoice_no,
        "labor_total": r.labor_total,
        "parts_total": r.parts_total,
        "total": r.total,
        "vat_rate": r.vat_rate,
        "jobs": [
            {"description": j, "system": system_for(j), "category": None}
            for j in r.jobs
        ],
        "parts": [
            {
                "name": p.name, "qty": p.qty, "unit_price": p.unit_price,
                "total": p.total, "system": system_for(p.name),
            }
            for p in r.parts
        ],
        "notes": [f"חולץ אוטומטית מ-{document} ואומת מול החשבון שבחשבונית"],
    }


# ── the model call, kept behind a seam so the rest is testable offline ────────

Extractor = Callable[[bytes, str, type[BaseModel]], BaseModel]


def claude_extractor(image: bytes, media_type: str, schema: type[BaseModel]) -> BaseModel:
    import anthropic

    client = anthropic.Anthropic()
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": base64.standard_b64encode(image).decode("utf-8"),
                    },
                },
                {"type": "text", "text": PROMPT},
            ],
        }],
        output_format=schema,
    )
    return response.parsed_output


def read_document(
    path: str | Path, kind: str, extractor: Extractor | None = None
) -> tuple[BaseModel, list[Check]]:
    path = Path(path)
    doc = extract(path)
    if not doc.is_scan:
        raise ValueError(
            f"{path.name}: יש למסמך שכבת טקסט — השתמשו בפרסר הרגיל, לא ב-OCR"
        )
    images = page_images(path)
    if not images:
        raise ValueError(f"{path.name}: לא נמצאה תמונה בקובץ")

    schema = FuelReceipt if kind == "fuel" else ServiceInvoice
    extractor = extractor or claude_extractor
    result = extractor(images[0], "image/jpeg", schema)
    checks = verify_fuel(result) if kind == "fuel" else verify_service(result)
    return result, checks


# ── CLI ──────────────────────────────────────────────────────────────────────

HERE = Path(__file__).resolve().parent.parent


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="קריאת חשבונית סרוקה באמצעות מודל ראייה.")
    ap.add_argument("path")
    ap.add_argument("--kind", choices=("fuel", "service"), required=True)
    ap.add_argument("--write", action="store_true", help="שמירת הרשומה לתיקיית הנתונים")
    ap.add_argument("--force", action="store_true", help="שמירה גם אם האימות נכשל")
    ap.add_argument("--out", help="נתיב יעד; ברירת מחדל לפי סוג המסמך")
    args = ap.parse_args(argv)

    try:
        result, checks = read_document(args.path, args.kind)
    except Exception as e:                      # noqa: BLE001 — surfaced to the user
        print(f"שגיאה: {e}", file=sys.stderr)
        return 2

    document = Path(args.path).name
    record = (
        fuel_record(result, document) if args.kind == "fuel"
        else service_record(result, document)
    )

    print(json.dumps(record, ensure_ascii=False, indent=2))
    print("\nאימות מול החשבון שבמסמך:")
    for c in checks:
        print(f"  {'✓' if c.ok else '✗'} {c.name}: {c.detail}")

    ok = passed(checks)
    if not ok:
        print("\nהאימות נכשל — המספרים שנקראו לא מסתדרים זה עם זה.", file=sys.stderr)

    if not args.write:
        print("\n(הרצה יבשה. הוסיפו --write לשמירה.)")
        return 0 if ok else 1
    if not ok and not args.force:
        print("לא נשמר. תקנו ידנית, או --force לשמירה בכל זאת.", file=sys.stderr)
        return 1

    folder = HERE / "data" / ("fuel" if args.kind == "fuel" else "manual")
    out = Path(args.out) if args.out else folder / f"{record['date']}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nנשמר: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
