/* Prompt builders for stills (Appendix A / A2) and motion (Part 7). A direct
   port of backend/app/services/planning/prompts.py. Written as flowing
   sentences. Materials and elements come from the designer's own words on each
   hub render; never invent a material name. */

import * as L from "./location.js";

const NEGATIVE = {
  exterior: "static rain, frozen streaks, rain overlay that does not move, painted lines, warping walls, " +
    "extra floors, changing window layout, changing roof shape, morphing architecture, added staircase, " +
    "added wall, changing road alignment, fast camera movement, extra people, faces turning to camera, " +
    "distorted faces, text, watermark",
  interior: "warping walls, bending ceiling, leaning verticals, moving furniture, changing joinery, extra doors, " +
    "extra windows, changing floor pattern, morphing fixtures, flickering lights, smoke filling the room, " +
    "fast camera movement, extra people, faces turning to camera, distorted faces, text, watermark",
};

const PEOPLE_COLOURS = ["charcoal", "oatmeal", "camel", "deep green", "cream"];
const MOOD_WORDS = {
  serene: "serene, still, quiet", moody: "moody, atmospheric, low contrast",
  warm: "warm, lived-in, soft", bold: "bold, dramatic, high contrast",
};
const TIME_WORDS = {
  dawn: "first light, sky pale, long soft shadows", morning: "clear morning light, crisp shadows",
  midday: "high sun, short hard shadows", afternoon: "settled afternoon light",
  golden_hour: "golden hour, low warm sun, long shadows", dusk: "blue hour, cool sky, warm interior glow",
  night: "night, sky deep blue-black, warm interior light behind glass",
};

function peopleLine(p, shot) {
  if (p.intake.people === "none" || shot.human_beat === "none" || p.intake.end_use === "planning_consultation") return "No people.";
  const colour = PEOPLE_COLOURS[shot.n % PEOPLE_COLOURS.length];
  if (shot.human_beat.startsWith("hands")) {
    // human_beat is free text in the plan editor, so the colon is optional
    const detail = shot.human_beat.includes(":") ? shot.human_beat.split(":").slice(1).join(":").trim() : shot.human_beat.trim();
    return `Add exactly ONE person as a close-up of hands only: ${detail}, muted ${colour} knit sleeve, no face.`;
  }
  const where = shot.cls === "exterior" ? "at the threshold" : "seated, facing the view";
  const who = shot.human_beat.includes(":") ? shot.human_beat.split(":").slice(1).join(":").trim() : "one figure";
  return `Add exactly ONE person: ${who}, small in the frame, ${where}, seen entirely from behind, face not visible, ` +
    `muted ${colour} wool, not touching the joinery.`;
}

const profOf = (p) => ((p.location_profile && p.location_profile.location !== undefined) ? p.location_profile : L.profile(p.intake.location));

export function stillPrompt(p, shot, hub, corrections = "") {
  const prof = profOf(p);
  const st = shot.state;
  const k = L.KELVIN[st.time] || 5000;
  const loc = p.intake.location || "the site";
  const local = prof.signature || "";
  const materials = (hub.materials || "").trim() || "the materials exactly as rendered";
  const elements = (hub.elements || "").trim() || "every level, opening, canopy, wall, tree and road exactly as rendered";
  let cues = shot.motion;
  if (p.intake.mood === "serene" && shot.cls === "exterior") cues = cues.split(",")[0] + ", nothing else moving";
  const people = peopleLine(p, shot);
  const lights = st.lights_on ? "on" : "off";
  // the project type, when stated, names what the model is looking at; it is
  // one word in the first sentence and never a licence to redesign
  const kind = (p.intake.project_type || "").replace(/_/g, " ").trim();
  let txt;
  if (shot.cls === "exterior") {
    txt =
      `Take the attached original architectural render${kind ? " of a " + kind : ""} and change ONLY the season, weather and lighting. ` +
      "Keep the identical camera, the identical framing of the building, and the identical site layout. " +
      "This is a season change, not a redesign.\n\n" +
      `The building must stay exactly where it is in the frame and exactly as built: ${elements}. ` +
      `Materials, by name: ${materials}.\n\n` +
      "Do NOT add a terrace wall, retaining wall, plinth, staircase, steps, ramp, path, hedge or planting bed " +
      "that is not in the reference. Do NOT move the road or change its alignment. Do NOT move or rearrange " +
      "the trees. Do NOT change the building geometry, materials, window or door layout, roof or proportions. " +
      "Do NOT extend the canvas.\n\n" +
      `Change to ${st.season} near ${loc}, ${st.month}. ${TIME_WORDS[st.time] || ""}, sun ${shot.sun_side}, ` +
      `about ${k}K. Weather: ${st.weather}. Vegetation: ${prof.vegetation || ""} in its ${st.season} state. ` +
      `${local ? local + "." : ""} Interior lights ${lights}.\n\n` +
      `Motion cues, light only: ${cues}.\n\n` +
      `${people}\n\n` +
      "No bright coloured clothing. No crowd. No text. No composite grid, single image only. " +
      "Photoreal, natural colour grade, verticals true.";
  } else {
    const through = st.time !== "night" ? st.weather : "darkness with the garden faintly lit";
    txt =
      `Take the attached original interior render${kind ? " of a " + kind : ""} and change ONLY the light, the time of day, the weather and ` +
      "season visible through the openings, and the state of the artificial lighting. Keep the identical camera, " +
      "the identical framing of the room, and the identical layout. This is a lighting change, not a redesign.\n\n" +
      `The room must stay exactly as designed: ${elements}. Finishes and fittings, by name: ${materials}.\n\n` +
      "Do NOT move walls, doors, windows, joinery, furniture or fixtures. Do NOT add or remove any object. " +
      "Do NOT change any finish, colour or grain direction. Do NOT change the floor pattern. Do NOT extend " +
      "the canvas. Verticals stay true.\n\n" +
      `Change to ${st.time.replace("_", " ")} in ${st.season}, ${loc}, ${st.month}. ${TIME_WORDS[st.time] || ""}, ` +
      `light entering ${shot.sun_side}, about ${k}K. Artificial lights ${lights}. ` +
      `Through the glazing: ${through}.\n\n` +
      `Motion cues, light only: ${cues}.\n\n` +
      `${people}\n\n` +
      "No bright coloured clothing. No crowd. No text. No composite grid, single image only. " +
      "Photoreal, natural colour grade, wide lens, verticals true.";
  }
  if (corrections.trim()) txt += `\n\nCorrections from the last attempt, treat as hard exclusions: ${corrections.trim()}`;
  return txt;
}

