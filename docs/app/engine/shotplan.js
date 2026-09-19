/* Rule-based shot planner (spec Part 3). A direct port of
   backend/app/services/planning/shotplan.py, deterministic on purpose: the
   designer must be able to predict what a change to the intake does to the
   plan. An LLM can polish prose; it should not decide the structure. */

import * as L from "./location.js";

const INTERIOR_WORDS = /living|kitchen|bed|bath|room|ceiling|joinery|island|stair|hall|light enters|window seat|fireplace|dining|study|interior|inside|corridor|entry hall/i;

export const FRAMING = {
  "exterior|wide": "three-quarter view, whole building with its site, 24mm feel, eye level",
  "exterior|medium": "corner approach, entry and one facade, 35mm feel",
  "exterior|detail": "close on a material junction or an opening, 85mm feel",
  "exterior|aerial": "angled aerial, roof and site",
  "exterior|macro": "macro on a surface: rain on stone, snow on a rail",
  "interior|wide": "interior wide, room in full, 16mm feel, verticals true",
  "interior|medium": "frame view through a doorway into the room, 24mm feel",
  "interior|detail": "close on joinery, a benchtop edge or a window seat, 50mm feel",
  "interior|aerial": "interior wide from the stair or mezzanine",
  "interior|macro": "macro on a finish: grain, stone, fabric",
};

export const CUES = {
  exterior: {
    wet: "a few sparse rain streaks near camera, drips from one eave, three or four rings on the wet ground",
    snow: "a few slow flakes drifting near camera, one wisp of breath-mist",
    dry: "one or two motion-blurred branch tips, one torn wisp of mist crossing the frame",
    blossom: "a handful of petals drifting near camera, one branch tip blurred",
    leaves: "three or four leaves drifting across the foreground, mist in the low ground",
  },
  interior: {
    wet: "rain tracks on one pane of glass, sparse; foliage moving outside that window",
    snow: "snow falling slowly outside one window; steam from one cup",
    dry: "dust motes drifting in one shaft of sun; a sheer curtain lifting a few centimetres",
    blossom: "foliage moving outside one window; a sheer curtain lifting slightly",
    leaves: "leaves moving outside one window; one candle or fireplace flame",
  },
};

function cueKey(season, weather) {
  if (weather.includes("snow")) return "snow";
  if (weather.includes("rain") || weather.includes("shower") || weather.includes("drops")) return "wet";
  if (season === "spring") return "blossom";
  if (season === "autumn") return "leaves";
  return "dry";
}

const TIME_WORDS = [["dawn", "dawn"], ["sunrise", "dawn"], ["morning", "morning"], ["midday", "midday"], ["noon", "midday"],
  ["afternoon", "afternoon"], ["golden", "golden_hour"], ["sunset", "golden_hour"], ["evening", "dusk"],
  ["dusk", "dusk"], ["blue hour", "dusk"], ["night", "night"]];

function timeInText(text) {
  const tl = (text || "").toLowerCase();
  for (const [word, slot] of TIME_WORDS) {
    if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(tl)) return slot;
  }
  return null;
}

function scalePattern(k, firstChapter = false) {
  if (k <= 0) return [];
  if (k === 1) return ["wide"];
  if (k === 2) return firstChapter ? ["wide", "medium"] : ["medium", "wide"];
  const body = [], cyc = ["medium", "detail"];
  for (let i = 0; i < k - 2; i++) body.push(cyc[i % 2]);
  return ["wide", ...body, "wide"];
}

/** Film-level beat arc. With both classes: approach, enter, dwell, detail,
    return; interiors take dwell and detail. */
