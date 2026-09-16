"""Location profile and sun-side logic (spec 3.1 and Law 7).
The built-in table covers the regions a small practice meets most. Anything
else gets a generic temperate profile and a note saying so, and the optional
Claude helper can replace it with a researched one."""
from __future__ import annotations

import re

SOUTHERN = re.compile(r"australia|sydney|melbourne|brisbane|perth|adelaide|new zealand|auckland|wellington|"
                      r"south africa|cape town|johannesburg|chile|santiago|argentina|buenos aires|brazil|"
                      r"s[aã]o paulo|peru|lima|uruguay|bali|jakarta", re.I)

PROFILES = [
    (re.compile(r"san jose|bay area|santa clara|los altos|palo alto|cupertino|saratoga|los gatos|sunnyvale|"
                r"mountain view|campbell|milpitas|fremont|san francisco|oakland|berkeley|california", re.I),
     dict(climate="Mediterranean, dry summers, mild wet winters", elevation="near sea level to foothills",
          vegetation="coast live oak, valley oak, olive, citrus, redwood in the hills, drought-tolerant planting",
          snow_months=[], wet_months=["December", "January", "February", "March"],
          signature="clear high sun, long dry season with golden hills by July, low winter light, morning fog near the bay",
          blossom="February to March (cherry, plum, almond)", fog="summer mornings near the coast, winter tule fog inland")),
    (re.compile(r"himalaya|manali|shimla|mussoorie|nainital|leh|ladakh|darjeeling|gangtok|kasol|dharamshala|uttarakhand|himachal", re.I),
     dict(climate="alpine monsoon, cold winters, heavy summer rain", elevation="1,500 to 3,500 m",
          vegetation="deodar cedar, blue pine, oak, rhododendron", snow_months=["December", "January", "February"],
          wet_months=["July", "August", "September"], signature="slate roofs, terraced slopes, cloud sitting in the valley, blue-grey wet stone",
          blossom="March to April (rhododendron)", fog="monsoon valley cloud, winter morning mist")),
    (re.compile(r"india|mumbai|delhi|bangalore|bengaluru|pune|goa|kerala|chennai|hyderabad|kolkata|gurgaon|noida|jaipur", re.I),
     dict(climate="tropical to sub-tropical, monsoon", elevation="lowland to plateau",
          vegetation="rain tree, neem, gulmohar, banyan, coconut on the coast", snow_months=[],
          wet_months=["June", "July", "August", "September"], signature="strong overhead sun, saturated monsoon greens, warm dust haze before the rains",
          blossom="April to May (gulmohar, laburnum)", fog="winter mornings in the north")),
    (re.compile(r"london|england|uk\b|united kingdom|scotland|wales|manchester|edinburgh|bristol", re.I),
     dict(climate="maritime temperate, overcast, frequent light rain", elevation="lowland",
          vegetation="plane, oak, beech, yew, wet lawns", snow_months=["January", "February"],
          wet_months=["October", "November", "December", "January"], signature="soft flat light, wet slate and brick, long dusk in summer",
          blossom="April (cherry, magnolia)", fog="autumn and winter mornings")),
    (re.compile(r"japan|tokyo|kyoto|osaka|hokkaido|nagano", re.I),
     dict(climate="humid temperate, four clear seasons", elevation="varies",
          vegetation="cedar, maple, cherry, bamboo, moss", snow_months=["December", "January", "February"],
          wet_months=["June", "July"], signature="warm olive forest light, cherry in spring, red maple in November, deep snow in the north",
          blossom="late March to early April", fog="mountain valleys in autumn")),
    (re.compile(r"australia|sydney|melbourne|brisbane|perth|adelaide", re.I),
     dict(climate="varies: temperate south, sub-tropical north, hot dry interior", elevation="varies",
          vegetation="eucalyptus, banksia, tree fern, grevillea", snow_months=[], wet_months=["June", "July", "August"],
          signature="hard bright light, long shadows, sandstone and corrugated steel, harbour or bush setting",
          blossom="September to October (wattle, jacaranda in November)", fog="rare, winter valleys")),
    (re.compile(r"dubai|abu dhabi|uae|qatar|doha|riyadh|saudi", re.I),
     dict(climate="hot desert, negligible rain", elevation="sea level", vegetation="date palm, ghaf, irrigated lawn",
          snow_months=[], wet_months=[], signature="heat haze, pale sky, strong reflections, dramatic sunsets over sand",
          blossom="", fog="winter morning fog")),
]

