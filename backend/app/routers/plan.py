from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import costs
from ..models import Shot
from ..services.planning import prompts
from ..services.planning.shotplan import build_plan, validate
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
    p.plan.shots = sorted(body.shots, key=lambda s: s.n)
    for i, s in enumerate(p.plan.shots):
        s.n = i + 1
    p.plan.approved = False
    p.plan.warnings = validate(p.plan, p, reference_driven=p.plan.reference_driven)
    p.intake.length_shots = len(p.plan.shots)
    p.budget = costs.estimate(p)
    save_project(p)
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
