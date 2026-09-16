"""Prompt builders for stills (Appendix A / A2) and motion (Part 7).
Written as flowing sentences. Materials and elements come from the designer's
own words on each hub render; never invent a material name."""
from __future__ import annotations

from ...models import HubImage, Project, Shot
from . import location as L

NEGATIVE = {
    "exterior": ("static rain, frozen streaks, rain overlay that does not move, painted lines, warping walls, "
                 "extra floors, changing window layout, changing roof shape, morphing architecture, added staircase, "
                 "added wall, changing road alignment, fast camera movement, extra people, faces turning to camera, "
                 "distorted faces, text, watermark"),
    "interior": ("warping walls, bending ceiling, leaning verticals, moving furniture, changing joinery, extra doors, "
                 "extra windows, changing floor pattern, morphing fixtures, flickering lights, smoke filling the room, "
                 "fast camera movement, extra people, faces turning to camera, distorted faces, text, watermark"),
}

PEOPLE_COLOURS = ["charcoal", "oatmeal", "camel", "deep green", "cream"]
MOOD_WORDS = {"serene": "serene, still, quiet", "moody": "moody, atmospheric, low contrast",
              "warm": "warm, lived-in, soft", "bold": "bold, dramatic, high contrast"}
TIME_WORDS = {"dawn": "first light, sky pale, long soft shadows", "morning": "clear morning light, crisp shadows",
              "midday": "high sun, short hard shadows", "afternoon": "settled afternoon light",
              "golden_hour": "golden hour, low warm sun, long shadows", "dusk": "blue hour, cool sky, warm interior glow",
              "night": "night, sky deep blue-black, warm interior light behind glass"}


def _people_line(p: Project, shot: Shot) -> str:
    if p.intake.people == "none" or shot.human_beat == "none" or p.intake.end_use == "planning_consultation":
        return "No people."
    colour = PEOPLE_COLOURS[shot.n % len(PEOPLE_COLOURS)]
    if shot.human_beat.startswith("hands"):
        return (f"Add exactly ONE person as a close-up of hands only: {shot.human_beat.split(':',1)[1].strip()}, "
                f"muted {colour} knit sleeve, no face.")
    where = "at the threshold" if shot.cls == "exterior" else "seated, facing the view"
    return (f"Add exactly ONE person: {shot.human_beat.split(':',1)[1].strip() if ':' in shot.human_beat else 'one figure'}, "
            f"small in the frame, {where}, seen entirely from behind, face not visible, muted {colour} wool, "
            f"not touching the joinery.")


def still_prompt(p: Project, shot: Shot, hub: HubImage, corrections: str = "") -> str:
    prof = p.location_profile or L.profile(p.intake.location)
    st = shot.state
    k = L.KELVIN.get(st.time, 5000)
    loc = p.intake.location or "the site"
    local = prof.get("signature", "")
    materials = hub.materials.strip() or "the materials exactly as rendered"
    elements = hub.elements.strip() or "every level, opening, canopy, wall, tree and road exactly as rendered"
    cues = shot.motion
    if p.intake.mood == "serene" and shot.cls == "exterior":
        cues = cues.split(",")[0] + ", nothing else moving"
    people = _people_line(p, shot)
    lights = "on" if st.lights_on else "off"
    if shot.cls == "exterior":
        txt = (
            "Take the attached original architectural render and change ONLY the season, weather and lighting. "
            "Keep the identical camera, the identical framing of the building, and the identical site layout. "
            "This is a season change, not a redesign.\n\n"
            f"The building must stay exactly where it is in the frame and exactly as built: {elements}. "
            f"Materials, by name: {materials}.\n\n"
            "Do NOT add a terrace wall, retaining wall, plinth, staircase, steps, ramp, path, hedge or planting bed "
            "that is not in the reference. Do NOT move the road or change its alignment. Do NOT move or rearrange "
            "the trees. Do NOT change the building geometry, materials, window or door layout, roof or proportions. "
            "Do NOT extend the canvas.\n\n"
            f"Change to {st.season} near {loc}, {st.month}. {TIME_WORDS.get(st.time, '')}, sun {shot.sun_side}, "
            f"about {k}K. Weather: {st.weather}. Vegetation: {prof.get('vegetation', '')} in its {st.season} state. "
            f"{local + '.' if local else ''} Interior lights {lights}.\n\n"
            f"Motion cues, light only: {cues}.\n\n"
            f"{people}\n\n"
            "No bright coloured clothing. No crowd. No text. No composite grid, single image only. "
            "Photoreal, natural colour grade, verticals true."
        )
    else:
        through = st.weather if st.time != "night" else "darkness with the garden faintly lit"
        txt = (
            "Take the attached original interior render and change ONLY the light, the time of day, the weather and "
            "season visible through the openings, and the state of the artificial lighting. Keep the identical camera, "
            "the identical framing of the room, and the identical layout. This is a lighting change, not a redesign.\n\n"
            f"The room must stay exactly as designed: {elements}. Finishes and fittings, by name: {materials}.\n\n"
            "Do NOT move walls, doors, windows, joinery, furniture or fixtures. Do NOT add or remove any object. "
            "Do NOT change any finish, colour or grain direction. Do NOT change the floor pattern. Do NOT extend "
            "the canvas. Verticals stay true.\n\n"
            f"Change to {st.time.replace('_', ' ')} in {st.season}, {loc}, {st.month}. {TIME_WORDS.get(st.time, '')}, "
            f"light entering {shot.sun_side}, about {k}K. Artificial lights {lights}. "
            f"Through the glazing: {through}.\n\n"
            f"Motion cues, light only: {cues}.\n\n"
            f"{people}\n\n"
            "No bright coloured clothing. No crowd. No text. No composite grid, single image only. "
            "Photoreal, natural colour grade, wide lens, verticals true."
        )
    if corrections.strip():
        txt += f"\n\nCorrections from the last attempt, treat as hard exclusions: {corrections.strip()}"
    return txt


