"""Rule-based shot planner (spec Part 3). Deterministic on purpose: the
designer must be able to predict what a change to the intake does to the
plan. An LLM can polish prose; it should not decide the structure."""
from __future__ import annotations

import re

from ...models import ChapterState, HubImage, Intake, Project, Shot, ShotPlan
from . import location as L

INTERIOR_WORDS = re.compile(r"living|kitchen|bed|bath|room|ceiling|joinery|island|stair|hall|light enters|window seat|"
                            r"fireplace|dining|study|interior|inside|corridor|entry hall", re.I)

FRAMING = {
    ("exterior", "wide"): "three-quarter view, whole building with its site, 24mm feel, eye level",
    ("exterior", "medium"): "corner approach, entry and one facade, 35mm feel",
    ("exterior", "detail"): "close on a material junction or an opening, 85mm feel",
    ("exterior", "aerial"): "angled aerial, roof and site",
    ("exterior", "macro"): "macro on a surface: rain on stone, snow on a rail",
    ("interior", "wide"): "interior wide, room in full, 16mm feel, verticals true",
    ("interior", "medium"): "frame view through a doorway into the room, 24mm feel",
    ("interior", "detail"): "close on joinery, a benchtop edge or a window seat, 50mm feel",
    ("interior", "aerial"): "interior wide from the stair or mezzanine",
    ("interior", "macro"): "macro on a finish: grain, stone, fabric",
}

CUES = {
    "exterior": {
        "wet": "a few sparse rain streaks near camera, drips from one eave, three or four rings on the wet ground",
        "snow": "a few slow flakes near camera, one wisp of breath-mist, nothing else moving",
        "dry": "one or two motion-blurred branch tips, one torn wisp of mist crossing the frame",
        "blossom": "a handful of petals drifting near camera, one branch tip blurred",
        "leaves": "three or four leaves drifting across the foreground, mist in the low ground",
    },
    "interior": {
        "wet": "rain tracks on one pane of glass, sparse; foliage moving outside that window",
        "snow": "snow falling slowly outside one window; steam from one cup",
        "dry": "dust motes in one shaft of sun; a sheer curtain lifting a few centimetres",
        "blossom": "foliage moving outside one window; a sheer curtain lifting slightly",
        "leaves": "leaves moving outside one window; one candle or fireplace flame",
    },
}


def _cue_key(season: str, weather: str) -> str:
    if "snow" in weather:
        return "snow"
    if "rain" in weather or "shower" in weather or "drops" in weather:
        return "wet"
    if season == "spring":
        return "blossom"
    if season == "autumn":
        return "leaves"
    return "dry"


TIME_WORDS = [("dawn", "dawn"), ("sunrise", "dawn"), ("morning", "morning"), ("midday", "midday"), ("noon", "midday"),
              ("afternoon", "afternoon"), ("golden", "golden_hour"), ("sunset", "golden_hour"), ("evening", "dusk"),
              ("dusk", "dusk"), ("blue hour", "dusk"), ("night", "night")]


def _time_in_text(text: str) -> str | None:
    tl = text.lower()
    for word, slot in TIME_WORDS:
        if re.search(rf"\b{re.escape(word)}\b", tl):
            return slot
    return None


def _scale_pattern(k: int, first_chapter: bool = False) -> list[str]:
    if k <= 0:
        return []
    if k == 1:
        return ["wide"]
    if k == 2:  # the film opens wide; later two-shot chapters close wide
        return ["wide", "medium"] if first_chapter else ["medium", "wide"]
    body = []
    cyc = ["medium", "detail"]
    for i in range(k - 2):
        body.append(cyc[i % 2])
    return ["wide"] + body + ["wide"]


def _beats(n: int, both: bool) -> list[str]:
    """Film-level beat arc. With both classes: approach, enter, dwell, detail,
    return; interiors take dwell and detail. Chapter boundaries split this
    list, so interiors appear even when chapters are short."""
    if n <= 0:
        return []
    if not both:
        return ["approach"] + ["dwell"] * max(0, n - 2) + (["return"] if n > 1 else [])
    if n == 1:
        return ["approach"]
    if n == 2:
        return ["approach", "dwell"]
    if n == 3:
        return ["approach", "dwell", "return"]
    if n == 4:
        return ["approach", "dwell", "detail", "return"]
    mid = ["enter", "dwell", "detail"]
    out = ["approach"]
    for i in range(n - 2):
        out.append(mid[i] if i < 3 else ["dwell", "detail", "enter"][i % 3])
    out.append("return")
    return out


def _time_slots(intake: Intake) -> list[str]:
    if intake.time_arc == "dawn_to_night":
        return ["dawn", "morning", "midday", "afternoon", "golden_hour", "dusk", "night"]
    if intake.time_arc == "golden_hour":
        return ["golden_hour"]
    if intake.time_arc == "night":
        return ["night"]
    return [intake.single_time or "afternoon"]


