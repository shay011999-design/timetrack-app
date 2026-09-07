"""Map the Hebrew wording used by garages and importers onto wear systems.

The source documents are inconsistent — Eldan writes "מע' בלמים", the garage
invoice just writes "פילטר שמן" — so matching is on substrings, most specific
bucket first.
"""

from __future__ import annotations

import re

from .models import (
    SYS_BRAKES,
    SYS_ENGINE,
    SYS_FLUIDS,
    SYS_GENERAL,
    SYS_TIMING,
    SYS_TIRES,
)

# Ordered: the first bucket with a matching keyword wins.
_RULES: list[tuple[str, tuple[str, ...]]] = [
    (SYS_TIMING, ("רצועת תזמון", "שרשרת תזמון", "תזמון")),
    (SYS_BRAKES, ("בלמים", "דיסקיות", "דסקיות", "צלחות", "רפידות", "בלם יד")),
    (SYS_TIRES, ("צמיג", "גלגל", "איזון", "כיוון פרונט")),
    # Filters before fluids: "פילטר שמן" is an engine part, not a fluid.
    (SYS_ENGINE, ("מסנן", "פילטר", "מצתים")),
    (SYS_FLUIDS, ("שמן", "פלשינג", "נוזל", "מצנן", "אנטיפריז")),
    (SYS_ENGINE, ("מנוע", "רעשים", "רעידות")),
]

# A periodic service is announced by a round-number label like "טיפולים 120,000".
_PLAN_RE = re.compile(r"(\d{1,3}(?:,\d{3})+|\d{4,6})")


def system_for(*texts: str | None) -> str:
    """Best-guess wear system for a job or part, from any of the given strings."""
    blob = " ".join(t for t in texts if t)
    for system, keywords in _RULES:
        if any(k in blob for k in keywords):
            return system
    return SYS_GENERAL


def plan_label(text: str | None) -> str | None:
    """Extract the scheduled-service milestone, e.g. '120,000', if present."""
    if not text:
        return None
    m = _PLAN_RE.search(text)
    if not m:
        return None
    value = int(m.group(1).replace(",", ""))
    # Milestones are multiples of 15,000 km on this service plan; anything else
    # (an invoice number, a part code) is not a plan label.
    if value < 5_000 or value % 5_000 != 0:
        return None
    return f"{value:,}"
