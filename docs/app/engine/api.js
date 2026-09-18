/* The engine, behind the same routes the FastAPI server exposed.

   Keeping the route shape means the interface layer did not have to be
   rewritten to run without a server, and it keeps the gates in one place: the
   plan must be approved and the budget confirmed before anything is generated,
   every shot needs an approved still before a clip, and a shot that has failed
   twice is refused rather than retried into more spend.

   What is genuinely different from the server version is stated where it
   happens, not buried: there is no access lock, because a static page cannot
   enforce one, and the API key lives in this browser's storage. */

import * as db from "./db.js";
import * as L from "./location.js";
import * as P from "./prompts.js";
import * as SP from "./shotplan.js";
import { analyseHub, auditStill } from "./audit.js";
import { analyseReference } from "./reference.js";
import { runQC, meanBrightness } from "./qc.js";
import { makeProvider, testProvider, ProviderError } from "./providers.js";
import { renderFilm, renderCrop, verify, stillsPack, projectRecord } from "./render.js";
import { drawToImg, imgToCanvas } from "./imaging.js";
import { canvasOf, cropLoss, thumbnail, blobToImage, canvasToBlob, prepareUpload } from "./compose.js";
import { posterBlob } from "./video.js";
import { makeZip, readZip, bytesOf, textBytes } from "./zip.js";

export const CLIP_SECONDS = 5;
export const MAX_ATTEMPTS_PER_SHOT = 2;
const RESERVE_FRACTION = 0.20;

export class ApiError extends Error {
  constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
}

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
const uid = (p) => p + "_" + Math.random().toString(16).slice(2, 10);
const round2 = (x) => Math.round(x * 100) / 100;

// ------------------------------------------------------------------- jobs

let JOB = null;
const JOBS = [];

function startJob(kind, total) {
  JOB = { id: uid("job"), kind, total, done: 0, current: "", errors: [], started: Date.now() };
  return JOB;
}
function endJob() {
  if (JOB) { JOBS.push({ ...JOB, errors: [...JOB.errors] }); JOB = null; }
}

// ---------------------------------------------------------------- project

function blankProject(name) {
  return {
    id: uid("prj"), name: name || "Untitled project", created_at: nowIso(), updated_at: nowIso(),
    stage: "intake", hubs: [],
    intake: {
      route: "brief", aspect: "16:9", seasons: ["summer"], time_arc: "dawn_to_night", single_time: "afternoon",
      mood: "serene", people: "scale_figure", length_shots: 5, location: "", project_type: "",
      project_stage: "design_development", end_use: "client_presentation", interior_emphasis: null,
      design_intents: ["", "", ""], project_name: "", practice_name: "",
    },
    location_profile: {}, reference: null,
    budget: { confirmed: false, hero_images: 0, stills: 0, clips: 0, image_cost: 0, video_cost: 0, reserve: 0, total: 0 },
    plan: { approved: false, reference_driven: false, shots: [], warnings: [], rationale: "" },
    heroes: [], stills: [], clips: [],
    sequence: { order: [], suggested_order: [], rationale: "", warnings: [] },
    branding: {
      title_position: "start", project_name: "", practice_name: "", location_line: "", subtitle: "",
      year: String(new Date().getFullYear()), stage_stamp: "",
      disclaimer: "Artist's impression. Not a daylight study or planning drawing.",
      disclaimer_every_frame: false, style: "minimal", logo_path: "",
    },
    deliverables: { film: "", crops: {}, stills_pack: "", record_json: "", record_html: "", verification: {} },
    ledger: [], approvals: [], audio_beds: {},
  };
}

const spendOf = (p) => round2(p.ledger.reduce((a, e) => a + e.cost, 0));
const hubOf = (p, id) => p.hubs.find((h) => h.id === id);
const shotOf = (p, n) => p.plan.shots.find((s) => s.n === Number(n));

function charge(p, kind, cost, note = "", units = 1) {
  p.ledger.push({ ts: nowIso(), kind, units, cost: Math.round(cost * 10000) / 10000, note });
}

/** Clip cost in 5-second units. A provider that only sells discrete lengths
    bills an 8-second shot as a 10-second clip, so pricing every shot as one
    unit understated a reference-driven film by up to double. */
function clipUnits(p, nShots) {
  const durations = p.plan.shots.map((s) => s.duration);
  if (!durations.length) return nShots;
  let units = 0;
  for (const d of durations.slice(0, nShots)) units += Math.max(1, Math.ceil(Math.max(1, d) / 5));
  units += Math.max(0, nShots - durations.length);
  return units;
}

async function estimate(p) {
  const s = await db.loadSettings();
  const classes = new Set(p.hubs.map((h) => h.cls));
  const nShots = Math.max(1, p.intake.length_shots);
  const heroImages = 2 * (classes.size || 1);
  const units = clipUnits(p, nShots);
  const b = {
    confirmed: p.budget.confirmed, hero_images: heroImages, stills: nShots, clips: nShots,
    image_cost: s.image_cost, video_cost: s.video_cost, reserve: 0, total: 0,
  };
  const base = (heroImages + nShots) * b.image_cost + units * b.video_cost;
  b.reserve = round2(base * RESERVE_FRACTION);
  b.total = round2(base + b.reserve);
  return b;
}

// -------------------------------------------------------------- generation

async function provider() {
  const s = await db.loadSettings();
  return { p: makeProvider(s), s };
}

function requireGates(p) {
  if (!p.plan.approved) throw new ApiError(409, "approve the shot plan first");
  if (!p.budget.confirmed) throw new ApiError(409, "confirm the budget first");
}

async function storeStillArtifacts(p, dir, id, blob) {
  const path = `projects/${p.id}/${dir}/${id}.jpg`;
  const thumbPath = `projects/${p.id}/${dir}/${id}.thumb.jpg`;
  await db.putFile(path, blob);
  const img = await blobToImage(blob);
  await db.putFile(thumbPath, await thumbnail(img, img.naturalWidth, img.naturalHeight));
  return { path, thumb: thumbPath };
}

/** Both images are brought to one 512-wide frame before the audit compares
    them, which is what the server did with a resize before edge extraction. */
