"""Freepik / Magnific provider. Image edit (season change from a reference
image) and image-to-video. Endpoints and model paths are set in config
because model names on that platform move; check the current API reference
before going live. The task/poll shape is the platform's standard one:

    POST {base}{path}            -> {"data": {"task_id": ..., "status": ...}}
    GET  {base}{path}/{task_id}  -> {"data": {"status": "COMPLETED", "generated": [url, ...]}}
"""
from __future__ import annotations

import base64
import time
from pathlib import Path

import cv2
import httpx

from ... import config
from ..imageops import crop_to_aspect
from .base import GenResult, Provider, ProviderError


def _b64_image(path: Path, aspect: str) -> str:
    img = cv2.imread(str(path))
    if img is None:
        raise ProviderError(f"cannot read {path}")
    img = crop_to_aspect(img, aspect)  # Law 6: crop, never outpaint
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        raise ProviderError("encode failed")
    return base64.b64encode(buf.tobytes()).decode()


class FreepikProvider(Provider):
    name = "freepik"

    def __init__(self) -> None:
        if not config.FREEPIK_API_KEY:
            raise ProviderError("FREEPIK_API_KEY is not set")
        self.client = httpx.Client(base_url=config.FREEPIK_BASE_URL, timeout=60,
                                   headers={"x-freepik-api-key": config.FREEPIK_API_KEY, "Content-Type": "application/json"})

    def _submit_and_wait(self, path: str, payload: dict) -> list[str]:
        r = self.client.post(path, json=payload)
        if r.status_code >= 300:
            raise ProviderError(f"{path}: {r.status_code} {r.text[:300]}")
        task_id = (r.json().get("data") or {}).get("task_id")
        if not task_id:
            raise ProviderError(f"{path}: no task_id in response {r.text[:300]}")
        deadline = time.time() + config.FREEPIK_TIMEOUT_SECONDS
        while time.time() < deadline:
            time.sleep(config.FREEPIK_POLL_SECONDS)
            s = self.client.get(f"{path}/{task_id}")
            if s.status_code >= 300:
                raise ProviderError(f"poll {task_id}: {s.status_code} {s.text[:300]}")
            data = s.json().get("data") or {}
            status = (data.get("status") or "").upper()
            if status == "COMPLETED":
                gen = data.get("generated") or []
                if not gen:
                    raise ProviderError(f"task {task_id} completed with no output")
                return [g if isinstance(g, str) else g.get("url", "") for g in gen]
            if status in ("FAILED", "ERROR", "CANCELLED"):
                raise ProviderError(f"task {task_id} {status}: {data}")
        raise ProviderError(f"task {task_id} timed out")

    def _download(self, url: str, out: Path) -> None:
        out.parent.mkdir(parents=True, exist_ok=True)
        with httpx.stream("GET", url, timeout=120, follow_redirects=True) as r:
            r.raise_for_status()
            with open(out, "wb") as f:
                for chunk in r.iter_bytes():
                    f.write(chunk)

    def generate_still(self, source: Path, prompt: str, negative: str, aspect: str, out: Path) -> GenResult:
        payload = {"prompt": prompt + "\n\nAvoid: " + negative, "reference_images": [_b64_image(source, aspect)]}
        urls = self._submit_and_wait(config.FREEPIK_IMAGE_EDIT_PATH, payload)
        self._download(urls[0], out)
        return GenResult(path=out, provider_id=urls[0], cost=config.IMAGE_COST)

    # the platform bills per discrete clip length, so an arbitrary request is
    # snapped to the nearest one it accepts and the caller is told
    SUPPORTED_SECONDS = (5, 10)

    def generate_clip(self, still: Path, prompt: str, negative: str, seconds: float, aspect: str, out: Path) -> GenResult:
        billed = min(self.SUPPORTED_SECONDS, key=lambda v: abs(v - seconds))
        payload = {"image": _b64_image(still, aspect), "prompt": prompt, "negative_prompt": negative,
                   "duration": str(billed), "cfg_scale": 0.5}
        urls = self._submit_and_wait(config.FREEPIK_VIDEO_PATH, payload)
        self._download(urls[0], out)
        note = "" if abs(billed - seconds) < 0.05 else f"asked for {seconds:.1f}s, provider billed {billed}s"
        return GenResult(path=out, provider_id=urls[0], cost=config.VIDEO_COST * (billed / 5.0), note=note)
