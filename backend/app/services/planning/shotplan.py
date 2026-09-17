"""Rule-based shot planner (spec Part 3). Deterministic on purpose: the
designer must be able to predict what a change to the intake does to the
plan. An LLM can polish prose; it should not decide the structure."""
from __future__ import annotations

import re

from ... import config
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
        "snow": "a few slow flakes drifting near camera, one wisp of breath-mist",
        "dry": "one or two motion-blurred branch tips, one torn wisp of mist crossing the frame",
        "blossom": "a handful of petals drifting near camera, one branch tip blurred",
        "leaves": "three or four leaves drifting across the foreground, mist in the low ground",
    },
    "interior": {
        "wet": "rain tracks on one pane of glass, sparse; foliage moving outside that window",
        "snow": "snow falling slowly outside one window; steam from one cup",
        "dry": "dust motes drifting in one shaft of sun; a sheer curtain lifting a few centimetres",
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


# ---------------------------------------------------------------- reference

def arc_shape(light_arc: list[float]) -> str:
    """The shape of a reference film's light curve: rising, falling, peak
    (bright in the middle), trough, or flat. The *shape* is structure and is
    matched; the absolute brightness is colour and is not (Part 2 caveat)."""
    if not light_arc or len(light_arc) < 3:
        return "flat"
    n = len(light_arc)
    head = sum(light_arc[: max(1, n // 3)]) / max(1, n // 3)
    mid = sum(light_arc[n // 3: 2 * n // 3]) / max(1, len(light_arc[n // 3: 2 * n // 3]))
    tail = sum(light_arc[-max(1, n // 3):]) / max(1, n // 3)
    span = max(light_arc) - min(light_arc)
    if span < 0.08:
        return "flat"
    if mid > head + 0.05 and mid > tail + 0.05:
        return "peak"
    if mid < head - 0.05 and mid < tail - 0.05:
        return "trough"
    if tail > head + 0.05:
        return "rising"
    if head > tail + 0.05:
        return "falling"
    return "flat"


ARC_SLOTS = {
    "rising": ["dawn", "morning", "midday", "afternoon"],
    "falling": ["afternoon", "golden_hour", "dusk", "night"],
    "peak": ["dawn", "morning", "midday", "afternoon", "golden_hour", "dusk", "night"],
    "trough": ["golden_hour", "dusk", "night", "dawn", "morning"],
    "flat": [],
}


def reference_structure(ra, n: int) -> dict | None:
    """Resample a measured reference film's structure onto n shots: shot
    length, inside/outside rhythm, scale changes and light-arc shape. Nothing
    about its colour or its climate is carried across."""
    if ra is None or not ra.shots:
        return None
    src = ra.shots
    pick = [min(len(src) - 1, int(i * len(src) / max(1, n))) for i in range(n)]
    durations = [max(2.0, min(10.0, round(src[k].duration_s, 1))) for k in pick]
    if ra.mean_shot_length_s:
        fallback = max(2.0, min(10.0, round(ra.mean_shot_length_s, 1)))
        durations = [d if d >= 2.0 else fallback for d in durations]
    return {
        "durations": durations,
        "classes": [src[k].setting for k in pick],
        "scales": [src[k].scale for k in pick],
        "arc": arc_shape(ra.light_arc),
        "mean_shot_length_s": ra.mean_shot_length_s,
    }


# ------------------------------------------------------- interior emphasis

EMPHASIS = {
    "daylight": {
        "times": ["morning", "midday", "afternoon"],
        "cue": "the patch of sunlight on the floor creeps slowly; dust motes drift in one shaft of sun",
        "lights_on": False,
    },
    "night": {
        "times": ["dusk", "night"],
        "cue": "one lamp pools warm light; a single candle or fireplace flame moves; the garden is dark beyond the glass",
        "lights_on": True,
    },
    "seasonal_view": {
        "times": [],          # any time; the view through the opening is the subject
        "cue": "",            # the weather cue already looks through the glazing
        "lights_on": None,
    },
    "lived_in": {
        "times": ["afternoon", "golden_hour"],
        "cue": "steam rises from one cup; a sheer curtain lifts a few centimetres and settles",
        "lights_on": None,
    },
}


def apply_interior_emphasis(shot: Shot, emphasis: str | None, may_move_time: bool,
                            linked: bool = False) -> str | None:
    """Steer an interior shot by the emphasis the designer chose (spec 1.3).
    Returns a note when the shot's time was moved, otherwise None.

    A design intent or a reference light arc outranks this, so the caller
    decides whether the time may move. On a shot linked to an exterior, the
    weather seen through the glazing is not negotiable, so the emphasis adds
    its room element beside that instead of replacing it.
    """
    rule = EMPHASIS.get(emphasis or "")
    if not rule or shot.cls != "interior":
        return None
    moved = False
    if rule["cue"]:
        if linked:
            through_glass = shot.motion.split(";")[0].strip()
            in_room = rule["cue"].split(";")[0].strip()
            shot.motion = f"{through_glass}; {in_room}"
        else:
            shot.motion = rule["cue"]
    note = None
    if may_move_time and rule["times"] and shot.time not in rule["times"]:
        old = shot.time
        shot.time = rule["times"][shot.n % len(rule["times"])]
        shot.state.time = shot.time
        if shot.state.lights_on is False and shot.time in ("dusk", "night"):
            shot.state.lights_on = True
        note = f"Shot {shot.n}: interior time moved from {old} to {shot.time} by the '{emphasis}' emphasis."
        moved = True
    # Only apply the emphasis's lighting when its time actually holds. Forcing
    # "lights off" onto a shot pinned to night by a design intent produces a
    # night interior lit by nothing.
    if rule["lights_on"] is not None and (moved or shot.time in (rule["times"] or [shot.time])):
        shot.state.lights_on = bool(rule["lights_on"])
    if shot.time in ("dusk", "night"):
        shot.state.lights_on = True
    return note


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

    ref = reference_structure(p.reference, n) if intake.route == "reference" else None
    ref_drives_time = False
    if intake.route == "reference" and ref is None:
        warnings.append("Reference route chosen but no reference film has been analysed; using the brief rules instead.")
    # A reference that never goes inside (or never comes out) cannot supply an
    # inside/outside rhythm for a project that has both. Following it literally
    # would strand a whole class of the designer's renders, so keep the
    # reference's lengths, scales and light arc, and let the house beats decide
    # exterior against interior.
    use_ref_classes = bool(ref)
    if ref and both and len(set(ref["classes"])) == 1:
        only = set(ref["classes"]).pop()
        warnings.append(f"The reference film reads as {only} throughout, so it cannot supply an inside/outside "
                        f"rhythm for a project with both. Its shot lengths, scales and light arc are still used; "
                        f"exterior and interior follow the house beats.")
        use_ref_classes = False

    seasons = [s for s in L.SEASON_ORDER if s in intake.seasons] or ["summer"]
    if "monsoon" in seasons and not prof.get("wet_months"):
        warnings.append("Monsoon chosen but the location profile has no wet season; the chapter will read as generic rain.")
    slots = _time_slots(intake)
    if ref and intake.time_arc == "dawn_to_night":
        arc_slots = ARC_SLOTS.get(ref["arc"] or "flat", [])
        if arc_slots:
            slots = arc_slots
            ref_drives_time = True
    elif ref and ref["arc"] not in ("flat", ""):
        warnings.append(f"The reference's light curve is {ref['arc']}, but the time arc is pinned to "
                        f"'{intake.time_arc}'; the pinned choice wins.")

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

    shot_seconds = float(config.CLIP_SECONDS)
    if ref and ref["mean_shot_length_s"]:
        warnings.append(f"Shot lengths follow the reference (mean {ref['mean_shot_length_s']}s per shot).")

    shots: list[Shot] = []
    counters = {"exterior": 0, "interior": 0}
    idx = 0
    total = sum(per)
    beats_all = _beats(total, both)
    intents = list(intake.design_intents)
    used_intents: set[int] = set()
    # When the film is chaptered by time (a single season), an intent that names
    # a time belongs in the chapter that already holds it, rather than fighting
    # that chapter's fixed time.
    intent_chapter: dict[int, int] = {}
    for ii, text in enumerate(intents):
        want = _time_in_text(text or "")
        if not want:
            continue
        for ci_, (_, fixed_t) in enumerate(chapters):
            if fixed_t == want:
                intent_chapter[ii] = ci_
                break
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
            if use_ref_classes:
                cls = ref["classes"][idx]          # match the reference's inside/outside rhythm
            if cls not in classes:
                cls = classes[0]
            # the pyramid decides the scale; the beat label follows it
            scale = scales[j]
            if ref and ref["scales"][idx] in ("wide", "medium", "detail", "macro"):
                scale = ref["scales"][idx]         # match the reference's scale changes
            if beat in ("dwell", "detail"):
                beat = "detail" if scale == "detail" else "dwell"
            hubs = hubs_by_cls[cls]
            hub = None
            if cls == "interior" and shots:
                prev_ext = next((x for x in reversed(shots) if x.cls == "exterior"), None)
                if prev_ext:
                    grp = p.hub(prev_ext.source_hub_id).continuity_group
                    if grp:
                        hub = next((h for h in hubs if h.continuity_group == grp), None)
            if hub is None:
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
                if ii in intent_chapter and intent_chapter[ii] != ci:
                    continue          # this intent waits for its own time chapter
                wants_int = bool(INTERIOR_WORDS.search(text))
                if (wants_int and cls == "interior") or (not wants_int and cls == "exterior"):
                    if scale in ("medium", "detail") or (k == 1):
                        intent = text
                        used_intents.add(ii)
                        want_t = _time_in_text(text)
                        if want_t and want_t != t and (not fixed_time or ii not in intent_chapter):
                            t = want_t
                            lights_on = t in ("dusk", "night", "dawn") or (cls == "interior" and t == "golden_hour")
                            state = ChapterState(season=season, time=t, weather=w, lights_on=lights_on, month=month, precipitation=pr)
                            warnings.append(f"Shot {idx+1}: time set to {t} by the design intent '{text}'.")
                        break
            shots.append(Shot(
                n=idx + 1, cls=cls, chapter=ci + 1, season=season, time=t, scale=scale,
                framing=FRAMING[(cls, scale)], source_hub_id=hub.id,
                motion=CUES[cls][_cue_key(season, w)], human_beat=human, design_intent=intent,
                beat=beat, heavy=heavy, duration=(ref["durations"][idx] if ref else shot_seconds), state=state,
                sun_side=L.sun_side(hub.camera_faces, t, hemi) if cls == "exterior" else
                L.sun_side(hub.camera_faces, t, hemi).replace("behind the building", "through the far opening").replace("behind the camera", "through the opening behind camera"),
            ))
            idx += 1

    linked_ids = _link_continuity(shots, p, hemi, warnings)
    if intake.interior_emphasis and any(s.cls == "interior" for s in shots):
        for sh in shots:
            if sh.cls != "interior":
                continue
            # a design intent, the reference's light arc, or a continuity link
            # all outrank the emphasis on timing; the emphasis still dresses the room
            may_move = not sh.design_intent and not ref_drives_time and sh.n not in linked_ids
            note = apply_interior_emphasis(sh, intake.interior_emphasis, may_move, linked=sh.n in linked_ids)
            if note:
                warnings.append(note)
                hub_for = p.hub(sh.source_hub_id)
                sh.sun_side = L.sun_side(hub_for.camera_faces, sh.time, hemi).replace(
                    "behind the building", "through the far opening").replace(
                    "behind the camera", "through the opening behind camera")
    _break_runs(shots)
    if ref and shots:
        if intake.time_arc == "dawn_to_night" and ARC_SLOTS.get(ref["arc"] or "flat"):
            warnings.append(f"Time arc follows the reference's light curve ({ref['arc']}): "
                            f"{shots[0].time} to {shots[-1].time}.")
    for ii, text in enumerate(intents):
        if ii not in used_intents and shots:
            # attach to the closest unassigned shot of any class
            for s in shots:
                if not s.design_intent:
                    s.design_intent = text
                    used_intents.add(ii)
                    break
    plan = ShotPlan(shots=shots, warnings=warnings, reference_driven=bool(ref))
    plan.warnings += validate(plan, p, reference_driven=bool(ref))
    plan.rationale = _rationale(chapters, both, intake)
    return plan


def _link_continuity(shots: list[Shot], p: Project, hemi: str, warnings: list[str]) -> None:
    """Spec 1.1 and 3.4. An interior render linked to an exterior one looks out
    at that exterior, so it carries the identical world state: same season,
    time, weather and precipitation. Otherwise the window shows rain while the
    room shows sunshine.

    A link binds only inside one chapter. A chapter is a season, and dragging a
    winter interior back to the monsoon chapter to satisfy a link would break
    the bigger arc, so an interior with no partner in its own chapter simply
    keeps that chapter's state.

    Returns the shot numbers that were bound.
    """
    bound: set[int] = set()
    groups = {h.id: h.continuity_group for h in p.hubs}
    linked_groups = {g for g in groups.values() if g}
    seen_ext = {groups.get(x.source_hub_id) for x in shots if x.cls == "exterior"}
    for g in sorted(linked_groups - seen_ext):
        if any(groups.get(x.source_hub_id) == g for x in shots):
            warnings.append(f"Continuity group '{g}' has no exterior shot anywhere in the film, "
                            f"so its interior is not tied to any weather.")
    for i, sh in enumerate(shots):
        grp = groups.get(sh.source_hub_id)
        if sh.cls != "interior" or not grp:
            continue
        partner = next((shots[j] for j in range(i - 1, -1, -1)
                        if shots[j].chapter == sh.chapter and shots[j].cls == "exterior"
                        and groups.get(shots[j].source_hub_id) == grp), None)
        if partner is None:
            partner = next((x for x in shots[i + 1:]
                            if x.chapter == sh.chapter and x.cls == "exterior"
                            and groups.get(x.source_hub_id) == grp), None)
        if partner is None:
            continue
        if (sh.state.time, sh.state.weather) != (partner.state.time, partner.state.weather):
            warnings.append(f"Shot {sh.n} takes its state from shot {partner.n} (continuity group '{grp}'): "
                            f"{partner.state.season} {partner.state.time}, {partner.state.weather}.")
        sh.season, sh.time = partner.state.season, partner.state.time
        sh.state = partner.state.model_copy(deep=True)
        sh.state.lights_on = partner.state.lights_on or sh.time in ("dusk", "night", "dawn")
        sh.motion = CUES["interior"][_cue_key(sh.season, sh.state.weather)]
        hub_for = p.hub(sh.source_hub_id)
        sh.sun_side = L.sun_side(hub_for.camera_faces, sh.time, hemi).replace(
            "behind the building", "through the far opening").replace(
            "behind the camera", "through the opening behind camera")
        bound.add(sh.n)
    return bound


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
    # Repeat: flipping a shot to break one run can complete a new run with the
    # two shots before it, which a single forward pass has already gone past.
    for _ in range(n + 2):
        changed = False
        for i in range(2, n):
            a, b, c = shots[i - 2], shots[i - 1], shots[i]
            if a.scale != b.scale or b.scale != c.scale:
                continue
            for cand in (i - 1, i - 2, i):
                if protected(cand):
                    continue
                t = shots[cand]
                neighbours = {shots[j].scale for j in (cand - 2, cand - 1, cand + 1, cand + 2) if 0 <= j < n}
                pick = next((x for x in ("medium", "detail", "wide") if x != t.scale and x not in neighbours), None)
                if pick is None:
                    pick = "medium" if t.scale != "medium" else "detail"
                t.scale = pick
                t.framing = FRAMING[(t.cls, t.scale)]
                if t.beat in ("dwell", "detail"):
                    t.beat = "detail" if t.scale == "detail" else "dwell"
                changed = True
                break
            if changed:
                break
        if not changed:
            break


def rederive_state(shot: Shot, p: Project) -> None:
    """Recompute everything a shot's season and time imply.

    The plan editor lets a designer change season or time directly. Without
    this, a shot flipped from winter to summer kept the snow weather, the
    winter month, the precipitation flag and the snow motion cue, and those
    are what reach the prompt.
    """
    prof = p.location_profile or L.profile(p.intake.location)
    weather, precip = L.season_weather(shot.season, prof, heavy=shot.heavy)
    months = prof.get("season_months", {}).get(shot.season, [""])
    shot.state.season = shot.season
    shot.state.time = shot.time
    shot.state.weather = weather
    shot.state.precipitation = precip
    shot.state.month = months[len(months) // 2] if months else ""
    shot.state.lights_on = shot.time in ("dusk", "night", "dawn") or (
        shot.cls == "interior" and shot.time == "golden_hour")
    shot.motion = CUES[shot.cls][_cue_key(shot.season, weather)]
    shot.framing = FRAMING[(shot.cls, shot.scale)]
    hub = p.hub(shot.source_hub_id)
    hemi = prof.get("hemisphere", "northern")
    side = L.sun_side(hub.camera_faces, shot.time, hemi)
    shot.sun_side = side if shot.cls == "exterior" else side.replace(
        "behind the building", "through the far opening").replace(
        "behind the camera", "through the opening behind camera")


def validate(plan: ShotPlan, p: Project, reference_driven: bool = False) -> list[str]:
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
                if reference_driven:
                    w.append(f"Chapter {ch} closes on its {chs[-1].scale} shot, following the reference's scale "
                             f"changes rather than the house rule of closing wide.")
                else:
                    w.append(f"Chapter {ch} does not close on its widest shot.")
    if sum(1 for s in shots if s.heavy) > 1:
        w.append("More than one heavy weather beat.")
    groups = {h.id: h.continuity_group for h in p.hubs}
    for i, sh in enumerate(shots):
        grp = groups.get(sh.source_hub_id)
        if sh.cls != "interior" or not grp:
            continue
        partner = next((shots[j] for j in range(i - 1, -1, -1)
                        if shots[j].chapter == sh.chapter and shots[j].cls == "exterior"
                        and groups.get(shots[j].source_hub_id) == grp), None)
        if partner and (sh.state.time, sh.state.weather) != (partner.state.time, partner.state.weather):
            w.append(f"Continuity break: shot {sh.n} is linked to shot {partner.n} but shows "
                     f"{sh.state.time}/{sh.state.weather} against {partner.state.time}/{partner.state.weather}.")
    used_hubs = {s.source_hub_id for s in shots}
    for cls_ in ("exterior", "interior"):
        owned = [h for h in p.hubs if h.cls == cls_]
        if owned and not any(h.id in used_hubs for h in owned):
            w.append(f"No shot uses any of the {len(owned)} {cls_} render(s) you uploaded.")
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
