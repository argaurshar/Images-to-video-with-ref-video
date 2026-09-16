"""Reference video measurement (spec Part 2). Measure, never watch casually."""
from __future__ import annotations

import subprocess
from pathlib import Path

import cv2
import numpy as np

from ...models import ReferenceAnalysis, ReferenceShot
from . import frames as F


def _hist(img: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h = cv2.calcHist([hsv], [0, 1, 2], None, [16, 8, 8], [0, 180, 0, 256, 0, 256])
    return cv2.normalize(h, h).flatten()


def _has_audio(path: Path) -> bool:
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        r = subprocess.run([exe, "-i", str(path)], capture_output=True, text=True, timeout=60)
        return "Audio:" in r.stderr
    except Exception:
        return False


def _streak_density(g: np.ndarray, band: slice | None = None) -> float:
    hp = np.abs(g - cv2.GaussianBlur(g, (0, 0), 3))
    region = hp if band is None else hp[band]
    return float((region > 18).mean())


def _scale_from_edges(g: np.ndarray) -> str:
    e = F.edge_map(g).mean()
    if e < 0.03:
        return "wide"
    if e < 0.06:
        return "medium"
    if e < 0.10:
        return "detail"
    return "macro"


def analyse_reference(path: str | Path) -> ReferenceAnalysis:
    path = Path(path)
    meta = F.video_meta(path)
    frames, times = F.sample_frames(path, sample_fps=10, max_w=320)
    if len(frames) < 2:
        raise ValueError("reference video is too short or unreadable")

    grays = [F.gray(f) for f in frames]
    hists = [_hist(f) for f in frames]
    diffs = np.array([cv2.compareHist(hists[i], hists[i + 1], cv2.HISTCMP_BHATTACHARYYA) for i in range(len(frames) - 1)])
    thr = max(0.35, float(diffs.mean() + 3 * diffs.std()))
    cuts = [0]
    for i, d in enumerate(diffs):
        if d > thr and (i + 1 - cuts[-1]) >= 5:  # at least 0.5 s per shot
            cuts.append(i + 1)
    cuts.append(len(frames))

    shots: list[ReferenceShot] = []
    for k in range(len(cuts) - 1):
        a, b = cuts[k], cuts[k + 1]
        seg = frames[a:b]
        gseg = grays[a:b]
        bright = float(np.mean([F.luminance(f) for f in seg]))
        # camera move from phase correlation between consecutive frames
        shifts = []
        for i in range(len(gseg) - 1):
            (dx, dy), _ = cv2.phaseCorrelate(gseg[i], gseg[i + 1])
            shifts.append(float(np.hypot(dx, dy)))
        mv = float(np.mean(shifts)) if shifts else 0.0
        move = "locked or drift" if mv < 0.4 else ("slow move" if mv < 1.5 else "fast move")
        sky = float(np.mean([F.sky_fraction(f) for f in seg]))
        shots.append(ReferenceShot(
            index=k + 1, start_s=round(times[a], 2), end_s=round(times[min(b, len(times) - 1)], 2),
            duration_s=round(times[min(b, len(times) - 1)] - times[a] + 0.1, 2),
            scale=_scale_from_edges(gseg[len(gseg) // 2]), brightness=round(bright, 3),
            camera_move=move, setting="exterior" if sky > 0.10 else "interior",
        ))

    lum_all = np.array([F.luminance(f) for f in frames])
    sat_all = np.array([F.saturation(f) for f in frames])
    warm_all = np.array([F.warmth(f) for f in frames])
    h = grays[0].shape[0]
    sky_band = slice(0, max(1, int(h * 0.3)))
    dens = float(np.mean([_streak_density(g) for g in grays]))
    dens_sky = float(np.mean([_streak_density(g, sky_band) for g in grays]))

    scales = [s.scale for s in shots]
    changes = sum(1 for i in range(1, len(scales)) if scales[i] != scales[i - 1])
    run, max_run = 1, 1
    for i in range(1, len(scales)):
        run = run + 1 if scales[i] == scales[i - 1] else 1
        max_run = max(max_run, run)
    pattern = "".join("E" if s.setting == "exterior" else "I" for s in shots)

    ra = ReferenceAnalysis(
        filename=path.name, duration_s=round(meta["duration"], 2), width=meta["width"], height=meta["height"],
        fps=round(meta["fps"], 2), aspect=_aspect(meta["width"], meta["height"]),
        shot_count=len(shots), mean_shot_length_s=round(meta["duration"] / max(1, len(shots)), 2),
        shots=shots, light_arc=[round(float(x), 3) for x in lum_all[:: max(1, len(lum_all) // 120)]],
        mean_brightness=round(float(lum_all.mean()), 3), mean_saturation=round(float(sat_all.mean()), 3),
        warmth=round(float(warm_all.mean()), 3),
        shadow_floor=round(float(np.percentile(np.concatenate([g.flatten() for g in grays[::5]]), 2) / 255.0), 3),
        highlight_ceiling=round(float(np.percentile(np.concatenate([g.flatten() for g in grays[::5]]), 98) / 255.0), 3),
        weather_density=round(dens, 4), sky_band_density=round(dens_sky, 4),
        has_audio=_has_audio(path),
        scale_changes_per_shot=round(changes / max(1, len(shots) - 1), 2), max_same_scale_run=max_run,
        inside_outside_pattern=pattern,
        caveat=("Match this reference's structure (shot length, rhythm, light arc, scale changes, inside/outside "
                "pattern). Do not copy its colour grade: grade to the real site and the real finishes."),
    )
    return ra


def _aspect(w: int, h: int) -> str:
    if not h:
        return ""
    r = w / h
    for name, val in (("16:9", 16 / 9), ("9:16", 9 / 16), ("1:1", 1.0), ("4:5", 0.8)):
        if abs(r - val) < 0.04:
            return name
    return f"{r:.2f}:1"