def motion_prompt(p: Project, shot: Shot) -> str:
    st = shot.state
    mood = MOOD_WORDS.get(p.intake.mood, "")
    cues = shot.motion
    person = ""
    if shot.human_beat != "none" and p.intake.people != "none":
        person = ("Hands move slowly and naturally. " if shot.human_beat.startswith("hands")
                  else "The person shifts weight slowly, seen from behind, never turning. ")
    camera = "Camera floats with a slow, barely perceptible handheld drift."
    if shot.beat in ("approach", "return") and shot.scale == "wide":
        camera = "Camera makes a slow, barely perceptible push in."
    if shot.beat == "enter" and shot.cls == "interior":
        camera = "Camera drifts slowly forward through the doorway, verticals stay true."
    if shot.cls == "exterior":
        precip = ""
        if st.precipitation:
            precip = ("Snow falls slowly and continuously, every flake travelling down and out of frame, sparse. " if "snow" in st.weather
                      else "Rain falls gently and continuously, every drop constantly travelling through the frame and leaving it, "
                           "never holding still, sparse enough that the building stays clearly visible. ")
        return (f"{st.season.capitalize()}, {st.time.replace('_', ' ')}, cinematic live-action footage. {precip}"
                f"Near camera: {cues}. Mist drifts slowly and thins. {person}"
                f"Light: {'warm interior light shimmers faintly behind glass; ' if st.lights_on else ''}sun {shot.sun_side}. "
                f"{camera} Photoreal, film grain, {mood}.")
    return (f"{st.season.capitalize()}, {st.time.replace('_', ' ')} inside the room, cinematic live-action footage. "
            f"Light enters {shot.sun_side}; the patch of light on the floor creeps very slowly. "
            f"One soft element moves: {cues}. {person}"
            f"{camera} Wide lens, verticals stay true. Photoreal, film grain, {mood}.")


def negative_prompt(cls: str) -> str:
    return NEGATIVE[cls]


def hero_shot(p: Project, cls: str) -> Shot:
    """The signature frame: the first chapter's golden hour (or the film's single time)."""
    hubs = [h for h in p.hubs if h.cls == cls]
    hub = hubs[0]
    prof = p.location_profile or L.profile(p.intake.location)
    seasons = [s for s in L.SEASON_ORDER if s in p.intake.seasons] or ["summer"]
    season = seasons[0]
    t = "golden_hour" if p.intake.time_arc in ("dawn_to_night", "golden_hour") else ("night" if p.intake.time_arc == "night" else (p.intake.single_time or "afternoon"))
    months = prof.get("season_months", {}).get(season, [""])
    weather, precip = L.season_weather(season, prof)
    st = {"season": season, "time": t, "weather": weather, "precipitation": precip, "lights_on": t in ("golden_hour", "dusk", "night"), "month": months[len(months)//2] if months else ""}
    from ...models import ChapterState
    return Shot(n=0, cls=cls, chapter=0, season=season, time=t, scale="wide",
                framing="signature frame", source_hub_id=hub.id, motion=("one torn wisp of mist crossing the frame" if cls == "exterior" else "dust motes in one shaft of sun"),
                human_beat="none", beat="hero", state=ChapterState(**st),
                sun_side=L.sun_side(hub.camera_faces, t, prof.get("hemisphere", "northern")))