function beats(n, both) {
  if (n <= 0) return [];
  if (!both) {
    const out = ["approach"];
    for (let i = 0; i < Math.max(0, n - 2); i++) out.push("dwell");
    if (n > 1) out.push("return");
    return out;
  }
  if (n === 1) return ["approach"];
  if (n === 2) return ["approach", "dwell"];
  if (n === 3) return ["approach", "dwell", "return"];
  if (n === 4) return ["approach", "dwell", "detail", "return"];
  const mid = ["enter", "dwell", "detail"], out = ["approach"];
  for (let i = 0; i < n - 2; i++) out.push(i < 3 ? mid[i] : ["dwell", "detail", "enter"][i % 3]);
  out.push("return");
  return out;
}

function timeSlots(intake) {
  if (intake.time_arc === "dawn_to_night") return ["dawn", "morning", "midday", "afternoon", "golden_hour", "dusk", "night"];
  if (intake.time_arc === "golden_hour") return ["golden_hour"];
  if (intake.time_arc === "night") return ["night"];
  return [intake.single_time || "afternoon"];
}

// ---------------------------------------------------------------- reference

/** The shape of a reference film's light curve. The shape is structure and is
    matched; the absolute brightness is colour and is not (Part 2 caveat). */
export function arcShape(lightArc) {
  if (!lightArc || lightArc.length < 3) return "flat";
  const n = lightArc.length, third = Math.max(1, Math.floor(n / 3));
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const head = avg(lightArc.slice(0, third));
  const mid = avg(lightArc.slice(Math.floor(n / 3), Math.floor((2 * n) / 3)));
  const tail = avg(lightArc.slice(-third));
  const span = Math.max(...lightArc) - Math.min(...lightArc);
  if (span < 0.08) return "flat";
  if (mid > head + 0.05 && mid > tail + 0.05) return "peak";
  if (mid < head - 0.05 && mid < tail - 0.05) return "trough";
  if (tail > head + 0.05) return "rising";
  if (head > tail + 0.05) return "falling";
  return "flat";
}

const ARC_SLOTS = {
  rising: ["dawn", "morning", "midday", "afternoon"],
  falling: ["afternoon", "golden_hour", "dusk", "night"],
  peak: ["dawn", "morning", "midday", "afternoon", "golden_hour", "dusk", "night"],
  trough: ["golden_hour", "dusk", "night", "dawn", "morning"],
  flat: [],
};

/** Resample a measured reference film's structure onto n shots. Nothing about
    its colour or its climate is carried across. */
export function referenceStructure(ra, n) {
  if (!ra || !ra.shots || !ra.shots.length) return null;
  const src = ra.shots;
  const pick = [];
  for (let i = 0; i < n; i++) pick.push(Math.min(src.length - 1, Math.floor((i * src.length) / Math.max(1, n))));
  let durations = pick.map((k) => Math.max(2, Math.min(10, Math.round(src[k].duration_s * 10) / 10)));
  if (ra.mean_shot_length_s) {
    const fallback = Math.max(2, Math.min(10, Math.round(ra.mean_shot_length_s * 10) / 10));
    durations = durations.map((d) => (d >= 2 ? d : fallback));
  }
  return {
    durations,
    classes: pick.map((k) => src[k].setting),
    scales: pick.map((k) => src[k].scale),
    arc: arcShape(ra.light_arc),
    mean_shot_length_s: ra.mean_shot_length_s,
  };
}

// ------------------------------------------------------- interior emphasis

const EMPHASIS = {
  daylight: {
    times: ["morning", "midday", "afternoon"],
    cue: "the patch of sunlight on the floor creeps slowly; dust motes drift in one shaft of sun",
    lights_on: false,
  },
  night: {
    times: ["dusk", "night"],
    cue: "one lamp pools warm light; a single candle or fireplace flame moves; the garden is dark beyond the glass",
    lights_on: true,
  },
  seasonal_view: { times: [], cue: "", lights_on: null },
  lived_in: {
    times: ["afternoon", "golden_hour"],
    cue: "steam rises from one cup; a sheer curtain lifts a few centimetres and settles",
    lights_on: null,
  },
};

/** Steer an interior shot by the emphasis the designer chose (spec 1.3).
    Returns a note when the shot's time was moved, otherwise null. */
