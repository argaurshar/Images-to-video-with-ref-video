/* Final render and delivery (spec Part 12): normalise to the target ratio,
   hard cuts, title cards and stamp, fades, an ambience bed, then verification,
   crop-only variants, the stills pack and the project record.

   The server did this with ffmpeg filter graphs. Here the film is drawn frame
   by frame into a canvas and recorded in real time, with the audio bed built in
   WebAudio and mixed into the same recording. The consequences are stated where
   they bite: the loudness figure is an RMS approximation and not an ITU-R
   BS.1770 integrated measurement, and the container is whatever the browser
   will encode. */

import { RES, OUTPUT_FPS, canvasOf, cropRect, paintTitle, paintOverlay, canvasToBlob } from "./compose.js";
import { record, extFor } from "./recorder.js";
import { sampleFrames, element as loadVideo, durationOf } from "./video.js";
import * as I from "./imaging.js";
import { makeZip, bytesOf, textBytes } from "./zip.js";

const CARD_SECONDS = 2.5;
const FADE = 0.4;

/** Shared with the analysis side so a container that states no duration, which
    is every WebM this app records, is measured once and the same way. */
async function videoFor(blob) {
  const v = await loadVideo(blob);
  if (!v.videoWidth) throw new Error("a clip could not be decoded for the render");
  return v;
}

/** An ambience bed. A designer's own recording is always better and is used
    when one is uploaded; otherwise this is filtered noise shaped into a slow
    swell, which is a placeholder and is labelled as one. */
async function buildAudio(ctx, seconds, beds) {
  const dest = ctx.createMediaStreamDestination();
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(dest);

  let usedUploaded = false;
  for (const [kind, blob] of Object.entries(beds)) {
    try {
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      // a score sits under the ambience rather than over it
      g.gain.value = kind === "score" ? 0.32 : 0.7;
      src.connect(g).connect(master);
      src.start();
      usedUploaded = true;
    } catch { /* an undecodable bed is skipped, not fatal to the render */ }
  }

  if (!usedUploaded) {
    const len = Math.max(1, Math.ceil(ctx.sampleRate * 4));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // brown-ish noise: quieter and less hissy than white, closer to room tone
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    src.connect(lp).connect(g).connect(master);
    src.start();
  }

  // fade the bed in and out with the picture
  const now = ctx.currentTime;
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(1, now + 1.2);
  master.gain.setValueAtTime(1, now + Math.max(1.3, seconds - 1.5));
  master.gain.linearRampToValueAtTime(0, now + seconds);
  return { dest, usedUploaded };
}

