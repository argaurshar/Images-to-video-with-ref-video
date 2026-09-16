"""Budget gate and running ledger (Parts 1.4 and 13 of the spec)."""
from __future__ import annotations

from . import config
from .models import Budget, LedgerEntry, Project


def estimate(p: Project) -> Budget:
    classes = {h.cls for h in p.hubs} or {"exterior"}
    n_shots = max(1, p.intake.length_shots)
    hero_images = 2 * len(classes)
    b = Budget(
        hero_images=hero_images,
        stills=n_shots,
        clips=n_shots,
        image_cost=config.IMAGE_COST,
        video_cost=config.VIDEO_COST,
    )
    base = (hero_images + n_shots) * config.IMAGE_COST + n_shots * config.VIDEO_COST
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
