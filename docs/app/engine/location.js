/* Location profile and sun-side logic (spec 3.1 and Law 7). A direct port of
   backend/app/services/planning/location.py. The built-in table covers the
   regions a small practice meets most; anything else gets a generic temperate
   profile and a note saying so. */

const SOUTHERN = /australia|sydney|melbourne|brisbane|perth|adelaide|new zealand|auckland|wellington|south africa|cape town|johannesburg|chile|santiago|argentina|buenos aires|brazil|s[aã]o paulo|peru|lima|uruguay|bali|jakarta/i;

const PROFILES = [
  [/san jose|bay area|santa clara|los altos|palo alto|cupertino|saratoga|los gatos|sunnyvale|mountain view|campbell|milpitas|fremont|san francisco|oakland|berkeley|california/i,
    {
      climate: "Mediterranean, dry summers, mild wet winters", elevation: "near sea level to foothills",
      vegetation: "coast live oak, valley oak, olive, citrus, redwood in the hills, drought-tolerant planting",
      snow_months: [], wet_months: ["December", "January", "February", "March"],
      signature: "clear high sun, long dry season with golden hills by July, low winter light, morning fog near the bay",
      blossom: "February to March (cherry, plum, almond)", fog: "summer mornings near the coast, winter tule fog inland",
    }],
  [/himalaya|manali|shimla|mussoorie|nainital|leh|ladakh|darjeeling|gangtok|kasol|dharamshala|uttarakhand|himachal/i,
    {
      climate: "alpine monsoon, cold winters, heavy summer rain", elevation: "1,500 to 3,500 m",
      vegetation: "deodar cedar, blue pine, oak, rhododendron", snow_months: ["December", "January", "February"],
      wet_months: ["July", "August", "September"],
      signature: "slate roofs, terraced slopes, cloud sitting in the valley, blue-grey wet stone",
      blossom: "March to April (rhododendron)", fog: "monsoon valley cloud, winter morning mist",
    }],
  [/india|mumbai|delhi|bangalore|bengaluru|pune|goa|kerala|chennai|hyderabad|kolkata|gurgaon|noida|jaipur/i,
    {
      climate: "tropical to sub-tropical, monsoon", elevation: "lowland to plateau",
      vegetation: "rain tree, neem, gulmohar, banyan, coconut on the coast", snow_months: [],
      wet_months: ["June", "July", "August", "September"],
      signature: "strong overhead sun, saturated monsoon greens, warm dust haze before the rains",
      blossom: "April to May (gulmohar, laburnum)", fog: "winter mornings in the north",
    }],
  [/london|england|uk\b|united kingdom|scotland|wales|manchester|edinburgh|bristol/i,
    {
      climate: "maritime temperate, overcast, frequent light rain", elevation: "lowland",
      vegetation: "plane, oak, beech, yew, wet lawns", snow_months: ["January", "February"],
      wet_months: ["October", "November", "December", "January"],
      signature: "soft flat light, wet slate and brick, long dusk in summer",
      blossom: "April (cherry, magnolia)", fog: "autumn and winter mornings",
    }],
  [/japan|tokyo|kyoto|osaka|hokkaido|nagano/i,
    {
      climate: "humid temperate, four clear seasons", elevation: "varies",
      vegetation: "cedar, maple, cherry, bamboo, moss", snow_months: ["December", "January", "February"],
      wet_months: ["June", "July"],
      signature: "warm olive forest light, cherry in spring, red maple in November, deep snow in the north",
      blossom: "late March to early April", fog: "mountain valleys in autumn",
    }],
  [/australia|sydney|melbourne|brisbane|perth|adelaide/i,
    {
      climate: "varies: temperate south, sub-tropical north, hot dry interior", elevation: "varies",
      vegetation: "eucalyptus, banksia, tree fern, grevillea", snow_months: [], wet_months: ["June", "July", "August"],
      signature: "hard bright light, long shadows, sandstone and corrugated steel, harbour or bush setting",
      blossom: "September to October (wattle, jacaranda in November)", fog: "rare, winter valleys",
    }],
  [/dubai|abu dhabi|uae|qatar|doha|riyadh|saudi/i,
    {
      climate: "hot desert, negligible rain", elevation: "sea level", vegetation: "date palm, ghaf, irrigated lawn",
      snow_months: [], wet_months: [],
      signature: "heat haze, pale sky, strong reflections, dramatic sunsets over sand",
      blossom: "", fog: "winter morning fog",
    }],
];

