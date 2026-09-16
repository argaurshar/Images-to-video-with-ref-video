from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from .. import costs
from ..models import HubImage, Intake
from ..services.analysis.hub import analyse_hub
from ..services.imageops import crop_loss, make_thumb
from ..services.planning import llm, location
from ..store import create_project, list_projects, new_id, project_dir, rel, save_project
from .common import get

router = APIRouter(prefix="/api", tags=["projects"])

OPENING = ("Upload the renders of your project. 1 to 8 images work best: exterior angles, interior rooms, or both. "
           "Then tell me the location, which way is north in your main exterior view, and either the seasons and mood "
           "you want or a reference video whose style you'd like to match. I'll ask what you most want the client to "
           "notice, plan the shots around that, generate stills for your approval, and only move to video once you're "
           "happy. You approve every stage, you can regenerate any single image or clip without rebuilding the rest, "
           "and you get the stills and a project record alongside the film.")


class NewProject(BaseModel):
    name: str = ""


class HubPatch(BaseModel):
    cls: str | None = None
    camera_faces: str | None = None
    materials: str | None = None
    elements: str | None = None
    label: str | None = None
    continuity_group: str | None = None


@router.get("/opening")
def opening():
    return {"message": OPENING}


@router.post("/projects")
def create(body: NewProject):
    p = create_project(body.name)
    return p


@router.get("/projects")
def index():
    return list_projects()


@router.get("/projects/{pid}")
def show(pid: str):
    return get(pid)


@router.post("/projects/{pid}/hubs")
def upload_hubs(pid: str, files: list[UploadFile] = File(...)):
    p = get(pid)
    if len(p.hubs) + len(files) > 8:
        raise HTTPException(400, "1 to 8 renders per project")
    d = project_dir(pid)
    added = []
    for f in files:
        ext = Path(f.filename or "render.png").suffix.lower() or ".png"
        if ext not in (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"):
            raise HTTPException(400, f"unsupported image type {ext}")
        hid = new_id("hub")
        dst = d / "hubs" / f"{hid}{ext}"
        with open(dst, "wb") as out:
            shutil.copyfileobj(f.file, out)
        try:
            det = analyse_hub(dst)
        except ValueError:
            dst.unlink(missing_ok=True)
            raise HTTPException(400, f"{f.filename} is not a readable image")
        make_thumb(dst, d / "thumbs" / f"{hid}.jpg")
        hub = HubImage(id=hid, filename=f.filename or dst.name, path=rel(dst), cls=det["suggested_class"],
                       width=det["width"], height=det["height"], detected=det, label=Path(f.filename or "").stem)
        p.hubs.append(hub)
        added.append(hub)
    save_project(p)
    return {"added": added, "project": p}


@router.patch("/projects/{pid}/hubs/{hid}")
def patch_hub(pid: str, hid: str, body: HubPatch):
    p = get(pid)
    try:
        h = p.hub(hid)
    except KeyError:
        raise HTTPException(404, "render not found")
    for k, v in body.model_dump(exclude_none=True).items():
        if k == "cls" and v not in ("exterior", "interior"):
            raise HTTPException(400, "class must be exterior or interior")
        if k == "camera_faces" and v and v.upper() not in location.COMPASS:
            raise HTTPException(400, "camera_faces must be one of N NE E SE S SW W NW")
        setattr(h, k, v.upper() if k == "camera_faces" and v else v)
    save_project(p)
    return h


@router.delete("/projects/{pid}/hubs/{hid}")
def delete_hub(pid: str, hid: str):
    p = get(pid)
    if any(s.source_hub_id == hid for s in p.plan.shots):
        raise HTTPException(409, "this render is used by the shot plan; regenerate the plan first")
    p.hubs = [h for h in p.hubs if h.id != hid]
    save_project(p)
    return {"ok": True}


@router.put("/projects/{pid}/intake")
def put_intake(pid: str, body: Intake):
    p = get(pid)
    if not body.location.strip():
        raise HTTPException(400, "location is required; it drives the climate research")
    body.design_intents = [t.strip() for t in body.design_intents if t.strip()][:3]
    p.intake = body
    prof = location.profile(body.location)
    researched = llm.research_location(body.location, prof)
    if researched:
        prof.update({k: v for k, v in researched.items() if v})
    p.location_profile = prof
    # end use drives defaults (spec 1.3)
    if body.end_use == "planning_consultation":
        p.intake.people = "none"
        p.branding.disclaimer_every_frame = True
    if body.end_use == "social" and body.aspect == "16:9":
        p.intake.aspect = "9:16"
    p.budget = costs.estimate(p)
    p.budget.confirmed = False
    p.stage = "reference" if body.route == "reference" else "plan"
    # crop warnings (Law 6)
    warnings = []
    for h in p.hubs:
        loss = crop_loss(h.width, h.height, p.intake.aspect)
        if loss > 0.30:
            warnings.append(f"{h.label or h.id}: a crop to {p.intake.aspect} discards {loss:.0%} of the render. "
                            f"Consider 4:5 or 1:1, or accept the crop.")
    save_project(p)
    return {"project": p, "warnings": warnings}


@router.get("/projects/{pid}/budget")
def budget(pid: str):
    p = get(pid)
    return {"budget": costs.estimate(p), "ledger": costs.summary(p)}


@router.post("/projects/{pid}/budget/confirm")
def confirm_budget(pid: str):
    p = get(pid)
    p.budget = costs.estimate(p)
    p.budget.confirmed = True
    p.record_approval("budget", p.budget.model_dump())
    save_project(p)
    return p.budget


@router.get("/projects/{pid}/ledger")
def ledger(pid: str):
    p = get(pid)
    return {"summary": costs.summary(p), "entries": p.ledger}