export function applyInteriorEmphasis(shot, emphasis, mayMoveTime, linked = false) {
  const rule = EMPHASIS[emphasis || ""];
  if (!rule || shot.cls !== "interior") return null;
  let moved = false;
  if (rule.cue) {
    if (linked) {
      const throughGlass = shot.motion.split(";")[0].trim();
      const inRoom = rule.cue.split(";")[0].trim();
      shot.motion = `${throughGlass}; ${inRoom}`;
    } else {
      shot.motion = rule.cue;
    }
  }
  let note = null;
  if (mayMoveTime && rule.times.length && !rule.times.includes(shot.time)) {
    const old = shot.time;
    shot.time = rule.times[shot.n % rule.times.length];
    shot.state.time = shot.time;
    if (shot.state.lights_on === false && (shot.time === "dusk" || shot.time === "night")) shot.state.lights_on = true;
    note = `Shot ${shot.n}: interior time moved from ${old} to ${shot.time} by the '${emphasis}' emphasis.`;
    moved = true;
  }
  // Only apply the emphasis's lighting when its time actually holds. Forcing
  // "lights off" onto a shot pinned to night by a design intent produces a
  // night interior lit by nothing.
  if (rule.lights_on !== null && (moved || (rule.times.length ? rule.times : [shot.time]).includes(shot.time))) {
    shot.state.lights_on = !!rule.lights_on;
  }
  if (shot.time === "dusk" || shot.time === "night") shot.state.lights_on = true;
  return note;
}

// ---------------------------------------------------------------- planner

const hubOf = (p, id) => p.hubs.find((h) => h.id === id) || {};

