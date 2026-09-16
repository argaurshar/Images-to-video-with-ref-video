"""End-to-end run of the spec's pipeline on the mock provider."""
import pytest
from tests.conftest import synth_exterior, synth_interior


def test_full_pipeline(client):
    r = client.post("/api/projects", json={"name": "Willow Glen ADU"})
    assert r.status_code == 200
    pid = r.json()["id"]

    r = client.post(f"/api/projects/{pid}/hubs", files=[
        ("files", ("front.png", synth_exterior(), "image/png")),
        ("files", ("living.png", synth_interior(), "image/png")),
    ])
    assert r.status_code == 200, r.text
    hubs = r.json()["added"]
    assert hubs[0]["cls"] == "exterior" and hubs[1]["cls"] == "interior", [h["detected"] for h in hubs]
    ext, inte = hubs[0]["id"], hubs[1]["id"]
    r = client.patch(f"/api/projects/{pid}/hubs/{ext}", json={"camera_faces": "NE", "materials": "smooth stucco, blackened steel, clear cedar soffit"})
    assert r.status_code == 200 and r.json()["camera_faces"] == "NE"
    r = client.patch(f"/api/projects/{pid}/hubs/{inte}", json={"materials": "white oak floor, honed quartz bench, limewash walls"})
    assert r.status_code == 200

    intake = {"route": "brief", "aspect": "16:9", "seasons": ["spring", "winter"], "time_arc": "dawn_to_night",
              "mood": "warm", "people": "scale_figure", "length_shots": 5, "location": "San Jose, California",
              "project_stage": "design_development", "end_use": "client_presentation",
              "design_intents": ["afternoon light in the living room", "the entry canopy against the street", ""],
              "project_name": "Willow Glen ADU", "practice_name": "Studio Test"}
    r = client.put(f"/api/projects/{pid}/intake", json=intake)
    assert r.status_code == 200, r.text
    prof = r.json()["project"]["location_profile"]
    assert prof["hemisphere"] == "northern" and "Mediterranean" in prof["climate"]

    # Law 3 gates: heroes need plan + budget
    assert client.post(f"/api/projects/{pid}/heroes/generate").status_code == 409

    r = client.post(f"/api/projects/{pid}/plan/generate")
    assert r.status_code == 200, r.text
    plan = r.json()
    shots = plan["shots"]
    assert len(shots) == 5
    assert shots[0]["cls"] == "exterior" and shots[-1]["cls"] == "exterior"  # approach ... return
    assert any(s["cls"] == "interior" for s in shots)
    assert [s["season"] for s in shots] == sorted([s["season"] for s in shots], key=["spring", "winter"].index)
    assert all(s["design_intent"] == "" or s["design_intent"] in intake["design_intents"] for s in shots)
    assert {s["design_intent"] for s in shots} >= {"afternoon light in the living room", "the entry canopy against the street"}
    assert not any(shots[i]["scale"] == shots[i-1]["scale"] == shots[i-2]["scale"] for i in range(2, len(shots)))
    assert "camera-" in shots[0]["sun_side"] or "behind" in shots[0]["sun_side"]

    r = client.get(f"/api/projects/{pid}/plan/prompts/1")
    assert "smooth stucco" in r.json()["still"] and "Do NOT extend the canvas" in r.json()["still"]
    assert "static" not in r.json()["motion"].lower()

    # non-uniform shot lengths must survive into the finished film
    edited = [dict(x) for x in shots]
    for x, secs in zip(edited, [3.0, 4.0, 5.0, 4.0, 3.0]):
        x["duration"] = secs
    r = client.put(f"/api/projects/{pid}/plan", json={"shots": edited})
    assert r.status_code == 200, r.text
    assert [x["duration"] for x in r.json()["shots"]] == [3.0, 4.0, 5.0, 4.0, 3.0]

    assert client.post(f"/api/projects/{pid}/plan/approve").status_code == 200
    assert client.post(f"/api/projects/{pid}/heroes/generate").status_code == 409  # budget not confirmed
    b = client.post(f"/api/projects/{pid}/budget/confirm").json()
    assert b["confirmed"] and b["hero_images"] == 4 and b["total"] > 0

    r = client.post(f"/api/projects/{pid}/heroes/generate")
    assert r.status_code == 200, r.text
    heroes = r.json()["heroes"]
    assert len(heroes) == 4 and {h["cls"] for h in heroes} == {"exterior", "interior"}
    assert all(h["audit"]["rating"] in ("pass", "minor", "fail") for h in heroes)
    assert client.post(f"/api/projects/{pid}/stills/generate").status_code == 409  # no hero chosen
    for cls in ("exterior", "interior"):
        h = next(x for x in heroes if x["cls"] == cls)
        client.post(f"/api/projects/{pid}/heroes/{h['id']}/choose")

    r = client.post(f"/api/projects/{pid}/stills/generate")
    assert r.status_code == 200, r.text
    stills = r.json()["stills"]
    assert len(stills) == 5
    assert client.post(f"/api/projects/{pid}/clips/generate").status_code == 409  # Law 3

    # reject one, regenerate only that one
    victim = stills[2]
    client.post(f"/api/projects/{pid}/stills/{victim['id']}/reject", json={"note": "invented a hedge on the left"})
    r = client.post(f"/api/projects/{pid}/stills/regenerate", json={"shot_ns": [victim["shot_n"]]})
    assert r.status_code == 200
    made = r.json()["made"]
    assert len(made) == 1 and made[0]["attempt"] == 2 and "invented a hedge" in made[0]["prompt"]
    r = client.post(f"/api/projects/{pid}/stills/approve_all")
    assert r.json()["approved"] == 5

    r = client.post(f"/api/projects/{pid}/clips/generate")
    assert r.status_code == 200, r.text
    clips = r.json()["clips"]
    assert len(clips) == 5
    for c in clips:
        qc = c["qc"]
        assert qc["ran"] and qc["frames_sampled"] >= c["duration"] * 9   # ~10 fps sampling
        assert qc["motion_score"] > 0 and all(v > 0 for v in qc["regions"].values())
        assert qc["geometry_similarity"] > 0.5, qc
    # attempts limit: two wet attempts then refusal
    n = clips[0]["shot_n"]
    r = client.post(f"/api/projects/{pid}/clips/regenerate", json={"items": [{"shot_n": n, "mode": "camera_softer"}]})
    assert r.status_code == 200 and len(r.json()["made"]) == 1
    r = client.post(f"/api/projects/{pid}/clips/regenerate", json={"items": [{"shot_n": n, "mode": "lighter_cues"}]})
    assert r.json()["refused"] and "No third wet attempt" in r.json()["refused"][0]["reason"]
    r = client.post(f"/api/projects/{pid}/clips/regenerate", json={"items": [{"shot_n": n, "mode": "dry"}]})
    assert r.status_code == 200 and len(r.json()["made"]) == 1 and "dry re-shoot" in r.json()["made"][0]["note"]

    p = client.get(f"/api/projects/{pid}").json()
    latest = {}
    for c in p["clips"]:
        if c["status"] == "pending":
            latest[c["shot_n"]] = c
    for c in latest.values():
        client.post(f"/api/projects/{pid}/clips/{c['id']}/approve")

    r = client.get(f"/api/projects/{pid}/sequence/suggest")
    assert r.status_code == 200, r.text
    seq = r.json()
    assert len(seq["order"]) == 5 and seq["total_duration_s"] == 19 and len(seq["brightness_strip"]) == 5
    rev = list(reversed(seq["order"]))
    r = client.put(f"/api/projects/{pid}/sequence", json={"order": rev})
    assert r.status_code == 200 and r.json()["order"] == rev
    client.put(f"/api/projects/{pid}/sequence", json={"order": seq["order"]})

    r = client.put(f"/api/projects/{pid}/branding", json={"title_position": "both", "project_name": "Willow Glen ADU",
                                                          "practice_name": "Studio Test", "location_line": "San Jose, CA",
                                                          "year": "2026", "stage_stamp": "Design development", "style": "minimal"})
    assert r.status_code == 200

    r = client.post(f"/api/projects/{pid}/render?crops=9:16")
    assert r.status_code == 200, r.text
    d = r.json()
    ver = d["verification"]
    assert ver["width"] == 1920 and ver["height"] == 1080 and abs(ver["duration_s"] - 19) < 0.5, ver
    assert "9:16" in d["crops"] and d["stills_pack"] and d["record_html"]
    assert -19 < ver.get("integrated_lufs", -16) < -13, ver
    for key in ("film", "stills_pack", "record_json", "record_html"):
        assert client.get(f"/files/{d[key]}").status_code == 200
    led = client.get(f"/api/projects/{pid}/ledger").json()["summary"]
    assert led["spent"] > 0 and led["entries"] == 4 + 5 + 1 + 5 + 1 + 1 + 1


