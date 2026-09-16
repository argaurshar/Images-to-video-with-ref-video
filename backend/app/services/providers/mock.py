"""Mock provider. Produces plausible stills and clips locally so the whole
pipeline, the audit and the QC can be exercised without an API key. Stills
are the hub render with a season and time treatment; clips are the still with
a slow drift and temporal grain, made with ffmpeg."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import cv2
import numpy as np

from ... import config
from ..imageops import crop_to_aspect
from .base import GenResult, Provider, ProviderError


def _ffmpeg() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


class MockProvider(Provider):
    name = "mock"

    def generate_still(self, source: Path, prompt: str, negative: str, aspect: str, out: Path) -> GenResult:
        img = cv2.imread(str(source))
        if img is None:
            raise ProviderError(f"cannot read {source}")
        img = crop_to_aspect(img, aspect).astype(np.float32)
        pl = prompt.lower()
        season = next((s for s in ("winter", "monsoon", "autumn", "spring", "summer") if re.search(rf"\b{s}\b", pl)), "summer")
        night = "night" in pl and "no sun" in pl
        golden = "golden hour" in pl
        dusk = "blue hour" in pl
        b, g, r = cv2.split(img)
        if season == "winter":
            gray = 0.3 * r + 0.59 * g + 0.11 * b
            r, g, b = 0.6 * r + 0.4 * gray + 12, 0.6 * g + 0.4 * gray + 14, 0.6 * b + 0.4 * gray + 22
        elif season == "monsoon":
            r, g, b = r * 0.78, g * 0.84, b * 0.95
        elif season == "autumn":
            r, g, b = r * 1.08 + 6, g * 0.98, b * 0.86
        elif season == "spring":
            r, g, b = r * 0.98, g * 1.05 + 4, b * 0.96
        if night:
            r, g, b = r * 0.22 + 2, g * 0.24 + 3, b * 0.34 + 10
        elif dusk:
            r, g, b = r * 0.55, g * 0.6, b * 0.85
        elif golden:
            r, g, b = r * 1.12 + 10, g * 1.0, b * 0.8
        img = cv2.merge([b, g, r])
        img = np.clip(img, 0, 255).astype(np.uint8)
        h, w = img.shape[:2]
        rng = np.random.default_rng(abs(hash(prompt)) % (2**32))
        # light motion cues only: a few sparse streaks near camera (bottom-left third)
        if ("rain" in pl or "shower" in pl or "drops" in pl) and "clear after" not in pl and not night:
            for _ in range(6):  # light cue only: a few streaks near camera
                x = int(rng.integers(0, w // 3)); y = int(rng.integers(h // 2, h - 20))
                cv2.line(img, (x, y), (x + 3, y + int(rng.integers(12, 28))), (235, 235, 235), 2, cv2.LINE_AA)
        if "snow" in pl:
            for _ in range(60):
                x = int(rng.integers(0, w)); y = int(rng.integers(0, h))
                cv2.circle(img, (x, y), int(rng.integers(1, 3)), (250, 250, 250), -1, cv2.LINE_AA)
        out.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        return GenResult(path=out, provider_id="mock-still", cost=config.IMAGE_COST, note="simulated generation; cost is the configured rate, not a real charge")

    def generate_clip(self, still: Path, prompt: str, negative: str, seconds: float, aspect: str, out: Path) -> GenResult:
        img = cv2.imread(str(still))
        if img is None:
            raise ProviderError(f"cannot read {still}")
        h, w = img.shape[:2]
        w2, h2 = (w // 2) * 2, (h // 2) * 2
        frames = int(seconds * config.OUTPUT_FPS)
        # slow push + gentle sway, temporal grain so every region has motion
        # slow push, gentle sway of a few pixels, temporal grain; the sway is
        # what real image-to-video models do with a "handheld drift" brief
        vf = (f"scale={w2*2}:{h2*2},zoompan=z='1.0+0.03*on/{frames}':"
              f"x='iw/2-(iw/zoom/2)+14*sin(on/11)':y='ih/2-(ih/zoom/2)+10*cos(on/13)':d={frames}:s={w2}x{h2}:fps={config.OUTPUT_FPS},"
              f"noise=alls=16:allf=t+u,format=yuv420p")
        out.parent.mkdir(parents=True, exist_ok=True)
        pl = prompt.lower()
        precip = ("rain falls" in pl) or ("snow falls" in pl)
        inputs = ["-loop", "1", "-i", str(still)]
        if precip:
            # a sparse streak layer that scrolls through the frame: every
            # particle travels and leaves, the way the motion brief asks
            layer = out.with_suffix(".streaks.png")
            rng = np.random.default_rng(7)
            rgba = np.zeros((h2, w2, 4), np.uint8)
            snow = "snow falls" in pl
            for _ in range(80 if not snow else 240):
                x = int(rng.integers(0, w2)); y = int(rng.integers(0, h2))
                if snow:
                    cv2.circle(rgba, (x, y), int(rng.integers(3, 6)), (250, 250, 250, 230), -1, cv2.LINE_AA)
                else:
                    L = int(rng.integers(30, 70))
                    cv2.line(rgba, (x, y), (x + L // 8, y + L), (185, 185, 200, 235), 3, cv2.LINE_AA)
            cv2.imwrite(str(layer), rgba)
            speed = 200 if not snow else 80
            inputs += ["-loop", "1", "-i", str(layer)]
            fc = (f"[0:v]{vf}[base];[1:v]format=rgba,split[s1][s2];"
                  f"[base][s1]overlay=x=0:y='-{h2}+mod(t*{speed},{h2})'[o1];[o1][s2]overlay=x=0:y='mod(t*{speed},{h2})',format=yuv420p[v]")
            cmd = [_ffmpeg(), "-y", "-loglevel", "error", *inputs, "-t", f"{seconds}", "-filter_complex", fc, "-map", "[v]",
                   "-r", str(config.OUTPUT_FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", str(out)]
        else:
            cmd = [_ffmpeg(), "-y", "-loglevel", "error", *inputs, "-t", f"{seconds}",
                   "-vf", vf, "-r", str(config.OUTPUT_FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", str(out)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise ProviderError(r.stderr[-800:])
        return GenResult(path=out, provider_id="mock-clip", cost=config.VIDEO_COST, note="simulated generation; cost is the configured rate, not a real charge")