export function buildPlan(p, clipSeconds = 5) {
  const intake = p.intake;
  const prof = (p.location_profile && p.location_profile.location !== undefined) ? p.location_profile : L.profile(intake.location);
  const hemi = prof.hemisphere || "northern";
  const hubsByCls = { exterior: [], interior: [] };
  for (const h of p.hubs) hubsByCls[h.cls].push(h);
  const classes = ["exterior", "interior"].filter((c) => hubsByCls[c].length);
  if (!classes.length) return { approved: false, reference_driven: false, shots: [], warnings: ["No renders uploaded."], rationale: "" };
  const both = classes.length === 2;
  // A whole number, always: an imported project can carry anything, and NaN
  // here used to filter every chapter away and return an empty plan silently.
  const nRaw = Math.round(Number(intake.length_shots));
  const n = Number.isFinite(nRaw) ? Math.max(1, Math.min(30, nRaw)) : 5;
  const warnings = [];

  const ref = intake.route === "reference" ? referenceStructure(p.reference, n) : null;
  let refDrivesTime = false;
  if (intake.route === "reference" && !ref) {
    warnings.push("Reference route chosen but no reference film has been analysed; using the brief rules instead.");
  }
  // A reference that never goes inside (or never comes out) cannot supply an
  // inside/outside rhythm for a project that has both. Keep its lengths,
  // scales and light arc, and let the house beats decide.
  let useRefClasses = !!ref;
  if (ref && both && new Set(ref.classes).size === 1) {
    const only = [...new Set(ref.classes)][0];
    warnings.push(`The reference film reads as ${only} throughout, so it cannot supply an inside/outside rhythm for a project with both. Its shot lengths, scales and light arc are still used; exterior and interior follow the house beats.`);
    useRefClasses = false;
  }

  const seasons = L.SEASON_ORDER.filter((s) => intake.seasons.includes(s));
  const seasonList = seasons.length ? seasons : ["summer"];
  if (seasonList.includes("monsoon") && !(prof.wet_months && prof.wet_months.length)) {
    warnings.push("Monsoon chosen but the location profile has no wet season; the chapter will read as generic rain.");
  }
  let slots = timeSlots(intake);
  if (ref && intake.time_arc === "dawn_to_night") {
    const arcSlots = ARC_SLOTS[ref.arc || "flat"] || [];
    if (arcSlots.length) { slots = arcSlots; refDrivesTime = true; }
  } else if (ref && ref.arc !== "flat" && ref.arc !== "") {
    warnings.push(`The reference's light curve is ${ref.arc}, but the time arc is pinned to '${intake.time_arc}'; the pinned choice wins.`);
  }

  // chapters: seasons in calendar order; a single season is chaptered by time
  let chapters;
  if (seasonList.length > 1) {
    chapters = seasonList.map((s) => [s, null]);
  } else if (slots.length > 1) {
    const pick = [slots[0], slots[Math.floor(slots.length / 3)], slots[Math.floor((2 * slots.length) / 3)], slots[slots.length - 1]];
    chapters = [...new Set(pick)].map((t) => [seasonList[0], t]);
  } else {
    chapters = [[seasonList[0], slots[0]]];
  }
  const nCh = chapters.length;
  let per = new Array(nCh).fill(Math.floor(n / nCh));
  for (let i = 0; i < n % nCh; i++) per[i] += 1;
  // A short film cannot hold every season or every hour, and dropping them
  // quietly is how a designer ends up wondering where winter went.
  const droppedCh = chapters.filter((_, i) => !(per[i] > 0));
  chapters = chapters.filter((_, i) => per[i] > 0);
  per = per.filter((k) => k > 0);
  if (droppedCh.length) {
    const names = [...new Set(droppedCh.map(([se, t]) => (seasonList.length > 1 ? se : String(t || "").replace(/_/g, " "))))];
    warnings.push(`${n} shot${n === 1 ? "" : "s"} is not enough for everything asked for, so ${names.length === 1 ? "one was" : names.length + " were"} left out: ${names.join(", ")}. Add shots, or narrow the brief so the film keeps what matters.`);
  }
  if (n <= 2) {
    warnings.push(`At ${n} shot${n === 1 ? "" : "s"} the scale pyramid, the chapter closer and the closing human beat have nothing to work with: every shot is a wide. It is a clip, not a sequence. Three or more shots is where the planner starts earning its keep.`);
  }

  // one heavy beat: the wettest chapter, its medium shot
  let heavyCh = null;
  for (const pref of ["monsoon", "winter", "spring", "autumn"]) {
    for (let i = 0; i < chapters.length; i++) {
      if (chapters[i][0] === pref) { heavyCh = i; break; }
    }
    if (heavyCh !== null) break;
  }

  if (ref && ref.mean_shot_length_s) {
    warnings.push(`Shot lengths follow the reference (mean ${ref.mean_shot_length_s}s per shot).`);
  }

  const shots = [];
  const counters = { exterior: 0, interior: 0 };
  let idx = 0;
  const total = per.reduce((a, b) => a + b, 0);
  const beatsAll = beats(total, both);
  const intents = (intake.design_intents || []).slice();
  const usedIntents = new Set();
  // When the film is chaptered by time, an intent that names a time belongs in
  // the chapter that already holds it.
  const intentChapter = {};
  intents.forEach((text, ii) => {
    const want = timeInText(text || "");
    if (!want) return;
    for (let ci = 0; ci < chapters.length; ci++) {
      if (chapters[ci][1] === want) { intentChapter[ii] = ci; break; }
    }
  });

  for (let ci = 0; ci < chapters.length; ci++) {
    const [season, fixedTime] = chapters[ci];
    const k = per[ci];
    const heavyHere = ci === heavyCh && intake.end_use !== "planning_consultation" && intake.mood !== "serene";
    const [weather, precip] = L.seasonWeather(season, prof, false);
    const months = (prof.season_months && prof.season_months[season]) || [""];
    const month = months.length ? months[Math.floor(months.length / 2)] : "";
    const scales = scalePattern(k, ci === 0);
    for (let j = 0; j < k; j++) {
      let t;
      if (fixedTime) t = fixedTime;
      else if (slots.length === 1) t = slots[0];
      else t = slots[Math.min(slots.length - 1, Math.floor((idx * slots.length) / Math.max(1, total)))];
      let beat = beatsAll[idx];
      let cls = both && (beat === "dwell" || beat === "detail") ? "interior" : "exterior";
      if (useRefClasses) cls = ref.classes[idx];
      if (!classes.includes(cls)) cls = classes[0];
      let scale = scales[j];
      if (ref && ["wide", "medium", "detail", "macro"].includes(ref.scales[idx])) scale = ref.scales[idx];
      if (beat === "dwell" || beat === "detail") beat = scale === "detail" ? "detail" : "dwell";
      const hubs = hubsByCls[cls];
      let hub = null;
      if (cls === "interior" && shots.length) {
        const prevExt = [...shots].reverse().find((x) => x.cls === "exterior");
        if (prevExt) {
          const grp = hubOf(p, prevExt.source_hub_id).continuity_group;
          if (grp) hub = hubs.find((h) => h.continuity_group === grp) || null;
        }
      }
      if (!hub) hub = hubs[counters[cls] % hubs.length];
      counters[cls] += 1;
      const heavy = !!(heavyHere && scale === "medium" && !shots.some((s) => s.heavy));
      const [w, pr] = heavy ? L.seasonWeather(season, prof, true) : [weather, precip];
      let lightsOn = ["dusk", "night", "dawn"].includes(t) || (cls === "interior" && t === "golden_hour");
      let state = { season, time: t, weather: w, lights_on: lightsOn, month, precipitation: pr };
      // human beat at the edges only
      let human = "none";
      if (intake.people !== "none" && intake.end_use !== "planning_consultation") {
        if (idx <= 1 && cls === "exterior" && scale !== "detail" && !shots.some((s) => s.human_beat.startsWith("arrival"))) {
          human = "arrival: one figure at the threshold, seen from behind, reading the height of the opening";
        } else if (idx === Math.max(0, total - 2) && cls === "interior" && scale === "detail") {
          human = "hands: a close-up of hands on the benchtop or holding a cup";
        } else if (idx === Math.max(0, total - 2) && intake.people === "lifestyle") {
          human = "one pair, seated, facing the view, from behind";
        }
      }
      // design intent mapping; a time word in the intent steers the shot's time
      let intent = "";
      for (let ii = 0; ii < intents.length; ii++) {
        const text = intents[ii];
        if (!text || usedIntents.has(ii)) continue;
        if (ii in intentChapter && intentChapter[ii] !== ci) continue;
        const wantsInt = INTERIOR_WORDS.test(text);
        if ((wantsInt && cls === "interior") || (!wantsInt && cls === "exterior")) {
          if (scale === "medium" || scale === "detail" || k === 1) {
            intent = text;
            usedIntents.add(ii);
            const wantT = timeInText(text);
            if (wantT && wantT !== t && (!fixedTime || !(ii in intentChapter))) {
              t = wantT;
              lightsOn = ["dusk", "night", "dawn"].includes(t) || (cls === "interior" && t === "golden_hour");
              state = { season, time: t, weather: w, lights_on: lightsOn, month, precipitation: pr };
              warnings.push(`Shot ${idx + 1}: time set to ${t} by the design intent '${text}'.`);
            }
            break;
          }
        }
      }
      const rawSide = L.sunSide(hub.camera_faces, t, hemi);
      shots.push({
        n: idx + 1, cls, chapter: ci + 1, season, time: t, scale,
        framing: FRAMING[`${cls}|${scale}`], source_hub_id: hub.id,
        motion: CUES[cls][cueKey(season, w)], human_beat: human, design_intent: intent,
        beat, heavy, duration: ref ? ref.durations[idx] : clipSeconds, state,
        sun_side: cls === "exterior" ? rawSide : L.interiorSunSide(rawSide),
        locked: false,
      });
      idx += 1;
    }
  }

  const linkedIds = linkContinuity(shots, p, hemi, warnings);
  if (intake.interior_emphasis && shots.some((s) => s.cls === "interior")) {
    for (const sh of shots) {
      if (sh.cls !== "interior") continue;
      // a design intent, the reference's light arc, or a continuity link all
      // outrank the emphasis on timing; the emphasis still dresses the room
      const mayMove = !sh.design_intent && !refDrivesTime && !linkedIds.has(sh.n);
      const note = applyInteriorEmphasis(sh, intake.interior_emphasis, mayMove, linkedIds.has(sh.n));
      if (note) {
        warnings.push(note);
        sh.sun_side = L.interiorSunSide(L.sunSide(hubOf(p, sh.source_hub_id).camera_faces, sh.time, hemi));
      }
    }
  }
  breakRuns(shots);
  if (ref && shots.length && intake.time_arc === "dawn_to_night" && (ARC_SLOTS[ref.arc || "flat"] || []).length) {
    warnings.push(`Time arc follows the reference's light curve (${ref.arc}): ${shots[0].time} to ${shots[shots.length - 1].time}.`);
  }
  // A leftover intent still has to land on a shot that can serve it: "the way
  // afternoon light enters the living room" on an exterior wide is an
  // instruction the generator cannot follow and the audit cannot catch.
  intents.forEach((text, ii) => {
    if (usedIntents.has(ii) || !shots.length || !text) return;
    const wantsInterior = INTERIOR_WORDS.test(text);
    const want = wantsInterior ? "interior" : "exterior";
    const free = shots.find((s) => !s.design_intent && s.cls === want);
    // No shot of the right kind: leave it unassigned and let validate() say so,
    // rather than attaching it to a shot that cannot serve it.
    if (free) { free.design_intent = text; usedIntents.add(ii); }
  });
  const plan = { approved: false, reference_driven: !!ref, shots, warnings, rationale: "" };
  plan.warnings = plan.warnings.concat(validate(plan, p, !!ref));
  plan.rationale = rationale(chapters, both, intake);
  return plan;
}

