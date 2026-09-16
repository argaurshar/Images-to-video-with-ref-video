from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, costs, jobs
from ..models import Hero, Still
from ..services.audit import audit_still
from ..services.imageops import make_thumb
from ..services.planning import prompts
from ..services.providers import ProviderError, get_provider
from ..store import abs_path, mutate, new_id, project_dir, rel, save_project
from .common import get, gate

router = APIRouter(prefix="/api/projects/{pid}", tags=["stills"])


class Note(BaseModel):
    note: str = ""


class Regen(BaseModel):
    shot_ns: list[int]
    corrections: dict[int, str] = {}


def _gen_still(p, shot, hub, out_dir, corrections: str = "", attempt: int = 1) -> Still:
    prov = get_provider()
    prompt = prompts.still_prompt(p, shot, hub, corrections)
    neg = prompts.negative_prompt(shot.cls)
    sid = new_id("stl")
    out = out_dir / f"{sid}.jpg"
    try:
        res = prov.generate_still(abs_path(hub.path), prompt, neg, p.intake.aspect, out)
    except ProviderError as e:
        raise HTTPException(502, f"provider error: {e}")
    make_thumb(out, project_dir(p.id) / "thumbs" / f"{sid}.jpg")
    st = Still(id=sid, shot_n=shot.n or None, cls=shot.cls, source_hub_id=hub.id, attempt=attempt, path=rel(out),
               thumb=rel(project_dir(p.id) / "thumbs" / f"{sid}.jpg"), prompt=prompt, negative=neg,
               provider=prov.name, provider_id=res.provider_id, cost=res.cost)
    st.audit = audit_still(abs_path(hub.path), out, shot.cls)
    return st


def _charge_still(p, st: Still, label: str = "still") -> None:
    costs.charge(p, label, st.cost, f"shot {st.shot_n if st.shot_n else 'hero'} attempt {st.attempt} ({st.provider})")


def _stills_batch(pid: str, job_id: str | None = None) -> list[Still]:
    """Generate every still that does not have one yet.

    Each finished still is committed on its own. A batch that dies partway
    through has already saved and accounted for everything it paid for, and
    running it again resumes rather than paying twice.
    """
    p = get(pid)
    todo = [s for s in p.plan.shots
            if not any(x.shot_n == s.n and x.status in ("pending", "approved") for x in p.stills)]
    if job_id:
        jobs.progress(job_id, done=0, current=f"{len(todo)} still(s) to generate")
    made: list[Still] = []
    consecutive_failures = 0
    for i, shot in enumerate(todo):
        if job_id:
            jobs.progress(job_id, done=i, current=f"shot {shot.n} ({shot.cls})")
        snap = get(pid)
        hub = snap.hub(shot.source_hub_id)
        attempt = 1 + sum(1 for x in snap.stills if x.shot_n == shot.n)
        try:
            st = _gen_still(snap, shot, hub, project_dir(pid) / "stills", attempt=attempt)
        except HTTPException as e:
            consecutive_failures += 1
            if job_id:
                jobs.progress(job_id, error=f"shot {shot.n}: {e.detail}")
            # a provider that fails twice in a row is down, not unlucky
            if consecutive_failures >= 2:
                if job_id:
                    jobs.progress(job_id, error="stopped after two consecutive provider failures")
                break
            continue
        consecutive_failures = 0
        with mutate(pid) as cur:
            cur.stills.append(st)
            _charge_still(cur, st)
            cur.stage = "board"
        made.append(st)
        if job_id:
            jobs.progress(job_id, done=i + 1)
    return made


# ---------------------------------------------------------------- heroes
@router.post("/heroes/generate")
def heroes_generate(pid: str):
    p = get(pid)
    gate(p.plan.approved, "approve the shot plan first")
    gate(p.budget.confirmed, "confirm the budget first")
    classes = sorted({s.cls for s in p.plan.shots})
    out_dir = project_dir(pid) / "heroes"
    made = []
    for cls in classes:
        if any(h.cls == cls and h.chosen for h in p.heroes):
            continue
        shot = prompts.hero_shot(p, cls)
        hub = p.hub(shot.source_hub_id)
        for v in (1, 2):
            st = _gen_still(p, shot, hub, out_dir,
                            corrections="" if v == 1 else "second variant: slightly cooler grade, mist thinner", attempt=v)
            h = Hero(**st.model_dump(), variant=v)
            h.shot_n = None
            with mutate(pid) as cur:
                cur.heroes.append(h)
                _charge_still(cur, h, "hero")
                cur.stage = "hero"
            made.append(h)
    p = get(pid)
    return {"heroes": p.heroes, "ledger": costs.summary(p)}