/** Render the film. `clips` is [{blob, duration}] already in sequence order. */
export async function renderFilm(project, clips, beds, onProgress) {
  const aspect = project.intake.aspect;
  const [W, H] = RES[aspect] || RES["16:9"];
  const b = project.branding;
  const cv = canvasOf(W, H);
  const ctx = cv.getContext("2d");

  const videos = [];
  for (const c of clips) videos.push(await videoFor(c.blob));
  // Timing comes from the files, never from the plan: a provider may return a
  // different length from the one that was asked for.
  const durations = videos.map((v, i) => durationOf(v) || clips[i].duration || 5);
  const body = durations.reduce((a, d) => a + d, 0);
  const cardStart = ["start", "both"].includes(b.title_position);
  const cardEnd = ["end", "both"].includes(b.title_position);
  const solid = b.style === "card";
  const headCard = solid && cardStart ? CARD_SECONDS : 0;
  const tailCard = solid && cardEnd ? CARD_SECONDS : 0;
  const total = headCard + body + tailCard;
  if (!body) throw new Error("no approved clips to render");

  // one segment per element of the timeline, so the draw loop is a lookup
  const segs = [];
  let at = 0;
  if (headCard) { segs.push({ kind: "card", which: "start", t0: 0, t1: headCard }); at = headCard; }
  videos.forEach((v, i) => { segs.push({ kind: "clip", v, i, t0: at, t1: at + durations[i] }); at += durations[i]; });
  if (tailCard) segs.push({ kind: "card", which: "end", t0: at, t1: at + tailCard });

  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const { dest, usedUploaded } = await buildAudio(actx, total, beds);
  const audioTrack = dest.stream.getAudioTracks()[0] || null;

  let playing = -1;
  const draw = (t) => {
    const seg = segs.find((s) => t >= s.t0 && t < s.t1) || segs[segs.length - 1];
    ctx.fillStyle = "#0b0b0c";
    ctx.fillRect(0, 0, W, H);
    if (seg.kind === "clip") {
      if (playing !== seg.i) {
        playing = seg.i;
        for (const v of videos) { if (v !== seg.v && !v.paused) v.pause(); }
        seg.v.currentTime = 0;
        seg.v.play().catch(() => {});
      }
      const sw = seg.v.videoWidth, sh = seg.v.videoHeight;
      if (sw && sh) {
        // scale up to cover, then crop to the frame: never pad, never outpaint
        const r = cropRect(sw, sh, aspect);
        ctx.drawImage(seg.v, r.x, r.y, r.w, r.h, 0, 0, W, H);
      }
      paintOverlay(ctx, b, W, H, b.style === "lower_third" && t < seg.t0 + 5 && seg.i === 0);
      if (!solid && cardStart && t < CARD_SECONDS + 1) {
        const a = t < CARD_SECONDS ? 1 : 1 - (t - CARD_SECONDS);
        paintTitle(ctx, b, W, H, "start", Math.max(0, a));
      }
      if (!solid && cardEnd && t > total - CARD_SECONDS - 1) {
        const a = Math.min(1, (t - (total - CARD_SECONDS - 1)));
        paintTitle(ctx, b, W, H, "end", Math.max(0, a));
      }
    } else {
      paintTitle(ctx, b, W, H, seg.which, 1);
    }
    // fade from and to black at the ends of the film
    let fade = 0;
    if (t < FADE) fade = 1 - t / FADE;
    else if (t > total - FADE) fade = 1 - (total - t) / FADE;
    if (fade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${Math.min(1, Math.max(0, fade))})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (onProgress) onProgress(t / total, `${t.toFixed(1)}s of ${total.toFixed(1)}s`);
  };

  const out = await record(cv, total, OUTPUT_FPS, draw, { audioTrack });
  videos.forEach((v) => { v.pause(); URL.revokeObjectURL(v.src); });
  try { await actx.close(); } catch { /* already closed */ }

  return { blob: out.blob, ext: out.ext, mime: out.mime, info: out.info, expected: total, usedUploaded };
}

/** A crop-only variant: never a re-frame, never an outpaint. Recorded the same
    way, from the rendered film. */
export async function renderCrop(filmBlob, aspect, onProgress) {
  const [W, H] = RES[aspect];
  const v = await videoFor(filmBlob);
  const seconds = durationOf(v);
  if (!seconds) throw new Error("the film has no readable duration to crop from");
  const cv = canvasOf(W, H);
  const ctx = cv.getContext("2d");
  v.currentTime = 0;
  await v.play().catch(() => {});
  const draw = (t) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const sw = v.videoWidth, sh = v.videoHeight;
    if (sw && sh) {
      const r = cropRect(sw, sh, aspect);
      ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, W, H);
    }
    if (onProgress) onProgress(t / seconds, aspect);
  };
  const out = await record(cv, seconds, OUTPUT_FPS, draw, {});
  v.pause(); URL.revokeObjectURL(v.src);
  return out;
}

/** Measure what was actually produced, rather than trusting the plan. */
export async function verify(filmBlob, expected, aspect, usedUploadedBed, info) {
  const [W, H] = RES[aspect] || RES["16:9"];
  const { frames, meta } = await sampleFrames(filmBlob, { sampleFps: 2, maxW: 200, maxFrames: 90 });
  const arc = frames.map((f) => Math.round(I.luminance(f) * 1000) / 1000);
  let lufs = null;
  try {
    const actx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 48000, 48000);
    const buf = await actx.decodeAudioData(await filmBlob.slice().arrayBuffer());
    const d = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < d.length; i += 7) sum += d[i] * d[i];
    const rms = Math.sqrt(sum / Math.ceil(d.length / 7));
    lufs = rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : null;
  } catch { /* no audio track, or the browser will not decode it back */ }
  return {
    duration_s: Math.round(meta.duration * 100) / 100,
    expected_duration_s: Math.round(expected * 100) / 100,
    width: W, height: H, fps: OUTPUT_FPS,
    integrated_lufs: lufs,
    loudness_method: "RMS approximation, not an ITU-R BS.1770 integrated measurement",
    true_peak_db: null,
    audio_bed: usedUploadedBed ? "uploaded" : "synthetic placeholder",
    container: info ? info.label : "unknown",
    interoperable: info ? info.interoperable : false,
    brightness_arc: arc,
  };
}

// ------------------------------------------------------------- deliverables

