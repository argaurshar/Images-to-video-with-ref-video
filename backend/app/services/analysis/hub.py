"""Auto-detection on an uploaded render (spec 1.1). Everything here is a
heuristic to pre-fill the form. The designer confirms or corrects it."""
from __future__ import annotations

from pathlib import Path

from . import frames as F


def analyse_hub(path: str | Path) -> dict:
    img = F.read_image(path, 640)
    h, w = img.shape[:2]
    lum = F.luminance(img)
    sat = F.saturation(img)
    warm = F.warmth(img)
    sky = F.sky_fraction(img)

    cls = "exterior" if sky > 0.30 else "interior"  # a window shows some sky; a facade shot shows a lot

    if lum < 0.22:
        tod = "night"
    elif lum < 0.40 and warm > 0.03:
        tod = "dusk"
    elif warm > 0.10 and lum < 0.6:
        tod = "golden_hour"
    elif lum > 0.72 and sat < 0.18:
        tod = "overcast_day"
    else:
        tod = "day"

    # Warm bright small regions read as artificial lights on.
    import cv2
    import numpy as np
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    v = hsv[..., 2] / 255.0
    b, g, r = cv2.split(img.astype(np.float32))
    warm_bright = ((v > 0.85) & ((r - b) > 25)).mean()
    lights_on = bool(warm_bright > 0.004 and lum < 0.6)

    vert = F.vertical_angle_deg(F.gray(img))
    return {
        "width": w, "height": h,
        "suggested_class": cls,
        "sky_fraction": round(sky, 3),
        "luminance": round(lum, 3),
        "saturation": round(sat, 3),
        "warmth": round(warm, 3),
        "colour_temperature": "warm" if warm > 0.05 else ("cool" if warm < -0.03 else "neutral"),
        "time_of_day": tod,
        "lights_on": lights_on,
        "dominant_colours": F.dominant_colours(img),
        "vertical_lean_deg": None if vert is None else round(vert, 2),
        "climate_hint": _climate_hint(lum, sat, warm, sky) if cls == "exterior" else "",
        "aspect": _aspect_name(w, h),
    }


def _aspect_name(w: int, h: int) -> str:
    r = w / h if h else 1.0
    for name, val in (("16:9", 16 / 9), ("9:16", 9 / 16), ("1:1", 1.0), ("4:5", 0.8), ("3:2", 1.5), ("4:3", 4 / 3)):
        if abs(r - val) < 0.04:
            return name
    return f"{r:.2f}:1"


def _climate_hint(lum: float, sat: float, warm: float, sky: float) -> str:
    if lum > 0.7 and sat > 0.3:
        return "bright, likely dry and sunny"
    if lum > 0.6 and sat < 0.2:
        return "flat light, likely overcast or temperate"
    if warm > 0.08:
        return "warm light, likely low sun or arid"
    return "unclear from the render; rely on the stated location"