async function auditAgainstHub(hubBlob, stillBlob, cls) {
  const a = await blobToImage(hubBlob), b = await blobToImage(stillBlob);
  const hubImg = drawToImg(a, 512);
  const cv = canvasOf(hubImg.w, hubImg.h);
  cv.getContext("2d").drawImage(b, 0, 0, cv.width, cv.height);
  const stillImg = drawToImg(cv, 512);
  return auditStill(hubImg, stillImg, cls);
}

async function genStill(p, prov, s, shot, hub, corrections, attempt) {
  const prompt = P.stillPrompt(p, shot, hub, corrections);
  const negative = P.negativePrompt(shot.cls);
  const hubBlob = await db.getFile(hub.path);
  const res = await prov.generateStill(hubBlob, prompt, negative, p.intake.aspect);
  const id = uid("stl");
  const { path, thumb } = await storeStillArtifacts(p, "stills", id, res.blob);
  return {
    id, shot_n: shot.n, cls: shot.cls, source_hub_id: hub.id, attempt, path, thumb,
    prompt, negative, provider: prov.name, provider_id: res.provider_id, cost: res.cost,
    created_at: nowIso(), status: "pending", note: res.note || "",
    audit: await auditAgainstHub(hubBlob, res.blob, shot.cls),
  };
}

async function genClip(p, prov, still, shot, attempt, mode, motionOverride, onProgress) {
  const prompt = motionOverride || P.motionPrompt(p, shot);
  const negative = P.negativePrompt(shot.cls);
  const stillBlob = await db.getFile(still.path);
  const res = await prov.generateClip(stillBlob, prompt, negative, shot.duration || CLIP_SECONDS, p.intake.aspect, onProgress);
  const id = uid("clp");
  const path = `projects/${p.id}/clips/${id}.${res.ext || "mp4"}`;
  const thumb = `projects/${p.id}/clips/${id}.thumb.jpg`;
  await db.putFile(path, res.blob);
  try { await db.putFile(thumb, await posterBlob(res.blob)); } catch { /* poster is cosmetic */ }
  const qc = await runQC(res.blob, shot.cls, !!shot.state.precipitation);
  return {
    id, shot_n: shot.n, cls: shot.cls, source_hub_id: shot.source_hub_id, attempt, path, thumb,
    prompt, negative, provider: prov.name, provider_id: res.provider_id, cost: res.cost,
    created_at: nowIso(), status: "pending", note: res.note || "", still_id: still.id, mode,
    duration: res.seconds || shot.duration || CLIP_SECONDS, qc,
    mean_brightness: await meanBrightness(res.blob).catch(() => 0),
  };
}

// ---------------------------------------------------------------- sequence

const approvedClips = (p) => p.clips.filter((c) => c.status === "approved");

/** Keep sequence.order honest about the approved clips: approving a
    regenerated clip demotes its predecessor, and cutting one leaves its id
    behind. Without this the page counts clips the render will drop. */
function reconcile(p) {
  const live = new Set(approvedClips(p).map((c) => c.id));
  let order = p.sequence.order.filter((i) => live.has(i));
  for (const i of p.sequence.suggested_order || []) if (live.has(i) && !order.includes(i)) order.push(i);
  for (const c of approvedClips(p)) if (!order.includes(c.id)) order.push(c.id);
  p.sequence.order = order;
  return order;
}

function seqWarnings(p, ordered) {
  const w = [];
  const shots = Object.fromEntries(p.plan.shots.map((s) => [s.n, s]));
  const orphans = [...new Set(ordered.filter((x) => !(x.shot_n in shots)).map((x) => x.shot_n))].sort();
  if (orphans.length) {
    w.push(`Clips for shot(s) ${orphans.join(", ")} have no matching shot in the current plan; the plan was regenerated or renumbered after they were made.`);
  }
  const live = ordered.filter((x) => x.shot_n in shots);
  for (let i = 2; i < live.length; i++) {
    const [a, b, c] = [live[i - 2], live[i - 1], live[i]].map((x) => shots[x.shot_n]);
    if (a.scale === b.scale && b.scale === c.scale) w.push(`Three ${a.scale} shots in a row at positions ${i - 1}-${i + 1}.`);
  }
  for (let i = 1; i < live.length; i++) {
    const a = shots[live[i - 1].shot_n], b = shots[live[i].shot_n];
    if (a.chapter === b.chapter && a.state.weather !== b.state.weather && !(a.heavy || b.heavy)) {
      w.push(`Continuity: positions ${i} and ${i + 1} share a chapter but not a weather state (${a.state.weather} / ${b.state.weather}).`);
    }
    if (a.chapter === b.chapter && a.cls !== b.cls && a.state.time !== b.state.time) {
      w.push(`Continuity: positions ${i} and ${i + 1} cross inside/outside with different times of day.`);
    }
  }
  return w;
}

function seqPreview(p) {
  const byId = Object.fromEntries(p.clips.map((c) => [c.id, c]));
  const approved = new Set(approvedClips(p).map((c) => c.id));
  const shots = Object.fromEntries(p.plan.shots.map((s) => [s.n, s]));
  const ordered = p.sequence.order
    .filter((i) => byId[i] && approved.has(i) && byId[i].shot_n in shots)
    .map((i) => byId[i]);
  return {
    order: p.sequence.order, suggested_order: p.sequence.suggested_order, rationale: p.sequence.rationale,
    warnings: p.sequence.warnings,
    total_duration_s: Math.round(ordered.reduce((a, c) => a + c.duration, 0) * 10) / 10,
    brightness_strip: ordered.map((c) => c.mean_brightness),
    items: ordered.map((c) => ({
      id: c.id, shot_n: c.shot_n, cls: c.cls, season: shots[c.shot_n].season, time: shots[c.shot_n].time,
      scale: shots[c.shot_n].scale, duration: c.duration, thumb: c.thumb, chapter: shots[c.shot_n].chapter,
    })),
  };
}

// ----------------------------------------------------------------- routes

async function load(pid) {
  const p = await db.getProject(pid);
  if (!p) throw new ApiError(404, "project not found");
  return p;
}
const save = (p) => db.putProject(p);

const ROUTES = [];
const on = (method, pattern, fn) => ROUTES.push({ method, parts: pattern.split("/"), fn });

on("GET", "/api/health", async () => ({
  ok: true, provider: (await db.loadSettings()).provider, max_attempts: MAX_ATTEMPTS_PER_SHOT,
  runtime: "browser", storage: await db.quota(),
}));

