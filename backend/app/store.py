"""Filesystem project store. One directory per project:

    data/projects/<id>/project.json
    data/projects/<id>/hubs/        original renders (never modified)
    data/projects/<id>/reference/   reference video
    data/projects/<id>/heroes/      hero variants
    data/projects/<id>/stills/      still board
    data/projects/<id>/clips/       generated clips
    data/projects/<id>/out/         final film, crops, packs, record

A JSON file per project is deliberate: a five-person practice can open it,
back it up and email it. It is also the project record the spec asks for.
"""
from __future__ import annotations

import json
import secrets
import threading
from pathlib import Path

from .config import DATA_DIR, ensure_dirs
from .models import Project, now_iso

_lock = threading.Lock()
SUBDIRS = ["hubs", "reference", "heroes", "stills", "clips", "out", "thumbs"]


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


def project_dir(pid: str) -> Path:
    return DATA_DIR / "projects" / pid


def create_project(name: str) -> Project:
    ensure_dirs()
    pid = new_id("prj")
    p = Project(id=pid, name=name or "Untitled project")
    d = project_dir(pid)
    for s in SUBDIRS:
        (d / s).mkdir(parents=True, exist_ok=True)
    save_project(p)
    return p


def list_projects() -> list[dict]:
    ensure_dirs()
    out = []
    for d in sorted((DATA_DIR / "projects").iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        f = d / "project.json"
        if f.exists():
            try:
                data = json.loads(f.read_text())
                out.append({
                    "id": data["id"], "name": data["name"], "stage": data.get("stage"),
                    "updated_at": data.get("updated_at"), "hubs": len(data.get("hubs", [])),
                })
            except Exception:  # corrupt file: skip, never crash the list
                continue
    return out


def load_project(pid: str) -> Project:
    f = project_dir(pid) / "project.json"
    if not f.exists():
        raise FileNotFoundError(pid)
    return Project.model_validate_json(f.read_text())


def save_project(p: Project) -> None:
    p.updated_at = now_iso()
    f = project_dir(p.id) / "project.json"
    tmp = f.with_suffix(".json.tmp")
    with _lock:
        tmp.write_text(p.model_dump_json(indent=2))
        tmp.replace(f)


def rel(path: Path) -> str:
    """Path relative to the data dir, used in the API and the record."""
    return str(Path(path).resolve().relative_to(DATA_DIR))


def abs_path(relpath: str) -> Path:
    return DATA_DIR / relpath
