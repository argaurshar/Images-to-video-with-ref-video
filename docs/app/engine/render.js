/* Final render and delivery (spec Part 12): normalise to the target ratio,
   hard cuts, title cards and stamp, fades, an ambience bed, then verification,
   crop-only variants, the stills pack and the project record.

   The server did this with ffmpeg filter graphs. Here the film is drawn frame
   by frame into a canvas and recorded in real time, with the audio bed built in
   WebAudio and mixed into the same recording. The consequences are stated where
   they bite: the loudness figure is an RMS approximation and not an ITU-R
   BS.1770 integrated measurement, and the container is whatever the browser
   will encode. */

import { RES, OUTPUT_FPS, canvasOf, cropRect, paintTitle, paintSolidCard, paintOverlay, blobToImage } from "./compose.js";
import { record } from "./recorder.js";
import { sampleFrames, element as loadVideo, durationOf } from "./video.js";
import * as I from "./imaging.js";
import { makeZip, bytesOf, textBytes } from "./zip.js";

const CARD_SECONDS = 3.0;
const FADE_IN = 1.2;
const FADE_OUT = 3.0;

/** Shared with the analysis side so a container that states no duration, which
    is every WebM this app records, is measured once and the same way. */
async function videoFor(blob) {
  const v = await loadVideo(blob);
  if (!v.videoWidth) throw new Error("a clip could not be decoded for the render");
  return v;
}

/** A synthetic bed: filtered noise. Brown and louder for outdoors, pink and
    quieter for a room. A placeholder, labelled as one; a designer's own
    recording is always better and is used whenever one is uploaded. */
function noiseBuffer(ctx, kind) {
  const len = Math.ceil(ctx.sampleRate * 4);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "exterior") {
      last = (last + 0.02 * w) / 1.02;           // brown
      d[i] = last * 3.5;
    } else {
      b0 = 0.99765 * b0 + w * 0.0990460;         // pink (Paul Kellet's filter)
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
    }
  }
  return buf;
}

/** The soundtrack, per spec 12.5: an exterior bed under exterior shots, a
    quieter room tone under interiors with the exterior bed kept low behind
    the glass, short crossfades at every cut so nothing clicks, and a score
    underneath at roughly a third of the bed. Everything is scheduled on one
    clock so it lands exactly on the picture's cuts.

    `segments` is [{cls, t0, t1}] in film time. Returns the destination node
    and whether any of the sound was the designer's own. */
async function buildAudio(ctx, total, segments, beds) {
  const dest = ctx.createMediaStreamDestination();
  const master = ctx.createGain();
  master.connect(dest);

  const decoded = {};
  let usedUploaded = false;
  for (const kind of ["exterior", "interior", "score"]) {
    if (!beds[kind]) continue;
    try {
      decoded[kind] = await ctx.decodeAudioData(await beds[kind].arrayBuffer());
      usedUploaded = true;
    } catch { /* an undecodable bed is skipped, not fatal to the render */ }
  }
  const bedFor = (kind) => decoded[kind] || noiseBuffer(ctx, kind);
  const now = ctx.currentTime;
  const XF = 0.3;

  // one looping source per bed, gated by a gain envelope per segment, so a
  // bed is continuous across two adjacent shots of the same class and only
  // crossfades where the class actually changes
  const lanes = {};
  for (const kind of ["exterior", "interior"]) {
    const src = ctx.createBufferSource();
    src.buffer = bedFor(kind);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = decoded[kind] ? 20000 : (kind === "exterior" ? 900 : 500);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    src.connect(lp).connect(g).connect(master);
    src.start(now);
    lanes[kind] = g;
  }
  const level = (kind, cls) => {
    const base = decoded[kind] ? 0.7 : (kind === "exterior" ? 0.35 : 0.18);
    if (kind === cls) return base;
    // the exterior bed stays faintly audible behind an interior's glazing
    return kind === "exterior" && cls === "interior" ? base * 0.25 : 0;
  };
  for (const kind of ["exterior", "interior"]) {
    const g = lanes[kind].gain;
    let prev = 0;
    segments.forEach((seg, i) => {
      const target = level(kind, seg.cls);
      const a = now + seg.t0;
      if (i === 0) {
        g.linearRampToValueAtTime(target, a + XF);
      } else if (target !== prev) {
        // crossfade centred on the cut; a cut between two shots of the same
        // class leaves the bed running untouched
        g.setValueAtTime(prev, Math.max(now, a - XF / 2));
        g.linearRampToValueAtTime(target, a + XF / 2);
      }
      prev = target;
    });
    const end = now + total;
    g.setValueAtTime(prev, Math.max(now, end - XF));
    g.linearRampToValueAtTime(0, end);
  }

  if (decoded.score) {
    const src = ctx.createBufferSource();
    src.buffer = decoded.score;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.32, now);
    g.gain.setValueAtTime(0.32, now + Math.max(0, total - 3));
    g.gain.linearRampToValueAtTime(0, now + total);
    src.connect(g).connect(master);
    src.start(now);
  }

  // the bed fades with the picture: in over 1.2 s, out over the last 3 s
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(1, now + 1.2);
  master.gain.setValueAtTime(1, now + Math.max(1.3, total - 3));
  master.gain.linearRampToValueAtTime(0, now + total);
  return { dest, usedUploaded };
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Render the film. `clips` is [{blob, duration, cls, chapter}] in sequence
    order; `beds` is {exterior?, interior?, score?} Blobs; `logo` a Blob or
    null. Timings follow spec Parts 11 and 12: picture fades in over 1.2 s
    and out over the last 3 s; an overlaid title fades in at 0.6 s and is gone
    by 4.0 s so the opening shot finishes clean; a solid card holds for 3 s
    with 0.6 s fades. */