// There is no access lock. A static page is served to anyone who has the link
// and cannot check a password before handing out its own source, so pretending
// to lock it would be theatre. The key lives in this browser only.
on("GET", "/api/auth/state", async () => ({ claimed: true, authed: true, settings: db.publicSettings(await db.loadSettings()) }));
on("POST", "/api/auth/logout", async () => ({ ok: true }));

on("GET", "/api/opening", async () => ({
  message: "Upload one project's renders, say where it is and what you want noticed, and the engine plans the film, " +
    "generates every frame from those renders, measures what comes back and cuts it together. Create a project to start.",
}));

on("GET", "/api/settings", async () => db.publicSettings(await db.loadSettings()));
on("PUT", "/api/settings", async (_m, body) => {
  const patch = {};
  for (const k of ["provider", "base_url", "image_path", "video_path"]) if (body[k] !== undefined) patch[k] = body[k];
  for (const k of ["image_cost", "video_cost"]) if (body[k] !== undefined) patch[k] = Number(body[k]);
  if (body.freepik_api_key) patch.freepik_api_key = body.freepik_api_key;
  return db.publicSettings(await db.saveSettings(patch));
});
on("POST", "/api/settings/test", async () => {
  const r = await testProvider(await db.loadSettings());
  return { ok: r.ok, detail: r.detail };
});

on("GET", "/api/projects", async () => {
  const all = await db.allProjects();
  all.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return all.map((p) => ({ id: p.id, name: p.name, stage: p.stage, updated_at: p.updated_at }));
});
on("POST", "/api/projects", async (_m, body) => {
  const p = blankProject(body && body.name);
  await save(p);
  return p;
});
on("GET", "/api/projects/:pid", async (m) => load(m.pid));
on("PATCH", "/api/projects/:pid", async (m, body) => {
  const p = await load(m.pid);
  if (body.name !== undefined) p.name = String(body.name).trim() || p.name;
  await save(p);
  return p;
});
on("DELETE", "/api/projects/:pid", async (m) => {
  await db.delFilesUnder(`projects/${m.pid}/`);
  await db.delProject(m.pid);
  db.forgetAllURLs();
  return { ok: true };
});

/** Spec Part 13, reuse across films: a practice returns to the same project at
    DA, at CD and at completion. The copy keeps the renders, the intake, the
    location, the plan and the chosen heroes, so a second film costs stills and
    clips only, not rediscovery. Spend starts from zero because it is a new
    film. */
on("POST", "/api/projects/:pid/duplicate", async (m, body) => {
  const src = await load(m.pid);
  const p = JSON.parse(JSON.stringify(src));
  p.id = uid("prj");
  p.name = (body && body.name) || `${src.name} (copy)`;
  p.created_at = nowIso();
  p.stage = src.plan.shots.length ? (src.heroes.some((h) => h.chosen) ? "board" : "hero") : "intake";
  p.stills = []; p.clips = []; p.ledger = []; p.approvals = [];
  p.sequence = { order: [], suggested_order: [], rationale: "", warnings: [] };
  p.deliverables = { film: "", crops: {}, stills_pack: "", record_json: "", record_html: "", verification: {} };
  p.budget.confirmed = false;
  // heroes that were not chosen are not carried: they were a decision, and
  // the decision was made
  p.heroes = src.heroes.filter((h) => h.chosen);
  const copyFile = async (from) => {
    if (!from) return "";
    const to = from.replace(`projects/${src.id}/`, `projects/${p.id}/`);
    const b = await db.getFile(from);
    if (b) await db.putFile(to, b);
    return to;
  };
  for (const h of p.hubs) { h.path = await copyFile(h.path); await copyFile(`projects/${src.id}/thumbs/${h.id}.jpg`); }
  for (const h of p.heroes) { h.path = await copyFile(h.path); h.thumb = await copyFile(h.thumb); }
  if (p.branding.logo_path) p.branding.logo_path = await copyFile(p.branding.logo_path);
  for (const [k, v] of Object.entries(p.audio_beds)) p.audio_beds[k] = await copyFile(v);
  p.approvals.push({ ts: nowIso(), what: "duplicated from " + src.name, detail: { source: src.id } });
  await save(p);
  return p;
});

/** Everything about a project in one ZIP: the document and every file it
    refers to. Storage here is one browser on one device, so this is how a
    project moves to another machine, goes into the practice's file store, or
    survives someone clearing site data. */
on("GET", "/api/projects/:pid/export", async (m) => {
  const p = await load(m.pid);
  const keys = (await db.allFileKeys()).filter((k) => String(k).startsWith(`projects/${p.id}/`));
  const entries = [{ name: "project.json", data: textBytes(JSON.stringify(p, null, 2)) }];
  for (const k of keys) {
    const b = await db.getFile(k);
    if (b) entries.push({ name: String(k).slice(`projects/${p.id}/`.length), data: await bytesOf(b) });
  }
  return { blob: makeZip(entries), filename: `${p.name.replace(/[^\w.-]+/g, "_") || "project"}.archviz.zip` };
});

on("POST", "/api/projects/import", async (_m, body) => {
  const f = body.get ? body.get("file") : null;
  if (!f) throw new ApiError(400, "choose an exported project (.archviz.zip)");
  let entries;
  try { entries = await readZip(f); } catch (e) { throw new ApiError(400, e.message); }
  const doc = entries.find((e) => e.name === "project.json");
  if (!doc) throw new ApiError(400, "that ZIP has no project.json in it, so it is not an exported project");
  let p;
  try { p = JSON.parse(new TextDecoder().decode(doc.data)); } catch { throw new ApiError(400, "project.json is not valid JSON"); }
  if (!p.id || !p.intake || !p.plan) throw new ApiError(400, "project.json does not look like a project");
  // a fresh id so an import never overwrites a project that is already here,
  // and a suffix when the name is already taken so the list stays readable
  const oldId = p.id;
  p.id = uid("prj");
  const names = new Set((await db.allProjects()).map((x) => x.name));
  if (names.has(p.name)) p.name = `${p.name} (imported)`;
  const rewrite = (s) => (typeof s === "string" ? s.split(`projects/${oldId}/`).join(`projects/${p.id}/`) : s);
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") { for (const k of Object.keys(o)) o[k] = walk(o[k]); return o; }
    return rewrite(o);
  };
  walk(p);
  const guessType = (n) => (/\.(jpe?g)$/i.test(n) ? "image/jpeg" : /\.png$/i.test(n) ? "image/png" : /\.webm$/i.test(n) ? "video/webm"
    : /\.mp4$/i.test(n) ? "video/mp4" : /\.zip$/i.test(n) ? "application/zip" : /\.json$/i.test(n) ? "application/json"
    : /\.html?$/i.test(n) ? "text/html" : "application/octet-stream");
  for (const e of entries) {
    if (e.name === "project.json") continue;
    await db.putFile(`projects/${p.id}/${e.name}`, new Blob([e.data], { type: guessType(e.name) }));
  }
  p.approvals = p.approvals || [];
  p.approvals.push({ ts: nowIso(), what: "imported", detail: { from: oldId, files: entries.length - 1 } });
  await save(p);
  return p;
});

