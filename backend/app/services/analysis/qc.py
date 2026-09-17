"""Automated clip QC (spec Part 8). Runs on every clip before it is shown."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from ...models import QCReport
from . import frames as F

THRESHOLDS = {
    "motion_min": 1.5, "motion_max": 8.0, "motion_dead": 1.0,
    "frozen_max": 0.35, "frozen_painted": 0.5,
    "density_min": 0.03, "density_max": 0.10, "density_downpour": 0.12,
    "geometry_min": 0.50,
    "region_min": 0.15,
    "vertical_max_deg": 1.0,
    "lum_max": 0.06, "hue_max_deg": 8.0,
}


def _highpass(g: np.ndarray) -> np.ndarray:
    return np.abs(g - cv2.GaussianBlur(g, (0, 0), 2.5))


def _structure_mask(g: np.ndarray, tol_px: int = 3) -> np.ndarray:
    """Long straight lines in a frame: facade edges, joinery, roads."""
    e = F.edge_map(g).astype(np.uint8) * 255
    lines = cv2.HoughLinesP(e, 1, np.pi / 180, threshold=40, minLineLength=max(20, min(g.shape) // 5), maxLineGap=4)
    m = np.zeros(g.shape, np.uint8)
    if lines is not None:
        for x1, y1, x2, y2 in np.asarray(lines).reshape(-1, 4):
            cv2.line(m, (int(x1), int(y1)), (int(x2), int(y2)), 255, tol_px * 2 + 1)
    return m > 0


def _particle_mask(g: np.ndarray, structure: np.ndarray, thr: float = 12.0) -> np.ndarray:
    """Small high-pass components: rain streaks, snow flakes, petals, drifting
    leaves. Single-pixel grain and large blobs are excluded. Used only inside
    the sky or glazing band, where facade texture does not reach."""
    hp = (_highpass(g) > thr).astype(np.uint8)
    hp[structure] = 0
    n, labels, stats, _ = cv2.connectedComponentsWithStats(hp, connectivity=8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        w, h, area = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT], stats[i, cv2.CC_STAT_AREA]
        if 3 <= area <= 300 and max(w, h) <= 80:
            keep[i] = True
    return keep[labels]


def _band_mask(grays: list[np.ndarray], cls: str, frame: np.ndarray | None = None) -> np.ndarray:
    """Where precipitation is allowed to be measured.

    For an exterior this is open sky, and it has to be tested rather than
    assumed: a detail or macro shot has no sky at all, and a fixed top-30%
    rectangle would measure brick coursing as rain. When the top band is not
    actually sky the mask comes back empty, which reads as "no precipitation
    measured here" instead of a false reading.
    """
    h, w = grays[0].shape
    if cls == "exterior":
        m = np.zeros((h, w), bool)
        band = max(1, int(h * 0.30))
        if frame is not None:
            top = frame[:band]
            hsv = cv2.cvtColor(top, cv2.COLOR_BGR2HSV)
            sat = hsv[..., 1] / 255.0
            val = hsv[..., 2] / 255.0
            b, g_, r = cv2.split(top.astype(np.float32))
            sky = ((b > r + 8) & (b >= g_) & (val > 0.35)) | ((val > 0.72) & (sat < 0.18))
            if sky.mean() < 0.25:        # not an open-sky shot: measure nothing
                return m
            m[:band] = sky
            return m
        m[:band] = True
        return m
    # interior: glazing band = the brightest quarter of the temporal mean
    mean = np.mean(grays, axis=0)
    thr = np.percentile(mean, 75)
    return mean >= thr


def _text_suspect(g0: np.ndarray, g1: np.ndarray) -> bool:
    d = np.abs(g1 - g0)
    m = (d > 90).astype(np.uint8)
    n, _, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    small = [s for s in stats[1:] if 12 <= s[cv2.CC_STAT_AREA] <= 400 and s[cv2.CC_STAT_HEIGHT] < g0.shape[0] * 0.12
             and max(s[cv2.CC_STAT_WIDTH], s[cv2.CC_STAT_HEIGHT]) / max(1, min(s[cv2.CC_STAT_WIDTH], s[cv2.CC_STAT_HEIGHT])) <= 2.5]
    if len(small) < 12:
        return False
    ys = np.array([s[cv2.CC_STAT_TOP] for s in small])
    # glyphs sit on a common baseline: many components within a narrow row band
    hs = np.array([s[cv2.CC_STAT_HEIGHT] for s in small])
    hist, _ = np.histogram(ys, bins=max(4, g0.shape[0] // 12))
    return bool(hist.max() >= 10 and hs.std() < 0.35 * max(1.0, hs.mean()))


def run_qc(clip_path: str | Path, cls: str = "exterior", expects_particles: bool = False) -> QCReport:
    frames, _ = F.sample_frames(clip_path, sample_fps=10, max_w=480)
    r = QCReport(ran=True, frames_sampled=len(frames))
    if len(frames) < 3:
        r.failures.append("unreadable: fewer than 3 frames sampled")
        r.interpretation = "Clip could not be sampled; regenerate or check the file."
        return r
    grays = [F.gray(f) for f in frames]
    stack = np.stack(grays)  # T,H,W
    diffs = np.abs(np.diff(stack, axis=0))
    r.motion_score = round(float(diffs.mean()), 3)

    # frozen ratio (Part 8): particle marks in the open-sky (or glazing) band
    # of the first frame that are still there, unmoved, in the camera-aligned
    # later frames. Real precipitation travels and leaves; a painted overlay
    # stays put. Judged in the band only, so mullions, downpipes and trunks
    # do not count.
    structure = _structure_mask(grays[0])
    band = _band_mask(grays, cls, frames[0])
    s0 = _particle_mask(grays[0], structure) & band
    if s0.sum() > 30:
        k = np.ones((3, 3), np.uint8)
        later = grays[len(grays) // 2::max(1, len(grays) // 12)]
        persist = []
        for g in later:
            ga = F.align_affine(grays[0], g)
            # only particle-shaped marks count as "the streak is still there";
            # any-high-pass-energy gave a chance-overlap floor that rose with
            # density, so heavy but correctly travelling rain read as frozen
            m = cv2.dilate(_particle_mask(ga, structure).astype(np.uint8), k) > 0
            persist.append(m[s0].mean())
        r.frozen_ratio = round(float(np.clip(np.mean(persist), 0.0, 1.0)), 3)
    else:
        r.frozen_ratio = 0.0

    # particle density: streak-shaped marks in the open-sky band (exterior)
    # or the glazing band (interior), averaged over the sampled frames
    if band.sum():
        dens = [float((_particle_mask(g, structure) & band).sum() / band.sum()) for g in grays[::2]]
        r.particle_density = round(float(np.mean(dens)), 4)

    moving = _particle_mask(grays[0], structure) | _particle_mask(grays[-1], structure)
    r.geometry_similarity = round(F.edge_similarity(grays[0], grays[-1], exclude=cv2.dilate(moving.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0), 3)

    h, w = grays[0].shape
    regions = {
        "sky": diffs[:, : int(h * 0.3), :], "mid": diffs[:, int(h * 0.3): int(h * 0.7), :],
        "ground": diffs[:, int(h * 0.7):, :],
        "edges": np.concatenate([diffs[:, :, : int(w * 0.15)], diffs[:, :, int(w * 0.85):]], axis=2),
    }
    r.regions = {k: round(float(v.mean()), 3) for k, v in regions.items()}

    moving_v = cv2.dilate(moving.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    a0 = F.vertical_angle_deg(grays[0], exclude=moving_v)
    a1 = F.vertical_angle_deg(grays[-1], exclude=moving_v)
    if a0 is None or a1 is None:
        # no building verticals to measure: say so rather than report a
        # passing 0.00 degrees for a check that never ran
        r.vertical_drift_deg = 0.0
        r.vertical_measured = False
    else:
        r.vertical_drift_deg = round(abs(a1 - a0), 3)
        r.vertical_measured = True

    l0, l1 = grays[0].mean(), grays[-1].mean()
    r.luminance_drift = round(float(abs(l1 - l0) / max(l0, 1.0)), 4)
    r.hue_drift_deg = round(F.hue_diff_deg(F.mean_hue_deg(frames[0]), F.mean_hue_deg(frames[-1])), 2)
    r.text_suspect = _text_suspect(grays[0], grays[-1])

    T = THRESHOLDS
    f = r.failures
    notes = []
    if r.motion_score < T["motion_dead"]:
        f.append("motion: dead clip"); notes.append("Motion under 1.0: dead clip, the still had nothing to animate.")
    elif r.motion_score < T["motion_min"]:
        f.append("motion: too low"); notes.append("Motion is under 1.5: barely alive. Add one light cue near camera.")
    elif r.motion_score > T["motion_max"]:
        f.append("motion: too high"); notes.append("Motion over 8.0: the camera or the weather is doing too much.")
    # a frozen overlay is a precipitation problem: only judge it when the
    # clip carries particle content (in the band, or by brief)
    has_particles = expects_particles or r.particle_density >= 0.02
    if has_particles and r.frozen_ratio > T["frozen_painted"]:
        f.append("frozen: painted overlay"); notes.append("Frozen ratio above 0.5: a painted overlay standing still. The cue was too heavy.")
    elif has_particles and r.frozen_ratio > T["frozen_max"]:
        f.append("frozen: above 0.35"); notes.append("Frozen ratio above 0.35: some streaks are not travelling.")
    if r.particle_density > T["density_downpour"]:
        f.append("density: invented downpour"); notes.append("Density above 12%: the model invented its own downpour.")
    elif expects_particles and r.particle_density < T["density_min"]:
        f.append("density: no precipitation"); notes.append("Density under 3% on a shot that asked for precipitation.")
    elif r.particle_density > T["density_max"]:
        f.append("density: above 10%"); notes.append("Density above 10%: too much weather for the building to read.")
    if r.geometry_similarity < T["geometry_min"]:
        f.append("geometry: structural change"); notes.append("First and last frame edges disagree: geometry drifted. Regenerate from the hub.")
    dead_regions = [k for k, v in r.regions.items() if v < T["region_min"]]
    if dead_regions and r.motion_score >= T["motion_min"]:
        f.append("region: " + ",".join(dead_regions)); notes.append("Motion fine but only in some regions: the camera moved, the world did not.")
    if r.vertical_measured and r.vertical_drift_deg > T["vertical_max_deg"]:
        f.append("vertical drift"); notes.append("Verticals lean by more than 1 degree: the room or facade is tilting.")
    if r.luminance_drift > T["lum_max"]:
        f.append("exposure drift"); notes.append("Exposure drifts more than 6%: the clip will pop at the cut.")
    if r.hue_drift_deg > T["hue_max_deg"]:
        f.append("colour drift"); notes.append("Hue drifts more than 8 degrees: colour is not holding.")
    if r.text_suspect:
        f.append("text suspect"); notes.append("Glyph-like clusters appeared that are absent from the still. Check for text or watermark.")
    if not r.vertical_measured:
        notes.append("Verticals could not be measured on this framing, so that check did not run.")
    r.passed = not f
    r.interpretation = " ".join(notes) if notes else "All metrics inside range."
    return r
