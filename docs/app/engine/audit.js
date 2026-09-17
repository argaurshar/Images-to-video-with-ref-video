/* Fidelity audit of a generated still against its hub render (spec Part 4),
   and the auto-detection that pre-fills the intake form (spec 1.1). Ports of
   backend/app/services/audit.py and services/analysis/hub.py.

   Numeric proxies plus the class checklist the human runs. The numbers catch
   gross drift; a season change legitimately alters edges (snow, foliage), so
   thresholds are lenient and the rating is advisory. */

import * as I from "./imaging.js";

export const CHECKLIST = {
  exterior: [
    "Floor count", "Window rhythm and count per elevation", "Door positions", "Roof geometry",
    "Material reading", "Canopies and balconies", "Site elements: walls, steps, paths, fences",
    "Road alignment", "Tree positions", "Canvas not extended",
  ],
  interior: [
    "Room proportion and ceiling height", "Position and count of openings", "Joinery runs and door counts",
    "Fixture and fitting count", "Furniture positions", "Finish colours and grain direction",
    "Artwork and objects", "Flooring pattern", "Verticals true", "Canvas not extended",
  ],
};

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

export function auditStill(hubImg, stillImg, cls = "exterior") {
  // both are resized to a common 512-wide frame by the caller
  const w = hubImg.w, h = hubImg.h;
  const g0 = I.gray(hubImg), g1 = I.gray(stillImg);
  const sim = I.edgeSimilarity(g0, g1, w, h);
  const newEdges = I.newEdgeFraction(g0, g1, w, h);
  const lum = Math.abs(I.luminance(stillImg) - I.luminance(hubImg));
  const hue = I.hueDiffDeg(I.meanHueDeg(hubImg), I.meanHueDeg(stillImg));
  const r = {
    rating: "not_run",
    structure_similarity: round(sim, 3),
    new_edge_fraction: round(newEdges, 3),
    luminance_shift: round(lum, 3),
    hue_shift_deg: round(hue, 1),
    driver: "",
    checklist: CHECKLIST[cls],
    notes: "",
  };
  if (sim >= 0.55 && newEdges <= 0.40) {
    r.rating = "pass"; r.driver = "structure holds";
  } else if (sim >= 0.40 && newEdges <= 0.55) {
    r.rating = "minor";
    r.driver = newEdges > 0.40 ? "new edges appeared" : "structure similarity is marginal";
  } else {
    r.rating = "fail";
    r.driver = sim < 0.40 ? "structure changed" : "many edges with no counterpart in the hub";
  }
  r.notes = "Proxy metrics. A season change moves foliage, snow and shadow edges, so run the checklist by eye " +
    "before approving. Luminance and hue shifts are expected and are reported for the grade, not the geometry.";
  return r;
}

/** Auto-detection on an uploaded render. Everything here is a heuristic to
    pre-fill the form; the designer confirms or corrects it. */
export function analyseHub(img, fullW, fullH) {
  const lum = I.luminance(img);
  const sat = I.saturation(img);
  const warm = I.warmth(img);
  const sky = I.skyFraction(img);
  // a window shows some sky; a facade shot shows a lot
  const cls = sky > 0.30 ? "exterior" : "interior";

  let tod;
  if (lum < 0.22) tod = "night";
  else if (lum < 0.40 && warm > 0.03) tod = "dusk";
  else if (warm > 0.10 && lum < 0.6) tod = "golden_hour";
  else if (lum > 0.72 && sat < 0.18) tod = "overcast_day";
  else tod = "day";

  // Warm bright small regions read as artificial lights on.
  const d = img.data;
  let warmBright = 0;
  for (let j = 0; j < d.length; j += 4) {
    const v = Math.max(d[j], d[j + 1], d[j + 2]) / 255;
    if (v > 0.85 && d[j] - d[j + 2] > 25) warmBright++;
  }
  warmBright /= d.length / 4;
  const lightsOn = warmBright > 0.004 && lum < 0.6;

  const vert = I.verticalAngleDeg(I.gray(img), img.w, img.h);
  return {
    width: fullW, height: fullH,
    suggested_class: cls,
    sky_fraction: round(sky, 3),
    luminance: round(lum, 3),
    saturation: round(sat, 3),
    warmth: round(warm, 3),
    colour_temperature: warm > 0.05 ? "warm" : (warm < -0.03 ? "cool" : "neutral"),
    time_of_day: tod,
    lights_on: lightsOn,
    dominant_colours: I.dominantColours(img),
    vertical_lean_deg: vert === null ? null : round(vert, 2),
    climate_hint: cls === "exterior" ? climateHint(lum, sat, warm) : "",
    aspect: aspectName(fullW, fullH),
  };
}

export function aspectName(w, h) {
  const r = h ? w / h : 1;
  const table = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:5", 0.8], ["3:2", 1.5], ["4:3", 4 / 3]];
  for (const [name, val] of table) if (Math.abs(r - val) < 0.04) return name;
  return `${r.toFixed(2)}:1`;
}

function climateHint(lum, sat, warm) {
  if (lum > 0.7 && sat > 0.3) return "bright, likely dry and sunny";
  if (lum > 0.6 && sat < 0.2) return "flat light, likely overcast or temperate";
  if (warm > 0.08) return "warm light, likely low sun or arid";
  return "unclear from the render; rely on the stated location";
}
