from __future__ import annotations

from fastapi import HTTPException

from ..models import Project
from ..store import load_project


def get(pid: str) -> Project:
    try:
        return load_project(pid)
    except FileNotFoundError:
        raise HTTPException(404, f"project {pid} not found")


def gate(condition: bool, message: str) -> None:
    """Approval gates are hard stops (Law 3)."""
    if not condition:
        raise HTTPException(409, message)
