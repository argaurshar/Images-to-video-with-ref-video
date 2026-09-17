"""ArchViz Cinematic Engine API and static front end.

Run:  uvicorn backend.app.main:app --reload
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config
from . import settings as S
from .routers import access, clips, plan, projects, reference, render, sequence, stills

config.ensure_dirs()
app = FastAPI(title="ArchViz Cinematic Engine", version="2.0")
for r in (access, projects, reference, plan, stills, clips, sequence, render):
    app.include_router(r.router)

# Paths that must work before anyone has signed in.
_OPEN = ("/api/health", "/api/auth/state", "/api/auth/claim", "/api/auth/login", "/api/auth/logout")


@app.middleware("http")
async def require_access(request: Request, call_next):
    """Gate the API and every generated file behind the access code.

    This exists because the app holds a paid API key and is designed to sit on
    a public URL. Generated files are covered too: they are served by a static
    mount that would otherwise hand out a client's renders to anyone with the
    path. A cookie is used rather than a header so that image and video tags
    are authenticated as well.

    While the instance is unclaimed everything is open, so the first visitor
    can claim it. Set ARCHVIZ_ACCESS_CODE to close that window entirely.
    """
    path = request.url.path
    guarded = path.startswith("/api/") or path.startswith("/files/")
    if guarded and path not in _OPEN and S.load().claimed:
        if not S.valid_token(request.cookies.get(access.COOKIE)):
            return JSONResponse({"detail": "sign in to use this instance"}, status_code=401)
    return await call_next(request)

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
