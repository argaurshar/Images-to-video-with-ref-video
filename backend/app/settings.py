"""Runtime settings and the access lock.

The point of this module is that a deployed copy needs no server configuration:
you open the URL, set an access code, paste your API key, and work. Nothing has
to be typed into a hosting dashboard.

That convenience creates a real risk, so the lock is part of the same feature.
The app holds a paid API key and sits on a public URL, so anyone who found that
URL could spend the owner's money. The first visitor claims the instance by
setting an access code; from then on every API call and every generated file
needs a valid session.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from . import config

_lock = threading.Lock()
_SESSIONS: dict[str, float] = {}          # token -> expiry timestamp
SESSION_SECONDS = 60 * 60 * 24 * 14       # two weeks


class Settings(BaseModel):
    access_hash: str = ""                 # pbkdf2 of the access code
    access_salt: str = ""
    provider: str = Field(default="")     # "" means fall back to the environment
    freepik_api_key: str = ""
    image_cost: float = 0.0               # 0 means fall back to the environment
    video_cost: float = 0.0

    # ---- derived, never sent to the browser in full -------------------
    @property
    def claimed(self) -> bool:
        return bool(self.access_hash)

    def masked_key(self) -> str:
        k = self.freepik_api_key
        if not k:
            return ""
        return f"{'*' * max(0, len(k) - 4)}{k[-4:]}" if len(k) > 4 else "****"

    def public(self) -> dict[str, Any]:
        """What the browser is allowed to see. Never the key itself."""
        return {
            "claimed": self.claimed,
            "provider": self.effective_provider(),
            "has_key": bool(self.effective_key()),
            "key_hint": self.masked_key(),
            "key_from_env": bool(config.FREEPIK_API_KEY) and not self.freepik_api_key,
            "image_cost": self.effective_image_cost(),
            "video_cost": self.effective_video_cost(),
        }

    def effective_provider(self) -> str:
        return self.provider or config.PROVIDER

    def effective_key(self) -> str:
        return self.freepik_api_key or config.FREEPIK_API_KEY

    def effective_image_cost(self) -> float:
        return self.image_cost or config.IMAGE_COST

    def effective_video_cost(self) -> float:
        return self.video_cost or config.VIDEO_COST


def _path() -> Path:
    return config.DATA_DIR / "settings.json"


_cache: Settings | None = None


def load() -> Settings:
    global _cache
    if _cache is not None:
        return _cache
    f = _path()
    if f.exists():
        try:
            _cache = Settings.model_validate_json(f.read_text())
        except ValueError:
            _cache = Settings()
    else:
        _cache = Settings()
        # An operator can still pre-set the code, which closes the window
        # between deploying and claiming.
        env_code = os.environ.get("ARCHVIZ_ACCESS_CODE", "")
        if env_code:
            set_access_code(env_code, _cache, persist=False)
        if config.FREEPIK_API_KEY:
            _cache.provider = config.PROVIDER
        save(_cache)
    return _cache


def save(s: Settings) -> None:
    global _cache
    config.ensure_dirs()
    f = _path()
    tmp = f.with_suffix(".json.tmp")
    with _lock:
        tmp.write_text(s.model_dump_json(indent=2))
        os.chmod(tmp, 0o600)              # the key lives here; keep it off other accounts
        tmp.replace(f)
        _cache = s


def reset_cache() -> None:
    global _cache
    _cache = None


# ---------------------------------------------------------------- access
def _hash(code: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", code.encode(), bytes.fromhex(salt), 200_000).hex()


def set_access_code(code: str, s: Settings | None = None, persist: bool = True) -> Settings:
    s = s or load()
    salt = secrets.token_hex(16)
    s.access_salt = salt
    s.access_hash = _hash(code, salt)
    if persist:
        save(s)
    return s


def check_access_code(code: str) -> bool:
    s = load()
    if not s.claimed:
        return False
    return secrets.compare_digest(_hash(code, s.access_salt), s.access_hash)


def issue_token() -> str:
    token = secrets.token_urlsafe(32)
    with _lock:
        _SESSIONS[token] = time.time() + SESSION_SECONDS
        for t, exp in list(_SESSIONS.items()):
            if exp < time.time():
                _SESSIONS.pop(t, None)
    return token


def valid_token(token: str | None) -> bool:
    if not token:
        return False
    with _lock:
        exp = _SESSIONS.get(token)
        if exp is None:
            return False
        if exp < time.time():
            _SESSIONS.pop(token, None)
            return False
    return True


def revoke(token: str | None) -> None:
    if token:
        with _lock:
            _SESSIONS.pop(token, None)
