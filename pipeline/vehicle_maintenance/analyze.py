"""Turn a visit history into the numbers a car owner actually asks about.

Four questions drive everything here:
  * how far apart are the services, and is that drifting?
  * how fast is the car accumulating kilometres now, as opposed to on average?
  * when is the next service due, and is anything already overdue?
  * what does upkeep cost per year and per kilometre?
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from statistics import median
from typing import Any

from .models import INSPECTION, SERVICE, Vehicle, Visit

# Wording used for the annual roadworthiness test, wherever it turns up.
_INSPECTION_MARKERS = ("מבחן רישוי", "טסט")

# The manufacturer's plan for this car: a periodic service every 15,000 km or
# every 12 months, whichever comes first.
DEFAULT_PLAN_KM = 15_000
DEFAULT_PLAN_MONTHS = 12

# Rules of thumb for the long-interval items, used to flag what is coming up.
# ``km`` / ``months`` are the replacement intervals; whichever lands first wins.
WEAR_RULES: dict[str, dict[str, Any]] = {
    "timing": {"label": "רצועת תזמון", "km": 120_000, "months": 84},
    "brakes": {"label": "דיסקיות ורפידות", "km": 70_000, "months": 72},
    "tires":  {"label": "צמיגים", "km": 60_000, "months": 72},
}

# Recent behaviour is judged on the intervals closing inside this trailing
# window. A count-based window would blend regimes: this car ran ~20,000 km/yr
# as a company lease and ~9,000 km/yr since, and averaging across that break
# produces a usage rate the car has never actually had.
RECENT_WINDOW_DAYS = 730
RECENT_WINDOW_MIN = 2


@dataclass
class Reading:
    """One dated odometer observation, from any source.

    Services are sparse — a year apart once the car left the lease — so a rate
    derived from them alone goes stale between them. A fuel receipt carries an
    odometer too, and a recent one anchors the estimate far better than
    extrapolating twelve months from the last garage visit.
    """

    date: date
    odometer: int
    source: str = "service"


@dataclass
class Interval:
    """The gap between one scheduled service and the next."""

    from_date: date
    to_date: date
    from_odometer: int
    to_odometer: int
    plan_label: str | None = None

    @property
    def km(self) -> int:
        return self.to_odometer - self.from_odometer

    @property
    def days(self) -> int:
        return (self.to_date - self.from_date).days

    @property
    def km_per_year(self) -> float | None:
        return self.km / (self.days / 365.25) if self.days > 0 else None


@dataclass
class Forecast:
    due_km: int | None = None
    due_date: date | None = None
    km_remaining: int | None = None
    days_remaining: int | None = None
    basis_km: float | None = None          # interval used, in km
    basis_km_per_year: float | None = None  # usage rate used
    estimated_odometer_today: int | None = None


@dataclass
class Alert:
    level: str      # "due" | "soon" | "info"
    title: str
    detail: str


@dataclass
class Analysis:
    vehicle: Vehicle
    visits: list[Visit]
    services: list[Visit]
    intervals: list[Interval]
    plan_km: int
    plan_months: int
    forecast: Forecast
    alerts: list[Alert] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)
    wear: list[dict[str, Any]] = field(default_factory=list)
    costs: dict[str, Any] = field(default_factory=dict)


def _had_inspection(visit: Visit) -> bool:
    """True if this visit included a roadworthiness test.

    A test booked alongside a service merges into that service, so the visit
    kind alone under-counts them; the job text is the reliable signal.
    """
    if visit.kind == INSPECTION:
        return True
    return any(
        m in j.description for j in visit.jobs for m in _INSPECTION_MARKERS
    )


def _services(visits: list[Visit]) -> list[Visit]:
    """Scheduled services with a usable odometer, oldest first."""
    return sorted(
        (v for v in visits if v.kind == SERVICE and v.odometer),
        key=lambda v: v.odometer,
    )


def _intervals(services: list[Visit]) -> list[Interval]:
    return [
        Interval(
            from_date=a.date,
            to_date=b.date,
            from_odometer=a.odometer,
            to_odometer=b.odometer,
            plan_label=b.plan_label,
        )
        for a, b in zip(services, services[1:])
        if b.odometer > a.odometer
    ]


def _readings(visits: list[Visit], extra: list[Reading] | None = None) -> list[Reading]:
    """Every odometer observation we hold, oldest first, de-duplicated."""
    rows = [
        Reading(v.date, v.odometer, "service" if v.kind == SERVICE else v.kind)
        for v in visits if v.odometer
    ]
    rows += list(extra or [])
    seen: set[tuple[date, int]] = set()
    out: list[Reading] = []
    for r in sorted(rows, key=lambda r: (r.date, r.odometer)):
        if (r.date, r.odometer) in seen:
            continue
        seen.add((r.date, r.odometer))
        out.append(r)
    return out


def _usage_from_readings(readings: list[Reading], today: date) -> float | None:
    """Kilometres per year, measured across the trailing window's endpoints.

    Endpoints rather than a sum of pairs: the leasing report repeats the last
    known odometer on follow-up visits, which would contribute runs of zero-km
    steps and drag the rate down.
    """
    if len(readings) < 2:
        return None
    cutoff = today - timedelta(days=RECENT_WINDOW_DAYS)
    window = [r for r in readings if r.date >= cutoff]
    if len(window) < 2:
        window = readings[-2:]
    first, last = window[0], window[-1]
    days = (last.date - first.date).days
    if days <= 0 or last.odometer <= first.odometer:
        return None
    return (last.odometer - first.odometer) / (days / 365.25)


def _estimated_odometer(readings: list[Reading], rate: float | None, today: date) -> int | None:
    """Today's odometer, extrapolated from the most recent reading of any kind."""
    if not readings:
        return None
    last = readings[-1]
    if rate is None:
        return last.odometer
    elapsed = (today - last.date).days
    return round(last.odometer + rate * elapsed / 365.25)


