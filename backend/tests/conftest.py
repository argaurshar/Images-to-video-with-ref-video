import os
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_tmp = tempfile.mkdtemp(prefix="archviz_test_")
os.environ["ARCHVIZ_DATA_DIR"] = _tmp
os.environ["ARCHVIZ_PROVIDER"] = "mock"


def synth_exterior(w=960, h=540, seed=1) -> bytes:
    """A render-like image: sky, ground, a two-storey box with a window grid, a road, two trees."""
    rng = np.random.default_rng(seed)
    img = np.zeros((h, w, 3), np.uint8)
    img[: int(h * 0.55)] = (235, 200, 160)          # sky (BGR) bright bluish
    img[int(h * 0.55):] = (70, 110, 90)              # ground
    cv2.rectangle(img, (int(w * 0.3), int(h * 0.25)), (int(w * 0.7), int(h * 0.62)), (120, 130, 140), -1)  # building
    cv2.rectangle(img, (int(w * 0.3), int(h * 0.20)), (int(w * 0.7), int(h * 0.25)), (60, 60, 70), -1)     # roof
    for i in range(4):
        for j in range(2):
            x = int(w * 0.33) + i * int(w * 0.09)
            y = int(h * 0.30) + j * int(h * 0.15)
            cv2.rectangle(img, (x, y), (x + int(w * 0.05), y + int(h * 0.09)), (200, 230, 240), -1)
    cv2.rectangle(img, (0, int(h * 0.8)), (w, int(h * 0.9)), (60, 60, 60), -1)  # road
    for cx in (int(w * 0.15), int(w * 0.85)):
        cv2.circle(img, (cx, int(h * 0.5)), int(h * 0.12), (40, 120, 40), -1)
        cv2.rectangle(img, (cx - 6, int(h * 0.55)), (cx + 6, int(h * 0.7)), (30, 60, 90), -1)
    noise = rng.integers(0, 12, (h, w, 3), np.uint8)
    img = cv2.add(img, noise)
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def synth_interior(w=960, h=540, seed=2) -> bytes:
    rng = np.random.default_rng(seed)
    img = np.full((h, w, 3), (200, 205, 210), np.uint8)   # walls
    img[int(h * 0.7):] = (110, 140, 170)                   # timber floor
    img[: int(h * 0.12)] = (225, 225, 225)                  # ceiling
    cv2.rectangle(img, (int(w * 0.6), int(h * 0.2)), (int(w * 0.9), int(h * 0.65)), (245, 235, 220), -1)  # window
    cv2.rectangle(img, (int(w * 0.1), int(h * 0.45)), (int(w * 0.45), int(h * 0.7)), (90, 90, 95), -1)   # joinery
    cv2.rectangle(img, (int(w * 0.48), int(h * 0.1)), (int(w * 0.5), int(h * 0.7)), (60, 60, 60), -1)    # door edge
    cv2.circle(img, (int(w * 0.3), int(h * 0.15)), int(h * 0.03), (80, 160, 220), -1)                    # pendant
    noise = rng.integers(0, 10, (h, w, 3), np.uint8)
    img = cv2.add(img, noise)
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c
