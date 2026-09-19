/* ArchViz Cinematic Engine front end. No build step: plain ES modules.
   One renderer per stage of the spec; the engine enforces every gate.

   `call` runs the engine in this tab instead of posting to a server, and
   images and video come out of IndexedDB as object URLs, which is why markup
   carries data-file attributes that are resolved after each render rather
   than a src.

   Two things the interface itself is responsible for: saying what to do next
   and why a thing cannot be done yet, at the point where the person is
   looking. A gate the engine enforces silently is a gate the designer meets
   as an error toast; here every stage carries its state in the nav, a banner
   names the next step, and an action that is blocked says what unblocks it. */

import { call, ApiError, MAX_ATTEMPTS_PER_SHOT } from "./engine/api.js";
import { fileURL, quota, persist } from "./engine/db.js";
import { probe } from "./engine/recorder.js";
import { RES, resFor, commonAspect, ratioOf } from "./engine/compose.js";
import { VOCAB, elementSuggestions } from "./engine/draft.js";
import { profile as locationProfile } from "./engine/location.js";

// The module evaluated, which is what the shell's watchdog is waiting to hear.
// Whether the first screen draws is a separate signal, set after init resolves.
window.__booted = true;

const isSmallScreen = () => matchMedia("(max-width: 760px), (pointer: coarse)").matches;

const STAGES = [
  ["intake", "Intake"], ["reference", "Reference"], ["plan", "Shot plan"], ["hero", "Hero gate"],
  ["board", "Still board"], ["clips", "Clips + QC"], ["sequence", "Sequence"], ["branding", "Branding"], ["render", "Render"],
];
const SEASONS = ["spring", "summer", "monsoon", "autumn", "winter"];
const TIMES = ["dawn", "morning", "midday", "afternoon", "golden_hour", "dusk", "night"];
const SCALES = ["aerial", "wide", "medium", "detail", "macro"];

let P = null;          // current project document
let view = "intake";   // current stage view
let health = {};
let pendingIntake = null;   // questionnaire held across a re-render
let settings = null;
/* Two front doors to the same engine. Simple is the default because most of
   the time the answer to "what do you want" is a film, and the studio is one
   link away for the times it is not. */
let mode = (() => { try { return localStorage.getItem("archviz-mode") || "simple"; } catch { return "simple"; } })();
function setMode(m) {
  mode = m;
  try { localStorage.setItem("archviz-mode", m); } catch { /* private window */ }
  if (m === "simple") P = null;
  renderChrome();
  renderAll();
}
window.setMode = setMode;

