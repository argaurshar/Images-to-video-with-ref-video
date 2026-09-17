from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, costs, jobs
from ..models import Clip, QCReport
from ..services.analysis.qc import run_qc
from ..services.imageops import video_first_frame
from ..services.planning import prompts
from ..services.providers import ProviderError, get_provider
from ..store import abs_path, mutate, new_id, project_dir, project_lock, rel, save_project
from .common import get, gate
from .stills import _charge_still, _gen_still

router = APIRouter(prefix="/api/projects/{pid}/clips", tags=["clips"])


class RegenItem(BaseModel):
    shot_n: int
    mode: Literal["camera_softer", "lighter_cues", "dry", "notes"] = "camera_softer"
    note: str = ""


DRY_MARK = "dry-reshoot"          # a structured marker, never free user text


class RegenBody(BaseModel):
    items: list[RegenItem]


def _approved_still(p, n):
    return next((s for s in p.stills if s.shot_n == n and s.status == "approved"), None)


def _gen_clip(p, shot, still, attempt: int, motion_override: str | None = None) -> Clip:
    try:
        prov = get_provider()
    except ProviderError as e:
        raise HTTPException(502, f"provider error: {e}")
    prompt = motion_override or prompts.motion_prompt(p, shot)
    neg = prompts.negative_prompt(shot.cls)
    cid = new_id("clp")
    out = project_dir(p.id) / "clips" / f"{cid}.mp4"
    try:
        res = prov.generate_clip(abs_path(still.path), prompt, neg, shot.duration, p.intake.aspect, out)
    except ProviderError as e:
        raise HTTPException(502, f"provider error: {e}")
    thumb = project_dir(p.id) / "thumbs" / f"{cid}.jpg"
    try:
        bright = video_first_frame(out, thumb)
    except Exception:          # noqa: BLE001 - a poster frame is cosmetic; the paid clip is not
        bright = 0.0
    c = Clip(id=cid, shot_n=shot.n, cls=shot.cls, source_hub_id=shot.source_hub_id, still_id=still.id, attempt=attempt,
             path=rel(out), thumb=rel(thumb), prompt=prompt, negative=neg, provider=prov.name, provider_id=res.provider_id,
             cost=res.cost, duration=(res.seconds or shot.duration), mean_brightness=round(bright, 3),
             note=res.note)
    expects = shot.state.precipitation
    try:
        c.qc = run_qc(out, shot.cls, expects_particles=expects)  # Law 4: measure before showing
    except Exception as e:     # noqa: BLE001 - never discard a paid clip over a failed measurement
        c.qc = QCReport(ran=False, passed=False, failures=["qc could not run"],
                        interpretation=f"QC failed to run ({type(e).__name__}: {e}). Law 4 says do not "
                                       f"call this clip good on a thumbnail; review it by eye or regenerate.")
    if not c.qc.passed:
        c.status = "pending"
    return c


def _charge_clip(p, c: Clip) -> None:
    costs.charge(p, "clip", c.cost, f"shot {c.shot_n} attempt {c.attempt} ({c.provider})")


def _clips_batch(pid: str, job_id: str | None = None) -> list[Clip]:
    """Generate a clip for every shot that lacks one, committing each as it
    lands. Video is the expensive step, so a batch that dies at shot 12 of 14
    must not lose the twelve already paid for."""
    p = get(pid)
    # "cut" counts as settled: the user deliberately dropped that shot, often
    # after the two-attempt limit, and regenerating it would bill a third time
    todo = [s for s in p.plan.shots
            if not any(c.shot_n == s.n and c.status in ("pending", "approved", "cut") for c in p.clips)]
    if job_id:
        jobs.progress(job_id, done=0, current=f"{len(todo)} clip(s) to generate")
    made: list[Clip] = []
    consecutive_failures = 0
    aborted = False
    for i, shot in enumerate(todo):
        if job_id:
            jobs.progress(job_id, done=i, current=f"shot {shot.n} ({shot.cls}, {shot.duration}s)")
        snap = get(pid)
        still = _approved_still(snap, shot.n)
        if still is None:
            if job_id:
                jobs.progress(job_id, error=f"shot {shot.n}: no approved still")
            continue
        try:
            c = _gen_clip(snap, shot, still, attempt=1 + sum(1 for x in snap.clips if x.shot_n == shot.n))
        except Exception as e:                       # noqa: BLE001 - reported on the job
            consecutive_failures += 1
            detail = getattr(e, "detail", None) or f"{type(e).__name__}: {e}"
            if job_id:
                jobs.progress(job_id, error=f"shot {shot.n}: {detail}")
            if consecutive_failures >= 2:
                if job_id:
                    jobs.progress(job_id, error="stopped after two consecutive provider failures")
                aborted = True
                break
            continue
        consecutive_failures = 0
        with mutate(pid) as cur:
            cur.clips.append(c)
            _charge_clip(cur, c)
            cur.stage = "clips"
        made.append(c)
        if job_id:
            jobs.progress(job_id, done=i + 1, current=f"shot {shot.n}: QC {'pass' if c.qc.passed else 'fail'}")
    return {"made": made, "aborted": aborted}


