# ArchViz Cinematic Engine

Turns an architect's or interior designer's renders into a short cinematic film across seasons, times of day and moods, without ever redesigning the building. Built from `SPEC.md` (v2.0, the architecture and interior design edition of the original mega prompt).

There are two implementations of the same engine, sharing one interface and one
set of rules: a **browser version** that runs on GitHub Pages with nothing
installed, and a **Python server** for driving a paid generation API. Both
enforce the spec's laws the same way: every still comes from an original
render, video is refused until every still is approved, every clip is measured
before it is shown, and a shot that fails twice is cut or re-shot dry rather
than tried a third time.

## What you get

- **Intake**: upload 1 to 8 renders (exterior, interior or both), name the finishes, state which way each exterior camera faces, answer the questionnaire, confirm a budget.
- **Reference analysis**: shot detection, light arc, colour stats, weather density, scale rhythm and inside/outside pattern of a reference film. The structure is then applied to the plan: per-shot length, exterior/interior rhythm, scale changes, and a time arc taken from the light curve's shape. Colour is deliberately not copied, because a reference's grade belongs to its own climate.
- **Shot plan**: a deterministic planner that applies the scale pyramid, calendar order for the site's hemisphere, chapter closers, human beats at the edges, one heavy weather beat, approach → enter → dwell → detail → return, and maps your three design intents to shots. Sun side comes from the orientation you stated. Interior emphasis steers interior times, lighting and cues. An interior linked to an exterior inherits that exterior's exact weather and time, so the window never shows rain while the room shows sun. Every shot carries its own editable duration.
- **Hero gate, still board, clips**: generation through a pluggable provider, a fidelity audit of every still against its hub render, and the QC suite (motion, frozen ratio, particle density in the sky or glazing band, geometry drift, region check, vertical drift, exposure and hue drift, text check) on every clip.
- **Batches that survive a crash**: the still board and the clip run commit and account for each item as it completes, so a run that dies partway keeps everything it paid for and resumes rather than paying twice. Long runs go to a background job with live progress, because fourteen clips on a real provider is tens of minutes, not one HTTP request.
- **Sequence editor, branding, final render**: drag ordering with a light-arc strip and continuity warnings; title cards, stage stamp and disclaimer; a 30 fps render with an ambience bed (ffmpeg and −16 LUFS on the server; recorded from a canvas with an RMS-approximated level in the browser, which says so on the page); crop-only variants; a stills pack; a project record (JSON and HTML) with every prompt, audit, QC table, approval and cost.

## Run it in your browser, on GitHub Pages

**https://argaurshar.github.io/Images-to-video-with-ref-video/app/**

That link is the working app, not a description of one. The whole engine is the
page: the planner, the image analysis, the fidelity audit, the clip
measurements and the final render all run in the tab. No install, no account,
no server, and nothing you upload leaves your machine. It has no dependencies
at all: Canny, connected components, the frame aligner, the ZIP writer and the
video encoder are all in `docs/app/engine/`, so there is no CDN to go down.

A tour of the tool, with screenshots, is at
**https://argaurshar.github.io/Images-to-video-with-ref-video/**

Out of the box it uses a **demo generator** that runs in the tab, costs nothing
and still exercises every gate, so a whole project can be rehearsed end to end
before any money is involved.

The numbers are the server's numbers. The image metrics were checked against
the Python implementation on the same files: edge density matches to four
decimal places, and a still the server audits at 0.915 structural similarity
the browser audits at 0.911.

### What the browser version cannot do

**Drive a paid API directly.** A web page can only read a reply from another
site when that site marks it readable, and an API that authenticates with a
secret key normally refuses, on purpose. Paste a key under **Settings** and
press **Test the key**: it says plainly whether calls get through from your
browser. Nothing is charged either way. If they do not, run the Python server
below, which calls from the server side where the restriction does not apply.

**Promise you an MP4.** The film is recorded from a canvas, so the format is
whatever the browser encodes. Chrome, Edge and Safari on a desktop give H.264
in an MP4; Firefox and some Chromium builds give VP9 in a WebM, which plays in
browsers but not in QuickTime, PowerPoint or most editors. The tool records a
fraction of a second, reads the bytes back and tells you which you got, and
never names a file `.mp4` for something an MP4 cannot hold. The Python server
renders with ffmpeg and always writes H.264.