@router.post("/heroes/{hid}/choose")
def hero_choose(pid: str, hid: str):
    p = get(pid)
    target = next((h for h in p.heroes if h.id == hid), None)
    if not target:
        raise HTTPException(404, "hero not found")
    for h in p.heroes:
        if h.cls == target.cls:
            h.chosen = h.id == hid
            h.status = "approved" if h.chosen else "rejected"
    p.record_approval("hero", {"cls": target.cls, "id": hid, "audit": target.audit.rating})
    classes = {s.cls for s in p.plan.shots}
    if all(any(h.cls == c and h.chosen for h in p.heroes) for c in classes):
        p.stage = "board"
    save_project(p)
    return {"heroes": p.heroes, "stage": p.stage}


# ---------------------------------------------------------------- board
@router.post("/stills/generate")
def stills_generate(pid: str, background: bool = False):
    p = get(pid)
    classes = {s.cls for s in p.plan.shots}
    gate(all(any(h.cls == c and h.chosen for h in p.heroes) for c in classes), "choose a hero for every class first")
    gate(not jobs.active_for_project(pid), "a generation job is already running for this project")
    todo = [s for s in p.plan.shots
            if not any(x.shot_n == s.n and x.status in ("pending", "approved") for x in p.stills)]
    if background:
        jobs.prune()
        job_id = new_id("job")
        jobs.create(job_id, pid, "stills", len(todo))
        jobs.run_in_thread(job_id, lambda: _stills_batch(pid, job_id))
        return {"job": jobs.get(job_id).as_dict()}
    made = _stills_batch(pid)
    p = get(pid)
    return {"made": made, "stills": p.stills, "ledger": costs.summary(p)}


@router.post("/stills/{sid}/approve")
def still_approve(pid: str, sid: str):
    p = get(pid)
    st = next((s for s in p.stills if s.id == sid), None)
    if not st:
        raise HTTPException(404, "still not found")
    for other in p.stills:
        if other.shot_n == st.shot_n and other.id != sid and other.status == "approved":
            other.status = "rejected"
    st.status = "approved"
    p.record_approval("still", {"id": sid, "shot": st.shot_n, "audit": st.audit.rating})
    save_project(p)
    return st


@router.post("/stills/approve_all")
def stills_approve_all(pid: str):
    p = get(pid)
    n = 0
    for st in p.stills:
        if st.status == "pending":
            st.status = "approved"
            n += 1
    p.record_approval("stills_all", {"count": n})
    save_project(p)
    return {"approved": n, "stills": p.stills}


@router.post("/stills/{sid}/reject")
def still_reject(pid: str, sid: str, body: Note):
    p = get(pid)
    st = next((s for s in p.stills if s.id == sid), None)
    if not st:
        raise HTTPException(404, "still not found")
    st.status = "rejected"
    st.note = body.note
    save_project(p)
    return st


@router.post("/stills/regenerate")
def stills_regenerate(pid: str, body: Regen):
    """Regenerate only the named shots. Corrections become explicit exclusions."""
    p = get(pid)
    out_dir = project_dir(pid) / "stills"
    made = []
    for n in body.shot_ns:
        try:
            shot = p.shot(n)
        except KeyError:
            raise HTTPException(404, f"no shot {n}")
        prior = [s for s in p.stills if s.shot_n == n]
        for s in prior:
            if s.status == "pending":
                s.status = "rejected"
        notes = "; ".join(x.note for x in prior if x.note)
        corr = body.corrections.get(n) or body.corrections.get(str(n)) or notes  # type: ignore[call-overload]
        hub = p.hub(shot.source_hub_id)
        st = _gen_still(p, shot, hub, out_dir, corrections=corr, attempt=len(prior) + 1)
        with mutate(pid) as cur:
            for x in cur.stills:
                if x.shot_n == n and x.status == "pending":
                    x.status = "rejected"
            cur.stills.append(st)
            _charge_still(cur, st)
        made.append(st)
    p = get(pid)
    return {"made": made, "stills": p.stills, "ledger": costs.summary(p)}
