"""End-to-end run of the spec's pipeline on the mock provider."""
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
        assert qc["ran"] and qc["frames_sampled"] >= 40
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
    assert len(seq["order"]) == 5 and seq["total_duration_s"] == 25 and len(seq["brightness_strip"]) == 5
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
    assert ver["width"] == 1920 and ver["height"] == 1080 and abs(ver["duration_s"] - 25) < 0.5, ver
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
