"""CLI: read the source documents, analyse them, emit the dashboard dataset.

    python -m vehicle_maintenance.build --out ../public/vehicle-data.json
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from datetime import date
from pathlib import Path

from .analyze import Analysis, analyze
from .load import load

HERE = Path(__file__).resolve().parent.parent


def to_json(analysis: Analysis, warnings: list[str]) -> dict:
    return {
        "generated_at": date.today().isoformat(),
        "vehicle": analysis.vehicle.to_json(),
        "plan": {"km": analysis.plan_km, "months": analysis.plan_months},
        "stats": analysis.stats,
        "forecast": {
            **{
                k: (v.isoformat() if isinstance(v, date) else v)
                for k, v in asdict(analysis.forecast).items()
            }
        },
        "alerts": [asdict(a) for a in analysis.alerts],
        "wear": analysis.wear,
        "costs": analysis.costs,
        "intervals": [
            {
                "from_date": i.from_date.isoformat(),
                "to_date": i.to_date.isoformat(),
                "from_odometer": i.from_odometer,
                "to_odometer": i.to_odometer,
                "km": i.km,
                "days": i.days,
                "plan_label": i.plan_label,
                "over_plan": i.km > analysis.plan_km,
            }
            for i in analysis.intervals
        ],
        "visits": [v.to_json() for v in analysis.visits],
        "warnings": warnings,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build the vehicle maintenance dataset.")
    ap.add_argument("--pdfs", default=str(HERE / "data" / "pdfs"))
    ap.add_argument("--manual", default=str(HERE / "data" / "manual"))
    ap.add_argument("--out", default=str(HERE.parent / "public" / "vehicle-data.json"))
    ap.add_argument("--plan-km", type=int, default=15_000)
    ap.add_argument("--plan-months", type=int, default=12)
    ap.add_argument("--today", help="override today's date (YYYY-MM-DD), for testing")
    args = ap.parse_args(argv)

    result = load(args.pdfs, args.manual)
    today = date.fromisoformat(args.today) if args.today else date.today()
    analysis = analyze(
        result.vehicle, result.visits,
        today=today, plan_km=args.plan_km, plan_months=args.plan_months,
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(to_json(analysis, result.warnings), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"{len(result.visits)} ביקורים -> {out}")
    for w in result.warnings:
        print(f"  אזהרה: {w}")
    for a in analysis.alerts:
        print(f"  [{a.level}] {a.title}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
