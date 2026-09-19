/* Drafting the intake brief from an uploaded render.

   The designer who does not know what to type is the case this file exists
   for. What it may and may not do is decided by where each field ends up.

   `label` reaches no prompt; it is UI text. So it can be written outright, and
   a filename like "imgi_290_hampi-bazaar-street-entry-ticket-price.jpg" can be
   cleaned into something readable.

   `materials` is interpolated verbatim into "Materials, by name: …" on every
   prompt, and the empty-field fallback is already the strongest thing that
   could be said: "the materials exactly as rendered". A machine cannot beat
   that from pixels. There is no white balance anywhere in this engine, so warm
   light reads as warm material; a wall in sun and the same wall in shade
   cluster as two colours; and in a street photograph the saturation comes off
   the awnings and the clothes, not the plaster. Worse, the film's whole job is
   to change the light and the season, so pinning a colour measured under one
   light fights the thing being asked for. So nothing here ever writes that
   field. What it does instead is show the colours it measured as evidence,
   under a caption that says what they are, and hand the designer the
   vocabulary as one-tap chips. A word the designer taps is the designer's
   word. A word this file invents would not be.

   `elements` is geometry, which is what the engine protects rather than
   changes, so a measured fact about it is safe — but only a measured one. A
   count is offered only when the openings form a plain regular row, never from
   a screen of battens or a balustrade, and everything else is offered as a
   phrase to tick rather than asserted. */

import * as I from "./imaging.js";

// ------------------------------------------------------------------- label

/* Tokens that are a camera, a stock library or a scraper talking, not a
   building: IMG_4021, DSC00231, imgi_290, 360_F_444219751_ncxNq6Agg622sSD1,
   shutterstock, 1920x1080, a bare hash. */
const JUNK = /^(img|imgi|dsc|dscn|pxl|gopr|screenshot|photo|image|picture|untitled|final|copy|new|download|stock|shutterstock|istock|getty|alamy|adobe|freepik|unsplash|pexels|preview|thumb|thumbnail|large|small|medium|hires|hi|res|scaled|edited|render|jpg|jpeg|png|webp|heic|heif|f|v|no|id)$/i;
const MOSTLY_DIGITS = /^[0-9]+$/;
const CODEY = /^(?=.*[0-9])[a-z0-9]{6,}$/i;          // ncxNq6Agg622sSD1
const DIMENSIONS = /^\d{3,5}x\d{3,5}$/i;
const DATEISH = /^(19|20)\d{6,}$/;

/** A filename turned into something a person would recognise, or nothing.
    The words are used as a caption only. They are never taken as evidence of
    what the building is made of: a file called north-elevation-timber.jpg is
    evidence of what someone typed, not of timber. */
export function labelFromFilename(name) {
  const stem = String(name || "").replace(/\.[^.]+$/, "");
  const words = stem.split(/[\s_\-.+()[\]]+/).filter(Boolean).filter((w) =>
    !JUNK.test(w) && !MOSTLY_DIGITS.test(w) && !DIMENSIONS.test(w) && !DATEISH.test(w) && !CODEY.test(w) && w.length > 1);
  const out = words.join(" ").trim().toLowerCase();
  if (out.length < 3) return "";
  return out.length > 48 ? out.slice(0, 48).replace(/\s\S*$/, "") : out;
}

const TIME_WORD = {
  dawn: "dawn", morning: "morning", midday: "midday", afternoon: "afternoon",
  golden_hour: "golden hour", dusk: "dusk", night: "night", day: "daylight", overcast_day: "overcast",
};

/** The label a render arrives with. The filename first when it says anything,
    otherwise what was actually measured, which is at least true. */
export function draftLabel(filename, detected, cls, n) {
  const fromName = labelFromFilename(filename);
  if (fromName) return fromName;
  const time = TIME_WORD[detected && detected.time_of_day] || "";
  const what = cls === "interior" ? "interior" : "exterior";
  return time ? `${what} ${n} · ${time}` : `${what} ${n}`;
}

// -------------------------------------------------------------- measurement

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx / 255];
}

/* A closed set of plain colour words. None of them is a material: there is no
   "stone", no "sand", no "charcoal", because a colour word that doubles as a
   material is the one that gets mistaken for a finish. These are captions for
   a swatch, and they never enter a prompt. */