/** Spec 1.1 and 3.4. An interior render linked to an exterior one looks out at
    that exterior, so it carries the identical world state. A link binds only
    inside one chapter: a chapter is a season, and dragging a winter interior
    back to the monsoon chapter to satisfy a link would break the bigger arc.
    Returns the shot numbers that were bound. */
function linkContinuity(shots, p, hemi, warnings) {
  const bound = new Set();
  const groups = {};
  for (const h of p.hubs) groups[h.id] = h.continuity_group;
  const linkedGroups = new Set(Object.values(groups).filter(Boolean));
  const seenExt = new Set(shots.filter((x) => x.cls === "exterior").map((x) => groups[x.source_hub_id]));
  for (const g of [...linkedGroups].filter((g) => !seenExt.has(g)).sort()) {
    if (shots.some((x) => groups[x.source_hub_id] === g)) {
      warnings.push(`Continuity group '${g}' has no exterior shot anywhere in the film, so its interior is not tied to any weather.`);
    }
  }
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i], grp = groups[sh.source_hub_id];
    if (sh.cls !== "interior" || !grp) continue;
    let partner = null;
    for (let j = i - 1; j >= 0; j--) {
      if (shots[j].chapter === sh.chapter && shots[j].cls === "exterior" && groups[shots[j].source_hub_id] === grp) { partner = shots[j]; break; }
    }
    if (!partner) {
      partner = shots.slice(i + 1).find((x) => x.chapter === sh.chapter && x.cls === "exterior" && groups[x.source_hub_id] === grp) || null;
    }
    if (!partner) continue;
    if (sh.state.time !== partner.state.time || sh.state.weather !== partner.state.weather) {
      warnings.push(`Shot ${sh.n} takes its state from shot ${partner.n} (continuity group '${grp}'): ${partner.state.season} ${partner.state.time}, ${partner.state.weather}.`);
    }
    sh.season = partner.state.season;
    sh.time = partner.state.time;
    sh.state = JSON.parse(JSON.stringify(partner.state));
    sh.state.lights_on = partner.state.lights_on || ["dusk", "night", "dawn"].includes(sh.time);
    sh.motion = CUES.interior[cueKey(sh.season, sh.state.weather)];
    sh.sun_side = L.interiorSunSide(L.sunSide(hubOf(p, sh.source_hub_id).camera_faces, sh.time, hemi));
    bound.add(sh.n);
  }
  return bound;
}