def _recent_intervals(intervals: list[Interval], today: date) -> list[Interval]:
    """Intervals that describe how the car is driven now, not historically."""
    if not intervals:
        return []
    cutoff = today - timedelta(days=RECENT_WINDOW_DAYS)
    recent = [i for i in intervals if i.to_date >= cutoff]
    if len(recent) < RECENT_WINDOW_MIN:
        recent = intervals[-RECENT_WINDOW_MIN:]
    return recent


def _usage_km_per_year(intervals: list[Interval], today: date) -> float | None:
    recent = [i for i in _recent_intervals(intervals, today) if i.km_per_year]
    if not recent:
        return None
    total_km = sum(i.km for i in recent)
    total_days = sum(i.days for i in recent)
    return total_km / (total_days / 365.25) if total_days else None


def _last_touch(visits: list[Visit], system: str) -> Visit | None:
    touched = [v for v in visits if system in v.systems()]
    return max(touched, key=lambda v: v.date) if touched else None


def _wear_status(
    visits: list[Visit], odo_today: int | None, today: date
) -> list[dict[str, Any]]:
    rows = []
    for system, rule in WEAR_RULES.items():
        last = _last_touch(visits, system)
        row: dict[str, Any] = {
            "system": system,
            "label": rule["label"],
            "interval_km": rule["km"],
            "interval_months": rule["months"],
            "last_date": last.date.isoformat() if last else None,
            "last_odometer": last.odometer if last else None,
            "last_description": (
                "; ".join(
                    j.description for j in last.jobs if j.system == system
                ) or None
            ) if last else None,
        }
        if last and last.odometer and odo_today:
            row["km_since"] = odo_today - last.odometer
            row["km_to_go"] = rule["km"] - row["km_since"]
        if last:
            row["months_since"] = round((today - last.date).days / 30.44)
            row["months_to_go"] = rule["months"] - row["months_since"]
        rows.append(row)
    return rows