def test_reference_analysis(client, tmp_path):
    import subprocess
    import imageio_ffmpeg
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    ref = tmp_path / "ref.mp4"
    # three distinct "shots" of 2 s each with different brightness
    subprocess.run([exe, "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "color=c=0x202020:s=320x180:d=2:r=25",
                    "-f", "lavfi", "-i", "testsrc=s=320x180:d=2:r=25",
                    "-f", "lavfi", "-i", "color=c=0xd0d0d0:s=320x180:d=2:r=25",
                    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", str(ref)], check=True)
    r = client.post("/api/projects", json={"name": "ref"})
    pid = r.json()["id"]
    r = client.post(f"/api/projects/{pid}/hubs", files=[("files", ("a.png", synth_exterior(), "image/png"))])
    r = client.put(f"/api/projects/{pid}/intake", json={"route": "reference", "location": "Manali, Himachal"})
    assert r.json()["project"]["location_profile"]["snow_months"]
    with open(ref, "rb") as f:
        r = client.post(f"/api/projects/{pid}/reference", files={"file": ("ref.mp4", f, "video/mp4")})
    assert r.status_code == 200, r.text
    ra = r.json()
    assert ra["shot_count"] == 3, ra
    assert abs(ra["duration_s"] - 6) < 0.2 and len(ra["light_arc"]) > 10
    assert ra["shots"][0]["brightness"] < ra["shots"][2]["brightness"]
    assert "structure" in ra["caveat"]


def test_sun_side_and_hemisphere():
    from app.services.planning import location as L
    assert "camera-right" in L.sun_side("N", "morning")          # facing north, sun in the east is to the right
    assert "behind the camera" in L.sun_side("N", "midday")       # northern hemisphere midday sun is south
    assert "behind the building" in L.sun_side("N", "midday", "southern")  # southern hemisphere midday sun is north
    assert "behind the building" in L.sun_side("W", "golden_hour")
    assert "assumed" in L.sun_side(None, "morning")
    assert L.profile("Melbourne, Australia")["season_months"]["winter"][0] == "June"
    assert L.profile("Nowhere")["source"].startswith("generic")


def test_qc_flags_dead_clip(tmp_path):
    import subprocess
    import imageio_ffmpeg
    from app.services.analysis.qc import run_qc
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    dead = tmp_path / "dead.mp4"
    subprocess.run([exe, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=320x180:d=3:r=10",
                    "-vf", "select='eq(n,0)',loop=loop=-1:size=1,setpts=N/10/TB", "-t", "3", str(dead)], check=True)
    r = run_qc(dead, "exterior")
    assert not r.passed and any("dead" in f for f in r.failures)


def _ref(pattern, scales, durs, arc):
    from app.models import ReferenceAnalysis, ReferenceShot
    shots = [ReferenceShot(index=i + 1, start_s=i * 4.0, end_s=(i + 1) * 4.0, duration_s=durs[i], scale=scales[i],
                           brightness=0.5, camera_move="slow move",
                           setting=("exterior" if pattern[i] == "E" else "interior")) for i in range(len(pattern))]
    return ReferenceAnalysis(filename="r.mp4", duration_s=sum(durs), shot_count=len(shots),
                             mean_shot_length_s=round(sum(durs) / len(durs), 2), shots=shots, light_arc=arc)


def _project(hubs=("E", "E", "I"), groups=(None, None, None), **intake):
    from app.models import HubImage, Intake, Project
    from app.services.planning import location as L
    p = Project(id="t", name="t")
    p.hubs = [HubImage(id=f"h{i}", filename="f", path="f", cls=("exterior" if c == "E" else "interior"),
                       camera_faces=("NE" if c == "E" else None), continuity_group=g)
              for i, (c, g) in enumerate(zip(hubs, groups))]
    base = dict(location="San Jose, California", seasons=["spring", "winter"], length_shots=5)
    base.update(intake)
    p.intake = Intake(**base)
    p.location_profile = L.profile(p.intake.location)
    return p


def test_arc_shape():
    from app.services.planning.shotplan import arc_shape
    assert arc_shape([0.1, 0.2, 0.5, 0.8, 0.9]) == "rising"
    assert arc_shape([0.9, 0.8, 0.5, 0.2, 0.1]) == "falling"
    assert arc_shape([0.1, 0.5, 0.9, 0.5, 0.1]) == "peak"
    assert arc_shape([0.9, 0.5, 0.1, 0.5, 0.9]) == "trough"
    assert arc_shape([0.5, 0.5, 0.5, 0.5]) == "flat"
    assert arc_shape([]) == "flat" and arc_shape([0.2]) == "flat"


def test_reference_drives_structure():
    from app.services.planning.shotplan import build_plan
    p = _project(route="reference", length_shots=5)
    p.reference = _ref("EEIIE", ["wide", "medium", "detail", "medium", "wide"], [4.0] * 5, [0.9, 0.8, 0.6, 0.3, 0.1])
    plan = build_plan(p)
    assert plan.reference_driven
    assert [s.duration for s in plan.shots] == [4.0] * 5          # shot length from the reference
    assert "".join(s.cls[0] for s in plan.shots) == "eeiie"        # inside/outside rhythm
    assert plan.shots[-1].time == "night"                          # falling light arc ends dark
    assert plan.shots[0].time == "afternoon"
    assert any("light curve (falling)" in w for w in plan.warnings)

    p2 = _project(route="reference", length_shots=5)
    p2.reference = _ref("EIEIE", ["wide", "detail", "medium", "detail", "wide"], [6.5] * 5, [0.1, 0.3, 0.6, 0.8, 0.9])
    plan2 = build_plan(p2)
    assert [s.duration for s in plan2.shots] == [6.5] * 5
    assert plan2.shots[0].time == "dawn" and plan2.shots[-1].time == "afternoon"   # rising arc


def test_reference_route_without_a_reference_falls_back():
    from app.services.planning.shotplan import build_plan
    plan = build_plan(_project(route="reference"))
    assert not plan.reference_driven
    assert any("no reference film has been analysed" in w for w in plan.warnings)
    assert all(s.duration == 5.0 for s in plan.shots)


def test_interior_emphasis():
    from app.services.planning.shotplan import build_plan
    def interiors(emph):
        plan = build_plan(_project(hubs=("E", "I"), groups=(None, None), length_shots=6,
                                   interior_emphasis=emph, seasons=["spring"], design_intents=[]))
        return [s for s in plan.shots if s.cls == "interior"]
    for s in interiors("night"):
        assert s.time in ("dusk", "night") and s.state.lights_on
        assert "lamp" in s.motion or "candle" in s.motion
    for s in interiors("daylight"):
        assert s.time in ("morning", "midday", "afternoon") and not s.state.lights_on
        assert "sunlight" in s.motion or "dust motes" in s.motion
    for s in interiors("lived_in"):
        assert s.time in ("afternoon", "golden_hour") and "steam" in s.motion
    # an explicit design intent outranks the emphasis
    plan = build_plan(_project(hubs=("E", "I"), groups=(None, None), length_shots=6, seasons=["spring"],
                               interior_emphasis="night", design_intents=["afternoon light in the living room"]))
    pinned = [s for s in plan.shots if s.design_intent]
    assert pinned and pinned[0].time == "afternoon"


def test_continuity_group_binds_inside_a_chapter_only():
    from app.services.planning.shotplan import build_plan, validate
    p = _project(hubs=("E", "E", "I"), groups=("north", None, "north"),
                 seasons=["monsoon", "winter"], length_shots=6, location="Manali, Himachal")
    from app.services.planning import location as L
    p.location_profile = L.profile("Manali, Himachal")
    plan = build_plan(p)
    for s in plan.shots:
        assert s.state.season == ("monsoon" if s.chapter == 1 else "winter"), "season arc broken by a link"
    for i, s in enumerate(plan.shots):
        if s.cls != "interior" or p.hub(s.source_hub_id).continuity_group != "north":
            continue
        partner = next((x for x in plan.shots if x.chapter == s.chapter and x.cls == "exterior"
                        and p.hub(x.source_hub_id).continuity_group == "north"), None)
        if partner:
            assert (s.state.time, s.state.weather) == (partner.state.time, partner.state.weather)
    assert not [w for w in validate(plan, p) if "Continuity break" in w]


def test_continuity_group_without_an_exterior_warns():
    from app.services.planning.shotplan import build_plan
    plan = build_plan(_project(hubs=("E", "I"), groups=(None, "orphan"), seasons=["spring"], length_shots=4))
    assert any("no exterior shot anywhere" in w for w in plan.warnings)


def test_linked_interior_keeps_the_weather_and_gains_the_emphasis():
    """A linked interior looks out at real weather, so an emphasis may dress
    the room but must not paint over what is through the glass."""
    from app.services.planning import location as L
    from app.services.planning.shotplan import build_plan
    p = _project(hubs=("E", "E", "I"), groups=("north", None, "north"), seasons=["monsoon", "winter"],
                 length_shots=6, interior_emphasis="night", design_intents=[], location="Manali, Himachal")
    p.location_profile = L.profile("Manali, Himachal")
    plan = build_plan(p)
    linked = [s for s in plan.shots if s.cls == "interior"]
    assert linked, "expected interior shots"
    for s in linked:
        partner = next((x for x in plan.shots if x.chapter == s.chapter and x.cls == "exterior"
                        and p.hub(x.source_hub_id).continuity_group == "north"), None)
        if not partner:
            continue
        assert (s.state.time, s.state.weather) == (partner.state.time, partner.state.weather)
        assert "lamp" in s.motion, "emphasis room element missing"
        through_glass = "rain tracks" in s.motion or "snow falling" in s.motion or "outside" in s.motion
        assert through_glass, f"weather through the glazing was painted over: {s.motion}"
        assert s.motion.count(";") == 1, "a linked cue should stay to two clauses"


def test_single_class_reference_does_not_strand_renders():
    """A reference that never goes inside cannot supply an inside/outside
    rhythm for a project that has both, and following it would leave the
    designer's exterior renders unused."""
    from app.services.planning.shotplan import build_plan, validate
    p = _project(hubs=("E", "E", "I"), route="reference", length_shots=5)
    p.reference = _ref("IIIII", ["wide"] * 5, [4.1] * 5, [0.9, 0.7, 0.5, 0.3, 0.1])
    plan = build_plan(p)
    assert {s.cls for s in plan.shots} == {"exterior", "interior"}
    assert [s.duration for s in plan.shots] == [4.1] * 5      # lengths still come from the reference
    assert any("cannot supply an inside/outside rhythm" in w for w in plan.warnings)
    assert not [w for w in validate(plan, p) if "No shot uses any" in w]

    # a genuinely mixed reference is still followed exactly
    p2 = _project(hubs=("E", "E", "I"), route="reference", length_shots=5)
    p2.reference = _ref("EEIIE", ["wide", "medium", "detail", "medium", "wide"], [4.0] * 5, [0.9, 0.8, 0.6, 0.3, 0.1])
    assert "".join(s.cls[0] for s in build_plan(p2).shots) == "eeiie"


def test_validate_flags_a_wholly_unused_render_class():
    from app.services.planning.shotplan import build_plan, validate
    p = _project(hubs=("E", "I"), seasons=["spring"], length_shots=4)
    plan = build_plan(p)
    for s in plan.shots:                      # force every shot onto the exterior render
        s.cls, s.source_hub_id = "exterior", "h0"
    assert any("No shot uses any of the 1 interior render" in w for w in validate(plan, p))


def _ready_for_stills(client, shots=4):
    """A project taken as far as the still board gate."""
    from tests.conftest import synth_exterior, synth_interior
    pid = client.post("/api/projects", json={"name": "batch"}).json()["id"]
    client.post(f"/api/projects/{pid}/hubs", files=[
        ("files", ("front.png", synth_exterior(), "image/png")),
        ("files", ("living.png", synth_interior(), "image/png"))])
    client.put(f"/api/projects/{pid}/intake", json={"location": "San Jose, California", "length_shots": shots,
                                                    "seasons": ["summer"], "people": "none"})
    client.post(f"/api/projects/{pid}/plan/generate")
    client.post(f"/api/projects/{pid}/plan/approve")
    client.post(f"/api/projects/{pid}/budget/confirm")
    client.post(f"/api/projects/{pid}/heroes/generate")
    for h in client.get(f"/api/projects/{pid}").json()["heroes"]:
        if h["variant"] == 1:
            client.post(f"/api/projects/{pid}/heroes/{h['id']}/choose")
    return pid


def test_a_dying_batch_keeps_everything_it_paid_for(client, monkeypatch):
    """The failure that costs real money: a batch that stops partway must have
    persisted and accounted for every generation it already paid for, and
    running it again must resume rather than pay twice."""
    from app.routers import stills as stills_router
    pid = _ready_for_stills(client, shots=4)
    before = client.get(f"/api/projects/{pid}/ledger").json()["summary"]["spent"]

    real = stills_router._gen_still
    calls = {"n": 0}

    def explode_on_third(*a, **kw):
        calls["n"] += 1
        if calls["n"] >= 3:
            raise RuntimeError("provider went down mid-batch")
        return real(*a, **kw)

    monkeypatch.setattr(stills_router, "_gen_still", explode_on_third)
    with pytest.raises(RuntimeError):
        client.post(f"/api/projects/{pid}/stills/generate")

    p = client.get(f"/api/projects/{pid}").json()
    saved = [s for s in p["stills"] if s["status"] == "pending"]
    assert len(saved) == 2, "the two finished stills were lost"
    charges = [e for e in p["ledger"] if e["kind"] == "still"]
    assert len(charges) == 2, "paid work was not accounted for"
    spent = client.get(f"/api/projects/{pid}/ledger").json()["summary"]["spent"]
    assert spent > before

    # resuming pays only for what is still missing
    monkeypatch.setattr(stills_router, "_gen_still", real)
    r = client.post(f"/api/projects/{pid}/stills/generate")
    assert r.status_code == 200
    assert len(r.json()["made"]) == 2, "resume should generate only the two that were missing"
    p2 = client.get(f"/api/projects/{pid}").json()
    assert len({s["shot_n"] for s in p2["stills"] if s["status"] == "pending"}) == 4
    assert len([e for e in p2["ledger"] if e["kind"] == "still"]) == 4, "a resume must not pay twice"


def test_batch_stops_after_two_consecutive_provider_failures(client, monkeypatch):
    from app.routers import stills as stills_router
    from fastapi import HTTPException
    pid = _ready_for_stills(client, shots=5)

    def always_502(*a, **kw):
        raise HTTPException(502, "provider error: upstream down")

    monkeypatch.setattr(stills_router, "_gen_still", always_502)
    made = stills_router._stills_batch(pid, job_id=None)
    assert made == []
    p = client.get(f"/api/projects/{pid}").json()
    assert not [s for s in p["stills"] if s["status"] == "pending"]
    assert not [e for e in p["ledger"] if e["kind"] == "still"], "nothing should be charged for failures"


def test_background_job_reports_progress(client):
    import time
    pid = _ready_for_stills(client, shots=3)
    r = client.post(f"/api/projects/{pid}/stills/generate?background=true")
    assert r.status_code == 200
    job = r.json()["job"]
    assert job["kind"] == "stills" and job["total"] == 3 and job["status"] == "running"

    # a second batch is refused while one is in flight
    assert client.post(f"/api/projects/{pid}/stills/generate?background=true").status_code == 409

    for _ in range(120):
        j = client.get(f"/api/projects/{pid}/jobs/{job['id']}").json()
        if j["status"] != "running":
            break
        time.sleep(0.5)
    assert j["status"] == "finished", j
    assert j["done"] == 3 and not j["errors"]
    assert client.get(f"/api/projects/{pid}/jobs").json()["active"] is None
    assert len(client.get(f"/api/projects/{pid}").json()["stills"]) == 3


def test_a_crafted_project_id_cannot_escape_the_data_directory(client):
    """Project ids are server-generated and only ever name a directory inside
    the data root, so a traversal attempt is a not-found, never a path."""
    from app.store import project_dir
    for bad in ("../../etc", "a/../../b", "", "..", "x" * 80):
        with pytest.raises(ValueError):
            project_dir(bad)
    assert str(project_dir("prj_abc12345")).endswith("/projects/prj_abc12345")
    for bad in ("..%2F..%2Fetc", "..", "%2e%2e"):
        r = client.get(f"/api/projects/{bad}")
        assert r.status_code in (404, 307), f"{bad} -> {r.status_code}"