/** Never three of the same scale in a row (Part 3.3). Changes the shot that
    costs least: not a multi-shot chapter closer, not the first or last shot. */
function breakRuns(shots) {
  const n = shots.length;
  const sizes = {};
  for (const s of shots) sizes[s.chapter] = (sizes[s.chapter] || 0) + 1;
  const protectedAt = (i) => {
    const s = shots[i];
    const isCloser = sizes[s.chapter] > 1 && (i === n - 1 || shots[i + 1].chapter !== s.chapter);
    return i === 0 || i === n - 1 || isCloser;
  };
  // Repeat: flipping a shot to break one run can complete a new run with the
  // two before it, which a single forward pass has already gone past.
  for (let pass = 0; pass < n + 2; pass++) {
    let changed = false;
    for (let i = 2; i < n; i++) {
      const a = shots[i - 2], b = shots[i - 1], c = shots[i];
      if (a.scale !== b.scale || b.scale !== c.scale) continue;
      for (const cand of [i - 1, i - 2, i]) {
        if (protectedAt(cand)) continue;
        const t = shots[cand];
        const neighbours = new Set([cand - 2, cand - 1, cand + 1, cand + 2].filter((j) => j >= 0 && j < n).map((j) => shots[j].scale));
        let pick = ["medium", "detail", "wide"].find((x) => x !== t.scale && !neighbours.has(x));
        if (!pick) pick = t.scale !== "medium" ? "medium" : "detail";
        t.scale = pick;
        t.framing = FRAMING[`${t.cls}|${t.scale}`];
        if (t.beat === "dwell" || t.beat === "detail") t.beat = t.scale === "detail" ? "detail" : "dwell";
        changed = true;
        break;
      }
      if (changed) break;
    }
    if (!changed) break;
  }
}