on("POST", "/api/projects/:pid/hubs", async (m, body) => {
  const p = await load(m.pid);
  const files = body.getAll ? body.getAll("files") : [];
  if (!files.length) throw new ApiError(400, "no image was picked");
  if (p.hubs.length + files.length > 8) {
    throw new ApiError(400, `eight renders per project is the limit; this one has ${p.hubs.length} and you picked ${files.length}`);
  }
  const notes = [];
  for (const f of files) {
    // A photo picked from an iPhone gallery can arrive with no type at all, so
    // the name decides when the header does not.
    const looksImage = /^image\//i.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i.test(f.name || "");
    if (!looksImage) throw new ApiError(400, `${f.name || "that file"} is not an image`);
    let prepared;
    try {
      prepared = await prepareUpload(f);
    } catch {
      const heic = /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name || "");
      throw new ApiError(400, heic
        ? `${f.name} is an Apple HEIC photo and this browser cannot decode it. On the iPhone, set Settings › Camera › Formats to "Most Compatible" and take it again, or open this page in Safari, which reads HEIC natively.`
        : `${f.name || "that file"} is not a readable image`);
    }
    const id = uid("hub");
    const path = `projects/${p.id}/hubs/${id}.jpg`;
    const thumb = `projects/${p.id}/thumbs/${id}.jpg`;
    await db.putFile(path, prepared.blob);
    await db.putFile(thumb, await thumbnail(prepared.img, prepared.width, prepared.height));
    const detected = analyseHub(drawToImg(prepared.img, 640), prepared.width, prepared.height);
    if (prepared.from) {
      notes.push(`${f.name} was ${prepared.from[0]}×${prepared.from[1]} and has been resampled to ${prepared.width}×${prepared.height}. Nothing was cropped; a phone cannot hold a dozen full-size photos in canvas memory.`);
    }
    p.hubs.push({
      id, filename: f.name || `render-${p.hubs.length + 1}.jpg`, path, cls: detected.suggested_class,
      width: prepared.width, height: prepared.height, detected,
      camera_faces: null, continuity_group: null,
      label: (f.name || `render ${p.hubs.length + 1}`).replace(/\.[^.]+$/, ""),
      materials: "", elements: "",
    });
  }
  p.budget = await estimate(p);
  await save(p);
  return { project: p, notes };
});

on("PATCH", "/api/projects/:pid/hubs/:hid", async (m, body) => {
  const p = await load(m.pid);
  const h = hubOf(p, m.hid);
  if (!h) throw new ApiError(404, "render not found");
  for (const [k, v] of Object.entries(body)) {
    if (k === "cls" && !["exterior", "interior"].includes(v)) throw new ApiError(400, "class must be exterior or interior");
    if (k === "camera_faces" && v && !["N", "NE", "E", "SE", "S", "SW", "W", "NW"].includes(v)) {
      throw new ApiError(400, "camera_faces must be one of N NE E SE S SW W NW");
    }
    h[k] = v === "" && (k === "camera_faces" || k === "continuity_group") ? null : v;
  }
  p.budget = await estimate(p);
  await save(p);
  return h;
});

on("DELETE", "/api/projects/:pid/hubs/:hid", async (m) => {
  const p = await load(m.pid);
  if (p.plan.shots.some((s) => s.source_hub_id === m.hid)) {
    throw new ApiError(409, "this render is used by the shot plan; regenerate the plan first");
  }
  p.hubs = p.hubs.filter((h) => h.id !== m.hid);
  p.budget = await estimate(p);
  await save(p);
  return { ok: true };
});

on("PUT", "/api/projects/:pid/intake", async (m, body) => {
  const p = await load(m.pid);
  if (!String(body.location || "").trim()) throw new ApiError(400, "location is required; it drives the climate research");
  p.intake = Object.assign(p.intake, body);
  p.intake.length_shots = Math.max(1, Math.min(30, Number(p.intake.length_shots) || 5));
  p.intake.seasons = (p.intake.seasons || []).length ? p.intake.seasons : ["summer"];
  p.location_profile = L.profile(p.intake.location);
  p.budget = await estimate(p);
  // Law 6 is crop, never outpaint, so a ratio the renders cannot give up
  // gracefully is a warning at intake rather than a surprise in the film.
  const warnings = [];
  for (const h of p.hubs) {
    const loss = cropLoss(h.width, h.height, p.intake.aspect);
    if (loss > 0.15) {
      warnings.push(`${h.filename} is ${h.detected.aspect}; cropping it to ${p.intake.aspect} loses ` +
        `${Math.round(loss * 100)}% of the frame.`);
    }
  }
  // Which ratio would cost least across all of them. A phone camera shoots 4:3
  // and the default is 16:9, so this is the first thing most people meet;
  // telling them to re-render is no use when the source is a photograph.
  const alternatives = warnings.length
    ? ["16:9", "9:16", "1:1", "4:5"]
        .map((a) => ({ aspect: a, worst: Math.max(...p.hubs.map((h) => cropLoss(h.width, h.height, a))) }))
        .sort((x, y) => x.worst - y.worst)
        .map((x) => ({ aspect: x.aspect, loss: Math.round(x.worst * 100) }))
    : [];
  p.stage = "intake";
  await save(p);
  return { project: p, warnings, alternatives };
});

