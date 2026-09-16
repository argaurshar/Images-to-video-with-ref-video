"""A small in-process job registry for the long batches: still boards and
clip runs.

Right-sized on purpose. A five-person practice runs one project at a time,
so this is a thread per batch and a dictionary, not a queue server. What it
must guarantee is the thing that costs real money: a batch that dies partway
through has already persisted everything it paid for, and running it again
picks up from there rather than paying twice.

The registry is in memory. If the server restarts mid-batch the job vanishes
from the list, but the generations it had already finished are on disk and in
the project, so the user simply presses generate again.
"""
from __future__ import annotations

import threading
import traceback
from dataclasses import dataclass, field
from typing import Callable

from .models import now_iso


@dataclass
class Job:
    id: str
    project_id: str
    kind: str                       # "stills" | "clips"
    total: int
    done: int = 0
    current: str = ""
    status: str = "running"         # running | finished | failed
    errors: list[str] = field(default_factory=list)
    started_at: str = field(default_factory=now_iso)
    finished_at: str = ""

    def as_dict(self) -> dict:
        return {
            "id": self.id, "project_id": self.project_id, "kind": self.kind, "total": self.total,
            "done": self.done, "current": self.current, "status": self.status, "errors": self.errors,
            "started_at": self.started_at, "finished_at": self.finished_at,
        }


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def create(job_id: str, project_id: str, kind: str, total: int) -> Job:
    job = Job(id=job_id, project_id=project_id, kind=kind, total=total)
    with _lock:
        _jobs[job_id] = job
    return job


def get(job_id: str) -> Job | None:
    with _lock:
        return _jobs.get(job_id)


def for_project(project_id: str) -> list[dict]:
    with _lock:
        return [j.as_dict() for j in _jobs.values() if j.project_id == project_id]


def active_for_project(project_id: str) -> dict | None:
    with _lock:
        for j in _jobs.values():
            if j.project_id == project_id and j.status == "running":
                return j.as_dict()
    return None


def progress(job_id: str, done: int | None = None, current: str | None = None, error: str | None = None) -> None:
    with _lock:
        j = _jobs.get(job_id)
        if not j:
            return
        if done is not None:
            j.done = done
        if current is not None:
            j.current = current
        if error:
            j.errors.append(error)


def finish(job_id: str, status: str = "finished") -> None:
    with _lock:
        j = _jobs.get(job_id)
        if j:
            j.status = status
            j.finished_at = now_iso()
            j.current = ""


def run_in_thread(job_id: str, work: Callable[[], None]) -> None:
    """Run `work` on a daemon thread, marking the job finished or failed.
    An exception is recorded on the job rather than lost to the console."""
    def runner() -> None:
        try:
            work()
            finish(job_id, "finished")
        except Exception as e:                       # noqa: BLE001 - surfaced on the job
            progress(job_id, error=f"{type(e).__name__}: {e}")
            traceback.print_exc()
            finish(job_id, "failed")
    threading.Thread(target=runner, name=f"job-{job_id}", daemon=True).start()


def prune(keep: int = 40) -> None:
    """Keep the registry small; finished jobs are only useful briefly."""
    with _lock:
        done = sorted([j for j in _jobs.values() if j.status != "running"], key=lambda j: j.finished_at)
        for j in done[: max(0, len(done) - keep)]:
            _jobs.pop(j.id, None)