/** Recompute everything a shot's season and time imply. The plan editor lets a
    designer change season or time directly; without this a shot flipped from
    winter to summer keeps the snow weather, the winter month, the
    precipitation flag and the snow motion cue, and those reach the prompt. */
export function rederiveState(shot, p) {
  const prof = (p.location_profile && p.location_profile.location !== undefined) ? p.location_profile : L.profile(p.intake.location);
  const [weather, precip] = L.seasonWeather(shot.season, prof, shot.heavy);
  const months = (prof.season_months && prof.season_months[shot.season]) || [""];
  shot.state.season = shot.season;
  shot.state.time = shot.time;
  shot.state.weather = weather;
  shot.state.precipitation = precip;
  shot.state.month = months.length ? months[Math.floor(months.length / 2)] : "";
  shot.state.lights_on = ["dusk", "night", "dawn"].includes(shot.time) || (shot.cls === "interior" && shot.time === "golden_hour");
  shot.motion = CUES[shot.cls][cueKey(shot.season, weather)];
  shot.framing = FRAMING[`${shot.cls}|${shot.scale}`];
  const hub = hubOf(p, shot.source_hub_id);
  const hemi = prof.hemisphere || "northern";
  const side = L.sunSide(hub.camera_faces, shot.time, hemi);
  shot.sun_side = shot.cls === "exterior" ? side : L.interiorSunSide(side);
}