on("POST", "/api/projects/:pid/budget/confirm", async (m) => {
  const p = await load(m.pid);
  p.budget = await estimate(p);
  p.budget.confirmed = true;
  p.approvals.push({ ts: nowIso(), what: "budget confirmed", detail: { total: p.budget.total } });
  await save(p);
  return p.budget;
});

on("POST", "/api/projects/:pid/reference", async (m, body) => {
  const p = await load(m.pid);
  const f = body.get ? body.get("file") : null;
  if (!f) throw new ApiError(400, "choose a video");
  const job = startJob("reference", 1);
  try {
    job.current = "sampling frames";
    p.reference = await analyseReference(f, f.name, (frac) => { job.current = `sampling frames ${Math.round(frac * 100)}%`; });
    await db.putFile(`projects/${p.id}/reference/${f.name}`, f);
    p.intake.route = "reference";
    await save(p);
  } finally { endJob(); }
  return p.reference;
});

on("POST", "/api/projects/:pid/plan/generate", async (m) => {
  const p = await load(m.pid);
  if (!p.hubs.length) throw new ApiError(409, "upload at least one render first");
  if (!p.location_profile || !p.location_profile.location) p.location_profile = L.profile(p.intake.location);
  p.plan = SP.buildPlan(p, CLIP_SECONDS);
  p.budget = await estimate(p);
  p.stage = "plan";
  await save(p);
  return p.plan;
});

on("PUT", "/api/projects/:pid/plan", async (m, body) => {
  const p = await load(m.pid);
  const byN = Object.fromEntries(p.plan.shots.map((s) => [s.n, s]));
  for (const edited of body.shots) {
    const s = byN[edited.n];
    if (!s) continue;
    Object.assign(s, edited);
    s.duration = Math.max(1, Math.min(15, Number(s.duration) || CLIP_SECONDS));
    if (edited.rederive_state) SP.rederiveState(s, p);
    delete s.rederive_state;
  }
  p.plan.warnings = SP.validate(p.plan, p, p.plan.reference_driven);
  p.budget = await estimate(p);
  await save(p);
  return p.plan;
});

on("POST", "/api/projects/:pid/plan/approve", async (m) => {
  const p = await load(m.pid);
  if (!p.plan.shots.length) throw new ApiError(409, "generate a plan first");
  p.plan.approved = true;
  p.stage = "hero";
  p.approvals.push({ ts: nowIso(), what: "shot plan approved", detail: { shots: p.plan.shots.length } });
  await save(p);
  return p.plan;
});

on("GET", "/api/projects/:pid/plan/prompts/:n", async (m) => {
  const p = await load(m.pid);
  const s = shotOf(p, m.n);
  if (!s) throw new ApiError(404, "no such shot");
  return { still: P.stillPrompt(p, s, hubOf(p, s.source_hub_id) || {}), motion: P.motionPrompt(p, s), negative: P.negativePrompt(s.cls) };
});

on("POST", "/api/projects/:pid/heroes/generate", async (m) => {
  const p = await load(m.pid);
  requireGates(p);
  const { p: prov } = await provider();
  // only the variants that are missing: a class that already has its two is
  // settled, so a second press after a crash does not pay for four more
  const classes = [...new Set(p.hubs.map((h) => h.cls))]
    .filter((cls) => p.heroes.filter((h) => h.cls === cls).length < 2);
  if (!classes.length) throw new ApiError(409, "both variants already exist for every class; choose one below");
  const job = startJob("heroes", classes.length * 2);
  let consecutive = 0;
  try {
    for (const cls of classes) {
      const shot = P.heroShot(p, cls);
      const hub = hubOf(p, shot.source_hub_id);
      for (let variant = p.heroes.filter((h) => h.cls === cls).length + 1; variant <= 2; variant++) {
        if (consecutive >= 2) break;
        job.current = `${cls} variant ${variant}`;
        try {
          const nudge = variant === 2 ? "\n\nSecond variant: the same frame a few minutes later in the light." : "";
          const g = await genStill(p, prov, await db.loadSettings(), shot, hub, nudge, variant);
          const hero = { ...g, variant, chosen: false };
          hero.id = "hero" + g.id.slice(3);
          p.heroes.push(hero);
          charge(p, "hero", g.cost, `${cls} variant ${variant}`);
          consecutive = 0;
        } catch (e) {
          job.errors.push(`${cls} variant ${variant}: ${e.message}`);
          if (++consecutive >= 2) job.errors.push("stopped after two consecutive provider failures");
        }
        job.done += 1;
        await save(p);
      }
    }
    p.stage = "hero";
    await save(p);
  } finally { endJob(); }
  if (!p.heroes.length) throw new ApiError(502, "no hero variants were produced; see the errors above");
  return p.heroes;
});

on("POST", "/api/projects/:pid/heroes/:hid/choose", async (m) => {
  const p = await load(m.pid);
  const h = p.heroes.find((x) => x.id === m.hid);
  if (!h) throw new ApiError(404, "hero not found");
  for (const x of p.heroes) if (x.cls === h.cls) x.chosen = false;
  h.chosen = true;
  h.status = "approved";
  p.approvals.push({ ts: nowIso(), what: "hero chosen", detail: { cls: h.cls, id: h.id } });
  if (new Set(p.hubs.map((x) => x.cls)).size === p.heroes.filter((x) => x.chosen).length) p.stage = "board";
  await save(p);
  return h;
});

/** Generate every still that does not have one yet (spec Part 13).

    Run again after a crash, or after a browser tab was closed halfway, this
    makes only what is missing: a shot with a pending or approved still is
    settled and is not paid for twice. An explicit list of shot numbers (the
    rejected ones) overrides that. Two consecutive provider failures mean the
    provider is down, not unlucky, so the batch stops and says so rather than
    walking the rest of the plan into the same wall. */
