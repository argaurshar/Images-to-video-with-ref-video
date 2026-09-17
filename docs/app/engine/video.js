/* Reading frames out of a video Blob, which is what OpenCV's VideoCapture did
   server-side. A <video> element is seeked to each timestamp and drawn into a
   canvas.

   Seeking is used rather than playing because it is deterministic: a played
   video drops frames under load and the QC would then measure a different
   sample every run. The cost is that sampling is not instant, so callers pass
   a frame cap and the UI reports progress. */

import { imgFromCanvas, blankCanvas } from "./imaging.js";

export function element(blob) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    v.src = URL.createObjectURL(blob);
    const fail = () => reject(new Error("this browser could not decode the video"));
    v.onerror = fail;
    v.onloadedmetadata = () => {
      // A WebM written by MediaRecorder carries no duration: it was a live
      // stream and the header was finalised before the length was known. The
      // only way to learn it is to seek past the end and read where the
      // playhead actually landed. Everything downstream depends on this, so it
      // happens once, here, rather than each caller guessing from the plan.
      if (!isFinite(v.duration) || Number.isNaN(v.duration)) {
        v.currentTime = 1e6;
        v.ontimeupdate = () => {
          if (!isFinite(v.duration) && v.currentTime > 0) {
            Object.defineProperty(v, "measuredDuration", { value: v.currentTime, configurable: true });
          }
          v.ontimeupdate = null;
          v.currentTime = 0;
          resolve(v);
        };
        // a container that never fires timeupdate must not hang the pipeline
        setTimeout(() => { if (v.ontimeupdate) { v.ontimeupdate = null; resolve(v); } }, 4000);
      } else {
        resolve(v);
      }
    };
  });
}

function seek(v, t) {
  return new Promise((resolve, reject) => {
    const done = () => { v.removeEventListener("seeked", done); resolve(); };
    const timer = setTimeout(() => { v.removeEventListener("seeked", done); reject(new Error("seek timed out")); }, 8000);
    v.addEventListener("seeked", () => { clearTimeout(timer); done(); }, { once: true });
    const end = durationOf(v);
    v.currentTime = Math.max(0, end ? Math.min(t, end - 0.02) : t);
  });
}

/** The real length of a clip, whether or not its container states one. */
export function durationOf(v) {
  if (isFinite(v.duration) && v.duration > 0) return v.duration;
  if (v.measuredDuration) return v.measuredDuration;
  if (v.seekable && v.seekable.length) return v.seekable.end(v.seekable.length - 1);
  return 0;
}

export async function meta(blob) {
  const v = await element(blob);
  const out = { width: v.videoWidth, height: v.videoHeight, duration: durationOf(v) };
  URL.revokeObjectURL(v.src);
  return out;
}

/** Sample frames at roughly sampleFps. Returns {frames, times, meta}, with
    frames as {w,h,data} images no wider than maxW. */
export async function sampleFrames(blob, { sampleFps = 10, maxW = 320, maxFrames = 400, onProgress = null } = {}) {
  const v = await element(blob);
  const dur = durationOf(v);
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) { URL.revokeObjectURL(v.src); throw new Error("video has no readable picture track"); }
  const scale = w > maxW ? maxW / w : 1;
  const cv = blankCanvas(Math.round(w * scale), Math.round(h * scale));
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  let count = Math.max(2, Math.min(maxFrames, Math.round(dur * sampleFps)));
  const step = dur / count;
  const frames = [], times = [];
  for (let i = 0; i < count; i++) {
    const t = i * step;
    try { await seek(v, t); } catch { break; }
    ctx.drawImage(v, 0, 0, cv.width, cv.height);
    frames.push(imgFromCanvas(cv));
    times.push(t);
    if (onProgress && i % 10 === 0) onProgress(i / count);
  }
  URL.revokeObjectURL(v.src);
  return { frames, times, meta: { width: w, height: h, duration: dur, fps: count / Math.max(dur, 1e-6) } };
}

/** A single frame, used for clip posters. Returns a JPEG Blob. */
export async function posterBlob(blob, t = 0.1, maxW = 480, quality = 0.82) {
  const v = await element(blob);
  const scale = v.videoWidth > maxW ? maxW / v.videoWidth : 1;
  const cv = blankCanvas(Math.round(v.videoWidth * scale), Math.round(v.videoHeight * scale));
  try { await seek(v, t); } catch { /* fall back to whatever frame is decoded */ }
  cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
  URL.revokeObjectURL(v.src);
  return await new Promise((r) => cv.toBlob(r, "image/jpeg", quality));
}

/** Whether a video blob carries an audio track. There is no direct API for
    this, so the three vendor-prefixed signals browsers do expose are used and
    the answer is reported as "could not tell" when none of them is present. */
export async function hasAudio(blob) {
  const v = await element(blob);
  await new Promise((r) => setTimeout(r, 120));
  let answer = null;
  if (typeof v.mozHasAudio === "boolean") answer = v.mozHasAudio;
  else if (typeof v.webkitAudioDecodedByteCount === "number") answer = v.webkitAudioDecodedByteCount > 0;
  else if (v.audioTracks && typeof v.audioTracks.length === "number") answer = v.audioTracks.length > 0;
  URL.revokeObjectURL(v.src);
  return answer;
}
