/* Automated clip QC (spec Part 8). A port of
   backend/app/services/analysis/qc.py. Runs on every clip before it is shown.
   Thresholds are unchanged from the server version so a clip that passed there
   passes here. */

import * as I from "./imaging.js";
import { sampleFrames } from "./video.js";

export const THRESHOLDS = {
  motion_min: 1.5, motion_max: 8.0, motion_dead: 1.0,
  frozen_max: 0.35, frozen_painted: 0.5,
  density_min: 0.03, density_max: 0.10, density_downpour: 0.12,
  geometry_min: 0.50,
  region_min: 0.15,
  vertical_max_deg: 1.0,
  lum_max: 0.06, hue_max_deg: 8.0,
};

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/** Where precipitation is allowed to be measured.

    For an exterior this is open sky, and it has to be tested rather than
    assumed: a detail or macro shot has no sky at all, and a fixed top-30%
    rectangle would measure brick coursing as rain. When the top band is not
    actually sky the mask comes back empty, which reads as "no precipitation
    measured here" instead of a false reading. */
function bandMask(grays, w, h, cls, frame) {
  const m = new Uint8Array(w * h);
  if (cls === "exterior") {
    const band = Math.max(1, Math.round(h * 0.3));
    const d = frame.data;
    let sky = 0;
    const flags = new Uint8Array(band * w);
    for (let y = 0; y < band; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, j = i * 4;
        const r = d[j], g = d[j + 1], b = d[j + 2];
        const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
        const sat = mx > 0 ? (mx - mn) / mx : 0, val = mx;
        const isSky = (b > r + 8 && b >= g && val > 0.35) || (val > 0.72 && sat < 0.18);
        if (isSky) { flags[i] = 1; sky++; }
      }
    }
    if (sky / (band * w) < 0.25) return m;   // not an open-sky shot: measure nothing
    for (let i = 0; i < flags.length; i++) m[i] = flags[i];
    return m;
  }
  // interior: glazing band = the brightest quarter of the temporal mean
  const mean = new Float32Array(w * h);
  for (const g of grays) for (let i = 0; i < g.length; i++) mean[i] += g[i] / grays.length;
  const thr = I.percentile(mean, 75);
  for (let i = 0; i < mean.length; i++) m[i] = mean[i] >= thr ? 1 : 0;
  return m;
}

/** Glyph-like clusters that appeared between the first and last frame: a
    proxy for a burnt-in caption or watermark. */
function textSuspect(g0, g1, w, h) {
  const m = new Uint8Array(w * h);
  for (let i = 0; i < g0.length; i++) if (Math.abs(g1[i] - g0[i]) > 90) m[i] = 1;
  const { stats } = I.connectedComponents(m, w, h);
  const small = stats.slice(1).filter((s) => {
    const ratio = Math.max(s.w, s.h) / Math.max(1, Math.min(s.w, s.h));
    return s.area >= 12 && s.area <= 400 && s.h < h * 0.12 && ratio <= 2.5;
  });
  if (small.length < 12) return false;
  // glyphs sit on a common baseline: many components within a narrow row band
  const bins = Math.max(4, Math.floor(h / 12));
  const hist = new Array(bins).fill(0);
  for (const s of small) hist[Math.min(bins - 1, Math.floor((s.y / h) * bins))]++;
  const hs = small.map((s) => s.h);
  const mean = I.meanOf(hs);
  const sd = Math.sqrt(I.meanOf(hs.map((x) => (x - mean) ** 2)));
  return Math.max(...hist) >= 10 && sd < 0.35 * Math.max(1, mean);
}