def _costs(visits: list[Visit], intervals: list[Interval]) -> dict[str, Any]:
    priced = [v for v in visits if v.total]
    if not priced:
        return {"documented_visits": 0}

    total = sum(v.total for v in priced)
    by_system: dict[str, float] = {}
    for v in priced:
        for p in v.parts:
            if p.total:
                by_system[p.system] = by_system.get(p.system, 0.0) + p.total
        if v.labor_total:
            by_system["labor"] = by_system.get("labor", 0.0) + v.labor_total

    span_km = None
    first, last = priced[0], priced[-1]
    if first.odometer and last.odometer and last.odometer > first.odometer:
        span_km = last.odometer - first.odometer
    spend_in_span = sum(v.total for v in priced[1:])

    return {
        "documented_visits": len(priced),
        "total": round(total, 2),
        "average_per_visit": round(total / len(priced), 2),
        "by_system": {k: round(v, 2) for k, v in sorted(by_system.items())},
        "span_km": span_km,
        # Cost per km is computed across the priced visits only, so it reflects
        # what upkeep costs now — not the leased years, which have no invoices.
        "spend_in_span": round(spend_in_span, 2),
        "per_km": round(spend_in_span / span_km, 3) if span_km else None,
        "covers_from": first.date.isoformat(),
        "covers_to": last.date.isoformat(),
        "note": "מבוסס רק על ביקורים עם חשבונית. שנות הליסינג ללא תמחור.",
    }


def _forecast(
    services: list[Visit],
    intervals: list[Interval],
    plan_km: int,
    plan_months: int,
    today: date,
    rate: float | None = None,
    odometer_today: int | None = None,
) -> Forecast:
    if not services:
        return Forecast()
    last = services[-1]
    if rate is None:
        rate = _usage_km_per_year(intervals, today)

    # Predict on the owner's own recent rhythm when it is tighter than the
    # manufacturer plan — that is what they will actually do next.
    recent_km = [i.km for i in _recent_intervals(intervals, today)]
    basis_km = min(plan_km, round(median(recent_km))) if recent_km else plan_km

    f = Forecast(
        due_km=last.odometer + basis_km if last.odometer else None,
        basis_km=basis_km,
        basis_km_per_year=round(rate) if rate else None,
    )

    by_time = last.date + timedelta(days=plan_months * 30.44)
    if rate and last.odometer:
        days_by_km = (basis_km / rate) * 365.25
        by_km = last.date + timedelta(days=days_by_km)
        f.due_date = min(by_km, by_time)
        f.estimated_odometer_today = (
            odometer_today
            if odometer_today is not None
            else round(last.odometer + rate * (today - last.date).days / 365.25)
        )
        f.km_remaining = f.due_km - f.estimated_odometer_today
    else:
        f.due_date = by_time
        f.estimated_odometer_today = odometer_today

    f.days_remaining = (f.due_date - today).days if f.due_date else None
    return f


def _alerts(
    services: list[Visit],
    intervals: list[Interval],
    forecast: Forecast,
    wear: list[dict[str, Any]],
    visits: list[Visit],
    plan_km: int,
    today: date,
    timeline: list[Reading] | None = None,
) -> list[Alert]:
    alerts: list[Alert] = []

    # A recent real reading makes "overdue" a fact rather than a projection,
    # and the alert should say which of the two it is.
    latest = timeline[-1] if timeline else None
    fresh = latest is not None and (today - latest.date).days <= 60
    basis = (
        f"מד האוץ נקרא {latest.odometer:,} ק\"מ ב-{latest.date:%d/%m/%Y}"
        if fresh else "לפי קצב הנסיעה הנוכחי"
    )

    if forecast.days_remaining is not None:
        if forecast.days_remaining <= 0:
            over_km = (
                f", ועברת אותו בכ-{abs(forecast.km_remaining):,} ק\"מ"
                if forecast.km_remaining and forecast.km_remaining < 0 else ""
            )
            alerts.append(Alert(
                "due", "הטיפול הבא בפיגור",
                f"{basis}. הטיפול היה אמור להתבצע ב-{forecast.due_km:,} ק\"מ"
                f" (לפני {abs(forecast.days_remaining)} ימים){over_km}.",
            ))
        elif forecast.days_remaining <= 60:
            alerts.append(Alert(
                "soon", "הטיפול הבא מתקרב",
                f"נותרו כ-{forecast.days_remaining} ימים"
                + (f" או כ-{forecast.km_remaining:,} ק\"מ" if forecast.km_remaining else "")
                + ".",
            ))

    for row in wear:
        if row.get("km_to_go") is not None and row["km_to_go"] <= 0:
            alerts.append(Alert(
                "due", f"{row['label']} — חריגה מהמרווח",
                f"עברו {row['km_since']:,} ק\"מ מאז הטיפול האחרון "
                f"({row['last_date']}), מול מרווח מומלץ של {row['interval_km']:,} ק\"מ.",
            ))
        elif row.get("km_to_go") is not None and row["km_to_go"] <= 10_000:
            alerts.append(Alert(
                "soon", f"{row['label']} — מתקרב למרווח",
                f"נותרו כ-{row['km_to_go']:,} ק\"מ למרווח המומלץ.",
            ))

    over = [i for i in intervals if i.km > plan_km]
    if over:
        worst = max(over, key=lambda i: i.km)
        alerts.append(Alert(
            "info", f"{len(over)} מרווחים חרגו מהתוכנית",
            f"החריגה הגדולה ביותר: {worst.km:,} ק\"מ בין "
            f"{worst.from_date:%m/%Y} ל-{worst.to_date:%m/%Y} "
            f"(תוכנית: {plan_km:,} ק\"מ).",
        ))

    last_inspection = max(
        (v for v in visits if _had_inspection(v)), key=lambda v: v.date, default=None
    )
    if last_inspection:
        months = (today - last_inspection.date).days / 30.44
        if months > 14:
            alerts.append(Alert(
                "info", "אין תיעוד של מבחן רישוי עדכני",
                f"המבחן האחרון שמתועד הוא מ-{last_inspection.date:%m/%Y}. "
                "ייתכן שבוצעו מבחנים שלא תועדו במסמכים שנטענו.",
            ))
    return alerts