async function stillsBatch(pid, shotNs = null, corrections = {}) {
  const p = await load(pid);
  requireGates(p);
  const { p: prov } = await provider();
  const todo = shotNs
    ? p.plan.shots.filter((s) => shotNs.includes(s.n))
    : p.plan.shots.filter((s) => !p.stills.some((x) => x.shot_n === s.n && ["pending", "approved"].includes(x.status)));
  const job = startJob("stills", todo.length);
  job.current = todo.length ? `${todo.length} still(s) to generate` : "nothing to generate: every shot already has a still";
  let consecutive = 0;
  try {
    for (const shot of todo) {
      job.current = `shot ${shot.n} (${shot.cls}, ${shot.season} ${shot.time})`;
      const hub = hubOf(p, shot.source_hub_id);
      if (!hub) { job.errors.push(`shot ${shot.n}: its source render is gone`); job.done += 1; continue; }
      const attempt = p.stills.filter((s) => s.shot_n === shot.n).length + 1;
      try {
        const g = await genStill(p, prov, await db.loadSettings(), shot, hub, corrections[shot.n] || "", attempt);
        p.stills.push(g);
        charge(p, "still", g.cost, `shot ${shot.n} attempt ${attempt}`);
        consecutive = 0;
      } catch (e) {
        job.errors.push(`shot ${shot.n}: ${e.message}`);
        if (++consecutive >= 2) {
          job.errors.push("stopped after two consecutive provider failures; nothing that did not arrive was charged");
          break;
        }
      }
      job.done += 1;
      await save(p);          // crash-safe: work already paid for is on disk
    }
    if (p.stills.length) p.stage = "board";
    await save(p);
  } finally { endJob(); }
}

on("POST", "/api/projects/:pid/stills/generate", async (m, _b, q) => {
  if (q.get("background") === "true") { stillsBatch(m.pid).catch(() => {}); return { started: true }; }
  await stillsBatch(m.pid);
  return load(m.pid);
});

on("POST", "/api/projects/:pid/stills/regenerate", async (m, body) => {
  const p = await load(m.pid);
  const corrections = {};
  for (const n of body.shot_ns) {
    const prev = p.stills.filter((s) => s.shot_n === n).slice(-1)[0];
    corrections[n] = prev && prev.note ? prev.note : "";
  }
  stillsBatch(m.pid, body.shot_ns, corrections).catch(() => {});
  return { started: true };
});

on("POST", "/api/projects/:pid/stills/:sid/approve", async (m) => {
  const p = await load(m.pid);
  const s = p.stills.find((x) => x.id === m.sid);
  if (!s) throw new ApiError(404, "still not found");
  for (const x of p.stills) if (x.shot_n === s.shot_n && x.id !== s.id && x.status === "approved") x.status = "rejected";
  s.status = "approved";
  p.approvals.push({ ts: nowIso(), what: "still approved", detail: { shot: s.shot_n, id: s.id } });
  await save(p);
  return s;
});

on("POST", "/api/projects/:pid/stills/approve_all", async (m) => {
  const p = await load(m.pid);
  const latest = {};
  for (const s of p.stills) if (!latest[s.shot_n] || s.attempt >= latest[s.shot_n].attempt) latest[s.shot_n] = s;
  for (const s of Object.values(latest)) if (s.status === "pending") s.status = "approved";
  p.approvals.push({ ts: nowIso(), what: "stills approved in bulk", detail: { count: Object.keys(latest).length } });
  await save(p);
  return p.stills;
});

on("POST", "/api/projects/:pid/stills/:sid/reject", async (m, body) => {
  const p = await load(m.pid);
  const s = p.stills.find((x) => x.id === m.sid);
  if (!s) throw new ApiError(404, "still not found");
  s.status = "rejected";
  s.note = body.note || "";
  await save(p);
  return s;
});

/** Generate a clip for every shot that lacks one, committing each as it lands.
    Video is the expensive step, so a batch that dies at shot 12 of 14 must not
    lose the twelve already paid for, and running it again must make only the
    two. A cut clip counts as settled: the designer dropped that shot on
    purpose, often at the two-attempt limit, and remaking it would bill a third
    time. */
async function clipsBatch(pid) {
  const p = await load(pid);
  requireGates(p);
  const { p: prov } = await provider();
  const approvedFor = (n) => p.stills.filter((s) => s.shot_n === n && s.status === "approved").slice(-1)[0];
  const todo = p.plan.shots.filter((s) =>
    approvedFor(s.n) && !p.clips.some((c) => c.shot_n === s.n && ["pending", "approved", "cut"].includes(c.status)));
  const job = startJob("clips", todo.length);
  job.current = todo.length ? `${todo.length} clip(s) to generate` : "nothing to generate: every approved still already has a clip";
  let consecutive = 0;
  try {
    for (const shot of todo) {
      const still = approvedFor(shot.n);
      const attempt = p.clips.filter((c) => c.shot_n === shot.n).length + 1;
      job.current = `shot ${shot.n} (${shot.duration}s)`;
      try {
        const c = await genClip(p, prov, still, shot, attempt, "initial", null,
          (frac) => { job.current = `shot ${shot.n} · ${typeof frac === "number" ? Math.round(frac * 100) + "%" : frac}`; });
        p.clips.push(c);
        charge(p, "clip", c.cost, `shot ${shot.n} attempt ${attempt}`);
        consecutive = 0;
        job.current = `shot ${shot.n}: QC ${c.qc.passed ? "pass" : "fail"}`;
      } catch (e) {
        job.errors.push(`shot ${shot.n}: ${e.message}`);
        if (++consecutive >= 2) {
          job.errors.push("stopped after two consecutive provider failures; nothing that did not arrive was charged");
          break;
        }
      }
      job.done += 1;
      await save(p);
    }
    if (p.clips.length) p.stage = "clips";
    await save(p);
  } finally { endJob(); }
}

on("POST", "/api/projects/:pid/clips/generate", async (m, _b, q) => {
  const p = await load(m.pid);
  const missing = p.plan.shots.filter((s) => !p.stills.some((x) => x.shot_n === s.n && x.status === "approved"));
  if (missing.length === p.plan.shots.length) throw new ApiError(409, "no shot has an approved still yet");
  if (q.get("background") === "true") { clipsBatch(m.pid).catch(() => {}); return { started: true }; }
  await clipsBatch(m.pid);
  return load(m.pid);
});

on("POST", "/api/projects/:pid/clips/:cid/approve", async (m) => {
  const p = await load(m.pid);
  const c = p.clips.find((x) => x.id === m.cid);
  if (!c) throw new ApiError(404, "clip not found");
  for (const x of p.clips) if (x.shot_n === c.shot_n && x.id !== c.id && x.status === "approved") x.status = "cut";
  c.status = "approved";
  p.approvals.push({ ts: nowIso(), what: "clip approved", detail: { shot: c.shot_n, id: c.id, qc: c.qc.passed } });
  reconcile(p);
  await save(p);
  return c;
});

