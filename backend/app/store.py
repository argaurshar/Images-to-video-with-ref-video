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
import re
import secrets
import threading
from contextlib import contextmanager
from pathlib import Path

from .config import DATA_DIR, ensure_dirs
from .models import Project, now_iso

_lock = threading.Lock()
SUBDIRS = ["hubs", "reference", "heroes", "stills", "clips", "out", "thumbs"]


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


# Project ids are server-generated ("prj_" + 8 hex). Validating here, at the
# one place that turns an id into a path, stops a crafted id such as
# "../../etc" from building a path outside the data directory. Every route
# reaches the filesystem through this function.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class InvalidProjectId(ValueError):
    """A project id that could never have been issued by this server."""


def project_dir(pid: str) -> Path:
    if not _ID_RE.match(pid or ""):
        raise InvalidProjectId(f"invalid project id: {pid!r}")
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


# Generations and ledger entries are only ever appended, never removed, so a
# copy of the project loaded before a batch committed is not wrong, it is just
# short. Re-adding what it never saw is what stops a UI click from silently
# discarding work the provider has already been paid for.
_APPEND_ONLY = ("heroes", "stills", "clips")


def _merge_missing(target: Project, disk: Project) -> None:
    for field in _APPEND_ONLY:
        have = {x.id for x in getattr(target, field)}
        extra = [x for x in getattr(disk, field) if x.id not in have]
        if extra:
            getattr(target, field).extend(extra)
    seen = {(e.ts, e.kind, e.cost, e.note) for e in target.ledger}
    extra_ledger = [e for e in disk.ledger if (e.ts, e.kind, e.cost, e.note) not in seen]
    if extra_ledger:
        target.ledger.extend(extra_ledger)


def save_project(p: Project) -> None:
    """Write the project, first folding back any generation or charge that
    landed on disk after this copy was loaded.

    Every writer takes the project lock here, not only the ones that went
    through mutate(), because a plain load-edit-save handler racing a running
    batch is exactly how paid work goes missing.
    """
    f = project_dir(p.id) / "project.json"
    tmp = f.with_suffix(".json.tmp")
    with project_lock(p.id):
        if f.exists():
            try:
                _merge_missing(p, Project.model_validate_json(f.read_text()))
            except ValueError:
                pass          # unreadable on-disk copy: our in-hand one is the better record
        p.updated_at = now_iso()
        tmp.write_text(p.model_dump_json(indent=2))
        tmp.replace(f)


_project_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def project_lock(pid: str) -> threading.RLock:
    # Reentrant: mutate() holds this lock and the save_project() inside it
    # takes the same lock again.
    with _locks_guard:
        return _project_locks.setdefault(pid, threading.RLock())


@contextmanager
def mutate(pid: str):
    """Load, hand over, save, all under one per-project lock.

    Generation happens *outside* this block: a provider call takes minutes and
    holding the lock across it would freeze every read of the project. The
    pattern is generate first, then reopen the project and commit the result,
    so a long batch persists each paid item as it lands.
    """
    lock = project_lock(pid)
    with lock:
        p = load_project(pid)
        yield p
        save_project(p)


def rel(path: Path) -> str:
    """Path relative to the data dir, used in the API and the record."""
    return str(Path(path).resolve().relative_to(DATA_DIR))


def abs_path(relpath: str) -> Path:
    return DATA_DIR / relpath