def analyze(
    vehicle: Vehicle,
    visits: list[Visit],
    today: date | None = None,
    plan_km: int = DEFAULT_PLAN_KM,
    plan_months: int = DEFAULT_PLAN_MONTHS,
    readings: list[Reading] | None = None,
) -> Analysis:
    today = today or date.today()
    services = _services(visits)
    intervals = _intervals(services)

    # Services plus any other dated odometer observation (fuel receipts).
    timeline = _readings(visits, readings)
    rate = _usage_from_readings(timeline, today) or _usage_km_per_year(intervals, today)
    odo_today = _estimated_odometer(timeline, rate, today)

    forecast = _forecast(
        services, intervals, plan_km, plan_months, today,
        rate=rate, odometer_today=odo_today,
    )

    odo_today = forecast.estimated_odometer_today or vehicle.current_odometer
    wear = _wear_status(visits, odo_today, today)

    lifetime_rate = None
    if len(services) >= 2:
        first, last = services[0], services[-1]
        days = (last.date - first.date).days
        if days > 0:
            lifetime_rate = (last.odometer - first.odometer) / (days / 365.25)

    stats = {
        "first_record": min(v.date for v in visits).isoformat() if visits else None,
        "last_record": max(v.date for v in visits).isoformat() if visits else None,
        "total_visits": len(visits),
        "service_count": len(services),
        "repair_count": sum(1 for v in visits if v.kind == "repair"),
        "inspection_count": sum(1 for v in visits if _had_inspection(v)),
        "median_interval_km": round(median([i.km for i in intervals])) if intervals else None,
        "mean_interval_km": round(sum(i.km for i in intervals) / len(intervals)) if intervals else None,
        "median_interval_days": round(median([i.days for i in intervals])) if intervals else None,
        "recent_interval_km": round(median([i.km for i in _recent_intervals(intervals, today)])) if intervals else None,
        "km_per_year_recent": round(rate) if rate else None,
        "latest_reading_date": timeline[-1].date.isoformat() if timeline else None,
        "latest_reading_odometer": timeline[-1].odometer if timeline else None,
        "latest_reading_source": timeline[-1].source if timeline else None,
        "km_per_year_lifetime": round(lifetime_rate) if lifetime_rate else None,
        "adherence_pct": (
            round(100 * sum(1 for i in intervals if i.km <= plan_km) / len(intervals))
            if intervals else None
        ),
        "estimated_odometer_today": odo_today,
        "as_of": today.isoformat(),
    }

    return Analysis(
        vehicle=vehicle,
        visits=visits,
        services=services,
        intervals=intervals,
        plan_km=plan_km,
        plan_months=plan_months,
        forecast=forecast,
        alerts=_alerts(
            services, intervals, forecast, wear, visits, plan_km, today, timeline
        ),
        stats=stats,
        wear=wear,
        costs=_costs(visits, intervals),
    )