const GENERIC = {
  climate: "temperate (assumed: location not in the built-in table)", elevation: "unknown",
  vegetation: "deciduous and evergreen mix", snow_months: ["January", "February"],
  wet_months: ["October", "November", "March"], signature: "", blossom: "April", fog: "autumn mornings",
};

const SEASON_MONTHS_NH = {
  spring: ["March", "April", "May"], summer: ["June", "July", "August"],
  autumn: ["September", "October", "November"], winter: ["December", "January", "February"],
  monsoon: ["July", "August", "September"],
};

export const SEASON_ORDER = ["spring", "summer", "monsoon", "autumn", "winter"];
export const TIME_SLOTS = ["dawn", "morning", "midday", "afternoon", "golden_hour", "dusk", "night"];
export const KELVIN = { dawn: 3800, morning: 4800, midday: 5600, afternoon: 5200, golden_hour: 3200, dusk: 4200, night: 2700 };
const COMPASS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const ALL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function shift(months, k) {
  return months.map((m) => ALL_MONTHS[(ALL_MONTHS.indexOf(m) + k) % 12]);
}

export function profile(location) {
  const loc = location || "";
  const hemi = SOUTHERN.test(loc) ? "southern" : "northern";
  let data = Object.assign({}, GENERIC);
  let researched = false;
  for (const [rx, prof] of PROFILES) {
    if (rx.test(loc)) { data = Object.assign({}, prof); researched = true; break; }
  }
  const months = {};
  for (const [season, ms] of Object.entries(SEASON_MONTHS_NH)) months[season] = hemi === "northern" ? ms.slice() : shift(ms, 6);
  if (data.wet_months && data.wet_months.length) months.monsoon = data.wet_months.slice(0, 3);
  return Object.assign(data, {
    location: loc, hemisphere: hemi, season_months: months,
    sun_path: `Sun rises roughly east and sets roughly west. Midday sun sits to the ${hemi === "northern" ? "south" : "north"}, high in summer and low in winter.`,
    source: researched ? "built-in table" : "generic fallback; confirm with local research",
  });
}

/** Where the sun sits relative to the camera for a time slot. Approximate by
    design (Law 7). Returns a phrase usable in a prompt. */
export function sunSide(cameraFaces, time, hemisphere = "northern") {
  if (time === "night") return "no sun; moonlight and artificial light";
  const key = (cameraFaces || "").toUpperCase();
  if (!key || !(key in COMPASS)) return "camera-left (assumed: orientation not stated)";
  const cam = COMPASS[key];
  let sun;
  if (time === "dawn" || time === "morning") sun = 90;
  else if (time === "midday") sun = hemisphere === "northern" ? 180 : 0;
  else if (time === "afternoon") sun = hemisphere === "northern" ? 240 : 300;
  else sun = 270;
  const rel = ((sun - cam) % 360 + 360) % 360;
  if (rel <= 50 || rel >= 310) return "behind the building (backlit, glowing edges)";
  if (rel >= 130 && rel <= 230) return "behind the camera (front lit, flat facade)";
  if (rel > 50 && rel < 130) return "camera-right (raking side light)";
  return "camera-left (raking side light)";
}

/** Interiors see the sun through an opening rather than across a facade. */
export function interiorSunSide(side) {
  return side.replace("behind the building", "through the far opening")
             .replace("behind the camera", "through the opening behind camera");
}

/** Weather for a chapter, and whether it carries precipitation (which the QC
    then expects to see as travelling particles). */
export function seasonWeather(season, prof, heavy = false) {
  const snow = !!(prof.snow_months && prof.snow_months.length);
  const table = {
    spring: heavy ? ["light shower clearing, wet ground, blossom drifting", true]
                  : ["clear after a shower, damp ground, blossom", false],
    summer: heavy ? ["brief heat storm, first heavy drops", true]
                  : ["clear, dry, heat haze in the distance", false],
    monsoon: heavy ? ["steady rain, cloud in the valley", true]
                   : ["rain easing, wet surfaces, low cloud", true],
    autumn: heavy ? ["wind and leaf fall, mist in the low ground", false]
                  : ["still, mist lifting, leaves on the ground", false],
    winter: heavy ? (snow ? ["snow falling, snow on every horizontal", true] : ["cold rain, wet dark ground", true])
                  : (snow ? ["settled snow, clear cold sky", false] : ["cold and clear, low sun, frost in shadow", false]),
  };
  return table[season] || ["clear", false];
}
