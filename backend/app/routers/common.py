from __future__ import annotations

from fastapi import HTTPException

from ..models import Project
from ..store import load_project


def get(pid: str) -> Project:
    try:
        return load_project(pid)
    except (FileNotFoundError, ValueError):
        # ValueError covers a malformed id, which is a not-found as far as a
        # caller is concerned; it must not surface as a 500 or echo the path
        raise HTTPException(404, f"project {pid} not found")


def gate(condition: bool, message: str) -> None:
    """Approval gates are hard stops (Law 3)."""
    if not condition:
        raise HTTPException(409, message)
