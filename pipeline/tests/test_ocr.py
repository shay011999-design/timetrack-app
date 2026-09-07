"""Tests for the scanned-document reader.

The model call is stubbed: what matters here is that a correct reading is
accepted, a corrupted one is refused, and neither depends on the network.

The "corrupted" fixtures are not invented — they are what Tesseract with the
Hebrew pack actually produced on these same two documents. That is the failure
this layer exists to catch: numbers that look like numbers and are wrong.
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from vehicle_maintenance import ocr  # noqa: E402


# ── the real documents, read correctly ───────────────────────────────────────

def paz_correct(**over):
    return ocr.FuelReceipt(**{
        "date": "2026-07-24", "litres": 42.532, "price_per_litre": 7.48,
        "total": 318.14, "station": "פז", "fuel_type": "95", "vat_rate": 18.0,
        "plate": "38855601", "pump": "05", "invoice_no": "034109901437836",
        "odometer": None, **over,
    })


def garage_correct(**over):
    return ocr.ServiceInvoice(**{
        "date": "2024-11-03", "total": 708.0, "garage": "מוסך סלווה וודים בע\"מ",
        "invoice_no": "22491", "odometer": 143823, "labor_total": 270.0,
        "parts_total": 335.0, "subtotal": 605.0, "vat_rate": 17.0,
        "parts": [
            ocr.ServicePart(name="שמן מנוע", qty=1, unit_price=195.0, total=195.0),
            ocr.ServicePart(name="פילטר שמן", qty=1, unit_price=75.0, total=75.0),
            ocr.ServicePart(name="פילטר אוויר", qty=1, unit_price=65.0, total=65.0),
        ],
        "jobs": ["טיפול"], **over,
    })


def test_correct_fuel_reading_passes():
    checks = ocr.verify_fuel(paz_correct())
    assert ocr.passed(checks), [c.detail for c in checks if not c.ok]


def test_correct_service_reading_passes():
    checks = ocr.verify_service(garage_correct())
    assert ocr.passed(checks), [c.detail for c in checks if not c.ok]


# ── the corruptions Tesseract actually produced ──────────────────────────────

def test_dropped_digit_in_parts_total_is_caught():
    """Tesseract read the 335.00 parts total as '35.00'. The line items still
    sum to 335, so the sum-vs-total identity is what exposes it."""
    bad = garage_correct(parts_total=35.0)
    checks = ocr.verify_service(bad)
    assert not ocr.passed(checks)
    assert any("חלפים" in c.name and not c.ok for c in checks)


def test_wrong_payable_total_is_caught():
    """It read the 708.00 payable as '20000'."""
    bad = garage_correct(total=20000.0)
    checks = ocr.verify_service(bad)
    assert not ocr.passed(checks)
    assert any("לתשלום" in c.name and not c.ok for c in checks)


def test_lost_decimal_in_vat_is_caught():
    """102.87 VAT came back as '1287'; with it the gross no longer reconciles."""
    bad = garage_correct(subtotal=605.0, vat_rate=17.0, total=605.0 + 1287)
    checks = ocr.verify_service(bad)
    assert not ocr.passed(checks)


def test_mangled_litres_is_caught():
    """Upscaling turned 42.532 litres into '22.2', which no longer multiplies
    out to the printed total."""
    bad = paz_correct(litres=22.2)
    checks = ocr.verify_fuel(bad)
    assert not ocr.passed(checks)
    assert any("ליטרים" in c.name and not c.ok for c in checks)


def test_mangled_fuel_total_is_caught():
    bad = paz_correct(total=4.0)
    assert not ocr.passed(ocr.verify_fuel(bad))


def test_unparseable_date_is_caught():
    """The header date came back as '6 14:3%' — unusable as a record key."""
    bad = paz_correct(date="6 14:3%")
    checks = ocr.verify_fuel(bad)
    assert not ocr.passed(checks)
    assert any("תאריך" in c.name and not c.ok for c in checks)


def test_line_item_inconsistency_is_caught():
    bad = garage_correct(parts=[
        ocr.ServicePart(name="שמן מנוע", qty=1, unit_price=195.0, total=999.0),
    ])
    assert not ocr.passed(ocr.verify_service(bad))


@pytest.mark.parametrize("odo", [0, 12, 9_999_999])
def test_implausible_odometer_is_caught(odo):
    assert not ocr.passed(ocr.verify_service(garage_correct(odometer=odo)))


# ── records handed to the pipeline ───────────────────────────────────────────

def test_fuel_record_flags_the_missing_odometer():
    rec = ocr.fuel_record(paz_correct(), "paz.pdf")
    assert rec["odometer"] is None
    assert any("מד אוץ" in n for n in rec["notes"])
    assert rec["source"] == "ocr"


def test_service_record_classifies_parts():
    rec = ocr.service_record(garage_correct(), "garage.pdf")
    systems = {p["name"]: p["system"] for p in rec["parts"]}
    assert systems["פילטר שמן"] == "engine"
    assert systems["שמן מנוע"] == "fluids"


def test_records_load_back_into_the_pipeline():
    """The whole point: what OCR writes must be what the pipeline reads."""
    from vehicle_maintenance.fuel import Fillup
    from vehicle_maintenance.load import _visit_from_json

    fuel = ocr.fuel_record(paz_correct(), "paz.pdf")
    fuel.pop("source", None)
    fuel["date"] = date.fromisoformat(fuel["date"])
    f = Fillup(**{k: v for k, v in fuel.items() if k != "notes"}, notes=fuel["notes"])
    assert f.litres == 42.532

    visit = _visit_from_json(ocr.service_record(garage_correct(), "garage.pdf"))
    assert visit.total == 708.0
    assert visit.odometer == 143823


# ── the seam ─────────────────────────────────────────────────────────────────

def test_read_document_refuses_a_text_layer_pdf():
    """A PDF the normal parsers can read should not be sent to the model."""
    with pytest.raises(ValueError, match="שכבת טקסט"):
        ocr.read_document(ROOT / "data" / "pdfs" / "טיפולים_,מקור.pdf", "service")


def test_read_document_uses_the_injected_extractor():
    seen = {}

    def fake(image, media_type, schema):
        seen["bytes"] = len(image)
        seen["schema"] = schema.__name__
        return paz_correct()

    result, checks = ocr.read_document(
        ROOT / "data" / "fuel" / "paz_2026-07-24.pdf", "fuel", extractor=fake
    )
    assert seen["schema"] == "FuelReceipt"
    assert seen["bytes"] > 1000              # a real page image was passed
    assert result.litres == 42.532
    assert ocr.passed(checks)