on("POST", "/api/projects/:pid/clips/:cid/cut", async (m) => {
  const p = await load(m.pid);
  const c = p.clips.find((x) => x.id === m.cid);
  if (!c) throw new ApiError(404, "clip not found");
  c.status = "cut";
  reconcile(p);
  await save(p);
  return c;
});

/** After MAX_ATTEMPTS_PER_SHOT wet attempts, refuse and recommend a cut or a
    dry re-shoot rather than spending again on the same failure. */
on("POST", "/api/projects/:pid/clips/regenerate", async (m, body) => {
  const p = await load(m.pid);
  requireGates(p);
  const refused = [];
  const queued = [];
  for (const item of body.items) {
    const shot = shotOf(p, item.shot_n);
    if (!shot) throw new ApiError(404, `no shot ${item.shot_n}`);
    const wet = p.clips.filter((c) => c.shot_n === shot.n && c.mode !== "dry");
    if (item.mode !== "dry" && wet.length >= MAX_ATTEMPTS_PER_SHOT) {
      refused.push({
        shot_n: shot.n,
        reason: `Shot ${shot.n} has already had ${wet.length} attempts. The model is not going to get this one. ` +
          `Cut the shot, or choose a dry re-shoot, which drops the weather cue and generates a new still first.`,
      });
      continue;
    }
    queued.push(item);
  }
  if (queued.length) {
    (async () => {
      const job = startJob("clips", queued.length);
      try {
        const pp = await load(m.pid);
        const { p: prov } = await provider();
        for (const item of queued) {
          const shot = shotOf(pp, item.shot_n);
          job.current = `shot ${shot.n} · ${item.mode}`;
          try {
            let still = pp.stills.filter((s) => s.shot_n === shot.n && s.status === "approved").slice(-1)[0];
            const shotForGen = JSON.parse(JSON.stringify(shot));
            if (item.mode === "dry") {
              shotForGen.state.weather = "clear, dry";
              shotForGen.state.precipitation = false;
              shotForGen.motion = "one torn wisp of mist crossing the frame";
            }
            if (item.mode === "lighter_cues") shotForGen.motion = shotForGen.motion.split(",")[0] + ", nothing else moving";
            if (item.mode === "dry" || item.mode === "lighter_cues") {
              // the cue lives in the still, so these two modes need a new one
              const hub = hubOf(pp, shot.source_hub_id);
              const attempt = pp.stills.filter((s) => s.shot_n === shot.n).length + 1;
              const g = await genStill(pp, prov, await db.loadSettings(), shotForGen, hub, item.note || "", attempt);
              g.status = "approved";
              for (const x of pp.stills) if (x.shot_n === shot.n && x.status === "approved") x.status = "rejected";
              pp.stills.push(g);
              charge(pp, "still", g.cost, `shot ${shot.n} ${item.mode} re-shoot`);
              still = g;
              await save(pp);
            }
            let motion = null;
            if (item.mode === "camera_softer") {
              motion = P.motionPrompt(pp, shotForGen).replace(/Camera [^.]+\./, "Camera is locked off and does not move.");
            }
            if (item.mode === "notes" && item.note) motion = P.motionPrompt(pp, shotForGen) + ` Correction, treat as a hard exclusion: ${item.note}`;
            const attempt = pp.clips.filter((c) => c.shot_n === shot.n).length + 1;
            const c = await genClip(pp, prov, still, shotForGen, attempt, item.mode, motion,
              (f) => { job.current = `shot ${shot.n} · ${typeof f === "number" ? Math.round(f * 100) + "%" : f}`; });
            c.note = [c.note, item.note].filter(Boolean).join(" · ");
            pp.clips.push(c);
            charge(pp, "clip", c.cost, `shot ${shot.n} ${item.mode} attempt ${attempt}`);
          } catch (e) {
            job.errors.push(`shot ${item.shot_n}: ${e.message}`);
          }
          job.done += 1;
          await save(pp);
        }
      } finally { endJob(); }
    })().catch(() => {});
  }
  return { refused, queued: queued.length };
});

on("GET", "/api/projects/:pid/jobs", async () => ({
  active: JOB ? { ...JOB, errors: [...JOB.errors] } : null,
  jobs: JOBS.map((j) => ({ ...j, errors: [...j.errors] })),
}));

on("GET", "/api/projects/:pid/sequence/suggest", async (m) => {
  const p = await load(m.pid);
  reconcile(p);
  const clips = approvedClips(p);
  if (!clips.length) throw new ApiError(409, "no approved clips yet");
  const shots = Object.fromEntries(p.plan.shots.map((s) => [s.n, s]));
  const ordered = clips.filter((c) => c.shot_n in shots)
    .sort((a, b) => (shots[a.shot_n].chapter - shots[b.shot_n].chapter) || (a.shot_n - b.shot_n));
  p.sequence.suggested_order = ordered.map((c) => c.id);
  // Always re-suggest: a clip approved after the first suggest was otherwise
  // invisible here and silently absent from the film.
  p.sequence.order = [...p.sequence.suggested_order];
  p.sequence.rationale = p.plan.rationale ||
    "Plan order: calendar seasons, dawn to night, scale pyramid, chapter closers, human beats at the edges.";
  p.sequence.warnings = seqWarnings(p, ordered);
  p.stage = "sequence";
  await save(p);
  return seqPreview(p);
});

on("GET", "/api/projects/:pid/sequence/preview", async (m) => {
  const p = await load(m.pid);
  reconcile(p);
  await save(p);
  return seqPreview(p);
});

on("PUT", "/api/projects/:pid/sequence", async (m, body) => {
  const p = await load(m.pid);
  const ids = new Set(approvedClips(p).map((c) => c.id));
  if (body.order.length !== ids.size || !body.order.every((i) => ids.has(i))) {
    throw new ApiError(400, `order must contain every approved clip exactly once; ${ids.size} approved, ${new Set(body.order).size} given`);
  }
  p.sequence.order = body.order;
  const byId = Object.fromEntries(p.clips.map((c) => [c.id, c]));
  p.sequence.warnings = seqWarnings(p, body.order.map((i) => byId[i]));
  await save(p);
  return seqPreview(p);
});