export async function stillsPack(project, files) {
  // files: [{name, blob}] already resolved by the caller from storage
  const entries = [];
  for (const f of files) entries.push({ name: f.name, data: await bytesOf(f.blob) });
  const approved = project.stills.filter((s) => s.status === "approved");
  const shotOf = (n) => project.plan.shots.find((s) => s.n === n) || null;
  const sidecar = {
    project: project.name,
    disclaimer: project.branding.disclaimer,
    stage: project.intake.project_stage,
    stills: approved.map((s) => ({
      file: `shot_${String(s.shot_n).padStart(2, "0")}_${s.cls}`,
      shot: s.shot_n,
      source_hub: s.source_hub_id,
      state: shotOf(s.shot_n) ? shotOf(s.shot_n).state : null,
      prompt: s.prompt,
      audit: s.audit,
    })),
  };
  entries.push({ name: "sidecar.json", data: textBytes(JSON.stringify(sidecar, null, 2)) });
  return makeZip(entries);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function projectRecord(project, spend) {
  const p = project;
  const rows = p.plan.shots.map((s) => {
    const st = p.stills.find((x) => x.shot_n === s.n && x.status === "approved");
    const c = p.clips.find((x) => x.shot_n === s.n && x.status === "approved");
    const qc = c ? (c.qc.passed ? "pass" : "fail: " + c.qc.failures.join(", ")) : "-";
    return `<tr><td>${s.n}</td><td>${s.cls}</td><td>${esc(s.season)} / ${esc(s.time)}</td><td>${s.scale}</td>` +
      `<td>${esc(s.source_hub_id)}</td><td>${esc(s.design_intent)}</td>` +
      `<td>${st ? st.audit.rating : "-"}</td><td>${esc(qc)}</td></tr>`;
  }).join("");
  const prompts = p.plan.shots.map((s) => {
    const still = (p.stills.find((x) => x.shot_n === s.n && x.status === "approved") || {}).prompt || "";
    const clip = (p.clips.find((x) => x.shot_n === s.n && x.status === "approved") || {}).prompt || "";
    return `<h4>Shot ${s.n} still prompt</h4><pre>${esc(still)}</pre><h4>Shot ${s.n} motion prompt</h4><pre>${esc(clip)}</pre>`;
  }).join("");
  const approvals = p.approvals.map((a) => `<li>${esc(a.ts)} — ${esc(a.what)} ${a.detail ? esc(JSON.stringify(a.detail)) : ""}</li>`).join("");
  const ledger = p.ledger.map((l) => `<tr><td>${esc(l.ts)}</td><td>${esc(l.kind)}</td><td>${l.units}</td><td>${l.cost.toFixed(2)}</td><td>${esc(l.note)}</td></tr>`).join("");
  const hubs = p.hubs.map((h) => `<li><b>${esc(h.id)}</b> ${esc(h.filename)} · ${h.cls} · faces ${esc(h.camera_faces || "not stated")} · ${esc(h.materials)}</li>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Project record — ${esc(p.name)}</title>
<style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#222}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ddd;padding:6px}pre{white-space:pre-wrap;background:#f6f6f6;padding:10px;font-size:12px}</style></head><body>
<h1>Project record: ${esc(p.name)}</h1>
<p><b>${esc(p.branding.disclaimer)}</b></p>
<p>Location: ${esc(p.intake.location)} · Stage: ${esc(p.intake.project_stage)} · End use: ${esc(p.intake.end_use)} · Aspect: ${esc(p.intake.aspect)} · Provider: ${esc(p.clips.length ? p.clips[0].provider : "")}</p>
<h2>Hub renders (never modified)</h2><ul>${hubs}</ul>
<h2>Design intents</h2><ul>${(p.intake.design_intents || []).filter(Boolean).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
<h2>Shot plan and outcomes</h2>
<table><tr><th>#</th><th>Class</th><th>Season / time</th><th>Scale</th><th>Source</th><th>Design intent</th><th>Still audit</th><th>Clip QC</th></tr>${rows}</table>
<h2>Approvals</h2><ul>${approvals}</ul>
<h2>Spend</h2><p>Total ${spend.toFixed(2)} against a budget of ${(p.budget.total || 0).toFixed(2)}</p>
<table><tr><th>When</th><th>Kind</th><th>Units</th><th>Cost</th><th>Note</th></tr>${ledger}</table>
<h2>Prompts</h2>${prompts}
</body></html>`;
  return {
    html: new Blob([html], { type: "text/html" }),
    json: new Blob([JSON.stringify(p, null, 2)], { type: "application/json" }),
  };
}
