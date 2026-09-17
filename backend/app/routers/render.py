from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..models import Branding
from ..services.render import delivery, ffmpeg as R
from ..store import project_dir, rel, save_project
from .common import get, gate

router = APIRouter(prefix="/api/projects/{pid}", tags=["render"])


@router.put("/branding")
def put_branding(pid: str, body: Branding):
    p = get(pid)
    logo = p.branding.logo_path
    p.branding = body
    if not body.logo_path:
        p.branding.logo_path = logo
    if not p.branding.project_name:
        p.branding.project_name = p.intake.project_name or p.name
    if not p.branding.practice_name:
        p.branding.practice_name = p.intake.practice_name
    p.stage = "branding"
    save_project(p)
    return p.branding


@router.post("/branding/logo")
def upload_logo(pid: str, file: UploadFile = File(...)):
    p = get(pid)
    dst = project_dir(pid) / "out" / ("logo" + (Path(file.filename or "logo.png").suffix or ".png"))
    dst.parent.mkdir(exist_ok=True)
    with open(dst, "wb") as out:
        shutil.copyfileobj(file.file, out)
    p.branding.logo_path = str(dst)
    save_project(p)
    return {"logo": rel(dst)}


@router.post("/audio/{kind}")
def upload_audio(pid: str, kind: str, file: UploadFile = File(...)):
    """kind: exterior | interior | score. Loops under the matching clips."""
    if kind not in ("exterior", "interior", "score"):
        raise HTTPException(400, "kind must be exterior, interior or score")
    p = get(pid)
    dst = project_dir(pid) / "out" / f"bed_{kind}{Path(file.filename or '.wav').suffix or '.wav'}"
    dst.parent.mkdir(exist_ok=True)
    with open(dst, "wb") as out:
        shutil.copyfileobj(file.file, out)
    p.audio_beds[kind] = rel(dst)
    save_project(p)
    return p.audio_beds


@router.post("/render")
def render(pid: str, crops: str = ""):
    p = get(pid)
    from .sequence import _reconcile
    _reconcile(p)          # an approved clip missing from a stale order must not be dropped
    by_id = {c.id: c for c in p.clips}
    known = {s.n for s in p.plan.shots}
    ordered = [by_id[i] for i in p.sequence.order if i in by_id and by_id[i].status == "approved"]
    orphans = [c.shot_n for c in ordered if c.shot_n not in known]
    gate(not orphans, f"clips for shot(s) {sorted(set(orphans))} no longer match the plan; "
                      f"re-generate the plan or those clips before rendering")
    gate(bool(ordered), "sequence at least one approved clip first")
    if not p.branding.project_name:
        p.branding.project_name = p.intake.project_name or p.name
    out_dir = project_dir(pid) / "out"
    try:
        film, ver = R.final_render(p, ordered, out_dir)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    p.deliverables.film = rel(film)
    p.deliverables.verification = ver
    p.deliverables.crops = {}
    for a in [x.strip() for x in crops.split(",") if x.strip()]:
        if a in R.RES and a != p.intake.aspect:
            dst = out_dir / f"film_{a.replace(':', 'x')}.mp4"
            R.crop_variant(film, a, dst)
            p.deliverables.crops[a] = rel(dst)
    pack = out_dir / "stills_pack.zip"
    delivery.stills_pack(p, pack)
    p.deliverables.stills_pack = rel(pack)
    p.record_approval("render", ver)
    p.stage = "delivered"
    save_project(p)
    rec_j, rec_h = out_dir / "project_record.json", out_dir / "project_record.html"
    delivery.project_record(p, rec_j, rec_h)
    p.deliverables.record_json, p.deliverables.record_html = rel(rec_j), rel(rec_h)
    save_project(p)
    return p.deliverables


@router.get("/deliverables")
def deliverables(pid: str):
    return get(pid).deliverables
