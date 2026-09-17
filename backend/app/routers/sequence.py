from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..store import save_project
from .common import get

router = APIRouter(prefix="/api/projects/{pid}/sequence", tags=["sequence"])


class Order(BaseModel):
    order: list[str]


def _approved(p):
    return [c for c in p.clips if c.status == "approved"]


def _reconcile(p) -> list[str]:
    """Keep sequence.order honest about the approved clips.

    Approving a regenerated clip demotes its predecessor, and cutting a clip
    leaves its id behind. Without reconciling, the page shows and counts clips
    the render will drop, and the render silently ships a film missing a clip
    the director approved.
    """
    live = {c.id for c in _approved(p)}
    order = [i for i in p.sequence.order if i in live]
    missing = [i for i in (p.sequence.suggested_order or []) if i in live and i not in order]
    order += missing
    order += [c.id for c in _approved(p) if c.id not in order]
    changed = order != p.sequence.order
    p.sequence.order = order
    return order if changed else order


def _warnings(p, ordered):
    w = []
    shots = {s.n: s for s in p.plan.shots}
    orphans = sorted({x.shot_n for x in ordered if x.shot_n not in shots})
    if orphans:
        w.append(f"Clips for shot(s) {orphans} have no matching shot in the current plan; "
                 f"the plan was regenerated or renumbered after they were made.")
    ordered = [x for x in ordered if x.shot_n in shots]
    for i in range(2, len(ordered)):
        a, b, c = (shots[x.shot_n] for x in ordered[i - 2: i + 1])
        if a.scale == b.scale == c.scale:
            w.append(f"Three {a.scale} shots in a row at positions {i-1}-{i+1}.")
    for i in range(1, len(ordered)):
        a, b = shots[ordered[i - 1].shot_n], shots[ordered[i].shot_n]
        if a.chapter == b.chapter and a.state.weather != b.state.weather and not (a.heavy or b.heavy):
            w.append(f"Continuity: positions {i} and {i+1} share a chapter but not a weather state ({a.state.weather} / {b.state.weather}).")
        if a.chapter == b.chapter and a.cls != b.cls and a.state.time != b.state.time:
            w.append(f"Continuity: positions {i} and {i+1} cross inside/outside with different times of day.")
    return w


@router.get("/suggest")
def suggest(pid: str):
    p = get(pid)
    _reconcile(p)
    clips = _approved(p)
    if not clips:
        raise HTTPException(409, "no approved clips yet")
    shots = {s.n: s for s in p.plan.shots}
    known = {s.n for s in p.plan.shots}
    ordered = sorted([c for c in clips if c.shot_n in known],
                     key=lambda c: (shots[c.shot_n].chapter, shots[c.shot_n].n))
    p.sequence.suggested_order = [c.id for c in ordered]
    # Always re-suggest: a clip approved after the first suggest was otherwise
    # invisible here and silently absent from the film.
    p.sequence.order = list(p.sequence.suggested_order)
    p.sequence.rationale = p.plan.rationale or "Plan order: calendar seasons, dawn to night, scale pyramid, chapter closers, human beats at the edges."
    p.sequence.warnings = _warnings(p, ordered)
    p.stage = "sequence"
    save_project(p)
    return _preview(p)


@router.put("")
def set_order(pid: str, body: Order):
    p = get(pid)
    ids = {c.id for c in _approved(p)}
    if set(body.order) != ids:
        raise HTTPException(400, f"order must contain every approved clip exactly once; "
                                 f"{len(ids)} approved, {len(set(body.order))} given")
    p.sequence.order = body.order
    by_id = {c.id: c for c in p.clips}
    p.sequence.warnings = _warnings(p, [by_id[i] for i in body.order])
    save_project(p)
    return _preview(p)


@router.get("/preview")
def preview(pid: str):
    p = get(pid)
    _reconcile(p)
    save_project(p)
    return _preview(p)


def _preview(p):
    by_id = {c.id: c for c in p.clips}
    # only approved clips with a live shot: exactly what render will use
    approved = {c.id for c in p.clips if c.status == "approved"}
    shots = {s.n: s for s in p.plan.shots}
    ordered = [by_id[i] for i in p.sequence.order
               if i in by_id and i in approved and by_id[i].shot_n in shots]
    return {
        "order": p.sequence.order, "suggested_order": p.sequence.suggested_order, "rationale": p.sequence.rationale,
        "warnings": p.sequence.warnings, "total_duration_s": sum(c.duration for c in ordered),
        "brightness_strip": [c.mean_brightness for c in ordered],
        "items": [{"id": c.id, "shot_n": c.shot_n, "cls": c.cls, "season": shots[c.shot_n].season, "time": shots[c.shot_n].time,
                   "scale": shots[c.shot_n].scale, "duration": c.duration, "thumb": c.thumb, "chapter": shots[c.shot_n].chapter}
                  for c in ordered],
    }