export function validate(plan, p, referenceDriven = false) {
  const w = [];
  const shots = plan.shots;
  for (let i = 2; i < shots.length; i++) {
    if (shots[i].scale === shots[i - 1].scale && shots[i - 1].scale === shots[i - 2].scale) {
      w.push(`Shots ${shots[i - 2].n}-${shots[i].n} are three of the same scale in a row.`);
    }
  }
  if (p.hubs.some((h) => h.cls === "exterior" && !h.camera_faces)) {
    w.push("Orientation not stated for at least one exterior render; sun side is assumed camera-left.");
  }
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const hub = p.hubs.find((h) => h.id === s.source_hub_id);
    if (!hub) { w.push(`Shot ${s.n} points at a missing render.`); continue; }
    if (hub.cls !== s.cls) w.push(`Shot ${s.n} is ${s.cls} but its source render is ${hub.cls}.`);
    if (i && s.chapter === shots[i - 1].chapter && s.state.weather !== shots[i - 1].state.weather && !(s.heavy || shots[i - 1].heavy)) {
      w.push(`Shots ${shots[i - 1].n} and ${s.n} share a chapter but not a weather state.`);
    }
  }
  if (shots.length && !["wide", "aerial"].includes(shots[0].scale)) w.push("The film does not open on its widest shot.");
  const chapterSet = [...new Set(shots.map((s) => s.chapter))].sort((a, b) => a - b);
  if (chapterSet.length > 1) {
    for (const ch of chapterSet) {
      const chs = shots.filter((s) => s.chapter === ch);
      if (ch === 1 && chs.length === 2) continue;   // opening wide wins in a two-shot first chapter
      if (chs.length > 1 && !["wide", "aerial"].includes(chs[chs.length - 1].scale)) {
        w.push(referenceDriven
          ? `Chapter ${ch} closes on its ${chs[chs.length - 1].scale} shot, following the reference's scale changes rather than the house rule of closing wide.`
          : `Chapter ${ch} does not close on its widest shot.`);
      }
    }
  }
  if (shots.filter((s) => s.heavy).length > 1) w.push("More than one heavy weather beat.");
  const groups = {};
  for (const h of p.hubs) groups[h.id] = h.continuity_group;
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i], grp = groups[sh.source_hub_id];
    if (sh.cls !== "interior" || !grp) continue;
    let partner = null;
    for (let j = i - 1; j >= 0; j--) {
      if (shots[j].chapter === sh.chapter && shots[j].cls === "exterior" && groups[shots[j].source_hub_id] === grp) { partner = shots[j]; break; }
    }
    if (partner && (sh.state.time !== partner.state.time || sh.state.weather !== partner.state.weather)) {
      w.push(`Continuity break: shot ${sh.n} is linked to shot ${partner.n} but shows ${sh.state.time}/${sh.state.weather} against ${partner.state.time}/${partner.state.weather}.`);
    }
  }
  const usedHubs = new Set(shots.map((s) => s.source_hub_id));
  for (const cls of ["exterior", "interior"]) {
    const owned = p.hubs.filter((h) => h.cls === cls);
    if (owned.length && !owned.some((h) => usedHubs.has(h.id))) {
      w.push(`No shot uses any of the ${owned.length} ${cls} render(s) you uploaded.`);
    }
  }
  const assigned = new Set(shots.map((s) => s.design_intent));
  const unassigned = (p.intake.design_intents || []).filter((t) => t && !assigned.has(t));
  if (unassigned.length) w.push("Design intents without a shot: " + unassigned.join("; "));
  return w;
}

function rationale(chapters, both, intake) {
  const parts = [];
  if (chapters.length > 1 && chapters[0][1] === null) parts.push("Seasons run in calendar order for the site's hemisphere");
  else if (chapters.length > 1) parts.push("One season, chaptered dawn to night");
  else parts.push("Single chapter");
  parts.push("scale pyramid inside each chapter, closing on the widest shot");
  if (both) parts.push("approach, enter, dwell, detail, return across exterior and interior");
  if (intake.people !== "none") parts.push("human beats kept to the edges");
  return parts.join("; ") + ".";
}
