from __future__ import annotations

from fastapi import HTTPException

from ..models import Project
from ..store import InvalidProjectId, load_project


def get(pid: str) -> Project:
    try:
        return load_project(pid)
    except FileNotFoundError:
        raise HTTPException(404, f"project {pid} not found")
    except InvalidProjectId:
        # A crafted id is a not-found to the caller, and must not echo a path
        raise HTTPException(404, f"project {pid} not found")
    except ValueError as e:
        # A corrupt or schema-mismatched project.json is NOT a not-found.
        # Reporting it as one would hide real data behind a missing-project
        # message; say plainly that it exists and cannot be read.
        raise HTTPException(500, f"project {pid} is on disk but could not be parsed: {e}")


def gate(condition: bool, message: str) -> None:
    """Approval gates are hard stops (Law 3)."""
    if not condition:
        raise HTTPException(409, message)