**Keep your work anywhere but this browser.** Projects and generated files live
in this browser's storage on this device. Clearing site data erases them, and
another device will not see them. Download the film and the stills pack when a
project is done. There is also **no access lock**, because a static page cannot
check a password before serving its own source; on a shared machine, use the
server.

**Render faster than real time.** Clips and the film are recorded as they play,
so a 45-second film takes about 45 seconds, and the tab has to stay in front.
A background tab freezes the picture while the clock runs, so the tool discards
that render rather than hand you a frozen film.

### On a phone

The same URL. **Choose photos** opens the gallery, **Take a photo** opens the
camera, and the whole pipeline works by tapping. Phone specifics that are
handled rather than left to bite:

- **JPEG, PNG and WebP are read directly**, and a JPEG is a JPEG whatever made
  it: baseline or progressive, colour or greyscale, any subsampling, with or
  without a filename extension. The decoder decides, not the type header, since
  a gallery can hand over a good photo as `application/octet-stream` with no
  name. A photo with an **EXIF orientation tag is turned upright** on the way
  in, so a shot taken with the phone held sideways is not a film shot sideways.
- A 12 MP photo is **resampled to 2048 px on its long edge** on the way in,
  because a phone cannot hold a dozen full-size images in canvas memory. Nothing
  is cropped, and the page says when it has done it.
- A phone shoots 4:3 and the default film is 16:9, so the first save **offers
  the ratios that keep most of the frame**, one tap each, instead of telling you
  to re-render a photograph.
- HEIC opens in Safari, which reads it natively. Another browser that refuses it
  is told to switch the iPhone to "Most Compatible" rather than given "not a
  readable image".
- The render **defaults to half size on a small screen** and a **wake lock**
  keeps the screen on while video is written. A phone is for shooting, reviewing
  and approving; render the final film full size on a laptop, moving the project
  across with the export ZIP.

### Moving projects around

Every project can be **exported as one ZIP** (the document plus every render,
still, clip and film) from the project list or the render page, and imported
on any machine from the start screen. **Duplicate** keeps the renders, intake,
plan and chosen heroes and starts stills and clips fresh, which is the spec's
"reuse across films": a DA film and a CD film of the same building share the
rediscovery. A batch run twice makes only what is missing, and two consecutive
provider failures stop it rather than walking the rest of the plan into the
same wall.

## Run it as a server

The app runs unchanged inside a **GitHub Codespace**, which is GitHub's own
container host. Nothing is installed on your machine, and you get an HTTPS URL.

