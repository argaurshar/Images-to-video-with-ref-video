"""Shared frame utilities for reference analysis and QC."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def read_image(path: str | Path, max_w: int = 640) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"cannot read image {path}")
    return resize_w(img, max_w)


def resize_w(img: np.ndarray, max_w: int) -> np.ndarray:
    h, w = img.shape[:2]
    if w > max_w:
        s = max_w / w
        img = cv2.resize(img, (max_w, int(round(h * s))), interpolation=cv2.INTER_AREA)
    return img


def video_meta(path: str | Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError(f"cannot open video {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    cap.release()
    dur = n / fps if fps else 0.0
    return {"fps": fps, "frames": n, "width": w, "height": h, "duration": dur}


def sample_frames(path: str | Path, sample_fps: float = 10.0, max_w: int = 320,
                  max_frames: int = 3000) -> tuple[list[np.ndarray], list[float]]:
    """Return BGR frames sampled at roughly sample_fps and their timestamps."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError(f"cannot open video {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(fps / sample_fps)))
    frames, times = [], []
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            frames.append(resize_w(frame, max_w))
            times.append(i / fps)
            if len(frames) >= max_frames:
                break
        i += 1
    cap.release()
    return frames, times


def gray(img: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)


def luminance(img: np.ndarray) -> float:
    return float(gray(img).mean() / 255.0)


def saturation(img: np.ndarray) -> float:
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    return float(hsv[..., 1].mean() / 255.0)


def warmth(img: np.ndarray) -> float:
    """Red minus blue, normalised to -1..1. Positive is warm."""
    b, g, r = cv2.split(img.astype(np.float32))
    return float((r.mean() - b.mean()) / 255.0)


def mean_hue_deg(img: np.ndarray) -> float:
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h = hsv[..., 0].astype(np.float32) * 2.0  # OpenCV hue is 0..180
    s = hsv[..., 1].astype(np.float32) / 255.0
    ang = np.deg2rad(h)
    x = float((np.cos(ang) * s).sum())
    y = float((np.sin(ang) * s).sum())
    if abs(x) < 1e-6 and abs(y) < 1e-6:
        return 0.0
    return float(np.rad2deg(np.arctan2(y, x)) % 360.0)


def hue_diff_deg(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def sky_fraction(img: np.ndarray, band: float = 0.35) -> float:
    """Fraction of the top band that reads as sky. Sky is bluish, or it is a
    very bright, flat, unsaturated area that is clearly brighter than the
    rest of the image. A neutral ceiling fails both tests."""
    h = img.shape[0]
    top = img[: max(1, int(h * band))]
    hsv = cv2.cvtColor(top, cv2.COLOR_BGR2HSV)
    s = hsv[..., 1] / 255.0
    v = hsv[..., 2] / 255.0
    b, g, r = cv2.split(top.astype(np.float32))
    bluish = (b > r + 8) & (b >= g) & (v > 0.35)
    whole = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean() / 255.0
    margin = float(v.mean() - whole)
    bright_flat = (v > 0.78) & (s < 0.12) if margin > 0.2 else np.zeros_like(bluish)
    return float((bluish | bright_flat).mean())


def edge_map(g: np.ndarray, lo: int = 60, hi: int = 160) -> np.ndarray:
    blur = cv2.GaussianBlur(g.astype(np.uint8), (3, 3), 0)
    return cv2.Canny(blur, lo, hi) > 0


def align_affine(ref: np.ndarray, img: np.ndarray) -> np.ndarray:
    """Warp img onto ref with an affine fit (handles the slow push and sway
    of a drifting camera). Falls back to a pure translation if ECC does not
    converge."""
    h, w = ref.shape
    rb = cv2.GaussianBlur(ref, (0, 0), 2).astype(np.float32)
    ib = cv2.GaussianBlur(img, (0, 0), 2).astype(np.float32)
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(rb, ib, warp, cv2.MOTION_AFFINE,
                                       (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-4), None, 5)
        return cv2.warpAffine(img, warp, (w, h), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    except cv2.error:
        (dx, dy), _ = cv2.phaseCorrelate(ref, img)
        if abs(dx) < 40 and abs(dy) < 40:
            M = np.float32([[1, 0, -dx], [0, 1, -dy]])
            return cv2.warpAffine(img, M, (w, h), borderMode=cv2.BORDER_REPLICATE)
        return img


def edge_similarity(g0: np.ndarray, g1: np.ndarray, tol_px: int = 3, exclude: np.ndarray | None = None) -> float:
    """IoU of dilated edge maps after aligning g1 to g0. Tolerates a few
    pixels of handheld drift, catches structural change. `exclude` masks
    pixels that should not count (moving particles)."""
    g1 = align_affine(g0, g1)
    e0, e1 = edge_map(g0), edge_map(g1)
    if exclude is not None:
        e0 = e0 & ~exclude
        e1 = e1 & ~exclude
    k = np.ones((tol_px * 2 + 1, tol_px * 2 + 1), np.uint8)
    d0 = cv2.dilate(e0.astype(np.uint8), k) > 0
    d1 = cv2.dilate(e1.astype(np.uint8), k) > 0
    inter = ((e0 & d1).sum() + (e1 & d0).sum())
    union = e0.sum() + e1.sum()
    return float(inter / union) if union else 1.0


def new_edge_fraction(g_ref: np.ndarray, g_new: np.ndarray, tol_px: int = 4) -> float:
    """Fraction of edges in g_new that have no counterpart in g_ref: a proxy
    for invented elements."""
    e_ref, e_new = edge_map(g_ref), edge_map(g_new)
    k = np.ones((tol_px * 2 + 1, tol_px * 2 + 1), np.uint8)
    d_ref = cv2.dilate(e_ref.astype(np.uint8), k) > 0
    n = e_new.sum()
    return float((e_new & ~d_ref).sum() / n) if n else 0.0


def vertical_angle_deg(g: np.ndarray) -> float | None:
    """Median angle of near-vertical lines, in degrees from vertical.
    None if no vertical structure is found."""
    e = edge_map(g).astype(np.uint8) * 255
    lines = cv2.HoughLinesP(e, 1, np.pi / 360, threshold=50,
                            minLineLength=max(30, g.shape[0] // 3), maxLineGap=4)
    if lines is None:
        return None
    angs = []
    for x1, y1, x2, y2 in np.asarray(lines).reshape(-1, 4):
        dx, dy = x2 - x1, y2 - y1
        if dy == 0:
            continue
        a = np.degrees(np.arctan2(dx, dy))  # 0 = vertical
        a = ((a + 90) % 180) - 90
        if abs(a) < 15:
            angs.append(a)
    if not angs:
        return None
    return float(np.median(angs))


def dominant_colours(img: np.ndarray, k: int = 4) -> list[str]:
    small = cv2.resize(img, (64, 64), interpolation=cv2.INTER_AREA).reshape(-1, 3).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, labels, centers = cv2.kmeans(small, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.flatten(), minlength=k)
    order = np.argsort(-counts)
    out = []
    for i in order:
        b, g, r = centers[i]
        out.append("#%02x%02x%02x" % (int(r), int(g), int(b)))
    return out