on("PUT", "/api/projects/:pid/branding", async (m, body) => {
  const p = await load(m.pid);
  Object.assign(p.branding, body);
  p.stage = "branding";
  await save(p);
  return p.branding;
});

on("POST", "/api/projects/:pid/branding/logo", async (m, body) => {
  const p = await load(m.pid);
  const f = body.get("file");
  if (!f) throw new ApiError(400, "no file");
  const path = `projects/${p.id}/branding/logo`;
  await db.putFile(path, f);
  p.branding.logo_path = path;
  await save(p);
  return { ok: true };
});

on("POST", "/api/projects/:pid/audio/:kind", async (m, body) => {
  const p = await load(m.pid);
  if (!["exterior", "interior", "score"].includes(m.kind)) throw new ApiError(400, "kind must be exterior, interior or score");
  const f = body.get("file");
  if (!f) throw new ApiError(400, "no file");
  const path = `projects/${p.id}/audio/${m.kind}`;
  await db.putFile(path, f);
  p.audio_beds[m.kind] = path;
  await save(p);
  return { ok: true };
});

on("POST", "/api/projects/:pid/render", async (m, _b, q) => {
  const p = await load(m.pid);
  reconcile(p);
  const byId = Object.fromEntries(p.clips.map((c) => [c.id, c]));
  const shots = new Set(p.plan.shots.map((s) => s.n));
  const ordered = p.sequence.order.map((i) => byId[i]).filter((c) => c && c.status === "approved" && shots.has(c.shot_n));
  if (!ordered.length) throw new ApiError(409, "no approved clips to render");

  const job = startJob("render", 1 + (q.get("crops") ? q.get("crops").split(",").filter(Boolean).length : 0));
  try {
    const clips = [];
    for (const c of ordered) clips.push({ blob: await db.getFile(c.path), duration: c.duration });
    const beds = {};
    for (const [k, path] of Object.entries(p.audio_beds)) {
      const b = await db.getFile(path);
      if (b) beds[k] = b;
    }
    const logo = p.branding.logo_path ? await db.getFile(p.branding.logo_path) : null;
    // the clips carry their class so the bed can follow it (spec 12.5)
    ordered.forEach((c, i) => { clips[i].cls = c.cls; clips[i].chapter = (shotOf(p, c.shot_n) || {}).chapter || 1; });
    // the render size is the caller's choice, because a phone cannot hold a
    // 1080p canvas, five video elements and an encoder at once
    const scale = Math.min(1, Math.max(0.25, Number(q.get("scale")) || 1));
    job.current = "recording the film in real time";
    const film = await renderFilm(p, clips, beds, logo, (frac, label) => { job.current = `film · ${label}`; }, scale);
    const filmPath = `projects/${p.id}/deliverables/film.${film.ext}`;
    await db.putFile(filmPath, film.blob);
    p.deliverables.film = filmPath;
    p.deliverables.verification = await verify(film.blob, film.expected, p.intake.aspect, film.usedUploaded, film.info, [film.width, film.height]);
    job.done += 1;
    await save(p);

    p.deliverables.crops = {};
    for (const a of (q.get("crops") || "").split(",").filter(Boolean)) {
      if (a === p.intake.aspect) continue;
      job.current = `crop ${a}`;
      try {
        const crop = await renderCrop(film.blob, a, () => {}, scale);
        const cp = `projects/${p.id}/deliverables/film_${a.replace(":", "x")}.${crop.ext}`;
        await db.putFile(cp, crop.blob);
        p.deliverables.crops[a] = cp;
      } catch (e) { job.errors.push(`crop ${a}: ${e.message}`); }
      job.done += 1;
      await save(p);
    }

    job.current = "stills pack";
    const packFiles = [];
    for (const h of p.heroes.filter((x) => x.chosen)) {
      const b = await db.getFile(h.path);
      if (b) packFiles.push({ name: `hero_${h.cls}.jpg`, blob: b });
    }
    for (const s of p.stills.filter((x) => x.status === "approved")) {
      const b = await db.getFile(s.path);
      if (b) packFiles.push({ name: `shot_${String(s.shot_n).padStart(2, "0")}_${s.cls}.jpg`, blob: b });
    }
    const packPath = `projects/${p.id}/deliverables/stills_pack.zip`;
    await db.putFile(packPath, await stillsPack(p, packFiles));
    p.deliverables.stills_pack = packPath;

    const rec = projectRecord(p, spendOf(p));
    await db.putFile(`projects/${p.id}/deliverables/record.html`, rec.html);
    await db.putFile(`projects/${p.id}/deliverables/record.json`, rec.json);
    p.deliverables.record_html = `projects/${p.id}/deliverables/record.html`;
    p.deliverables.record_json = `projects/${p.id}/deliverables/record.json`;
    p.stage = "delivered";
    p.approvals.push({ ts: nowIso(), what: "film rendered", detail: { clips: ordered.length, container: film.mime } });
    await save(p);
  } finally { endJob(); }
  return p.deliverables;
});

on("GET", "/api/projects/:pid/ledger", async (m) => {
  const p = await load(m.pid);
  const byKind = {};
  for (const e of p.ledger) byKind[e.kind] = Math.round((byKind[e.kind] || 0) + e.cost, 4);
  return { spent: spendOf(p), budget_total: p.budget.total, by_kind: byKind, entries: p.ledger.length };
});

// -------------------------------------------------------------- dispatch

/** The same call signature the fetch wrapper used, so the interface layer did
    not have to change: call(path, {method, body}). */
export async function call(path, opts = {}) {
  const [rawPath, rawQuery] = path.split("?");
  const query = new URLSearchParams(rawQuery || "");
  const parts = rawPath.split("/");
  const method = opts.method || (opts.body !== undefined ? "POST" : "GET");
  for (const r of ROUTES) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const m = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (r.parts[i].startsWith(":")) m[r.parts[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (r.parts[i] !== parts[i]) { ok = false; break; }
    }
    if (!ok) continue;
    try {
      return await r.fn(m, opts.body, query);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof ProviderError) throw new ApiError(502, "provider error: " + e.message);
      throw new ApiError(500, e.message || String(e));
    }
  }
  throw new ApiError(404, `no route for ${method} ${rawPath}`);
}
