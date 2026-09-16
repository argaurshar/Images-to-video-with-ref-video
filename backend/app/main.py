"""ArchViz Cinematic Engine API and static front end.

Run:  uvicorn backend.app.main:app --reload
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .routers import clips, plan, projects, reference, render, sequence, stills

config.ensure_dirs()
app = FastAPI(title="ArchViz Cinematic Engine", version="2.0")
for r in (projects, reference, plan, stills, clips, sequence, render):
    app.include_router(r.router)

app.mount("/files", StaticFiles(directory=str(config.DATA_DIR)), name="files")


@app.get("/api/health")
def health():
    return {"ok": True, "provider": config.PROVIDER, "image_cost": config.IMAGE_COST, "video_cost": config.VIDEO_COST,
            "max_attempts": config.MAX_ATTEMPTS_PER_SHOT}


if config.FRONTEND_DIR.exists():
    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(config.FRONTEND_DIR / "index.html")

    app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR)), name="frontend")