// ------------------------------------------------------------------ helpers
async function api(path, opts = {}) {
  try { return await call(path, opts); }
  catch (e) { if (e instanceof ApiError) throw new Error(e.detail); throw e; }
}
function toast(msg, bad = false) { const t = el("toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : ""); setTimeout(() => t.className = "toast", bad ? 8000 : 2600); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function el(id) { return document.getElementById(id); }
function fmt(x, d = 2) { return typeof x === "number" ? x.toFixed(d) : x; }
const label = (s) => String(s || "").replace(/_/g, " ");
window.closeModal = () => el("modal").classList.add("hidden");

/** A WebM written by MediaRecorder states no duration, so a player shows 0:00
    and an unusable scrubber until something forces the length out of it. */
function fixDuration(v) {
  const settle = () => {
    if (isFinite(v.duration) && v.duration > 0) return;
    const restore = () => { v.removeEventListener("seeked", restore); v.currentTime = 0; };
    v.addEventListener("seeked", restore, { once: true });
    try { v.currentTime = 1e6; } catch { /* nothing more to try */ }
  };
  if (v.readyState >= 1) settle(); else v.addEventListener("loadedmetadata", settle, { once: true });
}
async function hydrate(root) {
  const jobs = [];
  root.querySelectorAll("[data-file]").forEach((n) => {
    jobs.push(fileURL(n.dataset.file).then((u) => {
      if (!u) return;
      if (n.tagName === "A") n.href = u;
      else { n.src = u; if (n.tagName === "VIDEO") fixDuration(n); }
    }));
  });
  root.querySelectorAll("[data-poster]").forEach((n) => jobs.push(fileURL(n.dataset.poster).then((u) => { if (u) n.poster = u; })));
  await Promise.all(jobs);
}
async function setHTML(node, html) { node.innerHTML = html; await hydrate(node); }
function modal(html) { setHTML(el("modal-body"), html); el("modal").classList.remove("hidden"); }
async function busy(fn, msg) {
  const m = el("main"); m.classList.add("busy");
  if (msg) toast(msg);
  try { await fn(); } catch (e) { toast(e.message, true); console.error(e); } finally { m.classList.remove("busy"); }
}
async function pollJob(kind) {
  const bar = el("jobbar");
  // the route that starts the work is itself async, so give the job a moment
  // to register before deciding there is nothing to follow
  for (let i = 0; i < 25; i++) {
    const { active } = await api(`/api/projects/${P.id}/jobs`);
    if (active) break;
    await new Promise(r => setTimeout(r, 80));
  }
  for (;;) {
    const { active } = await api(`/api/projects/${P.id}/jobs`);
    if (!active) break;
    if (bar) {
      const pct = active.total ? Math.round((active.done / active.total) * 100) : 0;
      bar.innerHTML = `<div class="card"><b>Generating ${esc(active.kind)}</b> · ${active.done}/${active.total} (${pct}%)
        <div class="muted">${esc(active.current || "")}</div>
        ${active.errors.length ? `<ul class="warn-list">${active.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}</div>`;
    }
    await new Promise(r => setTimeout(r, 900));
  }
  const { jobs: all } = await api(`/api/projects/${P.id}/jobs`);
  const last = all.filter(j => j.kind === kind).pop();
  if (last && last.errors.length) toast(`${kind}: ${last.errors.join("; ")}`, true);
  else if (last && last.total === 0) toast(last.current || "nothing to generate");
  if (bar) bar.innerHTML = "";
}
async function reload() { if (P) P = await api(`/api/projects/${P.id}`); renderChrome(); await renderAll(); }
function hub(id) { return (P.hubs || []).find(h => h.id === id) || {}; }
function latestBy(list, key) { const m = {}; list.forEach(x => { if (!m[x[key]] || x.attempt >= m[x[key]].attempt) m[x[key]] = x; }); return m; }

/** Download a Blob the engine produced. */
function download(blob, filename) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 30000);
}

// --------------------------------------------------------------- readiness
/** What each stage needs, and whether it has it. The engine enforces these;
    this is the same truth stated where the person can see it. */
function readiness() {
  const r = {};
  if (!P) return r;
  const classes = [...new Set(P.hubs.map(h => h.cls))];
  const chosen = classes.length && classes.every(c => P.heroes.some(h => h.cls === c && h.chosen));
  const shots = P.plan.shots || [];
  const approvedStill = n => P.stills.some(s => s.shot_n === n && s.status === "approved");
  const approvedClip = n => P.clips.some(c => c.shot_n === n && c.status === "approved");
  const anyClip = P.clips.some(c => c.status === "approved");
  r.intake = P.hubs.length && P.intake.location && P.budget.confirmed
    ? { s: "done" } : { s: "ready", why: !P.hubs.length ? "upload at least one render" : !P.intake.location ? "save the intake with a location" : "confirm the budget" };
  r.reference = P.reference ? { s: "done" } : { s: "ready", why: "optional: upload a film to copy its structure" };
  r.plan = !P.hubs.length || !P.intake.location ? { s: "locked", why: "needs renders and a saved intake" }
    : P.plan.approved ? { s: "done" } : { s: "ready", why: shots.length ? "review the plan and approve it" : "generate the plan" };
  r.hero = !P.plan.approved ? { s: "locked", why: "approve the shot plan first" }
    : !P.budget.confirmed ? { s: "locked", why: "confirm the budget on the intake page" }
    : chosen ? { s: "done" } : { s: "ready", why: P.heroes.length ? "choose one hero per class" : "generate the hero variants" };
  r.board = !chosen ? { s: "locked", why: "choose a hero for every class first" }
    : shots.length && shots.every(s => approvedStill(s.n)) ? { s: "done" } : { s: "ready", why: P.stills.length ? "approve or reject each still" : "generate the still board" };
  r.clips = !P.stills.some(s => s.status === "approved") ? { s: "locked", why: "approve at least one still first" }
    : shots.length && shots.every(s => approvedClip(s.n) || P.clips.some(c => c.shot_n === s.n && c.status === "cut")) ? { s: "done" }
    : { s: "ready", why: P.clips.length ? "approve, cut or regenerate each clip" : "generate clips for the approved stills" };
  r.sequence = !anyClip ? { s: "locked", why: "approve at least one clip first" }
    : P.sequence.order.length ? { s: "done" } : { s: "ready", why: "suggest an order" };
  r.branding = !anyClip ? { s: "locked", why: "approve at least one clip first" }
    : ["branding", "render", "delivered"].includes(P.stage) ? { s: "done" } : { s: "ready", why: "set the title card and save" };
  r.render = !anyClip ? { s: "locked", why: "approve at least one clip first" }
    : P.deliverables.film ? { s: "done" } : { s: "ready", why: "render the film" };
  return r;
}
function blocker(stage) {
  const r = readiness()[stage];
  return r && r.s === "locked" ? `<div class="blocker">Not yet: ${esc(r.why)}.</div>` : "";
}
function locked(stage) { const r = readiness()[stage]; return r && r.s === "locked"; }

// ------------------------------------------------------------------ chrome
function renderChrome() {
  const bar = el("projbar");
  if (mode === "simple") {
    bar.innerHTML = `<button class="btn small secondary" onclick="openSettings()">Settings</button>`;
    el("steps").innerHTML = ""; el("next").innerHTML = ""; el("spend").innerHTML = "";
    document.body.classList.add("simplemode");
    return;
  }
  document.body.classList.remove("simplemode");
  if (P) {
    bar.innerHTML = `<span class="crumb"><button class="btn small secondary" id="projects">Projects</button><b>${esc(P.name)}</b><span class="tag">${esc(P.stage)}</span></span>
      <span class="muted">generator: <b>${esc((settings && settings.provider) || health.provider || "?")}</b></span>
      <button class="btn small secondary" onclick="openSettings()">Settings</button>`;
    el("projects").onclick = () => { P = null; renderChrome(); renderAll(); };
  } else {
    bar.innerHTML = `<span class="muted">generator: <b>${esc((settings && settings.provider) || health.provider || "?")}</b></span>
      <button class="btn small secondary" onclick="openSettings()">Settings</button>`;
  }
  renderSteps(); renderSpend(); renderNext();
}
function renderSteps() {
  const s = el("steps");
  if (!P) { s.innerHTML = ""; return; }
  const r = readiness();
  s.innerHTML = STAGES.map(([k, name], i) => {
    const st = r[k] || { s: "ready" };
    const mark = st.s === "done" ? "✓" : st.s === "locked" ? "•" : String(i + 1);
    return `<button data-k="${k}" class="${view === k ? "active" : ""} ${st.s}" title="${esc(st.why || "")}"><span class="st">${mark}</span>${name}</button>`;
  }).join("");
  s.querySelectorAll("button").forEach(b => b.onclick = () => { view = b.dataset.k; renderChrome(); renderAll(); });
}
function renderNext() {
  const n = el("next");
  if (!P) { n.innerHTML = ""; return; }
  const r = readiness();
  const order = STAGES.map(x => x[0]).filter(k => k !== "reference");
  const k = order.find(k => r[k].s !== "done");
  if (!k) { n.innerHTML = `<span>✓ <b>Delivered.</b> The film, the crops, the stills pack and the record are on the render page.</span>`; return; }
  const name = STAGES.find(x => x[0] === k)[1];
  n.innerHTML = `<span>Next: <b>${esc(name)}</b> · ${esc(r[k].why)}</span>${view !== k ? `<button class="btn small" id="gonext">Go there</button>` : ""}`;
  const g = el("gonext"); if (g) g.onclick = () => { view = k; renderChrome(); renderAll(); };
}
function renderSpend() {
  const sp = el("spend");
  if (!P) { sp.innerHTML = ""; return; }
  const spent = (P.ledger || []).reduce((a, e) => a + e.cost, 0);
  sp.innerHTML = `spend <b>${spent.toFixed(2)}</b> / budget ${P.budget.total ? P.budget.total.toFixed(2) : "not set"} ${P.budget.confirmed ? "" : "<span class='tag warn'>unconfirmed</span>"}`;
}

// ---------------------------------------------------------------- settings
async function openSettings() {
  const st = await api("/api/settings");
  const rec = await probe();
  modal(`<h3>Settings</h3>
    <p class="muted">Kept in this browser's storage, on this device only. Nothing is sent to any server by this page and nothing here is in the repository. Clearing site data for this address erases the key, every project and every generated file, so export projects you care about.</p>
    <div class="row">
      <label class="f">generator<select id="set_provider">
        <option value="demo" ${st.provider === "demo" ? "selected" : ""}>Demo (runs in this tab, free, nothing is charged)</option>
        <option value="freepik" ${st.provider === "freepik" ? "selected" : ""}>Freepik (real generation, real money)</option>
      </select></label>
      <label class="f wide">Freepik API key<input id="set_key" type="password" placeholder="${st.has_key ? "set: " + esc(st.key_hint) + " — type to replace" : "paste your key"}"></label>
    </div>
    <div id="set_warn" class="warn-list" style="list-style:none;padding:0;${st.provider === "freepik" ? "" : "display:none"}">
      <b>Read this before you paste a paid key.</b> This page has no server. A browser can only read a reply from another site when that site says it may, and an API that takes a secret key normally says it may not. Press <b>Test the key</b>: it says plainly whether calls from this browser get through. If they do not, either point the base URL at a relay you control, or run the Python server from the repository, which calls from the server side where this restriction does not exist. The demo generator needs none of this.
    </div>
    <details style="margin-top:10px"><summary>Endpoints and pricing</summary>
      <div class="row" style="margin-top:8px">
        <label class="f wide">base URL<input id="set_base" value="${esc(st.base_url)}"></label>
        <label class="f wide">image edit path<input id="set_ip" value="${esc(st.image_path)}"></label>
        <label class="f wide">image-to-video path<input id="set_vp" value="${esc(st.video_path)}"></label>
        <label class="f">cost per image<input id="set_ic" type="number" step="0.01" min="0" value="${st.image_cost}"></label>
        <label class="f">cost per 5s clip<input id="set_vc" type="number" step="0.01" min="0" value="${st.video_cost}"></label>
      </div>
    </details>
    <p class="muted" style="margin-top:10px">${rec.info
      ? `This browser writes video as <b>${esc(rec.info.label)}</b>, measured by recording a fraction of a second and reading the bytes back, so films and demo clips come out as <b>.${esc(rec.info.container)}</b>.` +
        (rec.info.interoperable ? "" : " That plays in any browser but not in QuickTime, PowerPoint or most editors: this browser has no H.264 encoder. Chrome, Edge and Safari on a normal desktop usually do.")
      : "This browser cannot record video at all, so the demo generator and the final render will not work here."}</p>
    <div class="row" style="margin-top:12px"><button class="btn" id="set_save">Save</button><button class="btn secondary" id="set_test">Test the key</button><button class="btn secondary" id="set_check">Check this browser</button></div>
    <div id="set_result" class="muted" style="margin-top:10px"></div>`);
  el("set_check").onclick = () => selfCheck();
  el("set_provider").onchange = () => { el("set_warn").style.display = el("set_provider").value === "freepik" ? "" : "none"; };
  el("set_save").onclick = () => busy(async () => {
    const body = { provider: el("set_provider").value, image_cost: +el("set_ic").value, video_cost: +el("set_vc").value,
      base_url: el("set_base").value, image_path: el("set_ip").value, video_path: el("set_vp").value };
    const k = el("set_key").value; if (k) body.freepik_api_key = k;
    settings = await api("/api/settings", { method: "PUT", body });
    el("set_result").textContent = "Saved."; toast("settings saved"); renderChrome();
  });
  el("set_test").onclick = () => busy(async () => {
    el("set_result").textContent = "testing…";
    const r = await api("/api/settings/test", { method: "POST" });
    el("set_result").innerHTML = `<span class="tag ${r.ok ? "ok" : "bad"}">${r.ok ? "reachable" : "blocked"}</span> ${esc(r.detail)}`;
  });
}
window.openSettings = openSettings;

/* An eight-pixel greyscale JPEG. The check decodes this for real rather than
   asking the browser whether it believes it can read JPEGs. */
const TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAFA3PEY8MlBGQUZaVVBfeMiCeG5uePWvuZHI////////////////////////////////////////////////////wAALCAAIAAgBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z";

/** What this browser can actually do, one line at a time. Everything in this
    tool runs in the page, so when something does not work it is this list that
    says why. The report copies as plain text so it can be sent on as it is. */
async function selfCheck() {
  const rows = [];
  const add = (name, ok, detail) => rows.push([name, ok, detail]);

  add("JavaScript modules", true, "running: the tool loaded its own code");

  let idb = false, idbWhy = "";
  try {
    await new Promise((res, rej) => {
      const r = indexedDB.open("archviz-selfcheck", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("t");
      r.onsuccess = () => { r.result.close(); try { indexedDB.deleteDatabase("archviz-selfcheck"); } catch { } res(); };
      r.onerror = () => rej(r.error || new Error("refused"));
      r.onblocked = () => rej(new Error("blocked by another tab"));
    });
    idb = true;
  } catch (e) { idbWhy = e.message || String(e); }
  const q = await quota();
  add("Project storage", idb, idb
    ? (q ? `${(q.free / 1e9).toFixed(1)} GB free of ${(q.quota / 1e9).toFixed(1)} GB` : "available")
    : `IndexedDB will not open (${idbWhy}). Private browsing and blocked site data both do this, and nothing can be saved without it.`);

  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  add("Storage kept between visits", !!(navigator.storage && navigator.storage.persist), navigator.storage && navigator.storage.persist
    ? (persisted ? "granted: the browser will not evict your projects on its own" : "not granted yet; it is asked for when you create a project")
    : "this browser does not offer it, so a long-idle project can be evicted. Export anything you care about.");

  const ctx = document.createElement("canvas").getContext("2d");
  add("Canvas drawing", !!ctx, ctx ? "2D context available" : "no 2D context: nothing can be composed, measured or rendered");

  let jpeg = false, jpegWhy = "";
  try {
    const bm = await createImageBitmap(await (await fetch(TINY_JPEG)).blob());
    jpeg = bm.width === 8 && bm.height === 8;
    if (bm.close) bm.close();
  } catch (e) { jpegWhy = e.message || String(e); }
  add("JPEG decoding", jpeg, jpeg ? "a JPEG was decoded here just now, so photo upload works" : "failed: " + jpegWhy);

  const inp = document.createElement("input"); inp.type = "file";
  add("Choosing files", !!(window.File && window.FileList && "files" in inp && inp.type === "file"),
    "multiple: " + ("multiple" in inp) + " · camera: " + ("capture" in inp));

  const rec = await probe().catch(() => ({}));
  add("Video recording", !!rec.info, rec.info
    ? `${rec.info.label} written into .${rec.info.container}` + (rec.info.interoperable ? "" : ". That plays in browsers but not in QuickTime, PowerPoint or most editors: no H.264 encoder here.")
    : "this browser cannot record video, so demo clips and the final film will not work. Chrome, Edge and Safari can.");

  const AC = window.AudioContext || window.webkitAudioContext;
  add("Sound", typeof AC === "function", typeof AC === "function" ? "WebAudio available for the ambience bed" : "no WebAudio: films come out silent");

  add("Reading a project ZIP", typeof DecompressionStream === "function",
    typeof DecompressionStream === "function" ? "import works" : "import of an exported project will not work in this browser; export still does");

  add("Screen stays awake while rendering", !!navigator.wakeLock,
    navigator.wakeLock ? "the screen is held on during a render" : "not offered: keep the screen on yourself, or a long render is thrown away");

  const ok = rows.filter(r => r[1]).length;
  const text = [
    `ArchViz Cinematic Engine — browser check (${ok}/${rows.length} clear)`,
    `${location.href}`,
    `${navigator.userAgent}`,
    `screen ${screen.width}x${screen.height} @${devicePixelRatio}x · window ${innerWidth}x${innerHeight}`,
    "", ...rows.map(r => `${r[1] ? "ok  " : "NO  "}${r[0]}: ${r[2]}`),
  ].join("\n");

  modal(`<h3>This browser</h3>
    <p class="muted">${ok === rows.length ? "Everything this tool needs is here." : "The lines marked in red are what will not work here."} Copy the report if you need to send it on.</p>
    <div class="kv check">${rows.map(r => `<div><span class="tag ${r[1] ? "ok" : "bad"}">${r[1] ? "ok" : "no"}</span> ${esc(r[0])}</div><div>${esc(r[2])}</div>`).join("")}</div>
    <p class="muted" style="margin-top:12px">${esc(navigator.userAgent)}<br>screen ${screen.width}×${screen.height} at ${devicePixelRatio}× · window ${innerWidth}×${innerHeight}</p>
    <div class="row" style="margin-top:10px"><button class="btn secondary" id="copycheck">Copy the report</button></div>`);
  el("copycheck").onclick = async () => {
    try { await navigator.clipboard.writeText(text); toast("report copied"); }
    catch { modal(`<h3>This browser</h3><textarea rows="18" style="width:100%">${esc(text)}</textarea>`); }
  };
}
window.selfCheck = selfCheck;

// ------------------------------------------------------------------- frame
async function init() {
  health = await api("/api/health").catch(() => ({}));
  settings = (await api("/api/auth/state")).settings;
  el("home").onclick = (e) => { e.preventDefault(); P = null; renderChrome(); renderAll(); };
  renderChrome();
  await renderAll();
}
async function renderAll() {
  const m = el("main");
  if (mode === "simple") {
    if (P && P.deliverables && P.deliverables.film) await rDone(); else await rSimple();
    window.scrollTo({ top: 0 });
    return;
  }
  if (!P) { await rHome(); return; }
  await ({ intake: rIntake, reference: rReference, plan: rPlan, hero: rHero, board: rBoard, clips: rClips, sequence: rSequence, branding: rBranding, render: rRender })[view]();
  window.scrollTo({ top: 0 });
}
async function open(id, stage) { P = await api(`/api/projects/${id}`); view = stage || (P.stage === "delivered" ? "render" : (P.stage || "intake")); renderChrome(); await renderAll(); }

/* Two renders drawn in this tab, plus the brief that goes with them, so the
   tool can be taken end to end before anyone goes looking for their own files.
   They are plain shapes and the page says so: nothing is downloaded, nothing is
   pretended, and they go in through exactly the upload path a photo does. */
function sampleJPEG(w, h, paint) {
  return new Promise(res => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    paint(c.getContext("2d"), w, h);
    c.toBlob(b => res(b), "image/jpeg", 0.92);
  });
}
async function sampleRenders() {
  const ext = await sampleJPEG(1600, 900, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
    sky.addColorStop(0, "#6f9cc6"); sky.addColorStop(1, "#d6e3ee");
    g.fillStyle = sky; g.fillRect(0, 0, w, h * 0.62);
    g.fillStyle = "#8b9a63"; g.fillRect(0, h * 0.62, w, h * 0.38);          // lawn
    g.fillStyle = "#6e6e6e"; g.fillRect(0, h * 0.88, w, h * 0.12);          // road
    g.fillStyle = "#c9c1b2"; g.fillRect(w * 0.22, h * 0.30, w * 0.46, h * 0.40); // mass
    g.fillStyle = "#9a6b3f"; g.fillRect(w * 0.22, h * 0.30, w * 0.46, h * 0.15); // timber band
    g.fillStyle = "#2c3c4a";
    for (let i = 0; i < 4; i++) {                                           // four windows a level
      g.fillRect(w * (0.26 + i * 0.105), h * 0.34, w * 0.07, h * 0.08);
      g.fillRect(w * (0.26 + i * 0.105), h * 0.50, w * 0.07, h * 0.12);
    }
    g.fillStyle = "#3d3d3d"; g.fillRect(w * 0.30, h * 0.58, w * 0.20, h * 0.015); // canopy
    g.fillStyle = "#8d8378"; g.fillRect(0, h * 0.70, w, h * 0.02);          // retaining wall
    for (const [x, r] of [[0.10, 0.10], [0.86, 0.13]]) {                    // two oaks
      g.fillStyle = "#5a4630"; g.fillRect(w * x - 6, h * 0.52, 12, h * 0.20);
      g.fillStyle = "#4f6b3a"; g.beginPath(); g.arc(w * x, h * 0.48, h * r, 0, 7); g.fill();
    }
  });
  const int = await sampleJPEG(1600, 900, (g, w, h) => {
    g.fillStyle = "#efe9df"; g.fillRect(0, 0, w, h);                        // walls
    g.fillStyle = "#e6e0d5"; g.fillRect(0, 0, w, h * 0.14);                 // ceiling
    g.fillStyle = "#b98f5e"; g.fillRect(0, h * 0.72, w, h * 0.28); // oak floor
    g.fillStyle = "#6e8a4e"; g.fillRect(w * 0.52, h * 0.40, w * 0.44, h * 0.32); // garden through the glass
    g.fillStyle = "#3a5a2c"; g.fillRect(w * 0.52, h * 0.62, w * 0.44, h * 0.10);
    g.strokeStyle = "#39414a"; g.lineWidth = Math.max(2, w * 0.005);        // mullions
    for (let i = 0; i <= 3; i++) { const x = w * (0.52 + i * 0.1467); g.beginPath(); g.moveTo(x, h * 0.40); g.lineTo(x, h * 0.72); g.stroke(); }
    g.beginPath(); g.moveTo(w * 0.52, h * 0.40); g.lineTo(w * 0.96, h * 0.40); g.stroke();
    g.fillStyle = "#d9d2c6"; g.fillRect(w * 0.04, h * 0.18, w * 0.30, h * 0.54); // joinery
    g.fillStyle = "#9a9285"; g.fillRect(w * 0.30, h * 0.56, w * 0.26, h * 0.06); // island
    g.fillStyle = "#7b7367"; g.fillRect(w * 0.30, h * 0.62, w * 0.26, h * 0.10);
    g.fillStyle = "#2f2f2f";
    for (const x of [0.36, 0.48]) { g.fillRect(w * x, h * 0.20, 2, h * 0.28); g.beginPath(); g.arc(w * x + 1, h * 0.49, h * 0.018, 0, 7); g.fill(); }
    const pool = g.createLinearGradient(w * 0.52, 0, w * 0.20, 0);          // light off the glass
    pool.addColorStop(0, "rgba(255,238,200,.55)"); pool.addColorStop(1, "rgba(255,238,200,0)");
    g.fillStyle = pool; g.fillRect(w * 0.20, h * 0.72, w * 0.36, h * 0.28);
    g.fillStyle = "#c2b6a4"; g.fillRect(w * 0.12, h * 0.80, w * 0.34, h * 0.14); // wool rug
  });
  return [new File([ext], "sample-exterior.jpg", { type: "image/jpeg" }),
          new File([int], "sample-interior.jpg", { type: "image/jpeg" })];
}

/** A whole project, one tap: the two renders above, their finishes named, and
    the brief filled in ready to save. Everything after that is the real thing. */
async function startSample() {
  await persist();
  P = await api("/api/projects", { body: { name: "Sample: Willow Glen house" } });
  const fd = new FormData();
  for (const f of await sampleRenders()) fd.append("files", f);
  await api(`/api/projects/${P.id}/hubs`, { body: fd });
  P = await api(`/api/projects/${P.id}`);
  const say = {
    exterior: { label: "street elevation", camera_faces: "N",
      materials: "board-formed concrete base, spotted gum battens, zinc standing seam roof",
      elements: "two levels, four windows per level, entry canopy, retaining wall along the front, road, two oaks" },
    interior: { label: "kitchen and living",
      materials: "oak floor and joinery, honed limestone benchtop, wool rug, black steel window frames",
      elements: "one window wall of four bays, island with two pendants, full-height joinery left" },
  };
  for (const h of P.hubs) {
    const s = say[h.cls]; if (!s) continue;
    for (const [k, v] of Object.entries(s)) await api(`/api/projects/${P.id}/hubs/${h.id}`, { method: "PATCH", body: { [k]: v } });
  }
  P = await api(`/api/projects/${P.id}`);
  // held for the intake form rather than saved, so the first real decision is
  // still the designer's
  pendingIntake = {
    location: "Willow Glen, San Jose, California", project_name: "Willow Glen house", practice_name: "",
    seasons: ["spring", "summer", "autumn", "winter"], time_arc: "full_day", mood: "serene",
    design_intents: ["the way afternoon light enters the living room", "the entry canopy against the street", "the deck meeting the garden"],
  };
  view = "intake"; renderChrome(); await renderAll();
  toast("two sample renders drawn and named — press Save intake to carry on");
}

/* ------------------------------------------------------------------ simple

   The whole app in one screen: photos in, a season, a film out.

   Everything the studio view asks for is either answered from the photos, from
   where this browser is, or from a default that a small practice would pick
   anyway. The nine stages still run underneath, in order, with every gate
   satisfied automatically — this is a different front door to the same engine,
   not a second engine.

   The one thing that is never automatic is spending money. On the demo
   generator the film is free, so the button just makes it. On a paid provider
   the button says what it will cost and pressing it is the confirmation. */

const LOOKS = [
  ["sunny", "Sunny", "clear light, long shadows", { seasons: ["summer"], mood: "warm" }],
  ["rainy", "Rainy", "wet ground, heavy sky", { seasons: ["monsoon"], mood: "moody" }],
  ["winter", "Winter", "bare trees, low light", { seasons: ["winter"], mood: "serene" }],
  ["autumn", "Autumn", "turning leaves, warm haze", { seasons: ["autumn"], mood: "warm" }],
  ["spring", "Spring", "fresh planting, soft light", { seasons: ["spring"], mood: "serene" }],
  ["normal", "As it is now", "the season it is at the site today", { seasons: null, mood: "serene" }],
];

/** Where this browser is, which is what the engine needs for hemisphere, sun
    path and what grows there. Asked of the clock rather than of the designer;
    it is shown on screen and can be corrected in one tap. */
function placeFromBrowser() {
  try {
    // The city out of the timezone, on its own: the engine's location table
    // matches city names, and "America" as a region tells it nothing.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const city = tz.split("/").pop().replace(/_/g, " ").trim();
    return city && city.length > 2 ? city : "San Jose, California";
  } catch { return "San Jose, California"; }
}

/** The season it is right now where the building is. "As it is now" has to
    mean something, and the month plus the hemisphere is the honest answer. */
function seasonNow(hemisphere) {
  const m = new Date().getMonth();                       // 0 = January
  const north = ["winter", "winter", "spring", "spring", "spring", "summer",
    "summer", "summer", "autumn", "autumn", "autumn", "winter"][m];
  if (hemisphere !== "southern") return north;
  return { winter: "summer", spring: "autumn", summer: "winter", autumn: "spring" }[north];
}

let simplePicked = "sunny";
let simplePlace = null;

async function rSimple() {
  const list = await api("/api/projects").catch(() => []);
  const done = list.filter(p => p.stage === "delivered");
  simplePlace = simplePlace || placeFromBrowser();
  await setHTML(el("main"), `
    <div class="simple">
      <h1>Turn your renders into a film</h1>
      <p class="lead">Add your images, pick the weather you want to show, and press the button. Everything else is decided for you.</p>

      <div class="card step">
        <div class="stepnum">1</div>
        <div>
          <h3>Your images</h3>
          <div class="dropzone" id="drop">
            <div class="pickers">
              <button type="button" class="btn" id="pick_library">Choose photos</button>
              ${isSmallScreen() ? `<button type="button" class="btn secondary" id="pick_camera">Take a photo</button>` : ""}
            </div>
            <p class="muted droptip">or drop them here, or paste one</p>
            <p class="muted formats">One to eight images of one project. JPEG, PNG and WebP.</p>
            <input type="file" id="hubfiles" class="visually-hidden" multiple accept="image/*" tabindex="-1" aria-hidden="true">
            ${isSmallScreen() ? `<input type="file" id="hubcamera" class="visually-hidden" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true">` : ""}
          </div>
          <div class="thumbs" id="thumbs"></div>
        </div>
      </div>

      <div class="card step">
        <div class="stepnum">2</div>
        <div>
          <h3>What weather do you want to show?</h3>
          <div class="looks" id="looks">${LOOKS.map(([k, name, sub]) =>
            `<button type="button" class="look ${k === simplePicked ? "on" : ""}" data-look="${k}"><b>${name}</b><span>${sub}</span></button>`).join("")}</div>
        </div>
      </div>

      <div class="go">
        <button class="btn big" id="makefilm" disabled>Make the film</button>
        <p class="muted" id="goline">Add at least one image first.</p>
      </div>

      ${done.length ? `<h3 style="margin-top:34px">Your films</h3>
        <div class="filmlist">${done.map(p => `<div class="pcard"><h4>${esc(p.name)}</h4>
          <div class="meta">${esc(new Date(p.updated_at).toLocaleDateString())}</div>
          <div class="row"><button class="btn small" data-watch="${p.id}">Watch</button><button class="btn small secondary" data-export2="${p.id}">Download</button><button class="btn small danger" data-del2="${p.id}">Delete</button></div></div>`).join("")}</div>` : ""}

      <p class="muted foot">The film is put together in this tab; nothing is uploaded anywhere.
        Weather and sun path come from <b id="placename">${esc(simplePlace)}</b> <a href="#" id="changeplace">change</a>.
        <a href="#" id="tostudio">Open the full studio</a> if you want to direct every shot yourself.</p>
    </div>`);

  // the pickers, exactly as the studio wires them
  const files = [];
  const draw = () => {
    el("thumbs").innerHTML = files.map((f, i) =>
      `<div class="thumb"><img src="${URL.createObjectURL(f)}" alt=""><button class="x" data-drop="${i}">×</button></div>`).join("");
    el("thumbs").querySelectorAll("[data-drop]").forEach(b => b.onclick = () => { files.splice(+b.dataset.drop, 1); draw(); });
    const n = files.length;
    el("makefilm").disabled = !n;
    el("goline").textContent = n ? `${n} image${n === 1 ? "" : "s"} · about ${Math.round(shotsFor(n) * 5)} seconds of film` : "Add at least one image first.";
  };
  const take = (picked) => { for (const f of picked) if (files.length < 8) files.push(f); draw(); };
  const wire = (btnId, inputId) => {
    const btn = el(btnId), input = el(inputId);
    if (!btn || !input) return;
    btn.onclick = () => input.click();
    input.onchange = () => { const picked = [...input.files]; input.value = ""; take(picked); };
  };
  wire("pick_library", "hubfiles");
  wire("pick_camera", "hubcamera");
  const drop = el("drop");
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); take([...e.dataTransfer.files]); };
  document.onpaste = e => {
    if (!el("drop") || !e.clipboardData) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const cd = e.clipboardData;
    const got = cd.files && cd.files.length ? [...cd.files]
      : [...(cd.items || [])].filter(i => i.kind === "file").map(i => i.getAsFile()).filter(Boolean);
    if (!got.length) return;
    e.preventDefault();
    take(got);
  };
  draw();

  el("looks").querySelectorAll(".look").forEach(b => b.onclick = () => {
    el("looks").querySelectorAll(".look").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    simplePicked = b.dataset.look;
  });
  el("changeplace").onclick = (e) => {
    e.preventDefault();
    const v = prompt("Where is the building? This sets the sun path, the climate and what grows there.", simplePlace);
    if (v && v.trim()) { simplePlace = v.trim(); el("placename").textContent = simplePlace; }
  };
  el("tostudio").onclick = (e) => { e.preventDefault(); setMode("studio"); };
  el("makefilm").onclick = () => makeFilm(files);
  el("main").querySelectorAll("[data-watch]").forEach(b => b.onclick = () => busy(async () => {
    P = await api(`/api/projects/${b.dataset.watch}`); await rDone();
  }));
  el("main").querySelectorAll("[data-export2]").forEach(b => b.onclick = () => busy(async () => {
    const r = await api(`/api/projects/${b.dataset.export2}/export`); download(r.blob, r.filename);
  }, "packing the project…"));
  el("main").querySelectorAll("[data-del2]").forEach(b => b.onclick = () => busy(async () => {
    if (!confirm("Delete this film and everything in it?")) return;
    await api(`/api/projects/${b.dataset.del2}`, { method: "DELETE" });
    await rSimple();
  }));
}

/** Enough shots to read as a film, without asking. One image carries three
    looks comfortably; eight would be a slideshow if every one got three. */
function shotsFor(n) { return Math.max(3, Math.min(9, n * 3)); }

const STEPS = [
  "Reading your images",
  "Working out the shots",
  "Setting the look",
  "Making every frame",
  "Filming each shot",
  "Cutting it together",
];

function showProgress(i, detail) {
  const box = el("simpleprogress");
  if (!box) return;
  box.innerHTML = `<div class="prog">
    <div class="bar"><i style="width:${Math.round(((i + 0.5) / STEPS.length) * 100)}%"></i></div>
    <b>${esc(STEPS[i] || "Almost there")}</b>
    <span class="muted">${esc(detail || "")}</span>
    <p class="muted small">Keep this page in front while it works. The film is recorded in real time, so it takes about as long as it runs.</p>
  </div>`;
}

/** Every stage of the engine, in order, with the gates answered. */
async function makeFilm(files) {
  const look = LOOKS.find(l => l[0] === simplePicked) || LOOKS[0];
  await setHTML(el("main"), `<div class="simple"><h1>Making your film</h1><div id="simpleprogress"></div><div id="jobbar"></div></div>`);
  try {
    showProgress(0, `${files.length} image${files.length === 1 ? "" : "s"}`);
    await persist();
    const name = `${look[1]} film`;
    P = await api("/api/projects", { body: { name } });
    const fd = new FormData();
    files.forEach(f => fd.append("files", f));
    const up = await api(`/api/projects/${P.id}/hubs`, { body: fd });
    P = up.project;
    if (up.refused && up.refused.length) toast(up.refused.join(" "), true);
    if (!P.hubs.length) throw new Error("none of those files could be read as an image");

    showProgress(1, "sun path, seasons and the order of the shots");
    // the engine's own reading of the place, so "as it is now" is the season
    // it actually is there rather than the season it is here
    const seasons = look[3].seasons || [seasonNow(locationProfile(simplePlace).hemisphere)];
    P = (await api(`/api/projects/${P.id}/intake`, { method: "PUT", body: {
      route: "brief", aspect: "auto", length_shots: shotsFor(P.hubs.length),
      seasons, time_arc: "dawn_to_night", single_time: "golden_hour",
      mood: look[3].mood, people: "none", project_type: "",
      location: simplePlace, project_stage: "design_development", end_use: "client_presentation",
      interior_emphasis: null, design_intents: ["", "", ""],
      project_name: name, practice_name: "",
    } })).project;

    // the only gate a person should ever be asked about is money, and on the
    // demo generator there is none to ask about
    const s = await api("/api/settings");
    if (s.provider !== "demo" && !confirm(`This film will cost about ${P.budget.total.toFixed(2)} at your rates for ${P.budget.stills + P.budget.hero_images} images and ${P.budget.clips} clips. Go ahead?`)) {
      await api(`/api/projects/${P.id}`, { method: "DELETE" });
      return rSimple();
    }
    await api(`/api/projects/${P.id}/budget/confirm`, { method: "POST" });
    await api(`/api/projects/${P.id}/plan/generate`, { method: "POST" });
    await api(`/api/projects/${P.id}/plan/approve`, { method: "POST" });

    showProgress(2, "two looks per kind of shot, then the better one");
    await api(`/api/projects/${P.id}/heroes/generate`, { method: "POST" });
    P = await api(`/api/projects/${P.id}`);
    for (const cls of [...new Set(P.hubs.map(h => h.cls))]) {
      const best = P.heroes.filter(h => h.cls === cls)
        .sort((a, b) => (b.audit ? b.audit.structure_similarity : 0) - (a.audit ? a.audit.structure_similarity : 0))[0];
      if (best) await api(`/api/projects/${P.id}/heroes/${best.id}/choose`, { method: "POST" });
    }

    showProgress(3, "one frame per shot");
    await api(`/api/projects/${P.id}/stills/generate`, { method: "POST" });
    await api(`/api/projects/${P.id}/stills/approve_all`, { method: "POST" });

    showProgress(4, "this is the slow part");
    await api(`/api/projects/${P.id}/clips/generate`, { method: "POST" });
    P = await api(`/api/projects/${P.id}`);
    let failed = 0;
    for (const c of P.clips) {
      if (c.status === "approved") continue;
      if (!c.qc || !c.qc.passed) failed++;
      await api(`/api/projects/${P.id}/clips/${c.id}/approve`, { method: "POST" }).catch(() => {});
    }

    showProgress(5, "order, titles, sound and the render");
    await api(`/api/projects/${P.id}/sequence/suggest`);
    await api(`/api/projects/${P.id}/render?crops=&scale=${autoScaleFor(P)}`, { method: "POST" });
    P = await api(`/api/projects/${P.id}`);
    await rDone(failed);
  } catch (e) {
    console.error(e);
    await setHTML(el("main"), `<div class="simple"><h1>That did not finish</h1>
      <div class="note warn"><b>${esc(e.message || String(e))}</b></div>
      <p class="muted">Nothing was lost: ${P ? "the project is saved and the full studio can carry on from where this stopped." : "no project was created."}</p>
      <div class="row" style="margin-top:14px"><button class="btn" id="again">Start again</button>${P ? `<button class="btn secondary" id="studio2">Open it in the studio</button>` : ""}</div></div>`);
    el("again").onclick = () => busy(async () => { P = null; await rSimple(); });
    const st = el("studio2"); if (st) st.onclick = () => setMode("studio");
  }
}

/** Never upscale past the images that were given, and never hand a phone a
    full-size canvas. */
function autoScaleFor(p) {
  const [FW, FH] = resFor(p.intake.aspect);
  const srcLong = Math.max(...(p.hubs || []).map(h => Math.max(h.width, h.height)).concat([0]));
  const fromSource = srcLong ? Math.min(1, Math.max(0.25, Math.round((srcLong / Math.max(FW, FH)) * 100) / 100)) : 1;
  return isSmallScreen() ? Math.min(0.5, fromSource) : fromSource;
}

async function rDone(failed = 0) {
  const D = P.deliverables || {};
  const v = D.verification || {};
  if (!D.film) return rSimple();
  await setHTML(el("main"), `<div class="simple">
    <h1>Your film is ready</h1>
    <div class="card"><video data-file="${D.film}" controls playsinline style="width:100%;border-radius:8px;background:#000"></video>
      <div class="row" style="margin-top:12px">
        <a class="btn" data-file="${D.film}" download="${esc((P.name || "film").replace(/\s+/g, "-").toLowerCase())}.${D.film.split(".").pop()}">Download the film</a>
        <button class="btn secondary" id="another">Make another</button>
      </div>
      <p class="muted" style="margin-top:12px">${v.duration_s || "?"} seconds · ${v.width || "?"}×${v.height || "?"} · ${esc(v.container || "")}${v.interoperable === false ? " (plays in a browser; run it through a converter for PowerPoint)" : ""}</p>
      ${failed ? `<div class="note warn">${failed} shot${failed === 1 ? "" : "s"} did not pass the quality check and ${failed === 1 ? "was" : "were"} used anyway. Open the studio to re-shoot ${failed === 1 ? "it" : "them"}.</div>` : ""}
    </div>
    <p class="muted foot"><a href="#" id="tostudio2">Open this in the full studio</a> to change the shots, the titles or the order.</p>
  </div>`);
  el("another").onclick = () => busy(async () => { P = null; await rSimple(); });
  el("tostudio2").onclick = (e) => { e.preventDefault(); setMode("studio"); };
}

// -------------------------------------------------------------------- home
async function rHome() {
  const list = await api("/api/projects");
  const q = await quota();
  const cards = list.map(p => `<div class="pcard">
      <h4>${esc(p.name)}</h4>
      <div class="meta"><span class="tag">${esc(p.stage)}</span> updated ${esc(new Date(p.updated_at).toLocaleString())}</div>
      <div class="row"><button class="btn small" data-open="${p.id}">Open</button><button class="btn small secondary" data-dup="${p.id}">Duplicate</button><button class="btn small secondary" data-export="${p.id}">Export</button><button class="btn small secondary" data-rename="${p.id}">Rename</button><button class="btn small danger" data-del="${p.id}">Delete</button></div>
    </div>`).join("");
  await setHTML(el("main"), `<div class="start">
    <div>
      <div class="card"><h2>New project</h2>
        <p class="lead">One project per film: one building, its renders, one brief.</p>
        <label class="f wide">project name<input id="newname" placeholder="e.g. Willow Glen ADU"></label>
        <div style="margin-top:10px"><button class="btn" id="newbtn">Create project</button></div>
        <p class="muted" style="margin-top:14px">Or see it work first: this draws two sample renders in this tab, names their finishes and fills in the brief. Nothing is downloaded and nothing is charged.</p>
        <div><button class="btn secondary" id="samplebtn">Start a sample project</button></div>
      </div>
      <div class="card"><h3 style="margin-top:0">Bring a project in</h3>
        <p class="muted">Projects live in this browser only. An export is a ZIP with everything in it; import it here on any machine.</p>
        <input type="file" id="importfile" accept=".zip,application/zip">
      </div>
      <div class="card"><h3 style="margin-top:0">Just want a film?</h3>
        <p class="muted">The simple screen asks for your images and the weather you want, and does the rest on its own.</p>
        <div><button class="btn secondary" onclick="setMode('simple')">Back to the simple screen</button></div>
      </div>
      <div class="card"><h3 style="margin-top:0">How it works</h3>
        <p class="muted">Upload the renders, say where the building is and what you want noticed, approve a shot plan, and the engine generates every frame from those renders, measures what comes back and cuts it together. Out of the box it uses a demo generator that costs nothing, so a whole project can be rehearsed before any money is involved. Settings switches to a real API.${q ? ` About ${(q.free / 1e9).toFixed(1)} GB of browser storage is free.` : ""}</p>
        <div class="row" style="margin-top:10px"><button class="btn small secondary" id="browsercheck">Check this browser</button></div>
      </div>
    </div>
    <div>
      <h2>Projects</h2>
      ${list.length ? `<div class="projects">${cards}</div>` : `<p class="muted">None yet. Create one on the left.</p>`}
    </div></div>`);
  const create = () => busy(async () => {
    const name = el("newname").value.trim();
    if (!name) throw new Error("give the project a name");
    // asked on the gesture that starts real work, which is when Safari will
    // grant it: without it a phone may evict the only copy of the project
    await persist();
    P = await api("/api/projects", { body: { name } }); view = "intake"; renderChrome(); await renderAll();
  });
  el("newbtn").onclick = create;
  el("samplebtn").onclick = () => busy(startSample, "drawing two sample renders…");
  el("browsercheck").onclick = () => selfCheck();
  el("newname").onkeydown = e => { if (e.key === "Enter") create(); };
  el("importfile").onchange = e => busy(async () => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    const p = await api("/api/projects/import", { body: fd });
    toast(`imported ${p.name}`); await open(p.id);
  }, "importing…");
  el("main").querySelectorAll("[data-open]").forEach(b => b.onclick = () => busy(() => open(b.dataset.open)));
  el("main").querySelectorAll("[data-dup]").forEach(b => b.onclick = () => busy(async () => {
    const p = await api(`/api/projects/${b.dataset.dup}/duplicate`, { method: "POST", body: {} });
    toast(`copied as ${p.name}: renders, plan and chosen heroes kept; stills and clips start again`); await rHome();
  }));
  el("main").querySelectorAll("[data-export]").forEach(b => b.onclick = () => busy(async () => {
    const r = await api(`/api/projects/${b.dataset.export}/export`); download(r.blob, r.filename);
  }, "packing the project…"));
  el("main").querySelectorAll("[data-rename]").forEach(b => b.onclick = () => busy(async () => {
    const cur = list.find(p => p.id === b.dataset.rename);
    const name = prompt("New name", cur ? cur.name : ""); if (!name) return;
    await api(`/api/projects/${b.dataset.rename}`, { method: "PATCH", body: { name } }); await rHome();
  }));
  el("main").querySelectorAll("[data-del]").forEach(b => b.onclick = () => busy(async () => {
    const cur = list.find(p => p.id === b.dataset.del);
    if (!confirm(`Delete "${cur ? cur.name : "this project"}" and every file in it? Export it first if you might want it back.`)) return;
    await api(`/api/projects/${b.dataset.del}`, { method: "DELETE" }); await rHome();
  }));
}

// ------------------------------------------------------------- lightboxes
function lightbox(path, caption) {
  modal(`<div class="lightbox"><img data-file="${esc(path)}" alt=""></div><p class="muted" style="text-align:center">${esc(caption || "")}</p>`);
}
function lightboxVideo(path, caption) {
  modal(`<div class="lightbox"><video data-file="${esc(path)}" controls autoplay muted loop playsinline></video></div><p class="muted" style="text-align:center">${esc(caption || "")}</p>`);
}
/** The audit the spec asks the human to run: the generated frame beside the
    render it came from, with the class checklist under both. */
function compare(gen, hubImg, checklist, title) {
  modal(`<h3>${esc(title)}</h3>
    <div class="compare">
      <figure><img data-file="${esc(hubImg.path)}" alt=""><figcaption>source render · ${esc(hubImg.label || hubImg.id)} · never modified</figcaption></figure>
      <figure><img data-file="${esc(gen.path)}" alt=""><figcaption>generated · attempt ${gen.attempt}${gen.audit && gen.audit.rating !== "not_run" ? ` · <span class="tag ${gen.audit.rating}">${gen.audit.rating}</span> ${esc(gen.audit.driver)}` : ""}</figcaption></figure>
    </div>
    ${checklist && checklist.length ? `<h3>Check by eye</h3><ul>${checklist.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
    ${gen.audit && gen.audit.notes ? `<p class="muted">${esc(gen.audit.notes)}</p>` : ""}`);
}

// ---------------------------------------------------------------- 1 intake
/* Filling in the brief without typing it.

   The finish names are chips rather than a drafted sentence, and the reason is
   worth stating where the code is: that field is interpolated verbatim into
   "Materials, by name: …" on every prompt, and there is no white balance in
   this engine. Warm light reads as warm material, a wall in sun and the same
   wall in shade cluster as two colours, and in a street photograph the colour
   comes off the awnings. A machine sentence there would be a wrong sentence
   the generator then obeys. A word tapped from this row is the designer's own.
   The measured colours are shown next to it as what they are: the colours in
   this light, which is the thing the film is about to change. */
function vocabRow(h) {
  const groups = VOCAB[h.cls] || VOCAB.exterior;
  return `<details class="suggest" data-for="${h.id}" data-k="materials">
    <summary>Name the finishes without typing${h.materials ? "" : " · nothing is filled in for you here, and this is why"}</summary>
    <div class="muted">The colours in a photograph are the light, not the finish: a white wall at golden hour measures as warm tan, and the same wall in shade measures as two colours. Those words would go into every prompt as if they were the material, and the film's whole job is to change the light. So the engine will not write this field. Tap what is actually there and it is your word that goes in. Leave it empty and every prompt says "the materials exactly as rendered", which is safe and vague.</div>
    ${groups.map(([name, words]) => `<div class="grp"><span class="lbl">${esc(name)}</span>${words.map(w =>
      `<span class="chip add" data-add="${esc(w)}">${esc(w)}</span>`).join("")}</div>`).join("")}
  </details>`;
}

/* Elements is geometry, which is what the engine protects rather than changes,
   so a measured fact is safe here in a way it is not above. The ones that
   arrive ticked are the ones a measurement supports; a count is only ever
   offered when the openings form a plain regular row. */
function elementsRow(h) {
  const sugg = elementSuggestions(h.cls, h.measured || {});
  const have = String(h.elements || "").toLowerCase();
  const measured = sugg.filter(x => x.measured);
  return `<div class="suggest tight" data-for="${h.id}" data-k="elements">
    <div class="row" style="gap:8px;align-items:center">
      <button class="btn small secondary" data-fill="${h.id}">Fill this in for me</button>
      <span class="muted">${measured.length ? esc(measured[0].t) + ", counted in your image" : "the usual things to protect, for this kind of render"}</span>
    </div>
    <details><summary>choose them one at a time</summary>
      <div class="grp">${sugg.map(x =>
        `<span class="chip add ${have.includes(x.t.toLowerCase()) ? "on" : ""}" data-add="${esc(x.t)}"${x.measured ? ' title="counted in this image"' : ""}>${x.measured ? "▣ " : ""}${esc(x.t)}</span>`).join("")}</div>
    </details>
  </div>`;
}

/* The colours actually in the image, as evidence rather than as an answer. */
function swatchRow(h) {
  const m = h.measured;
  if (!m || !m.swatches || !m.swatches.length) return "";
  return `<div class="swatches"><span class="muted">colours in this image, under ${esc(m.measured_under)}:</span>
    ${m.swatches.map(sw => `<span class="sw" title="${esc(sw.word)} · ${Math.round(sw.share * 100)}% of the surface"><i style="background:${esc(sw.hex)}"></i>${esc(sw.word)}</span>`).join("")}
    <span class="muted">a colour is not a finish: these are what the light is doing today, and the film changes the light.</span></div>`;
}

const CHOICES = {
  route: [["brief", "Season or mood brief"], ["reference", "Reference video"]],
  project_type: [["", "not stated"], ["house", "House"], ["adu", "ADU"], ["extension", "Extension"], ["apartment", "Apartment"], ["workplace", "Workplace"], ["hospitality", "Hospitality"]],
  aspect: [["auto", "Auto · match my renders"], ["16:9", "16:9 presentation"], ["9:16", "9:16 vertical"], ["1:1", "1:1 square"], ["4:5", "4:5 feed"]],
  length: [["1", "5 s · 1 shot"], ["2", "10 s · 2 shots"], ["3", "15 s · 3 shots"], ["5", "25 s · 5 shots"], ["9", "45 s · 9 shots"], ["14", "70 s · 14 shots"], ["custom", "Custom"]],
  time_arc: [["dawn_to_night", "Dawn to night"], ["single", "Single time of day"], ["golden_hour", "Golden hour only"], ["night", "Night only"]],
  mood: [["serene", "Serene and still"], ["moody", "Moody and atmospheric"], ["warm", "Warm and lived-in"], ["bold", "Bold and dramatic"]],
  people: [["none", "None (pure architecture)"], ["scale_figure", "Scale figure, from behind"], ["lifestyle", "Lifestyle, one pair or small group"]],
  project_stage: [["concept", "Concept"], ["design_development", "Design development"], ["planning", "Planning / DA"], ["construction_docs", "Construction docs"], ["completed", "Completed"]],
  end_use: [["client_presentation", "Client presentation"], ["planning_consultation", "Planning or neighbour consultation"], ["website", "Website hero"], ["social", "Social (Reels/Shorts)"], ["awards", "Awards submission"], ["developer_marketing", "Marketing for a developer client"]],
  interior_emphasis: [["", "Not applicable"], ["daylight", "Daylight through the day"], ["night", "Night and artificial light"], ["seasonal_view", "Seasonal view through openings"], ["lived_in", "Lived-in moments"]],
};
function choice(group, lbl, cur, multi = false, options = null) {
  return `<div class="opt"><span class="lbl">${esc(lbl)}</span><div class="choice" data-group="${group}" ${multi ? 'data-multi="1"' : ""}>${(options || CHOICES[group]).map(([v, l]) =>
    `<span class="chip ${(multi ? cur.includes(v) : String(cur ?? "") === v) ? "on" : ""}" data-v="${esc(v)}">${esc(l)}</span>`).join("")}</div></div>`;
}

/** The ratio chips. "Auto" is offered first and names the shape it resolves to,
    and a ratio the renders are already in stays on the row once chosen, so a
    3:2 film does not quietly become 16:9 on the next save. */
function aspectOptions(cur, native) {
  const list = CHOICES.aspect.map(([v, l]) => [v, v === "auto" && native ? `Auto · match my renders (${native})` : l]);
  const have = new Set(list.map(([v]) => v));
  for (const extra of [native, cur]) {
    if (extra && extra !== "auto" && !have.has(extra)) { list.splice(1, 0, [extra, `${extra}${extra === native ? " · your renders" : ""}`]); have.add(extra); }
  }
  return list;
}
function aspectChips(cur) { return String(cur ?? ""); }
function picked(group) { const g = el("main").querySelector(`[data-group="${group}"]`); const on = g ? g.querySelector(".chip.on") : null; return on ? on.dataset.v : ""; }
function readIntakeForm() {
  // The questionnaire lives in the DOM until it is saved, and uploading or
  // removing a render re-renders the page. Capture it first so nothing typed
  // is lost.
  if (!el("i_location")) return null;
  const len = picked("length");
  return {
    route: picked("route"), aspect: picked("aspect"), time_arc: picked("time_arc"), single_time: el("i_single_time").value,
    mood: picked("mood"), people: picked("people"), project_type: picked("project_type"),
    length_shots: Math.max(1, Math.min(30, Math.round(Number(len === "custom" ? el("i_custom").value : len)) || 5)),
    seasons: [...el("seasons").querySelectorAll(".chip.on")].map(c => c.dataset.s),
    location: el("i_location").value, project_stage: picked("project_stage"), end_use: picked("end_use"),
    interior_emphasis: picked("interior_emphasis") || null,
    design_intents: [0, 1, 2].map(i => el("i_intent" + i).value),
    project_name: el("i_pname").value, practice_name: el("i_practice").value,
  };
}
/** Spec 1.3: end use changes defaults. Applied when the person taps it, in
    front of them, and said out loud, rather than silently on save. */
function endUseDefaults(v) {
  const set = (group, val) => { const g = el("main").querySelector(`[data-group="${group}"]`); if (!g) return; g.querySelectorAll(".chip").forEach(c => c.classList.toggle("on", c.dataset.v === val)); };
  const notes = [];
  if (v === "social") { set("aspect", "9:16"); set("length", "5"); notes.push("9:16 by crop, shortest length"); }
  if (v === "client_presentation") { set("aspect", "16:9"); notes.push("16:9"); }
  if (v === "planning_consultation") { set("people", "none"); notes.push("no people, no heavy weather beat, disclaimer on every frame"); }
  if (v === "awards") { set("people", "none"); notes.push("no people unless you choose them"); }
  if (notes.length) toast("end use set defaults: " + notes.join("; "));
}
async function rIntake() {
  const I = Object.assign({}, P.intake, pendingIntake || {});
  pendingIntake = null;
  const hasInteriors = P.hubs.some(h => h.cls === "interior");
  // kept in step with CHOICES.length above, or a preset renders as "Custom"
  const LEN_PRESETS = CHOICES.length.map(([v]) => v).filter(v => v !== "custom").map(Number);
  const lenKey = LEN_PRESETS.includes(I.length_shots) ? String(I.length_shots) : "custom";
  const nativeAspect = commonAspect(P.hubs || []);
  const hubs = (P.hubs || []).map(h => `
    <div class="tile"><img data-file="projects/${P.id}/thumbs/${h.id}.jpg" alt="" data-view="${h.id}">
      <div class="body">
        <div class="row" style="gap:8px">
          <label class="f" style="min-width:110px">class<select data-h="${h.id}" data-k="cls"><option ${h.cls === "exterior" ? "selected" : ""}>exterior</option><option ${h.cls === "interior" ? "selected" : ""}>interior</option></select></label>
          ${h.cls === "exterior" ? `<label class="f" style="min-width:90px">camera faces<select data-h="${h.id}" data-k="camera_faces"><option value="">not stated</option>${["N", "NE", "E", "SE", "S", "SW", "W", "NW"].map(d => `<option ${h.camera_faces === d ? "selected" : ""}>${d}</option>`).join("")}</select></label>` : ""}
        </div>
        <label class="f">label<input data-h="${h.id}" data-k="label" value="${esc(h.label)}"></label>
        ${h.cls === "interior" ? `<label class="f">looks out at (shares that view's weather and time)<select data-link="${h.id}"><option value="">not linked</option>${(P.hubs || []).filter(x => x.cls === "exterior").map(x => `<option value="${x.id}" ${h.continuity_group && h.continuity_group === x.continuity_group ? "selected" : ""}>${esc(x.label || x.id)}</option>`).join("")}</select></label>` : ""}
        <label class="f">materials and finishes, by name<textarea data-h="${h.id}" data-k="materials" placeholder="${h.cls === "exterior" ? "e.g. smooth render, cedar siding, standing seam metal roof, black steel windows" : "e.g. white oak floor, painted shaker cabinetry, honed stone benchtop"}">${esc(h.materials)}</textarea></label>
        ${vocabRow(h)}
        <label class="f">fixed elements to protect<textarea data-h="${h.id}" data-k="elements" placeholder="${h.cls === "exterior" ? "e.g. two levels, four windows per level, entry canopy, retaining wall left, road along the front, two oaks" : "e.g. one window wall, island with two pendants, full-height joinery left"}">${esc(h.elements)}</textarea></label>
        ${elementsRow(h)}
        ${swatchRow(h)}
        <div class="muted">detected: ${esc(h.detected.time_of_day)} · ${esc(h.detected.colour_temperature)} · sky ${fmt(h.detected.sky_fraction)} · ${esc(h.detected.aspect)} · ${h.detected.lights_on ? "lights on" : "lights off"}${h.detected.climate_hint ? " · " + esc(h.detected.climate_hint) : ""}</div>
        <button class="btn small danger" data-del="${h.id}" style="margin-top:6px">remove</button>
      </div></div>`).join("");
  await setHTML(el("main"), `
    <h2>Intake</h2><p class="lead">Three things: the renders, the brief, and the site. Everything downstream is derived from these, so a minute here saves a regeneration later.</p>
    <div class="card">
      <div class="sect"><h3><span class="n">1</span>Renders</h3>
        <p class="muted">One to eight renders of one project: exterior angles, interior rooms, or both. ${isSmallScreen()
          ? "<b>Choose photos</b> opens the photo library and takes several at once. <b>Take a photo</b> opens the camera, which is the one to use on site."
          : `There is no photo library for a web page to open on a laptop, so <b>Choose photos</b> opens the file dialog. When your pictures are somewhere that dialog will not reach, drag them onto this page or paste one with ${/Mac/i.test(navigator.userAgent) ? "<b>⌘V</b>" : "<b>Ctrl&nbsp;+&nbsp;V</b>"}; both skip the dialog and whatever it filters out.`} <b>JPEG</b>, PNG and WebP are all read directly. Name the finishes on each; the prompts use your words, never invented ones. State which way the camera faces on exteriors so the sun comes from the right side. Tap a render to see it full size.</p>
        <div class="dropzone" id="drop">
          <div class="pickers">
            <button type="button" class="btn" id="pick_library">Choose photos</button>
            ${isSmallScreen() ? `<button type="button" class="btn secondary" id="pick_camera">Take a photo</button>` : ""}
          </div>
          <p class="muted droptip">or drop files here, or paste one</p>
          <p class="muted formats">JPEG, PNG and WebP. HEIC from an iPhone works in Safari.</p>
          <!-- The inputs are moved off screen rather than given display:none.
               Safari will not open a file picker for an input that is not
               rendered, whether it is clicked through a label or by script, so
               hiding one that way is how an upload button silently does
               nothing. No capture attribute on the first: that is what makes a
               phone offer the photo library. The second forces the camera.

               accept is exactly image/* and nothing else. A phone decides which
               app to open from this one value: plain image/* maps to the photo
               library, and a list with types the system does not recognise,
               image/heic among them, drops it back to the file manager, which
               is a gallery upload that cannot reach the gallery. Nothing is
               lost by being brief, because what a file actually is gets decided
               by decoding it, not by its type. -->
          <input type="file" id="hubfiles" class="visually-hidden" multiple accept="image/*" tabindex="-1" aria-hidden="true">
          ${isSmallScreen() ? `<input type="file" id="hubcamera" class="visually-hidden" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true">` : ""}
        </div>
        <div class="grid" style="margin-top:14px">${hubs || ""}</div>
      </div>
    </div>
    <div class="card">
      <div class="sect"><h3><span class="n">2</span>Direction and format</h3>
        <div class="row" style="gap:18px">
          ${choice("route", "route", I.route)}
          ${choice("project_type", "project type", I.project_type || "")}
        </div>
        <div class="row" style="gap:18px;margin-top:12px">
          ${choice("aspect", "shape of the film", aspectChips(I.aspect, nativeAspect), false, aspectOptions(I.aspect, nativeAspect))}
          ${choice("length", "length", lenKey)}
          <label class="f" id="customwrap" style="${lenKey === "custom" ? "" : "display:none"}">custom shots<input id="i_custom" type="number" step="1" min="1" max="30" value="${I.length_shots}"></label>
        </div>
        <div class="opt" style="margin-top:12px"><span class="lbl">seasons</span><div class="choice" id="seasons">${SEASONS.map(s => `<span class="chip ${I.seasons.includes(s) ? "on" : ""}" data-s="${s}">${s}</span>`).join("")}</div></div>
        <div class="row" style="gap:18px;margin-top:12px">
          ${choice("time_arc", "time arc", I.time_arc)}
          <label class="f" id="singlewrap" style="${I.time_arc === "single" ? "" : "display:none"}">single time<select id="i_single_time">${TIMES.map(t => `<option value="${t}" ${I.single_time === t ? "selected" : ""}>${label(t)}</option>`).join("")}</select></label>
        </div>
        <div class="row" style="gap:18px;margin-top:12px">
          ${choice("mood", "mood", I.mood)}
          ${choice("people", "people", I.people)}
        </div>
      </div>
      <div class="sect"><h3><span class="n">3</span>Site and intent</h3>
        <div class="row">
          <label class="f wide">location (required; drives climate, hemisphere and sun path)<input id="i_location" value="${esc(I.location)}" placeholder="e.g. Willow Glen, San Jose, California"></label>
        </div>
        <div class="row" style="gap:18px;margin-top:12px">
          ${choice("project_stage", "project stage", I.project_stage)}
          ${choice("end_use", "end use", I.end_use)}
        </div>
        ${hasInteriors ? `<div class="row" style="gap:18px;margin-top:12px">${choice("interior_emphasis", "interior emphasis", I.interior_emphasis || "")}</div>` : ""}
        <p class="lead" style="margin:14px 0 6px">What are the three things you most want the client to notice? Each becomes a shot. A time word (afternoon, dusk) sets that shot's time.</p>
        <div class="row">${[0, 1, 2].map(i => `<label class="f wide">intent ${i + 1}<input id="i_intent${i}" value="${esc(I.design_intents[i] || "")}" placeholder="${["the way afternoon light enters the living room", "the entry canopy against the street", "the deck meeting the garden"][i]}"></label>`).join("")}</div>
        <div class="row"><label class="f">project name<input id="i_pname" value="${esc(I.project_name)}"></label><label class="f">practice name<input id="i_practice" value="${esc(I.practice_name)}"></label></div>
        <div style="margin-top:12px"><button class="btn" id="save_intake">Save intake and research the location</button></div>
        ${P.location_profile.location ? `<h3>Location profile</h3><div class="kv">${["hemisphere", "climate", "vegetation", "signature", "sun_path", "source"].map(k => `<div>${label(k)}</div><div>${esc(P.location_profile[k] || "")}</div>`).join("")}</div>` : ""}
      </div>
    </div>
    <div class="card"><h3 style="margin-top:0"><span class="n">4</span>Budget gate</h3>
      ${P.budget.total ? budgetCard(P.budget) : `<p class="muted">Save the intake to see the estimate.</p>`}
    </div>`);
  // chips
  el("main").querySelectorAll(".choice[data-group]").forEach(g => g.querySelectorAll(".chip").forEach(c => c.onclick = () => {
    g.querySelectorAll(".chip").forEach(x => x.classList.remove("on")); c.classList.add("on");
    if (g.dataset.group === "length") el("customwrap").style.display = c.dataset.v === "custom" ? "" : "none";
    if (g.dataset.group === "time_arc") el("singlewrap").style.display = c.dataset.v === "single" ? "" : "none";
    if (g.dataset.group === "end_use") endUseDefaults(c.dataset.v);
  }));
  el("seasons").querySelectorAll(".chip").forEach(c => c.onclick = () => c.classList.toggle("on"));
  // renders
  const drop = el("drop");
  const upload = async files => busy(async () => {
    if (!files || !files.length) return;
    pendingIntake = readIntakeForm();
    const fd = new FormData(); [...files].forEach(f => fd.append("files", f));
    const r = await api(`/api/projects/${P.id}/hubs`, { body: fd });
    await reload();
    // resampling a phone photo is a thing that happened to the designer's file,
    // so it is said rather than done quietly. A file the browser refused matters
    // more than a note about one it accepted, so it goes first and goes red.
    if (r.refused && r.refused.length) toast(r.refused.join(" "), true);
    else if (r.notes && r.notes.length) toast(r.notes[0]);
  }, "reading the photos…");
  // The button opens the input, inside the click that the browser counts as a
  // user gesture. Taking a copy of the FileList before clearing the input
  // matters: the list is live and belongs to the input, so clearing it first
  // would hand the upload an empty list.
  const wire = (btnId, inputId) => {
    const btn = el(btnId), input = el(inputId);
    if (!btn || !input) return;   // the camera pair only exists on a touch device
    btn.onclick = () => input.click();
    input.onchange = () => {
      const picked = [...input.files];
      input.value = "";
      upload(picked);
    };
  };
  wire("pick_library", "hubfiles");
  wire("pick_camera", "hubcamera");
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); }; drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files); };
  // A laptop has no photo library for a web page to open, so the other two ways
  // in carry the weight there: drag the images onto the page, or copy one from
  // anywhere at all and paste it here. Set on the document because a paste goes
  // to whatever has focus, which is rarely the dropzone.
  document.onpaste = e => {
    if (!el("drop") || !e.clipboardData) return;
    // A paste into a box someone is typing in belongs to that box. A cell copied
    // out of a spreadsheet carries a picture of itself alongside its text, so
    // without this, pasting the site address into the location field would file
    // a screenshot as a render.
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const cd = e.clipboardData;
    const files = cd.files && cd.files.length ? [...cd.files]
      : [...(cd.items || [])].filter(i => i.kind === "file").map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    upload(files);
  };
  el("main").querySelectorAll("[data-view]").forEach(img => img.onclick = () => { const h = hub(img.dataset.view); lightbox(h.path, `${h.label || h.filename} · ${h.width}×${h.height}`); });
  el("main").querySelectorAll("[data-h]").forEach(inp => inp.onchange = () => busy(async () => {
    pendingIntake = readIntakeForm();
    await api(`/api/projects/${P.id}/hubs/${inp.dataset.h}`, { method: "PATCH", body: { [inp.dataset.k]: inp.value } });
    if (inp.dataset.k === "cls") await reload(); else { P = await api(`/api/projects/${P.id}`); renderSpend(); pendingIntake = null; }
  }));
  // A tapped chip appends to the field and saves it, so the designer builds the
  // sentence by choosing rather than by typing, and what lands in the prompt is
  // still a word they picked.
  const appendTo = async (hid, key, text) => {
    const ta = el("main").querySelector(`textarea[data-h="${hid}"][data-k="${key}"]`);
    if (!ta) return;
    const cur = ta.value.trim().replace(/,+$/, "");
    if (cur.toLowerCase().includes(text.toLowerCase())) return;
    ta.value = cur ? `${cur}, ${text}` : text;
    pendingIntake = readIntakeForm();
    await api(`/api/projects/${P.id}/hubs/${hid}`, { method: "PATCH", body: { [key]: ta.value } });
    P = await api(`/api/projects/${P.id}`);
  };
  el("main").querySelectorAll(".suggest .chip.add").forEach(c => c.onclick = () => busy(async () => {
    const box = c.closest(".suggest");
    await appendTo(box.dataset.for, box.dataset.k, c.dataset.add);
    c.classList.add("on");
  }));
  el("main").querySelectorAll("[data-fill]").forEach(b => b.onclick = () => busy(async () => {
    const hid = b.dataset.fill, h = hub(hid);
    for (const x of elementSuggestions(h.cls, h.measured || {})) if (x.on) await appendTo(hid, "elements", x.t);
    await renderAll();
    toast("suggested elements added — edit or remove any that are wrong");
  }));
  el("main").querySelectorAll("[data-link]").forEach(sel => sel.onchange = () => busy(async () => {
    pendingIntake = readIntakeForm();
    const interiorId = sel.dataset.link, exteriorId = sel.value;
    await api(`/api/projects/${P.id}/hubs/${interiorId}`, { method: "PATCH", body: { continuity_group: exteriorId || "" } });
    if (exteriorId) await api(`/api/projects/${P.id}/hubs/${exteriorId}`, { method: "PATCH", body: { continuity_group: exteriorId } });
    await reload();
  }));
  el("main").querySelectorAll("[data-del]").forEach(b => b.onclick = () => busy(async () => {
    pendingIntake = readIntakeForm();
    await api(`/api/projects/${P.id}/hubs/${b.dataset.del}`, { method: "DELETE" }); await reload();
  }));
  el("save_intake").onclick = () => busy(async () => {
    const body = readIntakeForm();
    const r = await api(`/api/projects/${P.id}/intake`, { method: "PUT", body }); P = r.project;
    renderChrome(); await renderAll();
    if (r.warnings.length) cropWarning(r);
  }, "researching the location…");
  const cb = el("confirm_budget"); if (cb) cb.onclick = () => busy(async () => {
    pendingIntake = readIntakeForm();
    await api(`/api/projects/${P.id}/budget/confirm`, { method: "POST" }); await reload(); toast("budget confirmed");
  });
}

/** What the number is made of, and what it is a number about. An estimate with
    no model, no unit and no rate behind it is a number nobody can check, and
    the rate a fresh install starts with is a placeholder rather than anybody's
    contract, so the panel says which of the two it is looking at. */
function budgetCard(b) {
  const money = (x) => fmt(x, 2);
  const per = b.seconds ? b.total / b.seconds : 0;
  const rows = [
    ["Image model", b.provider === "demo" ? "demo generator, drawn in this tab" : esc(b.image_model)],
    ["Video model", b.provider === "demo" ? "demo generator, drawn in this tab" : esc(b.video_model)],
    ["Hero variants", `${b.hero_images} images × ${money(b.image_cost)} = ${money(b.hero_images * b.image_cost)}<div class="muted">two per class, the gate that proves the look before the rest is generated</div>`],
    ["Stills", `${b.stills} images × ${money(b.image_cost)} = ${money(b.stills * b.image_cost)}<div class="muted">one per shot</div>`],
    ["Clips", `${b.clips} × ${money(b.video_cost)} = ${money(b.clips * b.video_cost)}<div class="muted">billed in ${b.clip_unit_seconds}-second blocks, so a ${b.clip_unit_seconds * 2}-second shot is two${b.shots && b.clips !== b.shots ? ` — ${b.shots} shots come to ${b.clips} blocks` : ""}</div>`],
    [`Reserve ${Math.round((b.reserve_fraction || 0.2) * 100)}%`, `${money(b.reserve)}<div class="muted">for retries: a shot that fails QC may be re-shot up to ${b.max_attempts} times, and those are not in the lines above</div>`],
    ["Total", `<b>${money(b.total)}</b>${b.seconds ? `<div class="muted">about ${money(per)} per second of finished film, ${b.seconds}s at ${b.shots} shot${b.shots === 1 ? "" : "s"}</div>` : ""}`],
  ];
  return `<div class="kv">${rows.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join("")}</div>
    ${b.provider === "demo"
      ? `<div class="note ok" style="margin-top:10px"><b>Nothing is charged.</b> The demo generator draws every still and clip in this tab. The figures above are what the same project would cost on a paid provider at the rates in Settings, so you can see the shape of the bill before you ever pay one.</div>`
      : `<div class="note" style="margin-top:10px"><b>Real money, at the rates in Settings.</b> Calls go to ${esc(b.image_endpoint)} and ${esc(b.video_endpoint)}.</div>`}
    ${b.rates_are_defaults
      ? `<div class="note warn" style="margin-top:10px"><b>These rates are placeholders, not quotes.</b> ${money(b.image_cost)} an image and ${money(b.video_cost)} per ${b.clip_unit_seconds}-second clip are the numbers this app ships with; no contract is in this repository and no price list is fetched. Until you put your own rate in Settings, treat the total as arithmetic rather than as a price. The unit counts above are exact either way.</div>`
      : `<div class="note ok" style="margin-top:10px">Priced at your own rates: ${money(b.image_cost)} an image, ${money(b.video_cost)} per ${b.clip_unit_seconds}-second clip.</div>`}
    <p class="muted">The total is a floor, not a ceiling. It covers one still and one clip per shot plus the reserve; regenerating a still you do not like, or a second attempt at a clip, is charged on top.</p>
    <div style="margin-top:10px">${b.confirmed ? `<span class="tag ok">confirmed</span> <span class="muted">at ${money(b.image_cost)} / ${money(b.video_cost)} on ${esc(b.provider)}</span>` : `<button class="btn" id="confirm_budget">Confirm budget</button>`}</div>`;
}

/** The ratio change is a crop and only a crop, so a source that cannot give up
    the difference gracefully has to be said out loud. A phone shoots 4:3 and
    the default is 16:9, so this is the first thing most people on a phone
    meet, and "re-render it" is no use when the source is a photograph. The
    ratios that would cost least are offered as one tap. */
function cropWarning(r) {
  // The engine returns every ratio ranked by what it costs, this one included.
  // Only the ones that cost less than the ratio in force are an offer; the rest
  // would be talking someone into a worse crop.
  const all = r.alternatives || [];
  const now = all.find(a => a.aspect === P.intake.aspect);
  const best = all.filter(a => a.aspect !== P.intake.aspect && (!now || a.loss < now.loss)).slice(0, 3);
  modal(`<h3>Cropping, not stretching</h3>
    <p class="muted">A ratio change is always a crop here: the engine never invents picture beyond the edge of what you gave it (Law 6). At ${esc(P.intake.aspect)} that costs you:</p>
    <ul class="warn-list">${r.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>
    ${best.length ? `<p>Ratios that keep more of these frames:</p>
      <div class="choice">${best.map(a => `<span class="chip" data-asp="${a.aspect}">${a.aspect} · loses ${a.loss}%</span>`).join("")}</div>`
      : `<p class="muted">No other ratio does better with these frames: every one of them costs at least as much as ${esc(P.intake.aspect)}. A 4:3 photograph gives up about a quarter of itself whichever way it is cut. Shoot or render wider if you need the whole frame.</p>`}
    <div style="margin-top:14px"><button class="btn" id="cropok">Keep ${esc(P.intake.aspect)}</button></div>`);
  el("cropok").onclick = closeModal;
  el("modal-body").querySelectorAll("[data-asp]").forEach(c => c.onclick = () => busy(async () => {
    const body = Object.assign({}, P.intake, { aspect: c.dataset.asp });
    const res = await api(`/api/projects/${P.id}/intake`, { method: "PUT", body });
    P = res.project; closeModal(); renderChrome(); await renderAll();
    toast(`aspect set to ${c.dataset.asp}`);
  }));
}

// ------------------------------------------------------------- 2 reference
async function rReference() {
  const R = P.reference;
  await setHTML(el("main"), `
    <h2>Reference video analysis</h2><p class="lead">Optional. Measured, not watched: the structure is what you copy (shot length, rhythm, light arc, scale changes, inside/outside pattern). The colour belongs to the reference's climate and stays there. Uploading a film here switches the route to Reference video; the plan then follows its structure.</p>
    <div class="card"><input type="file" id="reffile" accept="video/*"> <button class="btn" id="refbtn">Upload and analyse</button>
      <p class="muted">The file is read in this tab and never uploaded anywhere. A long reference takes a while: every frame is decoded here.</p></div>
    <div id="jobbar"></div>
    ${R ? `<div class="card"><h3>${esc(R.filename)}</h3>
      <div class="kv"><div>Duration</div><div>${R.duration_s}s · ${R.width}×${R.height} · ${R.fps} fps · ${esc(R.aspect)}</div>
      <div>Shots</div><div>${R.shot_count} · mean ${R.mean_shot_length_s}s</div>
      <div>Colour</div><div>brightness ${R.mean_brightness} · saturation ${R.mean_saturation} · warmth ${R.warmth} (${R.warmth > 0.03 ? "warm" : R.warmth < -0.03 ? "cool" : "neutral"}) · shadow floor ${R.shadow_floor} · highlight ceiling ${R.highlight_ceiling}</div>
      <div>Weather density</div><div>${(R.weather_density * 100).toFixed(1)}% frame · ${(R.sky_band_density * 100).toFixed(1)}% sky band</div>
      <div>Audio</div><div>${R.audio_known === false ? "this browser does not report whether there is an audio track" : (R.has_audio ? "audio track present (narration vs ambience: check by ear)" : "no audio track")}</div>
      <div>Scale rhythm</div><div>${R.scale_changes_per_shot} changes per cut · longest same-scale run ${R.max_same_scale_run}</div>
      <div>Inside/outside</div><div class="mono" style="display:inline-block;padding:2px 8px">${esc(R.inside_outside_pattern)}</div></div>
      <h3>Light arc</h3>${spark(R.light_arc)}
      <h3>Shot log</h3><table><tr><th>#</th><th>start</th><th>length</th><th>scale</th><th>camera</th><th>setting</th><th>brightness</th></tr>
      ${R.shots.map(s => `<tr><td>${s.index}</td><td>${s.start_s}s</td><td>${s.duration_s}s</td><td>${s.scale}</td><td>${s.camera_move}</td><td>${s.setting}</td><td>${s.brightness}</td></tr>`).join("")}</table>
      <p class="warn-list" style="list-style:none;padding:0">${esc(R.caveat)}</p></div>` : ""}`);
  el("refbtn").onclick = () => busy(async () => {
    const f = el("reffile").files[0]; if (!f) throw new Error("choose a video");
    const fd = new FormData(); fd.append("file", f);
    const run = api(`/api/projects/${P.id}/reference`, { body: fd });
    await pollJob("reference"); await run; await reload();
  }, "measuring the reference…");
}
function spark(arr) {
  if (!arr || !arr.length) return "";
  const w = 600, h = 48; const pts = arr.map((v, i) => `${(i / Math.max(1, arr.length - 1)) * w},${h - v * h}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#d9b46a" stroke-width="1.5"/></svg>`;
}

// ------------------------------------------------------------------ 3 plan
async function rPlan() {
  const plan = P.plan; const shots = plan.shots || [];
  const opts = (list, cur) => list.map(v => `<option value="${v}" ${v === cur ? "selected" : ""}>${label(v)}</option>`).join("");
  let lastCh = 0;
  const rows = shots.map(s => {
    const chRow = s.chapter !== lastCh ? `<tr class="chapter"><td colspan="11">Chapter ${s.chapter} · ${esc(s.season)}${shots.filter(x => x.chapter === s.chapter).every(x => x.time === s.time) ? " · " + esc(label(s.time)) : ""} · ${esc(s.state.weather)}</td></tr>` : "";
    lastCh = s.chapter;
    return chRow + `<tr data-n="${s.n}">
      <td><b>${s.n}</b><br><span class="muted">${esc(s.beat)}</span>${s.heavy ? '<br><span class="tag warn">heavy</span>' : ""}<span class="sun">sun ${esc(s.sun_side)}</span></td>
      <td><select data-k="cls">${opts(["exterior", "interior"], s.cls)}</select></td>
      <td><select data-k="season">${opts(SEASONS, s.season)}</select></td>
      <td><select data-k="time">${opts(TIMES, s.time)}</select></td>
      <td><select data-k="scale">${opts(SCALES, s.scale)}</select></td>
      <td><select data-k="source_hub_id">${(P.hubs || []).filter(h => h.cls === s.cls).map(h => `<option value="${h.id}" ${h.id === s.source_hub_id ? "selected" : ""}>${esc(h.label || h.id)}</option>`).join("")}</select></td>
      <td class="secs"><input data-k="duration" type="number" step="0.5" min="1" max="15" value="${s.duration}"></td>
      <td class="cue"><input data-k="motion" value="${esc(s.motion)}"></td>
      <td class="beat"><input data-k="human_beat" value="${esc(s.human_beat)}"></td>
      <td class="intent"><input data-k="design_intent" value="${esc(s.design_intent)}"></td>
      <td><button class="btn small secondary" data-prompt="${s.n}">prompt</button></td></tr>`;
  }).join("");
  await setHTML(el("main"), `
    <h2>Shot plan</h2><p class="lead">Rules: scale pyramid, one arc per axis, chapter closers on the widest shot, human beats at the edges, one heavy weather beat, approach → enter → dwell → detail → return when both classes exist. Edit anything, then approve. Nothing is generated until you do.</p>
    ${blocker("plan")}
    <div class="card"><div class="row"><button class="btn ${shots.length ? "secondary" : ""}" id="gen" ${locked("plan") ? "disabled" : ""}>${shots.length ? "Regenerate plan from the intake" : "Generate plan"}</button>${shots.length ? `<button class="btn secondary" id="saveplan">Save edits</button><button class="btn" id="approve" ${plan.approved ? "disabled" : ""}>${plan.approved ? "Approved" : "Approve plan"}</button>` : ""}</div>
      ${plan.rationale ? `<p class="muted" style="margin-top:10px">${esc(plan.rationale)}</p>` : ""}
      ${shots.length ? `<p class="muted">${plan.reference_driven ? '<span class="tag">structure from the reference film</span> ' : ""}${shots.length} shots · ${shots.reduce((a, x) => a + x.duration, 0).toFixed(1)}s total${plan.approved ? ' · <span class="tag ok">approved</span> regenerating or saving edits will need a fresh approval' : ""}</p>` : ""}
      ${plan.warnings.length ? `<ul class="warn-list">${plan.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}</div>
    ${shots.length ? `<div class="card plan-wrap"><table><tr><th>#</th><th>class</th><th>season</th><th>time</th><th>scale</th><th>source render</th><th>secs</th><th>motion cue (light only)</th><th>human beat</th><th>design intent</th><th></th></tr>${rows}</table></div>` : ""}`);
  el("gen").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/plan/generate`, { method: "POST" }); await reload(); });
  const sv = el("saveplan"); if (sv) sv.onclick = () => busy(async () => {
    const edited = shots.map(s => {
      const tr = el("main").querySelector(`tr[data-n="${s.n}"]`);
      const c = structuredClone(s);
      tr.querySelectorAll("[data-k]").forEach(i => c[i.dataset.k] = i.dataset.k === "duration" ? Number(i.value) : i.value);
      c.state.season = c.season; c.state.time = c.time;
      if (s.season !== c.season || s.time !== c.time) c.rederive_state = true;
      return c;
    });
    await api(`/api/projects/${P.id}/plan`, { method: "PUT", body: { shots: edited } }); await reload();
  });
  const ap = el("approve"); if (ap) ap.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/plan/approve`, { method: "POST" }); await reload(); toast("plan approved"); });
  el("main").querySelectorAll("[data-prompt]").forEach(b => b.onclick = () => busy(async () => { const r = await api(`/api/projects/${P.id}/plan/prompts/${b.dataset.prompt}`); modal(`<h3>Still prompt · shot ${b.dataset.prompt}</h3><div class="mono">${esc(r.still)}</div><h3>Motion prompt</h3><div class="mono">${esc(r.motion)}</div><h3>Negative (geometry only)</h3><div class="mono">${esc(r.negative)}</div>`); }));
  el("main").querySelectorAll('select[data-k="cls"]').forEach(sel => sel.onchange = () => { const tr = sel.closest("tr"); const src = tr.querySelector('[data-k="source_hub_id"]'); src.innerHTML = (P.hubs || []).filter(h => h.cls === sel.value).map(h => `<option value="${h.id}">${esc(h.label || h.id)}</option>`).join(""); });
}

// ------------------------------------------------------------------ 4 hero
function auditHtml(a) {
  if (!a || a.rating === "not_run") return "";
  return `<span class="tag ${a.rating}">${a.rating}</span> <span class="muted">structure ${fmt(a.structure_similarity)} · new edges ${fmt(a.new_edge_fraction)} · ${esc(a.driver)}</span>`;
}
async function rHero() {
  const heroes = P.heroes || [];
  const byCls = {}; heroes.forEach(h => (byCls[h.cls] = byCls[h.cls] || []).push(h));
  const classes = [...new Set(P.hubs.map(h => h.cls))];
  await setHTML(el("main"), `
    <h2>Hero image gate</h2><p class="lead">Two variants of the signature frame per class, audited against the source render. Open <b>compare</b> and run the checklist by eye, then pick one per class; it becomes the palette and lighting reference for the film. Hard stop until you do.</p>
    ${blocker("hero")}
    <div id="jobbar"></div>
    <div class="card"><button class="btn" id="gen" ${locked("hero") || (heroes.length && classes.every(c => heroes.filter(h => h.cls === c).length >= 2)) ? "disabled" : ""}>Generate hero variants</button> <span class="muted">${heroes.length ? `${heroes.length} of ${classes.length * 2} variants made · ${classes.filter(c => heroes.some(h => h.cls === c && h.chosen)).length} of ${classes.length} classes chosen` : `2 variants × ${classes.length} class${classes.length === 1 ? "" : "es"}`}</span></div>
    ${Object.entries(byCls).map(([cls, hs]) => `<div class="card"><h3>${cls}${hs.some(h => h.chosen) ? ' <span class="tag ok">chosen</span>' : ""}</h3><div class="grid">${hs.map(h => `
      <div class="tile ${h.chosen ? "chosen" : ""}"><img data-file="${h.thumb}" data-cmp="${h.id}"><div class="body">
        <b>variant ${h.variant}</b> · from ${esc(hub(h.source_hub_id).label || h.source_hub_id)}<br>${auditHtml(h.audit)}
        <div class="row" style="margin-top:6px"><button class="btn small" data-choose="${h.id}" ${h.chosen ? "disabled" : ""}>${h.chosen ? "chosen" : "choose"}</button><button class="btn small secondary" data-cmp="${h.id}">compare</button><button class="btn small secondary" data-showprompt="${h.id}">prompt</button></div>
      </div></div>`).join("")}</div></div>`).join("")}`);
  el("gen").onclick = () => busy(async () => {
    const run = api(`/api/projects/${P.id}/heroes/generate`, { method: "POST" });
    await pollJob("heroes"); await run.catch(e => toast(e.message, true)); await reload();
  }, "generating hero variants…");
  el("main").querySelectorAll("[data-choose]").forEach(b => b.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/heroes/${b.dataset.choose}/choose`, { method: "POST" }); await reload(); }));
  el("main").querySelectorAll("[data-cmp]").forEach(b => b.onclick = () => { const h = heroes.find(x => x.id === b.dataset.cmp); compare(h, hub(h.source_hub_id), h.audit.checklist, `${h.cls} hero · variant ${h.variant}`); });
  el("main").querySelectorAll("[data-showprompt]").forEach(b => b.onclick = () => { const h = heroes.find(x => x.id === b.dataset.showprompt); modal(`<div class="mono">${esc(h.prompt)}</div>`); });
}

// ----------------------------------------------------------------- 5 board
async function rBoard() {
  const stills = P.stills || [];
  const latest = latestBy(stills, "shot_n");
  const rejected = Object.values(latest).filter(s => s.status === "rejected").map(s => s.shot_n);
  const missing = (P.plan.shots || []).filter(sh => !latest[sh.n] || latest[sh.n].status === "rejected").length;
  const pending = Object.values(latest).filter(s => s.status === "pending").length;
  const tiles = (P.plan.shots || []).map(sh => { const s = latest[sh.n]; if (!s) return `<div class="tile"><div class="body">shot ${sh.n} · ${sh.cls} · ${esc(sh.season)} ${esc(label(sh.time))}<br><span class="muted">not generated yet</span></div></div>`; return `
    <div class="tile ${s.status}"><img data-file="${s.thumb}" data-cmp="${s.id}"><div class="body">
      <b>#${sh.n} ${sh.cls} · ${esc(sh.season)} ${esc(label(sh.time))} · ${sh.scale}</b> <span class="tag">attempt ${s.attempt}</span> <span class="tag ${s.status === "approved" ? "ok" : s.status === "rejected" ? "bad" : ""}">${s.status}</span><br>
      from ${esc(hub(s.source_hub_id).label || s.source_hub_id)} · ${esc(sh.state.weather)}<br>${auditHtml(s.audit)}
      ${sh.design_intent ? `<div>intent: ${esc(sh.design_intent)}</div>` : ""}
      ${s.note && s.status === "rejected" ? `<div class="warn-list" style="padding:0;list-style:none">rejected: ${esc(s.note)}</div>` : ""}
      <div class="row" style="margin-top:6px">
        <button class="btn small" data-approve="${s.id}" ${s.status === "approved" ? "disabled" : ""}>approve</button>
        <button class="btn small danger" data-reject="${s.id}">reject…</button>
        <button class="btn small secondary" data-cmp="${s.id}">compare</button>
        <button class="btn small secondary" data-showprompt="${s.id}">prompt</button></div>
    </div></div>`; }).join("");
  await setHTML(el("main"), `
    <h2>Still board</h2><p class="lead">Every still comes from its hub render, never from another generation. Approve all, approve some, or reject specific numbers; only rejected numbers are regenerated, and your note becomes an explicit exclusion in the retry. Generating again makes only what is missing, so a run that stopped halfway costs nothing twice.</p>
    ${blocker("board")}
    <div id="jobbar"></div>
    <div class="card"><div class="row"><button class="btn" id="gen" ${locked("board") || !missing ? "disabled" : ""}>${stills.length ? `Generate the ${missing} missing` : "Generate board"}</button><button class="btn secondary" id="all" ${pending ? "" : "disabled"}>Approve all pending (${pending})</button><button class="btn secondary" id="regen" ${rejected.length ? "" : "disabled"}>Regenerate rejected (${rejected.join(", ") || "none"})</button></div></div>
    <div class="grid">${tiles}</div>`);
  el("gen").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/stills/generate?background=true`, { method: "POST" }); await pollJob("stills"); await reload(); }, "generating stills from hub renders…");
  el("all").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/stills/approve_all`, { method: "POST" }); await reload(); });
  el("regen").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/stills/regenerate`, { body: { shot_ns: rejected } }); await pollJob("stills"); await reload(); }, "regenerating rejected stills…");
  el("main").querySelectorAll("[data-approve]").forEach(b => b.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/stills/${b.dataset.approve}/approve`, { method: "POST" }); await reload(); }));
  el("main").querySelectorAll("[data-reject]").forEach(b => b.onclick = () => {
    modal(`<h3>What specifically is wrong?</h3><p class="muted">Composition, season, light, people, or an invented element. This becomes a hard exclusion in the retry prompt.</p><textarea id="rejnote" style="width:100%"></textarea><div style="margin-top:8px"><button class="btn" id="rejgo">Reject</button></div>`);
    el("rejgo").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/stills/${b.dataset.reject}/reject`, { body: { note: el("rejnote").value } }); closeModal(); await reload(); });
  });
  el("main").querySelectorAll("[data-cmp]").forEach(b => b.onclick = () => { const s = stills.find(x => x.id === b.dataset.cmp); compare(s, hub(s.source_hub_id), s.audit.checklist, `shot ${s.shot_n} · ${s.cls}`); });
  el("main").querySelectorAll("[data-showprompt]").forEach(b => b.onclick = () => { const s = stills.find(x => x.id === b.dataset.showprompt); modal(`<div class="mono">${esc(s.prompt)}</div>`); });
}

// ----------------------------------------------------------------- 6 clips
function qcCell(q) {
  if (!q.ran) return "<span class='muted'>not run</span>";
  const t = (lbl, v, ok) => `<span class="tag ${ok ? "ok" : "bad"} num">${lbl} ${v}</span>`;
  return `${t("motion", fmt(q.motion_score, 2), q.motion_score >= 1.5 && q.motion_score <= 8)} ${t("frozen", fmt(q.frozen_ratio, 2), !q.failures.some(f => f.startsWith("frozen")))} ${t("density", (q.particle_density * 100).toFixed(1) + "%", !q.failures.some(f => f.startsWith("density")))} ${t("geometry", fmt(q.geometry_similarity, 2), q.geometry_similarity >= 0.5)} ${q.vertical_measured ? t("vertical", fmt(q.vertical_drift_deg, 2) + "°", q.vertical_drift_deg <= 1) : "<span class='tag num'>vertical not measured</span>"} ${t("exposure", (q.luminance_drift * 100).toFixed(1) + "%", q.luminance_drift <= 0.06)} ${t("hue", fmt(q.hue_drift_deg, 1) + "°", q.hue_drift_deg <= 8)} ${q.text_suspect ? '<span class="tag bad">text?</span>' : ""}
    <div class="muted">regions sky ${fmt(q.regions.sky, 2)} · mid ${fmt(q.regions.mid, 2)} · ground ${fmt(q.regions.ground, 2)} · edges ${fmt(q.regions.edges, 2)}</div>`;
}
async function rClips() {
  const clips = P.clips || [];
  const latest = latestBy(clips, "shot_n");
  const missing = (P.plan.shots || []).filter(sh => P.stills.some(s => s.shot_n === sh.n && s.status === "approved") && !clips.some(c => c.shot_n === sh.n && ["pending", "approved", "cut"].includes(c.status))).length;
  const rows = (P.plan.shots || []).map(sh => { const c = latest[sh.n]; const attempts = clips.filter(x => x.shot_n === sh.n).length; if (!c) return `<tr><td>${sh.n}</td><td colspan="4" class="muted">${P.stills.some(s => s.shot_n === sh.n && s.status === "approved") ? "not generated yet" : "no approved still for this shot"}</td></tr>`; return `
    <tr class="${c.status}"><td>${sh.n}<br><span class="muted">${sh.cls} · ${esc(sh.season)} ${esc(label(sh.time))} · ${sh.scale}</span><br><span class="tag">attempt ${c.attempt}</span></td>
      <td style="width:220px"><video data-file="${c.path}" data-poster="${c.thumb}" controls muted loop playsinline style="width:100%;border-radius:6px"></video><button class="btn small secondary" data-big="${c.id}" style="margin-top:4px">view large</button></td>
      <td>${c.qc.passed ? '<span class="tag ok">QC pass</span>' : `<span class="tag bad">QC fail</span> ${c.qc.failures.map(f => `<span class="tag bad">${esc(f)}</span>`).join(" ")}`}<br>${qcCell(c.qc)}<div class="muted" style="margin-top:4px">${esc(c.qc.interpretation)}</div>${c.note ? `<div class="muted">${esc(c.note)}</div>` : ""}</td>
      <td><span class="tag ${c.status === "approved" ? "ok" : c.status === "cut" ? "bad" : ""}">${c.status}</span></td>
      <td><div class="row" style="gap:6px"><button class="btn small" data-approve="${c.id}" ${c.status === "approved" ? "disabled" : ""}>approve</button><button class="btn small danger" data-cut="${c.id}" ${c.status === "cut" ? "disabled" : ""}>cut</button></div>
        <div class="row" style="gap:6px;margin-top:6px"><select data-mode="${sh.n}" style="font-size:12px"><option value="camera_softer">regenerate: softer camera</option><option value="lighter_cues">regenerate: lighter cues (new still)</option><option value="dry">regenerate: dry re-shoot (new still)</option><option value="notes">regenerate with notes</option></select><input data-note="${sh.n}" placeholder="notes" style="width:120px"><button class="btn small secondary" data-regen="${sh.n}">go</button></div>
        <div class="muted">${attempts} attempt${attempts === 1 ? "" : "s"}; after ${health.max_attempts || MAX_ATTEMPTS_PER_SHOT} the engine recommends a cut or a dry re-shoot</div></td></tr>`; }).join("");
  await setHTML(el("main"), `
    <h2>Clips and QC</h2><p class="lead">Every clip is measured before you see it. Fails are named with their cause. Regenerate only what you name, and only with a real change: the camera, the cue weight, or the weather. Never the same prompt again.</p>
    ${blocker("clips")}
    <div id="jobbar"></div>
    <div class="card"><button class="btn" id="gen" ${locked("clips") || !missing ? "disabled" : ""}>${clips.length ? `Generate the ${missing} missing` : "Generate clips for approved stills"}</button> <span class="muted">video costs about 3.5× an image. Keep this tab in front while clips are being written.</span></div>
    <div class="card clips-wrap" style="overflow:auto"><table><thead><tr><th>shot</th><th>clip</th><th>QC</th><th>status</th><th>actions</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  el("gen").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/clips/generate?background=true`, { method: "POST" }); await pollJob("clips"); await reload(); }, "generating and measuring clips…");
  el("main").querySelectorAll("[data-approve]").forEach(b => b.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/clips/${b.dataset.approve}/approve`, { method: "POST" }); await reload(); }));
  el("main").querySelectorAll("[data-cut]").forEach(b => b.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/clips/${b.dataset.cut}/cut`, { method: "POST" }); await reload(); }));
  el("main").querySelectorAll("[data-big]").forEach(b => b.onclick = () => { const c = clips.find(x => x.id === b.dataset.big); lightboxVideo(c.path, `shot ${c.shot_n} · attempt ${c.attempt}`); });
  el("main").querySelectorAll("[data-regen]").forEach(b => b.onclick = () => busy(async () => {
    const n = +b.dataset.regen; const mode = el("main").querySelector(`[data-mode="${n}"]`).value; const note = el("main").querySelector(`[data-note="${n}"]`).value;
    const r = await api(`/api/projects/${P.id}/clips/regenerate`, { body: { items: [{ shot_n: n, mode, note }] } });
    if (r.refused.length) { modal(`<h3>Refused</h3><p>${esc(r.refused[0].reason)}</p>`); return; }
    await pollJob("clips"); await reload();
  }, "regenerating…"));
}

// -------------------------------------------------------------- 7 sequence
async function rSequence() {
  await setHTML(el("main"), `<h2>Sequence</h2><p class="lead">A suggested order with its reasoning, then reorder freely: drag, or use the arrows. The strip shows the light arc; warnings flag three same-scale shots in a row or a continuity break inside a chapter.</p>
    ${blocker("sequence")}<div class="card"><button class="btn" id="suggest" ${locked("sequence") ? "disabled" : ""}>Suggest order</button></div><div id="seqbody"></div>`);
  el("suggest").onclick = () => busy(async () => { const d = await api(`/api/projects/${P.id}/sequence/suggest`); await drawSeq(d); });
  if (!locked("sequence")) api(`/api/projects/${P.id}/sequence/preview`).then(drawSeq).catch(() => {});
}
async function drawSeq(d) {
  if (!d.items || !d.items.length) { el("seqbody").innerHTML = `<p class="muted">No approved clips yet.</p>`; return; }
  // the strip is normalised across the film so its arc reads even when every
  // shot sits in a narrow band of brightness
  const lo = Math.min(...d.brightness_strip), hi = Math.max(...d.brightness_strip);
  const norm = b => (hi - lo > 1e-3 ? (b - lo) / (hi - lo) : 0.5);
  await setHTML(el("seqbody"), `<div class="card"><div class="muted">${esc(d.rationale)}</div>
    <div class="strip">${d.brightness_strip.map(b => `<div style="background:rgb(${Math.round(60 + norm(b) * 195)},${Math.round(55 + norm(b) * 180)},${Math.round(45 + norm(b) * 150)})" title="brightness ${fmt(b)}"></div>`).join("")}</div>
    <div>total ${d.total_duration_s}s · ${d.items.length} clips</div>
    ${d.warnings.length ? `<ul class="warn-list">${d.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    <ul class="seq" id="seq">${d.items.map(it => `<li draggable="true" data-id="${it.id}"><img data-file="${it.thumb}"><div class="body"><b>#${it.shot_n}</b> ${it.cls} · ch ${it.chapter}<br>${esc(it.season)} ${esc(label(it.time))} · ${it.scale} · ${it.duration}s</div><div class="arrows"><button class="btn small secondary" data-mv="-1">◀</button><button class="btn small secondary" data-mv="1">▶</button></div></li>`).join("")}</ul>
    <div style="margin-top:10px"><button class="btn" id="saveorder">Save order</button> <button class="btn secondary" id="reset">Back to suggested</button></div></div>`);
  const ul = el("seq"); let drag = null;
  ul.querySelectorAll("li").forEach(li => {
    li.ondragstart = () => { drag = li; li.classList.add("dragging"); }; li.ondragend = () => { li.classList.remove("dragging"); drag = null; };
    li.ondragover = e => { e.preventDefault(); if (!drag || drag === li) return; const r = li.getBoundingClientRect(); const before = (e.clientX - r.left) < r.width / 2; ul.insertBefore(drag, before ? li : li.nextSibling); };
    li.querySelectorAll("[data-mv]").forEach(b => b.onclick = () => { const dir = +b.dataset.mv; if (dir < 0 && li.previousElementSibling) ul.insertBefore(li, li.previousElementSibling); if (dir > 0 && li.nextElementSibling) ul.insertBefore(li.nextElementSibling, li); });
  });
  el("saveorder").onclick = () => busy(async () => { const order = [...ul.querySelectorAll("li")].map(l => l.dataset.id); const r = await api(`/api/projects/${P.id}/sequence`, { method: "PUT", body: { order } }); await drawSeq(r); toast("order saved"); });
  el("reset").onclick = () => busy(async () => { const r = await api(`/api/projects/${P.id}/sequence`, { method: "PUT", body: { order: d.suggested_order } }); await drawSeq(r); });
}

// -------------------------------------------------------------- 8 branding
async function rBranding() {
  const B = P.branding;
  const planning = P.intake.end_use === "planning_consultation";
  await setHTML(el("main"), `<h2>Branding</h2><p class="lead">Title card, practice name, location, stage stamp and the disclaimer that keeps a visualisation from being read as evidence. A logo goes on the end card. Real ambience beds and a score replace the synthetic placeholder bed.</p>
    ${blocker("branding")}
    <div class="card"><div class="row">
      <label class="f">title card<select id="b_pos">${[["start", "start"], ["end", "end"], ["both", "both"], ["none", "none"]].map(([v, l]) => `<option value="${v}" ${B.title_position === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="f">style<select id="b_style">${[["minimal", "minimal white on footage"], ["card", "solid card between shots"], ["lower_third", "lower third"]].map(([v, l]) => `<option value="${v}" ${B.style === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="f">project name<input id="b_project" value="${esc(B.project_name || P.intake.project_name || P.name)}"></label>
      <label class="f">practice<input id="b_practice" value="${esc(B.practice_name || P.intake.practice_name)}"></label>
      <label class="f">location line<input id="b_loc" value="${esc(B.location_line || P.intake.location)}"></label>
      <label class="f">subtitle / second language<input id="b_sub" value="${esc(B.subtitle)}"></label>
      <label class="f">year<input id="b_year" value="${esc(B.year || new Date().getFullYear())}"></label>
      <label class="f">stage stamp<select id="b_stamp"><option value="">none</option>${["Concept", "Design development", "Planning", "Not for construction"].map(s => `<option ${B.stage_stamp === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="f wide">disclaimer<input id="b_disc" value="${esc(B.disclaimer)}"></label>
      <label class="f">on every frame<select id="b_every" ${planning ? "disabled" : ""}><option value="false" ${!B.disclaimer_every_frame && !planning ? "selected" : ""}>title card only</option><option value="true" ${B.disclaimer_every_frame || planning ? "selected" : ""}>every frame</option></select>${planning ? `<span class="muted">always on for a planning or consultation film</span>` : ""}</label>
    </div><div style="margin-top:10px"><button class="btn" id="saveb">Save branding</button></div></div>
    <div class="card"><h3 style="margin-top:0">Assets</h3><div class="row">
      <label class="f">logo (end card)<input type="file" id="logo" accept="image/*"></label>
      <label class="f">exterior ambience bed<input type="file" id="bed_exterior" accept="audio/*"></label>
      <label class="f">interior room tone<input type="file" id="bed_interior" accept="audio/*"></label>
      <label class="f">score (mixed at 32%)<input type="file" id="bed_score" accept="audio/*"></label></div>
      <div class="row" style="margin-top:10px;align-items:center">
        ${B.logo_path ? `<img data-file="${B.logo_path}" alt="logo" style="max-height:60px;max-width:200px;background:#fff;border-radius:6px;padding:6px">` : `<span class="muted">no logo</span>`}
        <span class="muted">beds: ${Object.keys(P.audio_beds || {}).join(", ") || "none uploaded, the synthetic placeholder will be used"}</span>
      </div>
      <p class="muted" style="margin-top:8px">The exterior bed plays under exterior shots; the room tone under interiors with the exterior bed kept low behind the glass; the score sits under both. Cuts crossfade over 0.3 s.</p></div>`);
  el("saveb").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/branding`, { method: "PUT", body: { title_position: el("b_pos").value, style: el("b_style").value, project_name: el("b_project").value, practice_name: el("b_practice").value, location_line: el("b_loc").value, subtitle: el("b_sub").value, year: el("b_year").value, stage_stamp: el("b_stamp").value, disclaimer: el("b_disc").value, disclaimer_every_frame: el("b_every").value === "true" } }); await reload(); toast("branding saved"); });
  el("logo").onchange = e => busy(async () => { const fd = new FormData(); fd.append("file", e.target.files[0]); await api(`/api/projects/${P.id}/branding/logo`, { body: fd }); await reload(); });
  ["exterior", "interior", "score"].forEach(k => el("bed_" + k).onchange = e => busy(async () => { const fd = new FormData(); fd.append("file", e.target.files[0]); await api(`/api/projects/${P.id}/audio/${k}`, { body: fd }); await reload(); }));
}

// ---------------------------------------------------------------- 9 render
async function rRender() {
  const D = P.deliverables; const v = D.verification || {};
  const [FW, FH] = resFor(P.intake.aspect);
  const sizeFor = s => { const [w, h] = resFor(P.intake.aspect, s); return `${w}×${h}`; };
  const small = isSmallScreen();
  // "Auto" is the size your renders can actually carry. A 1600-pixel render
  // scaled up to 1920 is 1920 pixels of nothing, and a phone will not hold a
  // full 1080p canvas plus an encoder, so auto takes the smaller of the two
  // and says which it took.
  const srcLong = Math.max(...(P.hubs || []).map(h => Math.max(h.width, h.height)).concat([0]));
  const frameLong = Math.max(FW, FH);
  const fromSource = srcLong ? Math.min(1, Math.max(0.25, Math.round((srcLong / frameLong) * 100) / 100)) : 1;
  const autoScale = small ? Math.min(0.5, fromSource) : fromSource;
  const autoWhy = small && fromSource > 0.5 ? "this phone" : srcLong ? `your renders (${srcLong}px)` : "the default";
  const SIZES = [[autoScale, `Auto · matched to ${autoWhy}`], [1, "Full"], [0.667, "Two thirds"], [0.5, "Half"]]
    .filter(([v], i, a) => i === 0 || Math.abs(v - a[0][0]) > 0.02);
  await setHTML(el("main"), `<h2>Final render and delivery</h2><p class="lead">Normalise to the target ratio at 30 fps, hard cuts, title cards and stamp, fades, the ambience bed. Then the film, crop-only variants, the stills pack and the project record.</p>
    ${blocker("render")}
    <div class="card"><div class="row">
      <label class="f">render size<select id="size">${SIZES.map(([s, l], i) => `<option value="${s}" ${i === 0 ? "selected" : ""}>${l} · ${sizeFor(s)}</option>`).join("")}</select></label>
      <div class="opt"><span class="lbl">extra crops</span><div class="chips" id="crops">${[...new Set(["16:9", "9:16", "1:1", "4:5", commonAspect(P.hubs || [])].filter(Boolean))].filter(a => a !== P.intake.aspect).map(a => `<span class="chip" data-a="${a}">${a}</span>`).join("")}</div></div>
      <button class="btn" id="go" ${locked("render") ? "disabled" : ""}>${D.film ? "Render again" : "Render film"}</button></div>
      <p class="muted">The film is written in real time, so it takes about as long as it runs, and each extra crop takes that again. Keep this page in front while it works: in the background the picture freezes while the clock keeps running, and the render is thrown away rather than saved wrong.${small ? " On a phone, half size is the default because a 1080p canvas, several video tracks and an encoder at once is more than most phones will hold. Render it full size on a laptop when the film is settled." : ""}</p></div>
    <div id="jobbar"></div>
    ${D.film ? `<div class="card"><video data-file="${D.film}" controls playsinline style="width:100%;max-height:60vh;background:#000;border-radius:8px"></video>
      <h3>Verification</h3><div class="kv"><div>Duration</div><div>${v.duration_s}s (expected ${v.expected_duration_s}s)</div><div>Resolution</div><div>${v.width}×${v.height} @ ${v.fps} fps</div><div>Loudness</div><div>${v.integrated_lufs ?? "not measurable in this browser"} dBFS · <span class="muted">${esc(v.loudness_method || "")}</span></div><div>Audio bed</div><div>${esc(v.audio_bed || "")}</div><div>Container</div><div>${esc(v.container || "")} ${v.interoperable ? "" : "<span class='tag warn'>browser playback only</span>"}</div><div>Light arc</div><div><div class="strip">${(v.brightness_arc || []).map(b => `<div style="background:rgb(${Math.round(40 + b * 215)},${Math.round(40 + b * 200)},${Math.round(40 + b * 170)})"></div>`).join("")}</div></div></div>
      <h3>Downloads</h3><ul><li><a data-file="${D.film}" download="film.${D.film.split(".").pop()}">Film (${P.intake.aspect})</a></li>${Object.entries(D.crops).map(([a, p]) => `<li><a data-file="${p}" download="film_${a.replace(":", "x")}.${p.split(".").pop()}">Crop ${a}</a></li>`).join("")}<li><a data-file="${D.stills_pack}" download="stills_pack.zip">Stills pack (zip with sidecar)</a></li><li><a data-file="${D.record_html}" target="_blank">Project record (HTML)</a> · <a data-file="${D.record_json}" download="record.json">JSON</a></li><li><a href="#" id="exportproj">Whole project as a ZIP</a> <span class="muted">(the file copy: every render, prompt, still, clip and this film)</span></li></ul></div>` : ""}`);
  el("crops").querySelectorAll(".chip").forEach(c => c.onclick = () => c.classList.toggle("on"));
  el("go").onclick = () => busy(async () => {
    const crops = [...el("crops").querySelectorAll(".chip.on")].map(c => c.dataset.a).join(",");
    const scale = el("size").value;
    const run = api(`/api/projects/${P.id}/render?crops=${encodeURIComponent(crops)}&scale=${scale}`, { method: "POST" });
    await pollJob("render"); await run; await reload();
  }, "rendering in real time…");
  const ex = el("exportproj"); if (ex) ex.onclick = (e) => { e.preventDefault(); busy(async () => { const r = await api(`/api/projects/${P.id}/export`); download(r.blob, r.filename); }, "packing the project…"); };
}

/* A blank page is indistinguishable from a broken app, so a boot that fails
   says so on screen. Setting the flag also stands the watchdog down. */
init().then(() => { window.__ready = true; }).catch(e => {
  window.__ready = true;
  const msg = (e && e.message) || String(e);
  if (window.__fatal) window.__fatal("The tool could not start.", msg + " — open the browser check for what this browser is missing.");
  else throw e;
});