function colourWord(h, s, v) {
  const light = v > 0.82 ? "very light" : v > 0.6 ? "light" : v > 0.35 ? "mid" : v > 0.16 ? "dark" : "near-black";
  if (s < 0.10) return v > 0.85 ? "off-white" : `${light} grey`;
  const warm = (h < 70 || h > 330);
  const family = h < 20 || h >= 345 ? "red" : h < 45 ? "orange-brown" : h < 70 ? "yellow"
    : h < 165 ? "green" : h < 200 ? "cyan" : h < 255 ? "blue" : h < 290 ? "violet" : "pink";
  if (s < 0.25) return `${light} ${warm ? "warm" : "cool"} grey`;
  return `${light} ${family}`;
}

/** What the image measurably contains. Evidence for the designer to read, not
    text for a prompt: sky and planting are excluded from the colour clusters
    because both are things the film is about to change. */
export function measureBrief(img, detected) {
  // The working image is already 640 wide and is a plain {data,w,h}, not a
  // canvas, so it is sampled on a stride rather than redrawn.
  const d = img.data, w = img.w, h = img.h;
  const step = Math.max(1, Math.round(w / 96));
  const surface = [];
  let sky = 0, green = 0, n = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = y * w + x, j = i * 4;
    n++;
    const [hu, sa, va] = hsv(d[j], d[j + 1], d[j + 2]);
    const isSky = y < h * 0.5 && ((hu > 175 && hu < 260 && sa > 0.08 && va > 0.45) || (sa < 0.07 && va > 0.88));
    const isGreen = hu > 60 && hu < 165 && sa > 0.18 && va > 0.12;
    if (isSky) { sky++; continue; }
    if (isGreen) { green++; continue; }
    surface.push([d[j], d[j + 1], d[j + 2]]);
  }
  return {
    swatches: cluster(surface, 4),
    sky_share: round3(sky / n),
    planting_share: round3(green / n),
    openings: countOpenings(img),
    measured_under: TIME_WORD[detected && detected.time_of_day] || "the light in this image",
  };
}

function round3(x) { return Math.round(x * 1000) / 1000; }

/** k-means over the surface pixels, reported with the share each colour holds
    so the designer can see which one is the building and which is the car. */
function cluster(pts, k) {
  if (pts.length < 32) return [];
  let cent = [];
  for (let i = 0; i < k; i++) cent.push(pts[Math.floor((i + 0.5) * pts.length / k)].slice());
  const labels = new Int32Array(pts.length);
  for (let iter = 0; iter < 10; iter++) {
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = (pts[i][0] - cent[c][0]) ** 2 + (pts[i][1] - cent[c][1]) ** 2 + (pts[i][2] - cent[c][2]) ** 2;
        if (dd < bd) { bd = dd; best = c; }
      }
      labels[i] = best;
    }
    const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const c = labels[i];
      sum[c][0] += pts[i][0]; sum[c][1] += pts[i][1]; sum[c][2] += pts[i][2]; sum[c][3]++;
    }
    cent = sum.map((s, c) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cent[c]));
  }
  const counts = new Array(k).fill(0);
  for (let i = 0; i < labels.length; i++) counts[labels[i]]++;
  return cent.map((c, i) => ({
    hex: "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""),
    share: round3(counts[i] / pts.length),
    word: colourWord(...hsv(c[0], c[1], c[2])),
  })).filter((s) => s.share >= 0.06).sort((a, b) => b.share - a.share);
}

/** A count of openings, but only from a plain regular row of them. A screen of
    battens, a balustrade or a row of trees all produce many similar blobs, and
    a number offered for those would be a number the designer then has to
    check, which defeats the point. Three to eight, similar in size, sitting on
    a line, evenly spaced, or nothing. */
