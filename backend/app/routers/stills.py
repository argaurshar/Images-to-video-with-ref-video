from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, costs, jobs
from ..models import AuditReport, Hero, Still
from ..services.audit import audit_still
from ..services.imageops import make_thumb
from ..services.planning import prompts
from ..services.providers import ProviderError, get_provider
from ..store import abs_path, mutate, new_id, project_dir, project_lock, rel, save_project
from .common import get, gate

router = APIRouter(prefix="/api/projects/{pid}", tags=["stills"])


class Note(BaseModel):
    note: str = ""


class Regen(BaseModel):
    shot_ns: list[int]
    corrections: dict[int, str] = {}


def _gen_still(p, shot, hub, out_dir, corrections: str = "", attempt: int = 1) -> Still:
    try:
        prov = get_provider()          # constructing the provider can fail too
    except ProviderError as e:
        raise HTTPException(502, f"provider error: {e}")
    prompt = prompts.still_prompt(p, shot, hub, corrections)
    neg = prompts.negative_prompt(shot.cls)
    sid = new_id("stl")
    out = out_dir / f"{sid}.jpg"
    try:
        res = prov.generate_still(abs_path(hub.path), prompt, neg, p.intake.aspect, out)
    except ProviderError as e:
        raise HTTPException(502, f"provider error: {e}")
    try:
        make_thumb(out, project_dir(p.id) / "thumbs" / f"{sid}.jpg")
    except Exception:          # noqa: BLE001 - a thumbnail is cosmetic; the paid image is not
        pass
    st = Still(id=sid, shot_n=shot.n or None, cls=shot.cls, source_hub_id=hub.id, attempt=attempt, path=rel(out),
               thumb=rel(project_dir(p.id) / "thumbs" / f"{sid}.jpg"), prompt=prompt, negative=neg,
               provider=prov.name, provider_id=res.provider_id, cost=res.cost)
    try:
        st.audit = audit_still(abs_path(hub.path), out, shot.cls)
    except Exception as e:     # noqa: BLE001 - advisory; never drop a paid image over it
        st.audit = AuditReport(rating="not_run", notes=f"audit could not run: {e}")
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
    aborted = False
    for i, shot in enumerate(todo):
        if job_id:
            jobs.progress(job_id, done=i, current=f"shot {shot.n} ({shot.cls})")
        snap = get(pid)
        hub = snap.hub(shot.source_hub_id)
        attempt = 1 + sum(1 for x in snap.stills if x.shot_n == shot.n)
        try:
            st = _gen_still(snap, shot, hub, project_dir(pid) / "stills", attempt=attempt)
        except Exception as e:                       # noqa: BLE001 - reported on the job
            consecutive_failures += 1
            detail = getattr(e, "detail", None) or f"{type(e).__name__}: {e}"
            if job_id:
                jobs.progress(job_id, error=f"shot {shot.n}: {detail}")
            # a provider that fails twice in a row is down, not unlucky
            if consecutive_failures >= 2:
                if job_id:
                    jobs.progress(job_id, error="stopped after two consecutive provider failures")
                aborted = True
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
    return {"made": made, "aborted": aborted}


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
        have = {h.variant for h in p.heroes if h.cls == cls}
        for v in (1, 2):
            if v in have:          # a previous run already paid for this variant
                continue
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
    # Law 3 and Part 1.4 again: both can be invalidated after the heroes exist,
    # because regenerating or editing the plan clears them
    gate(p.plan.approved, "approve the shot plan first")
    gate(p.budget.confirmed, "confirm the budget first")
    gate(all(any(h.cls == c and h.chosen for h in p.heroes) for c in classes), "choose a hero for every class first")
    todo = [s for s in p.plan.shots
            if not any(x.shot_n == s.n and x.status in ("pending", "approved") for x in p.stills)]
    job_id = new_id("job")
    # check-and-register under the project lock: two requests must not both
    # pass the gate and then each pay for the same shots
    with project_lock(pid):
        gate(not jobs.active_for_project(pid), "a generation job is already running for this project")
        jobs.prune()
        jobs.create(job_id, pid, "stills", len(todo))
    if background:
        def work():
            if _stills_batch(pid, job_id)["aborted"]:
                raise RuntimeError("stopped after two consecutive provider failures")
        jobs.run_in_thread(job_id, work)
        return {"job": jobs.get(job_id).as_dict()}
    try:
        made = _stills_batch(pid, job_id)["made"]
    finally:
        jobs.finish(job_id)
    p = get(pid)
    return {"made": made, "stills": p.stills, "ledger": costs.summary(p)}


@router.post("/stills/{sid}/approve")
def still_approve(pid: str, sid: str):
    p = get(pid)
    st = next((s for s in p.stills if s.id == sid), None)
    if not st:
        raise HTTPException(404, "still not found")
    superseded = [o for o in p.stills if o.shot_n == st.shot_n and o.id != sid and o.status == "approved"]
    for other in superseded:
        other.status = "rejected"
    st.status = "approved"
    # A clip animated from a still that is no longer approved must not ship.
    # Retire it so the clips stage offers to rebuild it.
    for c in p.clips:
        if c.still_id in {o.id for o in superseded} and c.status in ("pending", "approved"):
            c.status = "rejected"
            c.note = (c.note + " | retired: its still was replaced").strip(" |")
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