**[Open this repo in a Codespace](https://github.com/codespaces/new?repo=argaurshar/Images-to-video-with-ref-video&ref=claude/app-md-review-enhance-its81i)**

Or from the repo page: **Code**, the **Codespaces** tab, **Create codespace**.

What happens: GitHub builds the container from `.devcontainer/`, installs the
dependencies, starts the server on port 8000 and forwards it. Click the
`…app.github.dev` link it shows you. Then, inside the app, set an access code
and paste your Freepik key under **Settings**.

The forwarded port is **private** by default, meaning only you, signed in to
GitHub, can open it. That is deliberate, because the instance holds a paid API
key. To send a client a link, open the **Ports** panel, right-click port 8000,
choose **Port Visibility**, then **Public**.

### What a Codespace costs

A personal GitHub Free account includes **120 core-hours a month**, which is
about 60 hours on the default 2-core machine, plus 15 GB of storage. Running
this app for an afternoon a week sits inside that comfortably.

Two things worth knowing:

- A codespace **stops after 30 minutes idle**. If a long clip batch is running
  and you close the tab, it will be interrupted. That is survivable here: the
  storage persists, and batches are resumable, so restarting the codespace and
  pressing generate again continues from where it stopped and does not pay for
  anything twice.
- Storage keeps billing while a codespace exists, even stopped. Delete it when
  a project is finished.

### If you want it always on instead

A Codespace is the right answer for working on projects yourself. It is not a
service that stays up for other people. For an address that is always live,
deploy the same repo to Render or Railway; see below.

## Run it on an always-on host

GitHub does not host long-running web services, so for an address that stays
up without you opening a codespace, use a container host. Still no terminal and
no Docker on your machine.

### Render, the path this repo is set up for

1. Go to **render.com**, click **Get Started**, then **GitHub**, and authorise Render.
2. Click **New +** (top right), then **Blueprint**.
3. Connect this repository. In the **Branch** dropdown pick
   `claude/app-md-review-enhance-its81i`.
4. Render reads `render.yaml` and shows one service. Click **Apply**.
5. Wait for the build. The first one takes several minutes because it installs
   OpenCV and ffmpeg. When the status turns **Live**, click the
   `…onrender.com` link.

Then, inside the app: set an access code, open **Settings**, paste your Freepik
key, choose the Freepik provider, and press **Test the key**.

> **Use the dashboard flow above, not the "Deploy to Render" button.** The
> button is known to fail with *"No render.yaml file found on main branch"*
> when a repository's default branch is not `main`, which is the case here.

### What the free plan really means

The blueprint defaults to Render's free plan so it deploys with no credit card.
That is honest for trying the pipeline on the **mock provider**, which costs
nothing and still runs the audit, the QC suite and the render for real.

**Do not run a paid API key on the free plan.** A free instance sleeps after
about 15 minutes with no inbound request, and this app returns immediately and
does its work in background threads. So a 30-minute clip batch only survives
while a browser tab is actively polling it. Close the tab and the instance
suspends mid-batch, and because the free plan has no persistent disk, the clips
you already paid for are gone with it.

For real work, edit `render.yaml`: change `plan: free` to `plan: starter` and
uncomment the disk block.

| | Free | Starter + disk |
|---|---|---|
| Cost | $0, no card | about $9.50/month |
| Projects, renders, saved key survive a restart | No | Yes |
| Sleeps when idle | Yes | No |
| Safe to use a paid API key | **No** | Yes |

One caveat on either plan: 512 MB of RAM is tight for ffmpeg and OpenCV holding
1080p frames. If renders fail with out-of-memory errors, raise the instance
size rather than shortening the film.

### Railway, if you want it cheaper

Railway works out around **$5/month** on its Hobby plan, which is less than
Render's paid tier. The repo ships a `railway.json` so the build is described.
The difference is that Railway does not create the disk for you: after the first
deploy you add a **Volume** mounted at `/data`, and set `ARCHVIZ_DATA_DIR=/data`
in the Variables tab. Railway's free trial is not enough for this app, because
its volume cap is far below what renders need.

### Why it cannot run on GitHub Pages

Pages serves static files. This is a Python server running ffmpeg and OpenCV
with background jobs alive for tens of minutes, so it needs a container host.
The page at https://argaurshar.github.io/Images-to-video-with-ref-video/
documents the app; it is not the app.

### On your own machine instead

```bash
pip install -r requirements.txt && ./run.sh      # http://127.0.0.1:8000
```

**Run a single worker.** The batch job registry lives in the process, so a
second worker would not see a running job and could start a duplicate batch and
pay twice.

## Providers

The app starts on the **mock provider**: stills are the hub render with a season
and light treatment, and clips are made locally with ffmpeg. Nothing is charged,
but the pipeline, the audit, the QC suite and the render all run for real, so a
whole project can be rehearsed before any money is spent.

Switch to real generation inside the app, under **Settings**: choose the Freepik
provider, paste your key, and press **Test the key**. The key is stored on your
own instance, never in this repository and never sent back to your browser. The
per-image and per-clip costs are set in the same place so the budget gate can
match your actual contract.

The Freepik adapter (`backend/app/services/providers/freepik.py`) submits an
image edit with the hub render as reference and an image-to-video task from the
approved still, then polls. Model paths are environment variables
(`FREEPIK_IMAGE_EDIT_PATH`, `FREEPIK_VIDEO_PATH`) because model names on that
platform change. Adding another provider means one class with two methods,
`generate_still` and `generate_clip`, in that folder.

Optional: set `ANTHROPIC_API_KEY` and the engine asks Claude to research the
location profile. Without it, a built-in table covers the Bay Area, India, the
Himalaya, the UK, Japan, Australia and the Gulf, and anything else gets a
generic temperate profile that says so.

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
