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


def _warnings(p, ordered):
    w = []
    shots = {s.n: s for s in p.plan.shots}
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
    clips = _approved(p)
    if not clips:
        raise HTTPException(409, "no approved clips yet")
    shots = {s.n: s for s in p.plan.shots}
    ordered = sorted(clips, key=lambda c: (shots[c.shot_n].chapter, shots[c.shot_n].n))
    p.sequence.suggested_order = [c.id for c in ordered]
    if not p.sequence.order:
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
        raise HTTPException(400, "order must contain every approved clip exactly once")
    p.sequence.order = body.order
    by_id = {c.id: c for c in p.clips}
    p.sequence.warnings = _warnings(p, [by_id[i] for i in body.order])
    save_project(p)
    return _preview(p)


@router.get("/preview")
def preview(pid: str):
    return _preview(get(pid))


def _preview(p):
    by_id = {c.id: c for c in p.clips}
    ordered = [by_id[i] for i in p.sequence.order if i in by_id]
    shots = {s.n: s for s in p.plan.shots}
    return {
        "order": p.sequence.order, "suggested_order": p.sequence.suggested_order, "rationale": p.sequence.rationale,
        "warnings": p.sequence.warnings, "total_duration_s": sum(c.duration for c in ordered),
        "brightness_strip": [c.mean_brightness for c in ordered],
        "items": [{"id": c.id, "shot_n": c.shot_n, "cls": c.cls, "season": shots[c.shot_n].season, "time": shots[c.shot_n].time,
                   "scale": shots[c.shot_n].scale, "duration": c.duration, "thumb": c.thumb, "chapter": shots[c.shot_n].chapter}
                  for c in ordered],
    }
