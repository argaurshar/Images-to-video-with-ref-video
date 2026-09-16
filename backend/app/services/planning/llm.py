"""Optional Claude helper. Two jobs only: research a location profile and
polish prompt prose. It never decides structure (that is the planner's job)
and it never runs without ANTHROPIC_API_KEY. Without the key every call
returns None and the deterministic path is used."""
from __future__ import annotations

import json
import os

import httpx

from ... import config


def _call(system: str, user: str, max_tokens: int = 1200) -> str | None:
    if not config.ANTHROPIC_API_KEY:
        return None
    base = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
    try:
        r = httpx.post(f"{base}/v1/messages", timeout=90,
                       headers={"x-api-key": config.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
                                "content-type": "application/json"},
                       json={"model": config.ANTHROPIC_MODEL, "max_tokens": max_tokens, "system": system,
                             "messages": [{"role": "user", "content": user}]})
        r.raise_for_status()
        return "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
    except Exception:
        return None


def research_location(location: str, fallback: dict) -> dict | None:
    txt = _call(
        "You research climate and light for an architectural visualisation. Answer with one JSON object only.",
        f"Location: {location}. Return JSON with keys: climate, elevation, vegetation, snow_months (list), "
        f"wet_months (list), signature (one sentence of local visual signature), blossom, fog, sun_path (one sentence). "
        f"If unsure, say so inside the value. Current fallback: {json.dumps(fallback)}")
    if not txt:
        return None
    try:
        start, end = txt.index("{"), txt.rindex("}") + 1
        data = json.loads(txt[start:end])
        data["source"] = f"researched by {config.ANTHROPIC_MODEL}"
        return data
    except Exception:
        return None
