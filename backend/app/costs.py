"""Budget gate and running ledger (Parts 1.4 and 13 of the spec)."""
from __future__ import annotations

from . import config
from . import settings as S
from .models import Budget, LedgerEntry, Project


def _clip_units(p: Project, n_shots: int) -> float:
    """Clip cost in 5-second units.

    A provider that only sells discrete lengths bills a 8-second shot as a
    10-second clip, i.e. two units. Pricing every shot as one unit understated
    a reference-driven film by up to double.
    """
    durations = [s.duration for s in p.plan.shots] or []
    if not durations:
        return float(n_shots)
    units = 0.0
    for d in durations[:n_shots]:
        units += max(1.0, round(max(1.0, float(d)) / 5.0 + 0.4999))
    units += max(0, n_shots - len(durations)) * 1.0
    return units


def estimate(p: Project) -> Budget:
    classes = {h.cls for h in p.hubs} or {"exterior"}
    n_shots = max(1, p.intake.length_shots)
    hero_images = 2 * len(classes)
    clip_units = _clip_units(p, n_shots)
    b = Budget(
        hero_images=hero_images,
        stills=n_shots,
        clips=n_shots,
        image_cost=S.load().effective_image_cost(),
        video_cost=S.load().effective_video_cost(),
    )
    base = (hero_images + n_shots) * b.image_cost + clip_units * b.video_cost
    b.reserve = round(base * config.RESERVE_FRACTION, 2)
    b.total = round(base + b.reserve, 2)
    b.confirmed = p.budget.confirmed
    return b


def charge(p: Project, kind: str, cost: float, note: str = "", units: int = 1) -> None:
    p.ledger.append(LedgerEntry(kind=kind, units=units, cost=round(cost, 4), note=note))


def summary(p: Project) -> dict:
    by_kind: dict[str, float] = {}
    for e in p.ledger:
        by_kind[e.kind] = round(by_kind.get(e.kind, 0.0) + e.cost, 4)
    return {
        "spent": p.spend(),
        "budget_total": p.budget.total,
        "remaining": round(p.budget.total - p.spend(), 2) if p.budget.total else None,
        "by_kind": by_kind,
        "entries": len(p.ledger),
    }
