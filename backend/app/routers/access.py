"""Claiming the instance, signing in, and the runtime settings panel."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from .. import settings as S
from ..services.providers import reset_provider

router = APIRouter(prefix="/api", tags=["access"])
COOKIE = "archviz_session"


class Code(BaseModel):
    code: str


class SettingsBody(BaseModel):
    provider: str | None = None
    freepik_api_key: str | None = None
    image_cost: float | None = None
    video_cost: float | None = None


def _is_https(request: Request) -> bool:
    # a platform proxy terminates TLS and says so in this header
    return (request.url.scheme == "https"
            or request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https")


def _set_cookie(resp: Response, token: str, request: Request) -> None:
    resp.set_cookie(
        COOKIE, token,
        max_age=S.SESSION_SECONDS,
        httponly=True,                 # not readable from JavaScript
        samesite="lax",
        secure=_is_https(request),     # only over TLS; a Secure cookie is
                                       # dropped on plain http, which would
                                       # break running it locally
        path="/",
    )


@router.get("/auth/state")
def auth_state(request: Request):
    s = S.load()
    return {
        "claimed": s.claimed,
        "authed": S.valid_token(request.cookies.get(COOKIE)),
        "settings": s.public() if S.valid_token(request.cookies.get(COOKIE)) else None,
    }


@router.post("/auth/claim")
def claim(body: Code, response: Response, request: Request):
    """First visitor sets the access code. Only possible once."""
    s = S.load()
    if s.claimed:
        raise HTTPException(409, "this instance has already been claimed; sign in instead")
    if len(body.code) < 8:
        raise HTTPException(400, "choose an access code of at least 8 characters")
    S.set_access_code(body.code)
    _set_cookie(response, S.issue_token(), request)
    return {"ok": True, "settings": S.load().public()}


@router.post("/auth/login")
def login(body: Code, response: Response, request: Request):
    if not S.load().claimed:
        raise HTTPException(409, "this instance has not been claimed yet")
    if not S.check_access_code(body.code):
        raise HTTPException(401, "wrong access code")
    _set_cookie(response, S.issue_token(), request)
    return {"ok": True, "settings": S.load().public()}


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    S.revoke(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/settings")
def get_settings():
    return S.load().public()


@router.put("/settings")
def put_settings(body: SettingsBody):
    s = S.load()
    if body.provider is not None:
        if body.provider not in ("mock", "freepik"):
            raise HTTPException(400, "provider must be mock or freepik")
        s.provider = body.provider
    if body.freepik_api_key is not None:
        # an empty string clears it and falls back to the environment
        s.freepik_api_key = body.freepik_api_key.strip()
    if body.image_cost is not None:
        s.image_cost = max(0.0, body.image_cost)
    if body.video_cost is not None:
        s.video_cost = max(0.0, body.video_cost)
    S.save(s)
    reset_provider()          # the next generation uses the new key
    return s.public()


@router.post("/settings/test")
def test_settings():
    """Prove the key works before any money is spent on a real batch."""
    s = S.load()
    if s.effective_provider() != "freepik":
        return {"ok": True, "detail": "running on the mock provider; nothing is charged"}
    if not s.effective_key():
        raise HTTPException(400, "no API key set")
    import httpx
    from .. import config
    try:
        r = httpx.get(f"{config.FREEPIK_BASE_URL}/ai/mystic",
                      headers={"x-freepik-api-key": s.effective_key()}, timeout=20)
    except Exception as e:                       # noqa: BLE001
        raise HTTPException(502, f"could not reach the provider: {e}")
    if r.status_code in (401, 403):
        raise HTTPException(401, "the provider rejected this API key")
    return {"ok": True, "detail": f"the provider answered ({r.status_code}); the key is accepted"}
