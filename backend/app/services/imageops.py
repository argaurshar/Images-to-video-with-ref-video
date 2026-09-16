"""Small image operations shared by providers and delivery.
Law 6: aspect changes are crops, never outpaints."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

ASPECTS = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0, "4:5": 4 / 5}


def crop_to_aspect(img: np.ndarray, aspect: str) -> np.ndarray:
    target = ASPECTS.get(aspect)
    if not target:
        return img
    h, w = img.shape[:2]
    cur = w / h
    if abs(cur - target) < 0.01:
        return img
    if cur > target:  # too wide: trim sides
        nw = int(round(h * target))
        x0 = (w - nw) // 2
        return img[:, x0: x0 + nw]
    nh = int(round(w / target))  # too tall: trim top and bottom, keep centre
    y0 = (h - nh) // 2
    return img[y0: y0 + nh]


def crop_loss(width: int, height: int, aspect: str) -> float:
    """Fraction of the original area a crop to `aspect` would discard."""
    target = ASPECTS.get(aspect)
    if not target or not height:
        return 0.0
    cur = width / height
    if cur > target:
        return 1.0 - target / cur
    return 1.0 - cur / target


def make_thumb(src: Path, dst: Path, max_w: int = 480) -> None:
    img = cv2.imread(str(src))
    if img is None:
        return
    h, w = img.shape[:2]
    if w > max_w:
        img = cv2.resize(img, (max_w, int(h * max_w / w)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(dst), img, [cv2.IMWRITE_JPEG_QUALITY, 82])


def video_first_frame(src: Path, dst: Path, max_w: int = 480) -> float:
    """Write the first frame as a thumbnail; return the clip's mean brightness
    over a coarse sample (used for the light-arc strip)."""
    cap = cv2.VideoCapture(str(src))
    ok, frame = cap.read()
    if not ok:
        cap.release()
        return 0.0
    h, w = frame.shape[:2]
    small = cv2.resize(frame, (max_w, int(h * max_w / w))) if w > max_w else frame
    cv2.imwrite(str(dst), small, [cv2.IMWRITE_JPEG_QUALITY, 82])
    lums = [cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean() / 255.0]
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    for pos in (n // 2, max(0, n - 2)):
        cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
        ok, f = cap.read()
        if ok:
            lums.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).mean() / 255.0)
    cap.release()
    return float(np.mean(lums))