def build_plan(p: Project) -> ShotPlan:
    intake = p.intake
    prof = p.location_profile or L.profile(intake.location)
    hemi = prof.get("hemisphere", "northern")
    hubs_by_cls: dict[str, list[HubImage]] = {"exterior": [], "interior": []}
    for h in p.hubs:
        hubs_by_cls[h.cls].append(h)
    classes = [c for c in ("exterior", "interior") if hubs_by_cls[c]]
    if not classes:
        return ShotPlan(warnings=["No renders uploaded."])
    both = len(classes) == 2
    n = max(1, intake.length_shots)
    warnings: list[str] = []

    seasons = [s for s in L.SEASON_ORDER if s in intake.seasons] or ["summer"]
    if "monsoon" in seasons and not prof.get("wet_months"):
        warnings.append("Monsoon chosen but the location profile has no wet season; the chapter will read as generic rain.")
    slots = _time_slots(intake)

    # chapters: seasons in calendar order; a single season is chaptered by time
    if len(seasons) > 1:
        chapters = [(s, None) for s in seasons]
    else:
        chapters = [(seasons[0], t) for t in slots[:min(len(slots), 4)]] if len(slots) > 1 else [(seasons[0], slots[0])]
        if len(slots) > 1:
            pick = [slots[0], slots[len(slots) // 3], slots[2 * len(slots) // 3], slots[-1]]
            chapters = [(seasons[0], t) for t in dict.fromkeys(pick)]
    n_ch = len(chapters)
    per = [n // n_ch] * n_ch
    for i in range(n % n_ch):
        per[i] += 1
    # drop empty chapters when there are fewer shots than chapters
    chapters = [c for c, k in zip(chapters, per) if k > 0]
    per = [k for k in per if k > 0]

    # one heavy beat: the wettest chapter, its medium shot
    heavy_ch = None
    for pref in ("monsoon", "winter", "spring", "autumn"):
        for i, (s, _) in enumerate(chapters):
            if s == pref:
                heavy_ch = i
                break
        if heavy_ch is not None:
            break

    shots: list[Shot] = []
    counters = {"exterior": 0, "interior": 0}
    idx = 0
    total = sum(per)
    beats_all = _beats(total, both)
    intents = list(intake.design_intents)
    used_intents: set[int] = set()
    for ci, ((season, fixed_time), k) in enumerate(zip(chapters, per)):
        heavy_here = ci == heavy_ch and intake.end_use != "planning_consultation" and intake.mood != "serene"
        weather, precip = L.season_weather(season, prof, heavy=False)
        months = prof.get("season_months", {}).get(season, [""])
        month = months[len(months) // 2] if months else ""
        scales = _scale_pattern(k, first_chapter=(ci == 0))
        for j in range(k):
            # time: fixed for time-chaptered films, else progress across the whole film
            if fixed_time:
                t = fixed_time
            elif len(slots) == 1:
                t = slots[0]
            else:
                t = slots[min(len(slots) - 1, int(idx * len(slots) / max(1, total)))]
            beat = beats_all[idx]
            cls = "interior" if (both and beat in ("dwell", "detail")) else "exterior"
            if cls not in classes:
                cls = classes[0]
            # the pyramid decides the scale; the beat label follows it
            scale = scales[j]
            if beat in ("dwell", "detail"):
                beat = "detail" if scale == "detail" else "dwell"
            hubs = hubs_by_cls[cls]
            hub = hubs[counters[cls] % len(hubs)]
            counters[cls] += 1
            heavy = bool(heavy_here and scale == "medium" and not any(s.heavy for s in shots))
            w, pr = L.season_weather(season, prof, heavy=True) if heavy else (weather, precip)
            lights_on = t in ("dusk", "night", "dawn") or (cls == "interior" and t in ("golden_hour",))
            state = ChapterState(season=season, time=t, weather=w, lights_on=lights_on, month=month, precipitation=pr)
            # human beat at the edges only
            human = "none"
            if intake.people != "none" and intake.end_use != "planning_consultation":
                if idx <= 1 and cls == "exterior" and scale != "detail" and not any(s.human_beat.startswith("arrival") for s in shots):
                    human = "arrival: one figure at the threshold, seen from behind, reading the height of the opening"
                elif idx == max(0, total - 2) and cls == "interior" and scale == "detail":
                    human = "hands: a close-up of hands on the benchtop or holding a cup"
                elif idx == max(0, total - 2) and intake.people == "lifestyle":
                    human = "one pair, seated, facing the view, from behind"
            # design intent mapping; a time word in the intent steers the shot's time
            intent = ""
            for ii, text in enumerate(intents):
                if ii in used_intents:
                    continue
                wants_int = bool(INTERIOR_WORDS.search(text))
                if (wants_int and cls == "interior") or (not wants_int and cls == "exterior"):
                    if scale in ("medium", "detail") or (k == 1):
                        intent = text
                        used_intents.add(ii)
                        want_t = _time_in_text(text)
                        if want_t and want_t != t and not fixed_time:
                            t = want_t
                            lights_on = t in ("dusk", "night", "dawn") or (cls == "interior" and t == "golden_hour")
                            state = ChapterState(season=season, time=t, weather=w, lights_on=lights_on, month=month, precipitation=pr)
                            warnings.append(f"Shot {idx+1}: time set to {t} by the design intent '{text}'.")
                        break
            shots.append(Shot(
                n=idx + 1, cls=cls, chapter=ci + 1, season=season, time=t, scale=scale,
                framing=FRAMING[(cls, scale)], source_hub_id=hub.id,
                motion=CUES[cls][_cue_key(season, w)], human_beat=human, design_intent=intent,
                beat=beat, heavy=heavy, state=state,
                sun_side=L.sun_side(hub.camera_faces, t, hemi) if cls == "exterior" else
                L.sun_side(hub.camera_faces, t, hemi).replace("behind the building", "through the far opening").replace("behind the camera", "through the opening behind camera"),
            ))
            idx += 1

    _break_runs(shots)
    for ii, text in enumerate(intents):
        if ii not in used_intents and shots:
            # attach to the closest unassigned shot of any class
            for s in shots:
                if not s.design_intent:
                    s.design_intent = text
                    used_intents.add(ii)
                    break
    plan = ShotPlan(shots=shots, warnings=warnings)
    plan.warnings += validate(plan, p)
    plan.rationale = _rationale(chapters, both, intake)
    return plan


def _break_runs(shots: list[Shot]) -> None:
    """Never three of the same scale in a row (Part 3.3). Changes the shot
    that costs least: not a multi-shot chapter closer, not the film's first
    or last shot."""
    n = len(shots)
    sizes: dict[int, int] = {}
    for s in shots:
        sizes[s.chapter] = sizes.get(s.chapter, 0) + 1
    def protected(i: int) -> bool:
        s = shots[i]
        is_closer = sizes[s.chapter] > 1 and (i == n - 1 or shots[i + 1].chapter != s.chapter)
        return i == 0 or i == n - 1 or is_closer
    for i in range(2, n):
        a, b, c = shots[i - 2], shots[i - 1], shots[i]
        if a.scale == b.scale == c.scale:
            for cand in (i - 1, i - 2, i):
                if not protected(cand):
                    t = shots[cand]
                    t.scale = "medium" if t.scale != "medium" else "detail"
                    t.framing = FRAMING[(t.cls, t.scale)]
                    if t.beat in ("dwell", "detail"):
                        t.beat = "detail" if t.scale == "detail" else "dwell"
                    break


def validate(plan: ShotPlan, p: Project) -> list[str]:
    w: list[str] = []
    shots = plan.shots
    for i in range(2, len(shots)):
        if shots[i].scale == shots[i - 1].scale == shots[i - 2].scale:
            w.append(f"Shots {shots[i-2].n}-{shots[i].n} are three of the same scale in a row.")
    if any(h.cls == "exterior" and not h.camera_faces for h in p.hubs):
        w.append("Orientation not stated for at least one exterior render; sun side is assumed camera-left.")
    for i, s in enumerate(shots):
        try:
            hub = p.hub(s.source_hub_id)
        except KeyError:
            w.append(f"Shot {s.n} points at a missing render."); continue
        if hub.cls != s.cls:
            w.append(f"Shot {s.n} is {s.cls} but its source render is {hub.cls}.")
        if i and s.chapter == shots[i - 1].chapter and s.state.weather != shots[i - 1].state.weather and not (s.heavy or shots[i - 1].heavy):
            w.append(f"Shots {shots[i-1].n} and {s.n} share a chapter but not a weather state.")
    if shots and shots[0].scale not in ("wide", "aerial"):
        w.append("The film does not open on its widest shot.")
    if len({s.chapter for s in shots}) > 1:
        for ch in sorted({s.chapter for s in shots}):
            chs = [s for s in shots if s.chapter == ch]
            if ch == 1 and len(chs) == 2:
                continue  # opening wide wins over closing wide in a two-shot first chapter
            if len(chs) > 1 and chs[-1].scale not in ("wide", "aerial"):
                w.append(f"Chapter {ch} does not close on its widest shot.")
    if sum(1 for s in shots if s.heavy) > 1:
        w.append("More than one heavy weather beat.")
    unassigned = [t for t in p.intake.design_intents if t and t not in {s.design_intent for s in shots}]
    if unassigned:
        w.append("Design intents without a shot: " + "; ".join(unassigned))
    return w


def _rationale(chapters, both: bool, intake: Intake) -> str:
    parts = []
    if len(chapters) > 1 and chapters[0][1] is None:
        parts.append("Seasons run in calendar order for the site's hemisphere")
    elif len(chapters) > 1:
        parts.append("One season, chaptered dawn to night")
    else:
        parts.append("Single chapter")
    parts.append("scale pyramid inside each chapter, closing on the widest shot")
    if both:
        parts.append("approach, enter, dwell, detail, return across exterior and interior")
    if intake.people != "none":
        parts.append("human beats kept to the edges")
    return "; ".join(parts) + "."