export function countOpenings(img) {
  const g = I.gray(img), w = img.w, h = img.h;
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  const mean = sum / g.length;
  const mask = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) mask[i] = g[i] < mean * 0.45 ? 1 : 0;
  const { stats } = I.connectedComponents(mask, w, h);
  const frame = w * h;
  const blobs = stats.slice(1).filter((s) => {
    const fill = s.area / (s.w * s.h);
    const rel = s.area / frame;
    return rel > 0.0006 && rel < 0.02 && fill > 0.55 && s.w / s.h > 0.25 && s.w / s.h < 4;
  });
  if (blobs.length < 3 || blobs.length > 8) return { count: null, confident: false };
  const areas = blobs.map((b) => b.area);
  const cv = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) / (m || 1); };
  if (cv(areas) > 0.45) return { count: null, confident: false };
  const cy = blobs.map((b) => b.y + b.h / 2);
  const rows = new Set(cy.map((y) => Math.round(y / (h * 0.12))));
  if (rows.size > 2) return { count: null, confident: false };
  const cx = blobs.map((b) => b.x + b.w / 2).sort((a, b) => a - b);
  const gaps = cx.slice(1).map((x, i) => x - cx[i]);
  if (gaps.length && cv(gaps) > 0.35) return { count: null, confident: false };
  return { count: blobs.length, confident: true, rows: rows.size };
}

// -------------------------------------------------------------- vocabulary

/* The words a small residential practice actually writes, grouped the way a
   finishes schedule is. Tapping one appends it to the field: the designer
   chooses, the engine never chooses for them. Nothing here is inferred from
   the image, because none of it can be. */
export const VOCAB = {
  exterior: [
    ["Walls", ["smooth render", "sand-finish stucco", "board-formed concrete", "face brick", "split-face block", "stone veneer", "cedar siding", "timber battens", "fibre-cement panel", "horizontal lap siding", "stucco with brick base"]],
    ["Roof", ["composition shingle", "standing seam metal", "clay tile", "concrete tile", "flat membrane roof", "metal fascia", "deep eaves"]],
    ["Openings", ["aluminium-framed glazing", "black steel windows", "vinyl windows", "timber-framed windows", "sliding glass doors", "garage door in matching timber", "clear glass balustrade"]],
    ["Ground", ["concrete driveway", "paver driveway", "stone paving", "gravel", "lawn", "drought-tolerant planting", "mature street trees", "timber fence", "low masonry wall"]],
  ],
  interior: [
    ["Floor", ["white oak floor", "engineered timber floor", "polished concrete", "large-format porcelain tile", "natural stone floor", "wool rug"]],
    ["Walls and ceiling", ["painted plasterboard", "lime plaster", "exposed timber ceiling", "timber-lined ceiling", "feature tile wall", "exposed brick"]],
    ["Joinery", ["oak joinery", "painted shaker cabinetry", "flat-panel cabinetry", "full-height joinery", "open timber shelving", "brass hardware", "black hardware"]],
    ["Surfaces and fittings", ["honed stone benchtop", "quartz benchtop", "stainless appliances", "pendant lights", "recessed downlights", "black tapware", "linen curtains"]],
  ],
};

/** The things worth telling the generator not to move. The ones a measurement
    supports arrive already ticked; the rest are there to tick. */
export function elementSuggestions(cls, m) {
  const o = (m && m.openings) || {};
  const list = cls === "interior"
    ? [
      { t: "every opening in its place and at its size", on: true },
      { t: "the joinery run where it is, at its height", on: true },
      { t: "the island and benchtop in position", on: false },
      { t: "the pendants and downlights where they are", on: false },
      { t: "the floor pattern and direction", on: false },
      { t: "the ceiling line and any exposed structure", on: false },
      { t: "the furniture layout", on: false },
    ]
    : [
      { t: "the number and position of every window and door", on: true },
      { t: "the roofline, eaves and chimney", on: true },
      { t: "the entry and any canopy or porch", on: false },
      { t: "the number of levels", on: false },
      { t: "the driveway, paths and paving where they are", on: false },
      { t: "boundary walls, fences and gates", on: false },
      { t: "existing trees and planting in their positions", on: (m && m.planting_share > 0.06) || false },
      { t: "the road and kerb line along the front", on: false },
      { t: "neighbouring buildings at the edges of the frame", on: false },
    ];
  if (o.confident && o.count) {
    list.unshift({ t: `the row of ${o.count} openings across the front, evenly spaced`, on: true, measured: true });
  }
  return list;
}
