"""Runtime configuration. Everything comes from environment variables so a
practice can run the same code with the mock provider on a laptop and a real
provider in production without touching the source."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("ARCHVIZ_DATA_DIR", ROOT / "data")).resolve()
FRONTEND_DIR = ROOT / "frontend"

# Which generation backend to use: "mock" (local, free, for testing the
# pipeline) or "freepik" (Freepik / Magnific API for images and video).
PROVIDER = os.environ.get("ARCHVIZ_PROVIDER", "mock").lower()

# Pricing used for the budget gate and the running ledger. Override per
# provider contract. Units are whatever currency the practice bills in.
IMAGE_COST = float(os.environ.get("ARCHVIZ_IMAGE_COST", "0.08"))
VIDEO_COST = float(os.environ.get("ARCHVIZ_VIDEO_COST", "0.28"))
RESERVE_FRACTION = float(os.environ.get("ARCHVIZ_RESERVE_FRACTION", "0.20"))

# Hard rule from the spec: after this many failed attempts on one shot the
# engine stops and recommends a cut.
MAX_ATTEMPTS_PER_SHOT = int(os.environ.get("ARCHVIZ_MAX_ATTEMPTS", "2"))

CLIP_SECONDS = float(os.environ.get("ARCHVIZ_CLIP_SECONDS", "5"))
OUTPUT_FPS = 30

# Freepik / Magnific provider settings. Endpoints are configurable because
# model names on that platform change; check the current API reference.
FREEPIK_API_KEY = os.environ.get("FREEPIK_API_KEY", "")
FREEPIK_BASE_URL = os.environ.get("FREEPIK_BASE_URL", "https://api.freepik.com/v1")
FREEPIK_IMAGE_EDIT_PATH = os.environ.get(
    "FREEPIK_IMAGE_EDIT_PATH", "/ai/gemini-2-5-flash-image-preview"
)
FREEPIK_VIDEO_PATH = os.environ.get(
    "FREEPIK_VIDEO_PATH", "/ai/image-to-video/kling-v2-5-pro"
)
FREEPIK_POLL_SECONDS = float(os.environ.get("FREEPIK_POLL_SECONDS", "4"))
FREEPIK_TIMEOUT_SECONDS = float(os.environ.get("FREEPIK_TIMEOUT_SECONDS", "600"))

# Optional: use Claude to write the location profile and polish prompts.
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")


def ensure_dirs() -> None:
    (DATA_DIR / "projects").mkdir(parents=True, exist_ok=True)