export async function runQC(blob, cls = "exterior", expectsParticles = false, onProgress = null) {
  const r = {
    ran: true, motion_score: 0, frozen_ratio: 0, particle_density: 0, geometry_similarity: 1,
    regions: {}, vertical_drift_deg: 0, vertical_measured: true, luminance_drift: 0, hue_drift_deg: 0,
    text_suspect: false, frames_sampled: 0, passed: false, failures: [], interpretation: "",
  };
  let frames;
  try {
    ({ frames } = await sampleFrames(blob, { sampleFps: 10, maxW: 480, maxFrames: 120, onProgress }));
  } catch (e) {
    r.failures.push("unreadable: " + e.message);
    r.interpretation = "Clip could not be sampled; regenerate or check the file.";
    return r;
  }
  r.frames_sampled = frames.length;
  if (frames.length < 3) {
    r.failures.push("unreadable: fewer than 3 frames sampled");
    r.interpretation = "Clip could not be sampled; regenerate or check the file.";
    return r;
  }
  const w = frames[0].w, h = frames[0].h;
  const grays = frames.map((f) => I.gray(f));

  // motion: mean absolute difference between consecutive sampled frames
  let motion = 0, pairs = 0;
  for (let t = 1; t < grays.length; t++) {
    let s = 0;
    for (let i = 0; i < grays[t].length; i++) s += Math.abs(grays[t][i] - grays[t - 1][i]);
    motion += s / grays[t].length; pairs++;
  }
  r.motion_score = round(pairs ? motion / pairs : 0, 3);

  // frozen ratio (Part 8): particle marks in the open-sky (or glazing) band of
  // the first frame that are still there, unmoved, in the camera-aligned later
  // frames. Real precipitation travels and leaves; a painted overlay stays put.
  const structure = I.structureMask(grays[0], w, h);
  const band = bandMask(grays, w, h, cls, frames[0]);
  const p0 = I.particleMask(grays[0], w, h, structure);
  const s0 = new Uint8Array(w * h);
  let s0n = 0;
  for (let i = 0; i < s0.length; i++) if (p0[i] && band[i]) { s0[i] = 1; s0n++; }
  if (s0n > 30) {
    const stride = Math.max(1, Math.floor(grays.length / 12));
    const persist = [];
    for (let t = Math.floor(grays.length / 2); t < grays.length; t += stride) {
      const ga = I.alignTo(grays[0], grays[t], w, h);
      // only particle-shaped marks count as "the streak is still there"; any
      // high-pass energy gave a chance-overlap floor that rose with density,
      // so heavy but correctly travelling rain read as frozen
      const m = I.dilate(I.particleMask(ga, w, h, structure), w, h, 1);
      let hit = 0;
      for (let i = 0; i < s0.length; i++) if (s0[i] && m[i]) hit++;
      persist.push(hit / s0n);
    }
    r.frozen_ratio = round(Math.min(1, Math.max(0, I.meanOf(persist))), 3);
  }

  // particle density: streak-shaped marks in the measured band
  let bandN = 0;
  for (let i = 0; i < band.length; i++) bandN += band[i];
  if (bandN) {
    const dens = [];
    for (let t = 0; t < grays.length; t += 2) {
      const pm = I.particleMask(grays[t], w, h, structure);
      let hit = 0;
      for (let i = 0; i < pm.length; i++) if (pm[i] && band[i]) hit++;
      dens.push(hit / bandN);
    }
    r.particle_density = round(I.meanOf(dens), 4);
  }

  const pLast = I.particleMask(grays[grays.length - 1], w, h, structure);
  const moving = new Uint8Array(w * h);
  for (let i = 0; i < moving.length; i++) moving[i] = p0[i] || pLast[i] ? 1 : 0;
  r.geometry_similarity = round(
    I.edgeSimilarity(grays[0], grays[grays.length - 1], w, h, 3, I.dilate(moving, w, h, 1)), 3);

  // regional motion: the camera can move while the world stands still
  const rowBand = (y0, y1) => {
    let s = 0, n = 0;
    for (let t = 1; t < grays.length; t++) {
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) { s += Math.abs(grays[t][y * w + x] - grays[t - 1][y * w + x]); n++; }
      }
    }
    return n ? s / n : 0;
  };
  const colBand = () => {
    let s = 0, n = 0;
    const lw = Math.floor(w * 0.15), rw = Math.floor(w * 0.85);
    for (let t = 1; t < grays.length; t++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (x >= lw && x < rw) continue;
          s += Math.abs(grays[t][y * w + x] - grays[t - 1][y * w + x]); n++;
        }
      }
    }
    return n ? s / n : 0;
  };
  r.regions = {
    sky: round(rowBand(0, Math.floor(h * 0.3)), 3),
    mid: round(rowBand(Math.floor(h * 0.3), Math.floor(h * 0.7)), 3),
    ground: round(rowBand(Math.floor(h * 0.7), h), 3),
    edges: round(colBand(), 3),
  };

  const movingV = I.dilate(moving, w, h, 2);
  const a0 = I.verticalAngleDeg(grays[0], w, h, movingV);
  const a1 = I.verticalAngleDeg(grays[grays.length - 1], w, h, movingV);
  if (a0 === null || a1 === null) {
    // no building verticals to measure: say so rather than report a passing
    // 0.00 degrees for a check that never ran
    r.vertical_drift_deg = 0;
    r.vertical_measured = false;
  } else {
    r.vertical_drift_deg = round(Math.abs(a1 - a0), 3);
    r.vertical_measured = true;
  }

  const l0 = I.meanOf(grays[0]), l1 = I.meanOf(grays[grays.length - 1]);
  r.luminance_drift = round(Math.abs(l1 - l0) / Math.max(l0, 1), 4);
  r.hue_drift_deg = round(I.hueDiffDeg(I.meanHueDeg(frames[0]), I.meanHueDeg(frames[frames.length - 1])), 2);
  r.text_suspect = textSuspect(grays[0], grays[grays.length - 1], w, h);

  const T = THRESHOLDS, f = r.failures, notes = [];
  if (r.motion_score < T.motion_dead) {
    f.push("motion: dead clip"); notes.push("Motion under 1.0: dead clip, the still had nothing to animate.");
  } else if (r.motion_score < T.motion_min) {
    f.push("motion: too low"); notes.push("Motion is under 1.5: barely alive. Add one light cue near camera.");
  } else if (r.motion_score > T.motion_max) {
    f.push("motion: too high"); notes.push("Motion over 8.0: the camera or the weather is doing too much.");
  }
  // a frozen overlay is a precipitation problem: only judge it when the clip
  // carries particle content (in the band, or by brief)
  const hasParticles = expectsParticles || r.particle_density >= 0.02;
  if (hasParticles && r.frozen_ratio > T.frozen_painted) {
    f.push("frozen: painted overlay"); notes.push("Frozen ratio above 0.5: a painted overlay standing still. The cue was too heavy.");
  } else if (hasParticles && r.frozen_ratio > T.frozen_max) {
    f.push("frozen: above 0.35"); notes.push("Frozen ratio above 0.35: some streaks are not travelling.");
  }
  if (r.particle_density > T.density_downpour) {
    f.push("density: invented downpour"); notes.push("Density above 12%: the model invented its own downpour.");
  } else if (expectsParticles && r.particle_density < T.density_min) {
    f.push("density: no precipitation"); notes.push("Density under 3% on a shot that asked for precipitation.");
  } else if (r.particle_density > T.density_max) {
    f.push("density: above 10%"); notes.push("Density above 10%: too much weather for the building to read.");
  }
  if (r.geometry_similarity < T.geometry_min) {
    f.push("geometry: structural change"); notes.push("First and last frame edges disagree: geometry drifted. Regenerate from the hub.");
  }
  const dead = Object.entries(r.regions).filter(([, v]) => v < T.region_min).map(([k]) => k);
  if (dead.length && r.motion_score >= T.motion_min) {
    f.push("region: " + dead.join(",")); notes.push("Motion fine but only in some regions: the camera moved, the world did not.");
  }
  if (r.vertical_measured && r.vertical_drift_deg > T.vertical_max_deg) {
    f.push("vertical drift"); notes.push("Verticals lean by more than 1 degree: the room or facade is tilting.");
  }
  if (r.luminance_drift > T.lum_max) {
    f.push("exposure drift"); notes.push("Exposure drifts more than 6%: the clip will pop at the cut.");
  }
  if (r.hue_drift_deg > T.hue_max_deg) {
    f.push("colour drift"); notes.push("Hue drifts more than 8 degrees: colour is not holding.");
  }
  if (r.text_suspect) {
    f.push("text suspect"); notes.push("Glyph-like clusters appeared that are absent from the still. Check for text or watermark.");
  }
  if (!r.vertical_measured) notes.push("Verticals could not be measured on this framing, so that check did not run.");
  r.passed = f.length === 0;
  r.interpretation = notes.length ? notes.join(" ") : "All metrics inside range.";
  return r;
}

/** Mean brightness of a clip, used for the sequence light strip. */
export async function meanBrightness(blob) {
  const { frames } = await sampleFrames(blob, { sampleFps: 2, maxW: 160, maxFrames: 20 });
  if (!frames.length) return 0;
  return round(I.meanOf(frames.map((f) => I.luminance(f))), 3);
}
