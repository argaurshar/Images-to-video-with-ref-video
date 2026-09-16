"""Fidelity audit of a generated still against its hub render (spec Part 4).
Numeric proxies plus the class checklist the human runs. The numbers catch
gross drift; a season change legitimately alters edges (snow, foliage), so
thresholds are lenient and the rating is advisory."""
from __future__ import annotations

from pathlib import Path

import cv2

from ..models import AuditReport
from .analysis import frames as F

CHECKLIST = {
    "exterior": [
        "Floor count", "Window rhythm and count per elevation", "Door positions", "Roof geometry",
        "Material reading", "Canopies and balconies", "Site elements: walls, steps, paths, fences",
        "Road alignment", "Tree positions", "Canvas not extended",
    ],
    "interior": [
        "Room proportion and ceiling height", "Position and count of openings", "Joinery runs and door counts",
        "Fixture and fitting count", "Furniture positions", "Finish colours and grain direction",
        "Artwork and objects", "Flooring pattern", "Verticals true", "Canvas not extended",
    ],
}


def audit_still(hub_path: str | Path, still_path: str | Path, cls: str = "exterior") -> AuditReport:
    hub = F.read_image(hub_path, 512)
    still = F.read_image(still_path, 512)
    if still.shape[:2] != hub.shape[:2]:
        still = cv2.resize(still, (hub.shape[1], hub.shape[0]), interpolation=cv2.INTER_AREA)
    g0, g1 = F.gray(hub), F.gray(still)
    sim = F.edge_similarity(g0, g1)
    new_edges = F.new_edge_fraction(g0, g1)
    lum = abs(F.luminance(still) - F.luminance(hub))
    hue = F.hue_diff_deg(F.mean_hue_deg(hub), F.mean_hue_deg(still))
    r = AuditReport(
        structure_similarity=round(sim, 3), new_edge_fraction=round(new_edges, 3),
        luminance_shift=round(lum, 3), hue_shift_deg=round(hue, 1), checklist=CHECKLIST[cls],
    )
    if sim >= 0.55 and new_edges <= 0.40:
        r.rating, r.driver = "pass", "structure holds"
    elif sim >= 0.40 and new_edges <= 0.55:
        r.rating = "minor"
        r.driver = "new edges appeared" if new_edges > 0.40 else "structure similarity is marginal"
    else:
        r.rating = "fail"
        r.driver = "structure changed" if sim < 0.40 else "many edges with no counterpart in the hub"
    r.notes = ("Proxy metrics. A season change moves foliage, snow and shadow edges, so run the checklist by eye "
               "before approving. Luminance and hue shifts are expected and are reported for the grade, not the geometry.")
    return r
