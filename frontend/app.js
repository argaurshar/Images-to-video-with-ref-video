/* ArchViz Cinematic Engine front end. No build step: plain ES module.
   One renderer per stage of the spec; the server enforces every gate. */

const STAGES = [
  ["intake", "1 Intake"], ["reference", "2 Reference"], ["plan", "3 Shot plan"], ["hero", "4 Hero gate"],
  ["board", "5 Still board"], ["clips", "6 Clips + QC"], ["sequence", "7 Sequence"], ["branding", "8 Branding"], ["render", "9 Render"],
];
const SEASONS = ["spring", "summer", "monsoon", "autumn", "winter"];
const TIMES = ["dawn", "morning", "midday", "afternoon", "golden_hour", "dusk", "night"];
const SCALES = ["aerial", "wide", "medium", "detail", "macro"];

let P = null;          // current project document
let view = "intake";   // current stage view
let health = {};

// ------------------------------------------------------------------ helpers
async function api(path, opts = {}) {
  const o = { method: opts.method || (opts.body ? "POST" : "GET"), headers: {} };
  if (opts.body instanceof FormData) o.body = opts.body;
  else if (opts.body !== undefined) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(opts.body); }
  const r = await fetch(path, o);
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  if (!r.ok) { const msg = (data && data.detail) ? (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)) : txt; throw new Error(msg); }
  return data;
}
function toast(msg, bad = false) { const t = document.getElementById("toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : ""); setTimeout(() => t.className = "toast", bad ? 6000 : 2600); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function file(rel) { return "/files/" + rel; }
function el(id) { return document.getElementById(id); }
window.closeModal = () => el("modal").classList.add("hidden");
function modal(html) { el("modal-body").innerHTML = html; el("modal").classList.remove("hidden"); }
async function busy(fn, msg) {
  const m = el("main"); m.classList.add("busy");
  if (msg) toast(msg);
  try { await fn(); } catch (e) { toast(e.message, true); console.error(e); } finally { m.classList.remove("busy"); }
}
async function reload() { if (P) P = await api(`/api/projects/${P.id}`); await renderProjectBar(); renderAll(); }
function hub(id) { return (P.hubs || []).find(h => h.id === id) || {}; }
function shot(n) { return (P.plan.shots || []).find(s => s.n === n) || {}; }
function fmt(x, d = 2) { return typeof x === "number" ? x.toFixed(d) : x; }

// ------------------------------------------------------------------ frame
async function init() {
  health = await api("/api/health").catch(() => ({}));
  await renderProjectBar();
  renderAll();
}
async function renderProjectBar() {
  const list = await api("/api/projects");
  const bar = el("projbar");
  bar.innerHTML = `<select id="projsel"><option value="">Open a project…</option>${list.map(p => `<option value="${p.id}" ${P && P.id === p.id ? "selected" : ""}>${esc(p.name)} · ${esc(p.stage)}</option>`).join("")}</select>
    <input id="newname" placeholder="New project name" style="width:200px"><button class="btn small" id="newbtn">Create</button>
    <span class="muted">provider: <b>${esc(health.provider || "?")}</b></span>`;
  el("projsel").onchange = async e => { if (e.target.value) { P = await api(`/api/projects/${e.target.value}`); view = P.stage === "delivered" ? "render" : (P.stage || "intake"); renderAll(); } };
  el("newbtn").onclick = () => busy(async () => { P = await api("/api/projects", { body: { name: el("newname").value } }); view = "intake"; await renderProjectBar(); renderAll(); });
}
function renderSteps() {
  const s = el("steps");
  if (!P) { s.innerHTML = ""; return; }
  const order = STAGES.map(x => x[0]);
  const cur = order.indexOf(P.stage === "delivered" ? "render" : P.stage);
  s.innerHTML = STAGES.map(([k, label], i) => {
    const skip = k === "reference" && P.intake.route !== "reference";
    return `<button data-k="${k}" class="${view === k ? "active" : ""} ${i < cur ? "done" : ""}" ${skip ? "disabled" : ""}>${label}</button>`;
  }).join("");
  s.querySelectorAll("button").forEach(b => b.onclick = () => { view = b.dataset.k; renderAll(); });
}
function renderSpend() {
  const sp = el("spend");
  if (!P) { sp.innerHTML = ""; return; }
  const spent = (P.ledger || []).reduce((a, e) => a + e.cost, 0);
  sp.innerHTML = `spend <b>${spent.toFixed(2)}</b> / budget ${P.budget.total ? P.budget.total.toFixed(2) : "not set"} ${P.budget.confirmed ? "" : "<span class='tag warn'>unconfirmed</span>"}`;
}
function renderAll() {
  renderSteps(); renderSpend();
  const m = el("main");
  if (!P) { m.innerHTML = `<div class="card"><h2>Start</h2><p class="lead" id="opening">…</p></div>`; api("/api/opening").then(d => el("opening").textContent = d.message); return; }
  ({ intake: rIntake, reference: rReference, plan: rPlan, hero: rHero, board: rBoard, clips: rClips, sequence: rSequence, branding: rBranding, render: rRender })[view]();
}

// ------------------------------------------------------------------ 1 intake
function rIntake() {
  const I = P.intake;
  const seasonChips = SEASONS.map(s => `<span class="chip ${I.seasons.includes(s) ? "on" : ""}" data-s="${s}">${s}</span>`).join("");
  const hubs = (P.hubs || []).map(h => `
    <div class="tile"><img src="${file(`projects/${P.id}/thumbs/${h.id}.jpg`)}" alt="">
      <div class="body">
        <div class="row" style="gap:8px">
          <label class="f" style="min-width:110px">class<select data-h="${h.id}" data-k="cls"><option ${h.cls === "exterior" ? "selected" : ""}>exterior</option><option ${h.cls === "interior" ? "selected" : ""}>interior</option></select></label>
          <label class="f" style="min-width:90px">camera faces<select data-h="${h.id}" data-k="camera_faces"><option value="">not stated</option>${["N", "NE", "E", "SE", "S", "SW", "W", "NW"].map(d => `<option ${h.camera_faces === d ? "selected" : ""}>${d}</option>`).join("")}</select></label>
        </div>
        <label class="f">label<input data-h="${h.id}" data-k="label" value="${esc(h.label)}"></label>
        <label class="f">materials and finishes, by name<textarea data-h="${h.id}" data-k="materials" placeholder="e.g. board-formed concrete, spotted gum battens, zinc standing seam">${esc(h.materials)}</textarea></label>
        <label class="f">fixed elements to protect (the prompt's sacred list)<textarea data-h="${h.id}" data-k="elements" placeholder="e.g. two levels, four windows per level, entry canopy, retaining wall left, road along the front, two oaks">${esc(h.elements)}</textarea></label>
        <div class="muted">detected: ${esc(h.detected.time_of_day)} · ${esc(h.detected.colour_temperature)} · sky ${fmt(h.detected.sky_fraction)} · ${esc(h.detected.aspect)} · ${h.detected.lights_on ? "lights on" : "lights off"} ${h.detected.climate_hint ? "· " + esc(h.detected.climate_hint) : ""}</div>
        <button class="btn small danger" data-del="${h.id}" style="margin-top:6px">remove</button>
      </div></div>`).join("");
  el("main").innerHTML = `
    <h2>Intake</h2><p class="lead">Upload 1 to 8 renders of one project: exterior angles, interior rooms, or both. Name the finishes on each render; the prompts use your words, never invented ones. State which way the camera faces on exteriors so the sun comes from the right side.</p>
    <div class="card"><div class="dropzone" id="drop">Drop renders here or <input type="file" id="hubfiles" multiple accept="image/*"></div>
      <div class="grid" style="margin-top:14px">${hubs}</div></div>
    <div class="card"><h3>Questionnaire</h3>
      <div class="row">
        <label class="f">route<select id="i_route"><option value="brief" ${I.route === "brief" ? "selected" : ""}>Season or mood brief</option><option value="reference" ${I.route === "reference" ? "selected" : ""}>Reference video</option></select></label>
        <label class="f">aspect ratio (by crop only)<select id="i_aspect">${["16:9", "9:16", "1:1", "4:5"].map(a => `<option ${I.aspect === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
        <label class="f">time arc<select id="i_time_arc">${[["dawn_to_night", "Dawn to night"], ["single", "Single time of day"], ["golden_hour", "Golden hour only"], ["night", "Night only"]].map(([v, l]) => `<option value="${v}" ${I.time_arc === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="f">single time (if chosen)<select id="i_single_time">${TIMES.map(t => `<option ${I.single_time === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="f">mood<select id="i_mood">${[["serene", "Serene and still"], ["moody", "Moody and atmospheric"], ["warm", "Warm and lived-in"], ["bold", "Bold and dramatic"]].map(([v, l]) => `<option value="${v}" ${I.mood === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="f">people<select id="i_people">${[["none", "None (pure architecture)"], ["scale_figure", "Scale figure, from behind"], ["lifestyle", "Lifestyle, one pair or small group"]].map(([v, l]) => `<option value="${v}" ${I.people === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="f">length<select id="i_length">${[[5, "25 s · 5 shots"], [9, "45 s · 9 shots"], [14, "70 s · 14 shots"]].map(([v, l]) => `<option value="${v}" ${I.length_shots == v ? "selected" : ""}>${l}</option>`).join("")}<option value="custom">Custom</option></select></label>
        <label class="f">custom shots<input id="i_custom" type="number" min="1" max="30" value="${I.length_shots}"></label>
      </div>
      <div style="margin:10px 0"><span class="muted">seasons</span><div class="chips" id="seasons">${seasonChips}</div></div>
      <div class="row">
        <label class="f wide">location (required; drives climate, hemisphere and sun path)<input id="i_location" value="${esc(I.location)}" placeholder="e.g. Willow Glen, San Jose, California"></label>
        <label class="f">project stage<select id="i_stage">${[["concept", "Concept"], ["design_development", "Design development"], ["planning", "Planning / DA"], ["construction_docs", "Construction docs"], ["completed", "Completed"]].map(([v, l]) => `<option value="${v}" ${I.project_stage === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="f">end use<select id="i_end_use">${[["client_presentation", "Client presentation"], ["planning_consultation", "Planning or neighbour consultation"], ["website", "Website hero"], ["social", "Social (Reels/Shorts)"], ["awards", "Awards submission"], ["developer_marketing", "Marketing for a developer client"]].map(([v, l]) => `<option value="${v}" ${I.end_use === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="f">interior emphasis<select id="i_int"><option value="">not applicable</option>${[["daylight", "Daylight through the day"], ["night", "Night and artificial light"], ["seasonal_view", "Seasonal view through openings"], ["lived_in", "Lived-in moments"]].map(([v, l]) => `<option value="${v}" ${I.interior_emphasis === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <h3>Design intent</h3><p class="lead">What are the three things you most want the client to notice? Each becomes a shot. A time word (afternoon, dusk) sets that shot's time.</p>
      <div class="row">${[0, 1, 2].map(i => `<label class="f wide">intent ${i + 1}<input id="i_intent${i}" value="${esc(I.design_intents[i] || "")}" placeholder="${["the way afternoon light enters the living room", "the entry canopy against the street", "the deck meeting the garden"][i]}"></label>`).join("")}</div>
      <div class="row"><label class="f">project name<input id="i_pname" value="${esc(I.project_name)}"></label><label class="f">practice name<input id="i_practice" value="${esc(I.practice_name)}"></label></div>
      <div style="margin-top:12px"><button class="btn" id="save_intake">Save intake and research the location</button></div>
      ${P.location_profile.location ? `<h3>Location profile</h3><div class="kv">${["hemisphere", "climate", "vegetation", "signature", "sun_path", "source"].map(k => `<div>${k}</div><div>${esc(P.location_profile[k] || "")}</div>`).join("")}</div>` : ""}
    </div>
    <div class="card"><h3>Budget gate</h3>
      ${P.budget.total ? `<div class="kv"><div>Hero variants</div><div>${P.budget.hero_images} × ${P.budget.image_cost}</div><div>Stills</div><div>${P.budget.stills} × ${P.budget.image_cost}</div><div>Clips</div><div>${P.budget.clips} × ${P.budget.video_cost}</div><div>Reserve 20%</div><div>${fmt(P.budget.reserve)}</div><div>Total</div><div><b>${fmt(P.budget.total)}</b></div></div>
        <div style="margin-top:10px">${P.budget.confirmed ? `<span class="tag ok">confirmed</span>` : `<button class="btn" id="confirm_budget">Confirm budget</button>`}</div>` : `<p class="muted">Save the intake to see the estimate.</p>`}
    </div>`;
  // handlers
  const drop = el("drop");
  const upload = async files => busy(async () => { const fd = new FormData(); [...files].forEach(f => fd.append("files", f)); await api(`/api/projects/${P.id}/hubs`, { body: fd }); await reload(); }, "analysing renders…");
  el("hubfiles").onchange = e => upload(e.target.files);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); }; drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files); };
  el("main").querySelectorAll("[data-h]").forEach(inp => inp.onchange = () => busy(async () => { await api(`/api/projects/${P.id}/hubs/${inp.dataset.h}`, { method: "PATCH", body: { [inp.dataset.k]: inp.value } }); P = await api(`/api/projects/${P.id}`); renderSpend(); }));
  el("main").querySelectorAll("[data-del]").forEach(b => b.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/hubs/${b.dataset.del}`, { method: "DELETE" }); await reload(); }));
  el("seasons").querySelectorAll(".chip").forEach(c => c.onclick = () => c.classList.toggle("on"));
  el("save_intake").onclick = () => busy(async () => {
    const lenSel = el("i_length").value;
    const body = {
      route: el("i_route").value, aspect: el("i_aspect").value, time_arc: el("i_time_arc").value, single_time: el("i_single_time").value,
      mood: el("i_mood").value, people: el("i_people").value, length_shots: lenSel === "custom" ? +el("i_custom").value : +lenSel,
      seasons: [...el("seasons").querySelectorAll(".chip.on")].map(c => c.dataset.s), location: el("i_location").value,
      project_stage: el("i_stage").value, end_use: el("i_end_use").value, interior_emphasis: el("i_int").value || null,
      design_intents: [0, 1, 2].map(i => el("i_intent" + i).value), project_name: el("i_pname").value, practice_name: el("i_practice").value,
    };
    const r = await api(`/api/projects/${P.id}/intake`, { method: "PUT", body }); P = r.project;
    if (r.warnings.length) modal(`<h3>Crop warnings (Law 6: crop, never outpaint)</h3><ul class="warn-list">${r.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>`);
    renderAll();
  }, "researching the location…");
  const cb = el("confirm_budget"); if (cb) cb.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/budget/confirm`, { method: "POST" }); await reload(); toast("budget confirmed"); });
}

// ------------------------------------------------------------------ 2 reference
function rReference() {
  const R = P.reference;
  el("main").innerHTML = `
    <h2>Reference video analysis</h2><p class="lead">Measured, not watched. The structure is what you copy: shot length, rhythm, light arc, scale changes, inside/outside pattern. The colour belongs to the reference's climate and stays there.</p>
    <div class="card"><input type="file" id="reffile" accept="video/*"> <button class="btn" id="refbtn">Upload and analyse</button></div>
    ${R ? `<div class="card"><h3>${esc(R.filename)}</h3>
      <div class="kv"><div>Duration</div><div>${R.duration_s}s · ${R.width}×${R.height} · ${R.fps} fps · ${esc(R.aspect)}</div>
      <div>Shots</div><div>${R.shot_count} · mean ${R.mean_shot_length_s}s</div>
      <div>Colour</div><div>brightness ${R.mean_brightness} · saturation ${R.mean_saturation} · warmth ${R.warmth} (${R.warmth > 0.03 ? "warm" : R.warmth < -0.03 ? "cool" : "neutral"}) · shadow floor ${R.shadow_floor} · highlight ceiling ${R.highlight_ceiling}</div>
      <div>Weather density</div><div>${(R.weather_density * 100).toFixed(1)}% frame · ${(R.sky_band_density * 100).toFixed(1)}% sky band</div>
      <div>Audio</div><div>${R.has_audio ? "audio track present (narration vs ambience: check by ear)" : "no audio track"}</div>
      <div>Scale rhythm</div><div>${R.scale_changes_per_shot} changes per cut · longest same-scale run ${R.max_same_scale_run}</div>
      <div>Inside/outside</div><div class="mono" style="display:inline-block;padding:2px 8px">${esc(R.inside_outside_pattern)}</div></div>
      <h3>Light arc</h3>${spark(R.light_arc)}
      <h3>Shot log</h3><table><tr><th>#</th><th>start</th><th>length</th><th>scale</th><th>camera</th><th>setting</th><th>brightness</th></tr>
      ${R.shots.map(s => `<tr><td>${s.index}</td><td>${s.start_s}s</td><td>${s.duration_s}s</td><td>${s.scale}</td><td>${s.camera_move}</td><td>${s.setting}</td><td>${s.brightness}</td></tr>`).join("")}</table>
      <p class="warn-list" style="list-style:none;padding:0">${esc(R.caveat)}</p></div>` : ""}`;
  el("refbtn").onclick = () => busy(async () => { const f = el("reffile").files[0]; if (!f) throw new Error("choose a video"); const fd = new FormData(); fd.append("file", f); await api(`/api/projects/${P.id}/reference`, { body: fd }); await reload(); }, "measuring the reference…");
}
function spark(arr) {
  if (!arr || !arr.length) return "";
  const w = 600, h = 48; const pts = arr.map((v, i) => `${(i / (arr.length - 1)) * w},${h - v * h}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#d9b46a" stroke-width="1.5"/></svg>`;
}

// ------------------------------------------------------------------ 3 plan
function rPlan() {
  const plan = P.plan; const shots = plan.shots || [];
  const opts = (list, cur) => list.map(v => `<option ${v === cur ? "selected" : ""}>${v}</option>`).join("");
  const rows = shots.map(s => `<tr data-n="${s.n}">
      <td>${s.n}<br><span class="muted">${esc(s.beat)}</span></td>
      <td><select data-k="cls">${opts(["exterior", "interior"], s.cls)}</select></td>
      <td><select data-k="season">${opts(SEASONS, s.season)}</select></td>
      <td><select data-k="time">${opts(TIMES, s.time)}</select></td>
      <td><select data-k="scale">${opts(SCALES, s.scale)}</select></td>
      <td><select data-k="source_hub_id">${(P.hubs || []).filter(h => h.cls === s.cls).map(h => `<option value="${h.id}" ${h.id === s.source_hub_id ? "selected" : ""}>${esc(h.label || h.id)}</option>`).join("")}</select></td>
      <td><input data-k="motion" value="${esc(s.motion)}"></td>
      <td><input data-k="human_beat" value="${esc(s.human_beat)}"></td>
      <td><input data-k="design_intent" value="${esc(s.design_intent)}"></td>
      <td class="muted">${esc(s.state.weather)}${s.heavy ? ' <span class="tag warn">heavy</span>' : ""}<br>sun ${esc(s.sun_side)}</td>
      <td><button class="btn small secondary" data-prompt="${s.n}">prompt</button></td></tr>`).join("");
  el("main").innerHTML = `
    <h2>Shot plan</h2><p class="lead">Rules: scale pyramid, one arc per axis, chapter closers on the widest shot, human beats at the edges, one heavy weather beat, approach → enter → dwell → detail → return when both classes exist. Edit anything, then approve. Nothing is generated until you do.</p>
    <div class="card"><div class="row"><button class="btn" id="gen">Generate plan</button>${shots.length ? `<button class="btn secondary" id="saveplan">Save edits</button><button class="btn" id="approve" ${plan.approved ? "disabled" : ""}>${plan.approved ? "Approved" : "Approve plan"}</button>` : ""}</div>
      ${plan.rationale ? `<p class="muted" style="margin-top:10px">${esc(plan.rationale)}</p>` : ""}
      ${plan.warnings.length ? `<ul class="warn-list">${plan.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}</div>
    ${shots.length ? `<div class="card" style="overflow:auto"><table><tr><th>#</th><th>class</th><th>season</th><th>time</th><th>scale</th><th>source render</th><th>motion cue (light only)</th><th>human beat</th><th>design intent</th><th>chapter state</th><th></th></tr>${rows}</table></div>` : ""}`;
  el("gen").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/plan/generate`, { method: "POST" }); await reload(); });
  const sv = el("saveplan"); if (sv) sv.onclick = () => busy(async () => {
    const edited = shots.map(s => { const tr = el("main").querySelector(`tr[data-n="${s.n}"]`); const c = structuredClone(s); tr.querySelectorAll("[data-k]").forEach(i => c[i.dataset.k] = i.value); c.state.season = c.season; c.state.time = c.time; return c; });
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
function rHero() {
  const heroes = P.heroes || [];
  const byCls = {}; heroes.forEach(h => (byCls[h.cls] = byCls[h.cls] || []).push(h));
  el("main").innerHTML = `
    <h2>Hero image gate</h2><p class="lead">Two variants of the signature frame per class. Audit them against the source render with the checklist. Pick one per class; it becomes the palette and lighting reference for the film. Hard stop until you do.</p>
    <div class="card"><button class="btn" id="gen">Generate hero variants</button> <span class="muted">${P.plan.approved ? "" : "plan not approved · "}${P.budget.confirmed ? "" : "budget not confirmed"}</span></div>
    ${Object.entries(byCls).map(([cls, hs]) => `<div class="card"><h3>${cls}</h3><div class="grid">${hs.map(h => `
      <div class="tile ${h.chosen ? "chosen" : ""} ${h.status === "rejected" ? "rejected" : ""}"><img src="${file(h.thumb)}"><div class="body">
        <b>variant ${h.variant}</b> · from ${esc(hub(h.source_hub_id).label || h.source_hub_id)}<br>${auditHtml(h.audit)}
        <details><summary>checklist</summary><ul>${h.audit.checklist.map(c => `<li>${esc(c)}</li>`).join("")}</ul><p class="muted">${esc(h.audit.notes)}</p></details>
        <div class="row" style="margin-top:6px"><button class="btn small" data-choose="${h.id}">${h.chosen ? "chosen" : "choose"}</button><a class="btn small secondary" href="${file(h.path)}" target="_blank">full size</a><button class="btn small secondary" data-showprompt="${h.id}">prompt</button></div>
      </div></div>`).join("")}</div></div>`).join("")}`;
  el("gen").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/heroes/generate`, { method: "POST" }); await reload(); }, "generating hero variants…");
  el("main").querySelectorAll("[data-choose]").forEach(b => b.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/heroes/${b.dataset.choose}/choose`, { method: "POST" }); await reload(); }));
  el("main").querySelectorAll("[data-showprompt]").forEach(b => b.onclick = () => { const h = heroes.find(x => x.id === b.dataset.showprompt); modal(`<div class="mono">${esc(h.prompt)}</div>`); });
}

// ------------------------------------------------------------------ 5 board
function rBoard() {
  const stills = P.stills || [];
  const latest = {}; stills.forEach(s => { if (!latest[s.shot_n] || s.attempt >= latest[s.shot_n].attempt) latest[s.shot_n] = s; });
  const rejected = Object.values(latest).filter(s => s.status === "rejected").map(s => s.shot_n);
  const tiles = (P.plan.shots || []).map(sh => { const s = latest[sh.n]; if (!s) return `<div class="tile"><div class="body">shot ${sh.n}: not generated</div></div>`; return `
    <div class="tile ${s.status}"><img src="${file(s.thumb)}"><div class="body">
      <b>#${sh.n} ${sh.cls} · ${esc(sh.season)} ${esc(sh.time)} · ${sh.scale}</b> <span class="tag">attempt ${s.attempt}</span> <span class="tag ${s.status === "approved" ? "ok" : s.status === "rejected" ? "bad" : ""}">${s.status}</span><br>
      from ${esc(hub(s.source_hub_id).label || s.source_hub_id)} · ${esc(sh.state.weather)}<br>${auditHtml(s.audit)}
      ${sh.design_intent ? `<div>intent: ${esc(sh.design_intent)}</div>` : ""}
      ${s.note ? `<div class="warn-list" style="padding:0;list-style:none">note: ${esc(s.note)}</div>` : ""}
      <div class="row" style="margin-top:6px">
        <button class="btn small" data-approve="${s.id}" ${s.status === "approved" ? "disabled" : ""}>approve</button>
        <button class="btn small danger" data-reject="${s.id}">reject…</button>
        <a class="btn small secondary" href="${file(s.path)}" target="_blank">full</a>
        <button class="btn small secondary" data-showprompt="${s.id}">prompt</button></div>
    </div></div>`; }).join("");
  el("main").innerHTML = `
    <h2>Still board</h2><p class="lead">Every still comes from its hub render, never from another generation. Light motion cues only. Approve all, approve some, or reject specific numbers; only rejected numbers are regenerated, and your note becomes an explicit exclusion in the retry.</p>
    <div class="card"><div class="row"><button class="btn" id="gen">Generate board</button><button class="btn secondary" id="all" ${stills.length ? "" : "disabled"}>Approve all pending</button><button class="btn secondary" id="regen" ${rejected.length ? "" : "disabled"}>Regenerate rejected (${rejected.join(", ") || "none"})</button></div></div>
    <div class="grid">${tiles}</div>`;
  el("gen").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/stills/generate`, { method: "POST" }); await reload(); }, "generating stills from hub renders…");
  el("all").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/stills/approve_all`, { method: "POST" }); await reload(); });
  el("regen").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/stills/regenerate`, { body: { shot_ns: rejected } }); await reload(); }, "regenerating rejected stills…");
  el("main").querySelectorAll("[data-approve]").forEach(b => b.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/stills/${b.dataset.approve}/approve`, { method: "POST" }); await reload(); }));
  el("main").querySelectorAll("[data-reject]").forEach(b => b.onclick = () => {
    modal(`<h3>What specifically is wrong?</h3><p class="muted">Composition, season, light, people, or an invented element. This becomes a hard exclusion in the retry prompt.</p><textarea id="rejnote" style="width:100%"></textarea><div style="margin-top:8px"><button class="btn" id="rejgo">Reject</button></div>`);
    el("rejgo").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/stills/${b.dataset.reject}/reject`, { body: { note: el("rejnote").value } }); closeModal(); await reload(); });
  });
  el("main").querySelectorAll("[data-showprompt]").forEach(b => b.onclick = () => { const s = stills.find(x => x.id === b.dataset.showprompt); modal(`<div class="mono">${esc(s.prompt)}</div>`); });
}

// ------------------------------------------------------------------ 6 clips
function qcCell(q) {
  if (!q.ran) return "<span class='muted'>not run</span>";
  const t = (label, v, ok) => `<span class="tag ${ok ? "ok" : "bad"} num">${label} ${v}</span>`;
  return `${t("motion", fmt(q.motion_score, 2), q.motion_score >= 1.5 && q.motion_score <= 8)} ${t("frozen", fmt(q.frozen_ratio, 2), q.frozen_ratio <= 0.35 || !q.failures.some(f => f.startsWith("frozen")))} ${t("density", (q.particle_density * 100).toFixed(1) + "%", !q.failures.some(f => f.startsWith("density")))} ${t("geometry", fmt(q.geometry_similarity, 2), q.geometry_similarity >= 0.5)} ${t("vertical", fmt(q.vertical_drift_deg, 2) + "°", q.vertical_drift_deg <= 1)} ${t("exposure", (q.luminance_drift * 100).toFixed(1) + "%", q.luminance_drift <= 0.06)} ${t("hue", fmt(q.hue_drift_deg, 1) + "°", q.hue_drift_deg <= 8)} ${q.text_suspect ? '<span class="tag bad">text?</span>' : ""}
    <div class="muted">regions sky ${fmt(q.regions.sky, 2)} · mid ${fmt(q.regions.mid, 2)} · ground ${fmt(q.regions.ground, 2)} · edges ${fmt(q.regions.edges, 2)}</div>`;
}
function rClips() {
  const clips = P.clips || [];
  const latest = {}; clips.forEach(c => { if (!latest[c.shot_n] || c.attempt >= latest[c.shot_n].attempt) latest[c.shot_n] = c; });
  const rows = (P.plan.shots || []).map(sh => { const c = latest[sh.n]; const attempts = clips.filter(x => x.shot_n === sh.n).length; if (!c) return `<tr><td>${sh.n}</td><td colspan="5" class="muted">not generated</td></tr>`; return `
    <tr class="${c.status}"><td>${sh.n}<br><span class="muted">${sh.cls} · ${esc(sh.season)} ${esc(sh.time)} · ${sh.scale}</span><br><span class="tag">attempt ${c.attempt}</span></td>
      <td style="width:220px"><video src="${file(c.path)}" poster="${file(c.thumb)}" controls muted loop style="width:100%;border-radius:6px"></video></td>
      <td>${c.qc.passed ? '<span class="tag ok">QC pass</span>' : `<span class="tag bad">QC fail</span> ${c.qc.failures.map(f => `<span class="tag bad">${esc(f)}</span>`).join(" ")}`}<br>${qcCell(c.qc)}<div class="muted" style="margin-top:4px">${esc(c.qc.interpretation)}</div>${c.note ? `<div class="warn-list" style="list-style:none;padding:0">${esc(c.note)}</div>` : ""}</td>
      <td><span class="tag ${c.status === "approved" ? "ok" : c.status === "cut" ? "bad" : ""}">${c.status}</span></td>
      <td><div class="row" style="gap:6px"><button class="btn small" data-approve="${c.id}" ${c.status === "approved" ? "disabled" : ""}>approve</button><button class="btn small danger" data-cut="${c.id}">cut</button></div>
        <div class="row" style="gap:6px;margin-top:6px"><select data-mode="${sh.n}" style="font-size:12px"><option value="camera_softer">regenerate: softer camera</option><option value="lighter_cues">regenerate: lighter cues (new still)</option><option value="dry">regenerate: dry re-shoot (new still)</option><option value="notes">regenerate with notes</option></select><input data-note="${sh.n}" placeholder="notes" style="width:120px"><button class="btn small secondary" data-regen="${sh.n}">go</button></div>
        <div class="muted">${attempts} attempt${attempts === 1 ? "" : "s"}; after ${health.max_attempts || 2} the engine recommends a cut or a dry re-shoot</div></td></tr>`; }).join("");
  el("main").innerHTML = `
    <h2>Clips and QC</h2><p class="lead">Every clip is measured before you see it. Fails are named with their cause. Regenerate only what you name, and only with a real change: the camera, the cue weight, or the weather. Never the same prompt again.</p>
    <div class="card"><button class="btn" id="gen">Generate clips for approved stills</button> <span class="muted">video costs about 3.5× an image; the server refuses until every shot has an approved still</span></div>
    <div class="card" style="overflow:auto"><table><tr><th>shot</th><th>clip</th><th>QC</th><th>status</th><th>actions</th></tr>${rows}</table></div>`;
  el("gen").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/clips/generate`, { method: "POST" }); await reload(); }, "generating and measuring clips…");
  el("main").querySelectorAll("[data-approve]").forEach(b => b.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/clips/${b.dataset.approve}/approve`, { method: "POST" }); await reload(); }));
  el("main").querySelectorAll("[data-cut]").forEach(b => b.onclick = () => busy(async () => { await api(`/api/projects/${P.id}/clips/${b.dataset.cut}/cut`, { method: "POST" }); await reload(); }));
  el("main").querySelectorAll("[data-regen]").forEach(b => b.onclick = () => busy(async () => {
    const n = +b.dataset.regen; const mode = el("main").querySelector(`[data-mode="${n}"]`).value; const note = el("main").querySelector(`[data-note="${n}"]`).value;
    const r = await api(`/api/projects/${P.id}/clips/regenerate`, { body: { items: [{ shot_n: n, mode, note }] } });
    if (r.refused.length) modal(`<h3>Refused</h3><p>${esc(r.refused[0].reason)}</p>`);
    await reload();
  }, "regenerating…"));
}

// ------------------------------------------------------------------ 7 sequence
function rSequence() {
  el("main").innerHTML = `<h2>Sequence</h2><p class="lead">A suggested order with its reasoning, then drag freely. The strip shows the light arc; warnings flag three same-scale shots in a row or a continuity break inside a chapter.</p><div class="card"><button class="btn" id="suggest">Suggest order</button></div><div id="seqbody"></div>`;
  el("suggest").onclick = () => busy(async () => { const d = await api(`/api/projects/${P.id}/sequence/suggest`); drawSeq(d); });
  api(`/api/projects/${P.id}/sequence/preview`).then(drawSeq).catch(() => {});
}
function drawSeq(d) {
  if (!d.items || !d.items.length) { el("seqbody").innerHTML = `<p class="muted">No approved clips yet.</p>`; return; }
  el("seqbody").innerHTML = `<div class="card"><div class="muted">${esc(d.rationale)}</div>
    <div class="strip">${d.brightness_strip.map(b => `<div style="background:rgb(${Math.round(40 + b * 215)},${Math.round(40 + b * 200)},${Math.round(40 + b * 170)})" title="${fmt(b)}"></div>`).join("")}</div>
    <div>total ${d.total_duration_s}s · ${d.items.length} clips</div>
    ${d.warnings.length ? `<ul class="warn-list">${d.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    <ul class="seq" id="seq">${d.items.map(it => `<li draggable="true" data-id="${it.id}"><img src="${file(it.thumb)}"><div class="body"><b>#${it.shot_n}</b> ${it.cls} · ch ${it.chapter}<br>${esc(it.season)} ${esc(it.time)} · ${it.scale} · ${it.duration}s</div></li>`).join("")}</ul>
    <div style="margin-top:10px"><button class="btn" id="saveorder">Save order</button> <button class="btn secondary" id="reset">Back to suggested</button></div></div>`;
  const ul = el("seq"); let drag = null;
  ul.querySelectorAll("li").forEach(li => {
    li.ondragstart = () => { drag = li; li.classList.add("dragging"); }; li.ondragend = () => { li.classList.remove("dragging"); drag = null; };
    li.ondragover = e => { e.preventDefault(); if (!drag || drag === li) return; const r = li.getBoundingClientRect(); const before = (e.clientX - r.left) < r.width / 2; ul.insertBefore(drag, before ? li : li.nextSibling); };
  });
  el("saveorder").onclick = () => busy(async () => { const order = [...ul.querySelectorAll("li")].map(l => l.dataset.id); const r = await api(`/api/projects/${P.id}/sequence`, { method: "PUT", body: { order } }); drawSeq(r); toast("order saved"); });
  el("reset").onclick = () => busy(async () => { const r = await api(`/api/projects/${P.id}/sequence`, { method: "PUT", body: { order: d.suggested_order } }); drawSeq(r); });
}

// ------------------------------------------------------------------ 8 branding
function rBranding() {
  const B = P.branding;
  el("main").innerHTML = `<h2>Branding</h2><p class="lead">Title card, practice name, location, stage stamp and the disclaimer that keeps a visualisation from being read as evidence. Upload a logo for the end card, and real ambience beds or a score if you have them; the synthetic bed is a placeholder.</p>
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
      <label class="f">on every frame<select id="b_every"><option value="false" ${!B.disclaimer_every_frame ? "selected" : ""}>title card only</option><option value="true" ${B.disclaimer_every_frame ? "selected" : ""}>every frame</option></select></label>
    </div><div style="margin-top:10px"><button class="btn" id="saveb">Save branding</button></div></div>
    <div class="card"><h3>Assets</h3><div class="row">
      <label class="f">logo (end card)<input type="file" id="logo" accept="image/*"></label>
      <label class="f">exterior ambience bed<input type="file" id="bed_exterior" accept="audio/*"></label>
      <label class="f">interior room tone<input type="file" id="bed_interior" accept="audio/*"></label>
      <label class="f">score (mixed at 32%)<input type="file" id="bed_score" accept="audio/*"></label></div>
      <div class="muted" style="margin-top:8px">uploaded: ${Object.keys(P.audio_beds || {}).join(", ") || "none"}${B.logo_path ? " · logo" : ""}</div></div>`;
  el("saveb").onclick = () => busy(async () => { await api(`/api/projects/${P.id}/branding`, { method: "PUT", body: { title_position: el("b_pos").value, style: el("b_style").value, project_name: el("b_project").value, practice_name: el("b_practice").value, location_line: el("b_loc").value, subtitle: el("b_sub").value, year: el("b_year").value, stage_stamp: el("b_stamp").value, disclaimer: el("b_disc").value, disclaimer_every_frame: el("b_every").value === "true" } }); await reload(); toast("branding saved"); });
  el("logo").onchange = e => busy(async () => { const fd = new FormData(); fd.append("file", e.target.files[0]); await api(`/api/projects/${P.id}/branding/logo`, { body: fd }); await reload(); });
  ["exterior", "interior", "score"].forEach(k => el("bed_" + k).onchange = e => busy(async () => { const fd = new FormData(); fd.append("file", e.target.files[0]); await api(`/api/projects/${P.id}/audio/${k}`, { body: fd }); await reload(); }));
}

// ------------------------------------------------------------------ 9 render
function rRender() {
  const D = P.deliverables; const v = D.verification || {};
  el("main").innerHTML = `<h2>Final render and delivery</h2><p class="lead">Normalise to the target ratio at 30 fps, hard cuts, title cards and stamp, fades, ambience bed at −16 LUFS. Then the film, crop-only variants, the stills pack and the project record.</p>
    <div class="card"><div class="row"><span class="muted">extra crops:</span><div class="chips" id="crops">${["16:9", "9:16", "1:1", "4:5"].filter(a => a !== P.intake.aspect).map(a => `<span class="chip" data-a="${a}">${a}</span>`).join("")}</div><button class="btn" id="go">Render film</button></div></div>
    ${D.film ? `<div class="card"><video src="${file(D.film)}" controls style="width:100%;max-height:60vh;background:#000;border-radius:8px"></video>
      <h3>Verification</h3><div class="kv"><div>Duration</div><div>${v.duration_s}s (expected ${v.expected_duration_s}s)</div><div>Resolution</div><div>${v.width}×${v.height} @ ${v.fps} fps</div><div>Loudness</div><div>${v.integrated_lufs ?? "?"} LUFS · true peak ${v.true_peak_db ?? "?"} dB (target −16 / −1.5)</div><div>Light arc</div><div><div class="strip">${(v.brightness_arc || []).map(b => `<div style="background:rgb(${Math.round(40 + b * 215)},${Math.round(40 + b * 200)},${Math.round(40 + b * 170)})"></div>`).join("")}</div></div></div>
      <h3>Downloads</h3><ul><li><a href="${file(D.film)}" download>Film (${P.intake.aspect})</a></li>${Object.entries(D.crops).map(([a, p]) => `<li><a href="${file(p)}" download>Crop ${a}</a></li>`).join("")}<li><a href="${file(D.stills_pack)}" download>Stills pack (zip with sidecar)</a></li><li><a href="${file(D.record_html)}" target="_blank">Project record (HTML)</a> · <a href="${file(D.record_json)}" download>JSON</a></li></ul></div>` : ""}`;
  el("crops").querySelectorAll(".chip").forEach(c => c.onclick = () => c.classList.toggle("on"));
  el("go").onclick = () => busy(async () => { const crops = [...el("crops").querySelectorAll(".chip.on")].map(c => c.dataset.a).join(","); await api(`/api/projects/${P.id}/render?crops=${encodeURIComponent(crops)}`, { method: "POST" }); await reload(); }, "rendering… this takes a minute");
}

init();
