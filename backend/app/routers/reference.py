from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..services.analysis.reference import analyse_reference
from ..store import project_dir, save_project
from .common import get

router = APIRouter(prefix="/api/projects/{pid}/reference", tags=["reference"])


@router.post("")
def upload_reference(pid: str, file: UploadFile = File(...)):
    p = get(pid)
    ext = Path(file.filename or "ref.mp4").suffix.lower() or ".mp4"
    dst = project_dir(pid) / "reference" / f"reference{ext}"
    with open(dst, "wb") as out:
        shutil.copyfileobj(file.file, out)
    try:
        ra = analyse_reference(dst)
    except ValueError as e:
        raise HTTPException(400, str(e))
    p.reference = ra
    p.intake.route = "reference"
    # structure suggestions from the reference, colour deliberately not copied
    if ra.shot_count:
        p.intake.length_shots = max(3, min(14, ra.shot_count))
        p.budget.confirmed = False
    p.stage = "plan"
    save_project(p)
    return ra
