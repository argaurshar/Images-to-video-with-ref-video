/* Reference video measurement (spec Part 2). A port of
   backend/app/services/analysis/reference.py. Measure, never watch casually. */

import * as I from "./imaging.js";
import { sampleFrames, hasAudio } from "./video.js";
import { aspectName } from "./audit.js";

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

function streakDensity(g, w, h, band = null) {
  const hp = I.highpass(g, w, h, 3);
  const y0 = band ? band[0] : 0, y1 = band ? band[1] : h;
  let hit = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) { if (hp[y * w + x] > 18) hit++; n++; }
  return n ? hit / n : 0;
}

function scaleFromEdges(g, w, h) {
  const e = I.edgeMap(g, w, h);
  let s = 0;
  for (let i = 0; i < e.length; i++) s += e[i];
  const density = s / e.length;
  if (density < 0.03) return "wide";
  if (density < 0.06) return "medium";
  if (density < 0.10) return "detail";
  return "macro";
}

export async function analyseReference(blob, filename, onProgress = null) {
  const { frames, times, meta } = await sampleFrames(blob, { sampleFps: 10, maxW: 320, maxFrames: 600, onProgress });
  if (frames.length < 2) throw new Error("reference video is too short or unreadable");
  const w = frames[0].w, h = frames[0].h;
  const grays = frames.map((f) => I.gray(f));
  const hists = frames.map((f) => I.hsvHistogram(f));

  // shot boundaries: histogram distance spikes, at least half a second apart
  const diffs = [];
  for (let i = 0; i < frames.length - 1; i++) diffs.push(I.bhattacharyya(hists[i], hists[i + 1]));
  const dMean = I.meanOf(diffs);
  const dSd = Math.sqrt(I.meanOf(diffs.map((x) => (x - dMean) ** 2)));
  const thr = Math.max(0.35, dMean + 3 * dSd);
  const cuts = [0];
  diffs.forEach((d, i) => {
    if (d > thr && i + 1 - cuts[cuts.length - 1] >= 5) cuts.push(i + 1);
  });
  cuts.push(frames.length);

  const shots = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k], b = cuts[k + 1];
    const seg = frames.slice(a, b), gseg = grays.slice(a, b);
    if (!seg.length) continue;
    const bright = I.meanOf(seg.map((f) => I.luminance(f)));
    // camera move from the frame-to-frame shift magnitude
    const shifts = [];
    for (let i = 0; i < gseg.length - 1; i += Math.max(1, Math.floor(gseg.length / 6))) {
      shifts.push(I.shiftMagnitude(gseg[i], gseg[i + 1], w, h));
    }
    const mv = shifts.length ? I.meanOf(shifts) : 0;
    const move = mv < 0.4 ? "locked or drift" : (mv < 1.5 ? "slow move" : "fast move");
    const sky = I.meanOf(seg.map((f) => I.skyFraction(f)));
    const endIdx = Math.min(b, times.length - 1);
    shots.push({
      index: k + 1,
      start_s: round(times[a], 2),
      end_s: round(times[endIdx], 2),
      duration_s: round(times[endIdx] - times[a] + 0.1, 2),
      scale: scaleFromEdges(gseg[Math.floor(gseg.length / 2)], w, h),
      brightness: round(bright, 3),
      camera_move: move,
      setting: sky > 0.10 ? "exterior" : "interior",
    });
  }

  const lumAll = frames.map((f) => I.luminance(f));
  const satAll = frames.map((f) => I.saturation(f));
  const warmAll = frames.map((f) => I.warmth(f));
  const skyBand = [0, Math.max(1, Math.floor(h * 0.3))];
  const dens = I.meanOf(grays.map((g) => streakDensity(g, w, h)));
  const densSky = I.meanOf(grays.map((g) => streakDensity(g, w, h, skyBand)));

  const scales = shots.map((s) => s.scale);
  let changes = 0, run = 1, maxRun = 1;
  for (let i = 1; i < scales.length; i++) {
    if (scales[i] !== scales[i - 1]) changes++;
    run = scales[i] === scales[i - 1] ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }

  // percentiles over a subsample of pixels, as the server took them over every
  // fifth frame's whole plane
  const pool = [];
  for (let t = 0; t < grays.length; t += 5) for (let i = 0; i < grays[t].length; i += 7) pool.push(grays[t][i]);

  const arcStride = Math.max(1, Math.floor(lumAll.length / 120));
  const audio = await hasAudio(blob);

  return {
    filename,
    duration_s: round(meta.duration, 2),
    width: meta.width, height: meta.height,
    fps: round(meta.fps, 2),
    aspect: aspectName(meta.width, meta.height),
    shot_count: shots.length,
    mean_shot_length_s: round(meta.duration / Math.max(1, shots.length), 2),
    shots,
    light_arc: lumAll.filter((_, i) => i % arcStride === 0).map((x) => round(x, 3)),
    mean_brightness: round(I.meanOf(lumAll), 3),
    mean_saturation: round(I.meanOf(satAll), 3),
    warmth: round(I.meanOf(warmAll), 3),
    shadow_floor: round(I.percentile(pool, 2) / 255, 3),
    highlight_ceiling: round(I.percentile(pool, 98) / 255, 3),
    weather_density: round(dens, 4),
    sky_band_density: round(densSky, 4),
    has_audio: audio === null ? false : audio,
    audio_known: audio !== null,
    scale_changes_per_shot: round(changes / Math.max(1, shots.length - 1), 2),
    max_same_scale_run: maxRun,
    inside_outside_pattern: shots.map((s) => (s.setting === "exterior" ? "E" : "I")).join(""),
    caveat: "Match this reference's structure (shot length, rhythm, light arc, scale changes, inside/outside " +
      "pattern). Do not copy its colour grade: grade to the real site and the real finishes.",
  };
}