export async function renderFilm(project, clips, beds, logo, onProgress) {
  const aspect = project.intake.aspect;
  const [W, H] = RES[aspect] || RES["16:9"];
  const b = project.branding;
  const cv = canvasOf(W, H);
  const ctx = cv.getContext("2d");
  const logoImg = logo ? await blobToImage(logo).catch(() => null) : null;

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
  // planning and consultation films carry the disclaimer on every frame
  // whether or not the box was ticked (spec 1.3)
  const everyFrame = !!b.disclaimer_every_frame || project.intake.end_use === "planning_consultation";

  // one segment per element of the timeline, so the draw loop is a lookup
  const segs = [];
  let at = 0;
  if (headCard) { segs.push({ kind: "card", which: "start", t0: 0, t1: headCard }); at = headCard; }
  videos.forEach((v, i) => {
    segs.push({ kind: "clip", v, i, cls: clips[i].cls || "exterior", t0: at, t1: at + durations[i] });
    at += durations[i];
  });
  if (tailCard) segs.push({ kind: "card", which: "end", t0: at, t1: at + tailCard });

  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const audioSegs = segs.map((s) => ({ cls: s.kind === "clip" ? s.cls : "interior", t0: s.t0, t1: s.t1 }));
  const { dest, usedUploaded } = await buildAudio(actx, total, audioSegs, beds);
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
      const bodyT = t - headCard;               // time since the first shot began
      paintOverlay(ctx, b, W, H, b.style === "lower_third" && bodyT < 5 && seg.i === 0, everyFrame);
      if (!solid && cardStart && bodyT < 4.0) {
        // in from 0.6 s over 0.5 s, out from 3.5 s over 0.5 s
        const a = bodyT < 0.6 ? 0 : bodyT < 1.1 ? (bodyT - 0.6) / 0.5 : bodyT < 3.5 ? 1 : 1 - (bodyT - 3.5) / 0.5;
        paintTitle(ctx, b, W, H, "start", clamp01(a), logoImg);
      }
      if (!solid && cardEnd && t > total - tailCard - 4.5) {
        const since = t - (total - tailCard - 4.5);
        const a = since < 0.3 ? 0 : (since - 0.3) / 0.5;
        paintTitle(ctx, b, W, H, "end", clamp01(a), logoImg);
      }
    } else {
      const since = t - seg.t0, left = seg.t1 - t;
      const a = Math.min(since / 0.6, left / 0.6);
      paintSolidCard(ctx, b, W, H, seg.which, clamp01(a), logoImg);
    }
    // fade from and to black at the ends of the film
    let fade = 0;
    if (t < FADE_IN) fade = 1 - t / FADE_IN;
    else if (t > total - FADE_OUT) fade = 1 - (total - t) / FADE_OUT;
    if (fade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${clamp01(fade)})`;
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