export function motionPrompt(p, shot) {
  const st = shot.state;
  const mood = MOOD_WORDS[p.intake.mood] || "";
  const cues = shot.motion;
  let person = "";
  if (shot.human_beat !== "none" && p.intake.people !== "none") {
    person = shot.human_beat.startsWith("hands")
      ? "Hands move slowly and naturally. "
      : "The person shifts weight slowly, seen from behind, never turning. ";
  }
  let camera = "Camera floats with a slow, barely perceptible handheld drift.";
  if ((shot.beat === "approach" || shot.beat === "return") && shot.scale === "wide") camera = "Camera makes a slow, barely perceptible push in.";
  if (shot.beat === "enter" && shot.cls === "interior") camera = "Camera drifts slowly forward through the doorway, verticals stay true.";
  const cap = st.season.charAt(0).toUpperCase() + st.season.slice(1);
  if (shot.cls === "exterior") {
    let precip = "";
    if (st.precipitation) {
      precip = st.weather.includes("snow")
        ? "Snow falls slowly and continuously, every flake travelling down and out of frame, sparse. "
        : "Rain falls gently and continuously, every drop constantly travelling through the frame and leaving it, " +
          "never holding still, sparse enough that the building stays clearly visible. ";
    }
    return `${cap}, ${st.time.replace("_", " ")}, cinematic live-action footage. ${precip}` +
      `Near camera: ${cues}. Mist drifts slowly and thins. ${person}` +
      `Light: ${st.lights_on ? "warm interior light shimmers faintly behind glass; " : ""}sun ${shot.sun_side}. ` +
      `${camera} Photoreal, film grain, ${mood}.`;
  }
  return `${cap}, ${st.time.replace("_", " ")} inside the room, cinematic live-action footage. ` +
    `Light enters ${shot.sun_side}; the patch of light on the floor creeps very slowly. ` +
    `One soft element moves: ${cues}. ${person}` +
    `${camera} Wide lens, verticals stay true. Photoreal, film grain, ${mood}.`;
}

export const negativePrompt = (cls) => NEGATIVE[cls];

/** The signature frame: the first chapter's golden hour (or the film's single
    time). Used for the hero gate. */
export function heroShot(p, cls) {
  const hub = p.hubs.filter((h) => h.cls === cls)[0];
  const prof = profOf(p);
  const seasons = L.SEASON_ORDER.filter((s) => p.intake.seasons.includes(s));
  const season = seasons.length ? seasons[0] : "summer";
  const t = ["dawn_to_night", "golden_hour"].includes(p.intake.time_arc)
    ? "golden_hour"
    : (p.intake.time_arc === "night" ? "night" : (p.intake.single_time || "afternoon"));
  const months = (prof.season_months && prof.season_months[season]) || [""];
  const [weather, precipitation] = L.seasonWeather(season, prof, false);
  const state = {
    season, time: t, weather, precipitation,
    lights_on: ["golden_hour", "dusk", "night"].includes(t),
    month: months.length ? months[Math.floor(months.length / 2)] : "",
  };
  return {
    n: 0, cls, chapter: 0, season, time: t, scale: "wide", framing: "signature frame",
    source_hub_id: hub.id,
    motion: cls === "exterior" ? "one torn wisp of mist crossing the frame" : "dust motes in one shaft of sun",
    human_beat: "none", design_intent: "", beat: "hero", heavy: false, duration: 5, state,
    sun_side: L.sunSide(hub.camera_faces, t, prof.hemisphere || "northern"), locked: false,
  };
}
