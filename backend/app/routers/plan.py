from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import costs
from ..models import Shot
from ..services.planning import prompts
from ..services.planning.shotplan import build_plan, rederive_state, validate
from ..store import save_project
from .common import get, gate

router = APIRouter(prefix="/api/projects/{pid}/plan", tags=["plan"])


class PlanEdit(BaseModel):
    shots: list[Shot]


@router.post("/generate")
def generate(pid: str):
    p = get(pid)
    gate(bool(p.hubs), "upload at least one render first")
    gate(bool(p.intake.location), "complete the intake first")
    p.plan = build_plan(p)
    p.budget = costs.estimate(p)
    p.budget.confirmed = False
    p.stage = "plan"
    save_project(p)
    return p.plan


@router.put("")
def edit(pid: str, body: PlanEdit):
    p = get(pid)
    for s in body.shots:
        try:
            hub = p.hub(s.source_hub_id)
        except KeyError:
            raise HTTPException(400, f"shot {s.n}: unknown source render")
        if hub.cls != s.cls:
            raise HTTPException(400, f"shot {s.n}: a {s.cls} shot needs a {s.cls} render (Law 1)")
    before = {s.n: (s.cls, s.source_hub_id) for s in p.plan.shots}
    p.plan.shots = sorted(body.shots, key=lambda s: s.n)
    for i, s in enumerate(p.plan.shots):
        s.n = i + 1
    p.plan.approved = False
    # A still or clip is keyed only by shot number. Renumbering or repointing a
    # shot would otherwise leave an interior still animated as the exterior it
    # now claims to be, and the Law 3 gate only checks that *some* approved
    # still carries the number. Retire anything whose shot changed underneath it.
    for sh in p.plan.shots:
        if sh.rederive_state or sh.state.season != sh.season or sh.state.time != sh.time:
            rederive_state(sh, p)
        sh.rederive_state = False
    now = {s.n: (s.cls, s.source_hub_id) for s in p.plan.shots}
    stale = {n for n, v in before.items() if now.get(n) != v} | (set(before) - set(now))
    retired = 0
    for item in list(p.stills) + list(p.clips):
        if item.shot_n in stale and item.status in ("pending", "approved"):
            item.status = "rejected"
            item.note = (item.note + " | retired: its shot changed in the plan").strip(" |")
            retired += 1
    p.plan.warnings = validate(p.plan, p, reference_driven=p.plan.reference_driven)
    p.intake.length_shots = len(p.plan.shots)
    p.budget = costs.estimate(p)
    # the cost basis moved, so the old confirmation cannot stand (Part 1.4)
    p.budget.confirmed = False
    p.sequence.order = [i for i in p.sequence.order
                        if any(c.id == i and c.status == "approved" for c in p.clips)]
    save_project(p)
    if retired:
        p.plan.warnings.append(f"{retired} still(s)/clip(s) were retired because their shot changed; "
                               f"regenerate them, and confirm the budget again.")
    return p.plan


@router.post("/approve")
def approve(pid: str):
    p = get(pid)
    gate(bool(p.plan.shots), "generate a plan first")
    p.plan.approved = True
    p.record_approval("shot_plan", {"shots": len(p.plan.shots)})
    p.stage = "hero"
    save_project(p)
    return p.plan


@router.get("/prompts/{n}")
def preview_prompts(pid: str, n: int):
    p = get(pid)
    try:
        s = p.shot(n)
    except KeyError:
        raise HTTPException(404, "no such shot")
    hub = p.hub(s.source_hub_id)
    return {"still": prompts.still_prompt(p, s, hub), "motion": prompts.motion_prompt(p, s),
            "negative": prompts.negative_prompt(s.cls)}