@router.post("/generate")
def generate(pid: str, background: bool = False):
    p = get(pid)
    missing = [s.n for s in p.plan.shots if not _approved_still(p, s.n)]
    gate(not missing, f"Law 3: approve a still for every shot before video. Missing: {missing}")
    todo = [s for s in p.plan.shots
            if not any(c.shot_n == s.n and c.status in ("pending", "approved", "cut") for c in p.clips)]
    job_id = new_id("job")
    with project_lock(pid):
        gate(not jobs.active_for_project(pid), "a generation job is already running for this project")
        jobs.prune()
        jobs.create(job_id, pid, "clips", len(todo))
    if background:
        def work():
            if _clips_batch(pid, job_id)["aborted"]:
                raise RuntimeError("stopped after two consecutive provider failures")
        jobs.run_in_thread(job_id, work)
        return {"job": jobs.get(job_id).as_dict()}
    try:
        made = _clips_batch(pid, job_id)["made"]
    finally:
        jobs.finish(job_id)
    p = get(pid)
    return {"made": made, "clips": p.clips, "ledger": costs.summary(p)}


@router.post("/{cid}/approve")
def approve(pid: str, cid: str):
    p = get(pid)
    c = next((x for x in p.clips if x.id == cid), None)
    if not c:
        raise HTTPException(404, "clip not found")
    for o in p.clips:
        if o.shot_n == c.shot_n and o.id != cid and o.status == "approved":
            o.status = "rejected"
    c.status = "approved"
    p.record_approval("clip", {"id": cid, "shot": c.shot_n, "qc_passed": c.qc.passed, "failures": c.qc.failures})
    save_project(p)
    return c


@router.post("/{cid}/cut")
def cut(pid: str, cid: str):
    p = get(pid)
    c = next((x for x in p.clips if x.id == cid), None)
    if not c:
        raise HTTPException(404, "clip not found")
    c.status = "cut"
    p.record_approval("clip_cut", {"id": cid, "shot": c.shot_n})
    save_project(p)
    return c


@router.post("/regenerate")
def regenerate(pid: str, body: RegenBody):
    """Regenerate only the named clips, and only with a real change (Part 9).
    After MAX_ATTEMPTS failures on a shot, refuse and recommend a cut or a dry
    re-shoot (Part 8 known model limit)."""
    p = get(pid)
    made, refused = [], []
    for item in body.items:
        try:
            shot = p.shot(item.shot_n)
        except KeyError:
            raise HTTPException(404, f"no shot {item.shot_n}")
        # reload per item: several items in one request for the same shot must
        # each see the attempts the previous ones committed
        prior = [c for c in get(pid).clips if c.shot_n == item.shot_n
                 and c.status in ("pending", "approved", "rejected", "cut")]
        wet_attempts = [c for c in prior if c.mode != "dry"]
        if item.mode != "dry" and len(wet_attempts) >= config.MAX_ATTEMPTS_PER_SHOT:
            refused.append({"shot_n": item.shot_n, "reason": (
                f"{len(wet_attempts)} attempts already. Recommend cutting the shot or re-shooting it dry "
                f"(mode 'dry': no precipitation, only mist, cloud drift and wind). No third wet attempt.")})
            continue
        if item.mode == "dry" and any(c.mode == "dry" for c in prior):
            refused.append({"shot_n": item.shot_n, "reason": "a dry re-shoot was already tried; recommend cutting this shot"})
            continue
        still = _approved_still(p, shot.n)
        if still is None:
            refused.append({"shot_n": item.shot_n, "reason": (
                "this shot has no approved still any more, so there is nothing to animate; "
                "approve a still for it on the board first")})
            continue
        for c in prior:
            if c.status == "pending":
                c.status = "rejected"
        attempt = len(prior) + 1
        note = item.note
        motion = None
        if item.mode == "camera_softer":
            motion = prompts.motion_prompt(p, shot).replace("makes a slow, barely perceptible push in", "holds with a barely perceptible drift") \
                .replace("drifts slowly forward through the doorway", "holds at the doorway with a barely perceptible drift")
            motion += " The camera does almost nothing; the world does the moving."
            note = f"camera softened. {note}".strip()
        elif item.mode in ("lighter_cues", "dry"):
            # change the still first: lighter cues, or no precipitation at all
            shot2 = shot.model_copy(deep=True)
            if item.mode == "dry":
                shot2.state.weather = "clear, still air, thin cloud drifting" if shot.cls == "exterior" else "clear, still"
                shot2.state.precipitation = False
                shot2.motion = "one torn wisp of mist crossing the frame, one branch tip barely moving" if shot.cls == "exterior" \
                    else "dust motes in one shaft of sun, nothing else moving"
                note = f"dry re-shoot. {note}".strip()
            else:
                shot2.motion = shot.motion.split(",")[0] + ", nothing else moving"
                note = f"lighter cues. {note}".strip()
            hub = p.hub(shot.source_hub_id)
            st = _gen_still(p, shot2, hub, project_dir(pid) / "stills", corrections=item.note, attempt=1 + sum(1 for s in p.stills if s.shot_n == shot.n))
            st.status = "approved"
            still.status = "rejected"
            with mutate(pid) as cur:
                for x in cur.stills:
                    if x.id == still.id:
                        x.status = "rejected"
                cur.stills.append(st)
                _charge_still(cur, st)
            still = st
            motion = prompts.motion_prompt(p, shot2)
        elif item.mode == "notes":
            motion = prompts.motion_prompt(p, shot) + f" Direction notes: {item.note}"
        c = _gen_clip(p, shot2 if item.mode in ("lighter_cues", "dry") else shot, still, attempt=attempt, motion_override=motion)
        c.note = note
        c.mode = item.mode
        with mutate(pid) as cur:
            for x in cur.clips:
                if x.shot_n == shot.n and x.status == "pending":
                    x.status = "rejected"
            cur.clips.append(c)
            _charge_clip(cur, c)
        made.append(c)
    p = get(pid)
    return {"made": made, "refused": refused, "clips": p.clips, "ledger": costs.summary(p)}
