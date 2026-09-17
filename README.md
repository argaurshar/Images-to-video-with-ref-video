# ArchViz Cinematic Engine

Turns an architect's or interior designer's renders into a short cinematic film across seasons, times of day and moods, without ever redesigning the building. Built from `SPEC.md` (v2.0, the architecture and interior design edition of the original mega prompt).

The app enforces the spec's laws server-side: every still comes from an original render, video is refused until every still is approved, every clip is measured before it is shown, and a shot that fails twice is cut or re-shot dry rather than tried a third time.

## What you get

- **Intake**: upload 1 to 8 renders (exterior, interior or both), name the finishes, state which way each exterior camera faces, answer the questionnaire, confirm a budget.
- **Reference analysis**: shot detection, light arc, colour stats, weather density, scale rhythm and inside/outside pattern of a reference film. The structure is then applied to the plan: per-shot length, exterior/interior rhythm, scale changes, and a time arc taken from the light curve's shape. Colour is deliberately not copied, because a reference's grade belongs to its own climate.
- **Shot plan**: a deterministic planner that applies the scale pyramid, calendar order for the site's hemisphere, chapter closers, human beats at the edges, one heavy weather beat, approach → enter → dwell → detail → return, and maps your three design intents to shots. Sun side comes from the orientation you stated. Interior emphasis steers interior times, lighting and cues. An interior linked to an exterior inherits that exterior's exact weather and time, so the window never shows rain while the room shows sun. Every shot carries its own editable duration.
- **Hero gate, still board, clips**: generation through a pluggable provider, a fidelity audit of every still against its hub render, and the QC suite (motion, frozen ratio, particle density in the sky or glazing band, geometry drift, region check, vertical drift, exposure and hue drift, text check) on every clip.
- **Batches that survive a crash**: the still board and the clip run commit and account for each item as it completes, so a run that dies partway keeps everything it paid for and resumes rather than paying twice. Long runs go to a background job with live progress, because fourteen clips on a real provider is tens of minutes, not one HTTP request.
- **Sequence editor, branding, final render**: drag ordering with a light-arc strip and continuity warnings; title cards, stage stamp and disclaimer; ffmpeg render at 30 fps with an ambience bed normalised to −16 LUFS; crop-only variants; a stills pack; a project record (JSON and HTML) with every prompt, audit, QC table, approval and cost.

## Run it

```bash
pip install -r requirements.txt
./run.sh            # http://127.0.0.1:8000
```

That runs on the **mock provider**: stills are the hub render with a season and light treatment, clips are made locally with ffmpeg. Nothing is charged, but the whole pipeline, the audit and the QC run for real, so you can rehearse a project before spending.

### Real generation

```bash
export ARCHVIZ_PROVIDER=freepik
export FREEPIK_API_KEY=...          # Freepik / Magnific API
export ARCHVIZ_IMAGE_COST=0.08      # what your contract charges per image
export ARCHVIZ_VIDEO_COST=0.28      # per 5 s clip
./run.sh
```

The Freepik adapter (`backend/app/services/providers/freepik.py`) submits an image edit with the hub render as reference and an image-to-video task from the approved still, then polls. Model paths are environment variables (`FREEPIK_IMAGE_EDIT_PATH`, `FREEPIK_VIDEO_PATH`) because model names on that platform change; check them against the current API reference before a paid run. Adding another provider means one class with two methods (`generate_still`, `generate_clip`) in that folder.

Optional: set `ANTHROPIC_API_KEY` and the engine asks Claude to research the location profile (climate, vegetation, wet and snow months, local signature). Without it, a built-in table covers the Bay Area, India, the Himalaya, the UK, Japan, Australia and the Gulf, and everything else gets a generic temperate profile that says so.

## The project page

A page describing the app, with screenshots of the interface, is published from `docs/` to
**https://argaurshar.github.io/Images-to-video-with-ref-video/**

It is documentation, not the running app: see below for why, and for how to run the real thing.