GENERIC = dict(climate="temperate (assumed: location not in the built-in table)", elevation="unknown",
               vegetation="deciduous and evergreen mix", snow_months=["January", "February"],
               wet_months=["October", "November", "March"], signature="", blossom="April", fog="autumn mornings")

SEASON_MONTHS_NH = {"spring": ["March", "April", "May"], "summer": ["June", "July", "August"],
                    "autumn": ["September", "October", "November"], "winter": ["December", "January", "February"],
                    "monsoon": ["July", "August", "September"]}
SEASON_ORDER = ["spring", "summer", "monsoon", "autumn", "winter"]

TIME_SLOTS = ["dawn", "morning", "midday", "afternoon", "golden_hour", "dusk", "night"]
KELVIN = {"dawn": 3800, "morning": 4800, "midday": 5600, "afternoon": 5200, "golden_hour": 3200, "dusk": 4200, "night": 2700}
COMPASS = {"N": 0, "NE": 45, "E": 90, "SE": 135, "S": 180, "SW": 225, "W": 270, "NW": 315}


def profile(location: str) -> dict:
    loc = location or ""
    hemi = "southern" if SOUTHERN.search(loc) else "northern"
    data = dict(GENERIC)
    researched = False
    for rx, prof in PROFILES:
        if rx.search(loc):
            data = dict(prof)
            researched = True
            break
    months = {}
    for season, ms in SEASON_MONTHS_NH.items():
        months[season] = ms if hemi == "northern" else _shift(ms, 6)
    if data.get("wet_months") and "monsoon" in SEASON_MONTHS_NH:
        months["monsoon"] = data["wet_months"][:3] or months["monsoon"]
    data.update({
        "location": loc, "hemisphere": hemi, "season_months": months,
        "sun_path": (f"Sun rises roughly east and sets roughly west. Midday sun sits to the "
                     f"{'south' if hemi == 'northern' else 'north'}, high in summer and low in winter."),
        "source": "built-in table" if researched else "generic fallback; confirm with local research",
    })
    return data


def _shift(months: list[str], k: int) -> list[str]:
    all_m = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    return [all_m[(all_m.index(m) + k) % 12] for m in months]


def sun_side(camera_faces: str | None, time: str, hemisphere: str = "northern") -> str:
    """Where the sun sits relative to the camera for a time slot. Approximate
    by design (Law 7). Returns a phrase usable in a prompt."""
    if time == "night":
        return "no sun; moonlight and artificial light"
    if not camera_faces or camera_faces.upper() not in COMPASS:
        return "camera-left (assumed: orientation not stated)"
    cam = COMPASS[camera_faces.upper()]
    if time in ("dawn", "morning"):
        sun = 90
    elif time == "midday":
        sun = 180 if hemisphere == "northern" else 0
    elif time == "afternoon":
        sun = 240 if hemisphere == "northern" else 300
    else:  # golden hour, dusk
        sun = 270
    rel = (sun - cam) % 360
    if rel <= 50 or rel >= 310:
        return "behind the building (backlit, glowing edges)"
    if 130 <= rel <= 230:
        return "behind the camera (front lit, flat facade)"
    if 50 < rel < 130:
        return "camera-right (raking side light)"
    return "camera-left (raking side light)"


def season_weather(season: str, prof: dict, heavy: bool = False) -> tuple[str, bool]:
    """Weather description for a chapter and whether it carries precipitation
    (which the QC then expects to see as travelling particles)."""
    snow = bool(prof.get("snow_months"))
    table = {
        "spring": ("light shower clearing, wet ground, blossom drifting", True) if heavy else ("clear after a shower, damp ground, blossom", False),
        "summer": ("brief heat storm, first heavy drops", True) if heavy else ("clear, dry, heat haze in the distance", False),
        "monsoon": ("steady rain, cloud in the valley", True) if heavy else ("rain easing, wet surfaces, low cloud", True),
        "autumn": ("wind and leaf fall, mist in the low ground", False) if heavy else ("still, mist lifting, leaves on the ground", False),
        "winter": (("snow falling, snow on every horizontal", True) if snow else ("cold rain, wet dark ground", True)) if heavy
                  else (("settled snow, clear cold sky", False) if snow else ("cold and clear, low sun, frost in shadow", False)),
    }
    return table.get(season, ("clear", False))