## Run it in the cloud, with nothing installed

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/argaurshar/Images-to-video-with-ref-video)

That button is the whole setup. You sign in to Render with GitHub, it reads
`render.yaml` from this repo, and it builds the Dockerfile for you. No terminal,
no Docker on your machine, no environment variables to fill in.

When the build finishes you get a URL. Open it and the app asks you to do two
things, both inside the app itself:

1. **Set an access code.** The instance holds your paid API key and lives on a
   public address, so it locks itself to you. Until you claim it, anyone with
   the URL could use it.
2. **Paste your Freepik API key** under Settings, choose the Freepik provider,
   and press "Test the key" to confirm it works before anything is charged.

That is it. The key is stored on your server, never in this repository and
never sent back to your browser.

### What the free plan actually gives you

The blueprint defaults to Render's free plan so you can deploy without a credit
card. Be aware of what that means:

| | Free | Starter, about $9.50/month |
|---|---|---|
| Projects and renders survive a restart | No, wiped | Yes, on a 10 GB disk |
| Your saved API key survives a restart | No, re-enter it | Yes |
| Sleeps when idle | Yes, ~50s to wake | No |
| Memory | 512 MB, tight for long films | 512 MB, always on |

Free is genuinely fine for trying the whole pipeline on the mock provider,
which costs nothing and still exercises the audit, the QC suite and the render.
For real client work, open `render.yaml`, change `plan: free` to `plan: starter`
and uncomment the disk block.

### Why it cannot run on GitHub Pages

Pages serves static files. This is a Python server that runs ffmpeg and OpenCV
and keeps background jobs alive for tens of minutes, so it needs a container
host. The Pages site at
https://argaurshar.github.io/Images-to-video-with-ref-video/ is documentation
about the app, not the app.

### Running it on your own machine instead

```bash
pip install -r requirements.txt && ./run.sh      # http://127.0.0.1:8000
```

Or with Docker:

```bash
docker build -t archviz . && docker run -p 8000:8000 -v archviz-data:/data archviz
```

**Run a single worker.** The batch job registry lives in the process. A second
worker would not see a running job, so it could start a duplicate batch and pay
twice. Scale with a larger machine instead.

## Long runs

The two expensive stages accept `?background=true`, which returns a job instead of holding the request open:

```
POST /api/projects/<id>/stills/generate?background=true
POST /api/projects/<id>/clips/generate?background=true
GET  /api/projects/<id>/jobs            # active job and history
```

The front end uses this and shows a progress card. The job registry is in memory, so if the server restarts mid-batch the job disappears from the list, but every generation it had already finished is saved. Press generate again and it picks up where it stopped.

## Tests

```bash
cd backend && python -m pytest -q
```

The suite runs the whole pipeline on the mock provider (about two and a half minutes, most of it ffmpeg), plus reference analysis, sun-side logic and a dead-clip QC check.

## Layout

```
SPEC.md                      the v2 spec the app implements
docs/…_v1_original.md        the original mega prompt, unchanged
backend/app/
  main.py                    FastAPI app, serves the API and the front end
  models.py                  project document (also the project record)
  store.py                   one JSON file + asset folders per project under data/
  routers/                   intake, reference, plan, stills, clips, sequence, render
  services/analysis/         hub detection, reference measurement, QC suite
  services/planning/         location and sun side, shot planner, prompt builders
  services/providers/        mock, freepik, (add yours here)
  services/render/           ffmpeg pipeline, stills pack, project record
frontend/                    no-build front end (index.html, app.js, styles.css)
```

## Limits to know about

- The fidelity audit and the QC metrics are numeric proxies. They catch gross drift and painted overlays; a designer still runs the checklist by eye before approving a still.
- Sun direction is approximated from the stated compass heading and the time slot (Law 7). It is not a solar study and the disclaimer says so.
- The synthetic ambience bed is a placeholder. Upload real beds and a score on the branding page.
- Analysis of a reference video's audio reports only whether a track exists; narration versus ambience is checked by ear.
