/* The generation layer. Two providers behind one interface, the same split the
   server had.

   demo    runs entirely in this tab. It applies the season and time treatment
           the prompt asks for and animates the result, so the planner, the
           audit, the QC and the render can all be exercised end to end with no
           key and no money. It is a simulation of a generator, not a generator.

   freepik calls the real API straight from the browser. Whether that works at
           all is not this code's decision: a browser will only read a
           cross-origin response the server marks as readable, and a key-bearing
           API has a good reason not to. The failure is detected and named
           rather than surfacing as a bare "Failed to fetch". */

import { canvasOf, cropRect, canvasToBlob, blobToImage, OUTPUT_FPS } from "./compose.js";
import { record } from "./recorder.js";

export class ProviderError extends Error {}

// ------------------------------------------------------------------- demo

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Read the season and light the prompt asked for. The prompt is the contract
    between the planner and the provider, so the demo reads it rather than
    being handed the shot, exactly as a real provider would. */
function readPrompt(prompt) {
  const pl = prompt.toLowerCase();
  const season = ["winter", "monsoon", "autumn", "spring", "summer"].find((s) => new RegExp(`\\b${s}\\b`).test(pl)) || "summer";
  return {
    season,
    night: pl.includes("night") && pl.includes("no sun"),
    golden: pl.includes("golden hour"),
    dusk: pl.includes("blue hour"),
    rain: (pl.includes("rain") || pl.includes("shower") || pl.includes("drops")) && !pl.includes("clear after"),
    snow: pl.includes("snow"),
    fallingRain: pl.includes("rain falls"),
    fallingSnow: pl.includes("snow falls"),
  };
}

function gradePixels(data, p) {
  for (let j = 0; j < data.length; j += 4) {
    let r = data[j], g = data[j + 1], b = data[j + 2];
    if (p.season === "winter") {
      const y = 0.3 * r + 0.59 * g + 0.11 * b;
      r = 0.6 * r + 0.4 * y + 12; g = 0.6 * g + 0.4 * y + 14; b = 0.6 * b + 0.4 * y + 22;
    } else if (p.season === "monsoon") {
      r *= 0.78; g *= 0.84; b *= 0.95;
    } else if (p.season === "autumn") {
      r = r * 1.08 + 6; g *= 0.98; b *= 0.86;
    } else if (p.season === "spring") {
      r *= 0.98; g = g * 1.05 + 4; b *= 0.96;
    }
    if (p.night) { r = r * 0.22 + 2; g = g * 0.24 + 3; b = b * 0.34 + 10; }
    else if (p.dusk) { r *= 0.55; g *= 0.6; b *= 0.85; }
    else if (p.golden) { r = r * 1.12 + 10; g *= 1.0; b *= 0.8; }
    data[j] = r; data[j + 1] = g; data[j + 2] = b;
  }
}

class DemoProvider {
  constructor(settings) { this.name = "demo"; this.s = settings; }

  async generateStill(sourceBlob, prompt, negative, aspect) {
    const img = await blobToImage(sourceBlob);
    const r = cropRect(img.naturalWidth, img.naturalHeight, aspect);
    const cv = canvasOf(r.w, r.h);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height);
    const p = readPrompt(prompt);
    const id = ctx.getImageData(0, 0, cv.width, cv.height);
    gradePixels(id.data, p);
    ctx.putImageData(id, 0, 0);

    // light motion cues only: a few sparse streaks near camera
    const rng = mulberry32(hashString(prompt));
    const w = cv.width, h = cv.height;
    if (p.rain && !p.night) {
      ctx.strokeStyle = "rgba(235,235,235,0.95)";
      ctx.lineWidth = Math.max(1, w / 640);
      for (let i = 0; i < 6; i++) {
        const x = rng() * (w / 3), y = h / 2 + rng() * (h / 2 - 20);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 3, y + 12 + rng() * 16); ctx.stroke();
      }
    }
    if (p.snow) {
      ctx.fillStyle = "rgba(250,250,250,0.95)";
      for (let i = 0; i < 60; i++) {
        ctx.beginPath(); ctx.arc(rng() * w, rng() * h, 1 + rng() * 2, 0, 7); ctx.fill();
      }
    }
    return {
      blob: await canvasToBlob(cv, "image/jpeg", 0.92),
      provider_id: "demo-still",
      cost: this.s.image_cost,
      note: "simulated generation; the cost shown is the configured rate, not a real charge",
    };
  }

  async generateClip(stillBlob, prompt, negative, seconds, aspect, onProgress) {
    const img = await blobToImage(stillBlob);
    // A phone encodes a 1280-wide clip slowly and then has to hold several of
    // them open to cut the film, so the demo works at a size the device can
    // actually sustain. A real provider returns whatever it returns.
    const cap = matchMedia("(max-width: 760px), (pointer: coarse)").matches ? 854 : 1280;
    const w = Math.min(cap, img.naturalWidth), h = Math.round((w / img.naturalWidth) * img.naturalHeight);
    const cv = canvasOf(w, h);
    const ctx = cv.getContext("2d");
    const p = readPrompt(prompt);
    const rng = mulberry32(hashString(prompt) ^ 0x9e37);
    // a particle layer that scrolls through the frame: every particle travels
    // and leaves, the way the motion brief asks and the QC then checks
    const parts = [];
    if (p.fallingRain || p.fallingSnow) {
      const count = p.fallingSnow ? 240 : 90;
      for (let i = 0; i < count; i++) parts.push({ x: rng() * cv.width, y: rng() * cv.height, s: 0.7 + rng() * 0.6 });
    }
    const speed = p.fallingSnow ? 80 : 220;
    // Grain tiles, per pixel and drawn at 1:1. The server's mock shelled out to
    // ffmpeg's temporal noise, which is per pixel; a cheaper low-resolution
    // grain scaled up is not the same thing, because its blocks carry real
    // gradients and the edge detector reads them as structure that moves,
    // which shows up as a geometry failure on exactly the clips that are
    // hardest to measure. Per-pixel noise is smoothed away before edges are
    // found and still registers in the frame-to-frame difference, which is
    // what the motion check wants. Four tiles are built once and cycled with a
    // random offset, so this costs one draw per frame instead of a million
    // writes.
    const tiles = [];
    for (let k = 0; k < 4; k++) {
      const tile = canvasOf(256, 256);
      const tctx = tile.getContext("2d");
      const id = tctx.createImageData(256, 256);
      for (let i = 0; i < id.data.length; i += 4) {
        const v = Math.floor(Math.random() * 22);
        id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
        id.data[i + 3] = 255;
      }
      tctx.putImageData(id, 0, 0);
      tiles.push(ctx.createPattern(tile, "repeat"));
    }

    const draw = (t) => {
      // slow push plus a gentle sway of a few pixels: what an image-to-video
      // model does with a "barely perceptible handheld drift" brief
      const zoom = 1 + 0.03 * (t / Math.max(seconds, 0.001));
      const dx = 14 * Math.sin(t * 2.7), dy = 10 * Math.cos(t * 2.3);
      const sw = img.naturalWidth / zoom, sh = img.naturalHeight / zoom;
      const sx = (img.naturalWidth - sw) / 2 + dx, sy = (img.naturalHeight - sh) / 2 + dy;
      ctx.drawImage(img, Math.max(0, sx), Math.max(0, sy), sw, sh, 0, 0, cv.width, cv.height);

      if (parts.length) {
        ctx.save();
        if (p.fallingSnow) {
          ctx.fillStyle = "rgba(250,250,250,0.9)";
          for (const q of parts) {
            const y = (q.y + t * speed) % cv.height;
            ctx.beginPath(); ctx.arc(q.x + 6 * Math.sin(t + q.y), y, 2.2 * q.s, 0, 7); ctx.fill();
          }
        } else {
          ctx.strokeStyle = "rgba(190,190,205,0.92)";
          ctx.lineWidth = 2;
          for (const q of parts) {
            const y = (q.y + t * speed) % cv.height;
            const len = 34 * q.s;
            ctx.beginPath(); ctx.moveTo(q.x, y); ctx.lineTo(q.x + len / 8, y + len); ctx.stroke();
          }
        }
        ctx.restore();
      }

      // Temporal grain, so every region carries some motion: that is what the
      // regional QC check looks for, and it is what real footage has.
      // Added rather than blended, because an overlay blend leaves near-black
      // pixels near-black and that left dusk and night clips reading as dead
      // when their picture was in fact moving.
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = tiles[Math.floor(Math.random() * tiles.length)];
      ctx.translate(-Math.floor(Math.random() * 256), -Math.floor(Math.random() * 256));
      ctx.fillRect(0, 0, cv.width + 256, cv.height + 256);
      ctx.restore();
    };

    const { blob, ext } = await record(cv, seconds, OUTPUT_FPS, draw, { onProgress });
    return {
      blob, ext, provider_id: "demo-clip", cost: this.s.video_cost, seconds,
      note: "simulated generation; the cost shown is the configured rate, not a real charge",
    };
  }
}

// ---------------------------------------------------------------- freepik

async function blobToDataParts(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A cross-origin fetch that fails without ever reaching the server, or whose
    response the browser refuses to expose, arrives here as an opaque
    TypeError. Say what it actually is. */
function explain(err, url) {
  const m = String(err && err.message || err);
  if (err instanceof TypeError || /failed to fetch|load failed|networkerror/i.test(m)) {
    return new ProviderError(
      `the browser could not read a response from ${new URL(url).host}. ` +
      "This is almost always CORS: a static page has no server to make the call for it, and an API that " +
      "takes a secret key usually refuses to let a web page read its replies. Nothing was charged. " +
      "Either point the base URL in Settings at a relay that adds the CORS headers, or run the Python " +
      "server from the repository, which calls the API from the server side where this restriction does not apply."
    );
  }
  return new ProviderError(m);
}

class FreepikProvider {
  constructor(settings) {
    this.name = "freepik";
    this.s = settings;
    if (!settings.freepik_api_key) {
      throw new ProviderError("no API key set; open Settings and paste your Freepik key");
    }
    this.base = (settings.base_url || "").replace(/\/+$/, "");
  }

  headers() {
    return { "x-freepik-api-key": this.s.freepik_api_key, "Content-Type": "application/json" };
  }

  async submitAndWait(path, payload, onProgress) {
    const url = this.base + path;
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: this.headers(), body: JSON.stringify(payload) });
    } catch (e) { throw explain(e, url); }
    if (!res.ok) throw new ProviderError(`${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const taskId = ((await res.json()).data || {}).task_id;
    if (!taskId) throw new ProviderError(`${path}: no task_id in the response`);
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      let s;
      try {
        s = await fetch(`${url}/${taskId}`, { headers: this.headers() });
      } catch (e) { throw explain(e, url); }
      if (!s.ok) throw new ProviderError(`poll ${taskId}: ${s.status} ${(await s.text()).slice(0, 300)}`);
      const data = (await s.json()).data || {};
      const status = (data.status || "").toUpperCase();
      if (onProgress) onProgress(status);
      if (status === "COMPLETED") {
        const gen = data.generated || [];
        if (!gen.length) throw new ProviderError(`task ${taskId} completed with no output`);
        return gen.map((g) => (typeof g === "string" ? g : g.url || ""));
      }
      if (["FAILED", "ERROR", "CANCELLED"].includes(status)) throw new ProviderError(`task ${taskId} ${status}`);
    }
    throw new ProviderError(`task ${taskId} timed out`);
  }

  async download(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new ProviderError(`download failed: ${r.status}`);
      return await r.blob();
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(
        "the generation succeeded and has been charged, but this page could not download the result from the " +
        "provider's file host because that host does not allow cross-origin reads. The file is in your Freepik " +
        "account. Open the task there to retrieve it."
      );
    }
  }

  async cropped(blob, aspect) {
    const img = await blobToImage(blob);
    const r = cropRect(img.naturalWidth, img.naturalHeight, aspect);   // Law 6
    const cv = canvasOf(r.w, r.h);
    cv.getContext("2d").drawImage(img, r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height);
    return canvasToBlob(cv, "image/jpeg", 0.95);
  }

  async generateStill(sourceBlob, prompt, negative, aspect, onProgress) {
    const b64 = await blobToDataParts(await this.cropped(sourceBlob, aspect));
    const urls = await this.submitAndWait(this.s.image_path,
      { prompt: prompt + "\n\nAvoid: " + negative, reference_images: [b64] }, onProgress);
    return { blob: await this.download(urls[0]), provider_id: urls[0], cost: this.s.image_cost, note: "" };
  }

  // the platform bills per discrete clip length, so an arbitrary request is
  // snapped to the nearest one it accepts and the caller is told
  static SUPPORTED_SECONDS = [5, 10];

  async generateClip(stillBlob, prompt, negative, seconds, aspect, onProgress) {
    const billed = FreepikProvider.SUPPORTED_SECONDS
      .reduce((a, b) => (Math.abs(b - seconds) < Math.abs(a - seconds) ? b : a));
    const b64 = await blobToDataParts(await this.cropped(stillBlob, aspect));
    const urls = await this.submitAndWait(this.s.video_path, {
      image: b64, prompt, negative_prompt: negative, duration: String(billed), cfg_scale: 0.5,
    }, onProgress);
    const blob = await this.download(urls[0]);
    const note = Math.abs(billed - seconds) < 0.05 ? "" :
      `asked for ${seconds.toFixed(1)}s, provider produced and billed ${billed}s`;
    return {
      blob, ext: "mp4", provider_id: urls[0], cost: this.s.video_cost * (billed / 5), note, seconds: billed,
    };
  }
}

export function makeProvider(settings) {
  if (settings.provider === "freepik") return new FreepikProvider(settings);
  return new DemoProvider(settings);
}

/** A cheap round trip that tells the designer whether a real key can be used
    from a browser at all, before a batch is started against it. */
export async function testProvider(settings) {
  if (settings.provider !== "freepik") {
    return { ok: true, detail: "The demo generator runs in this tab. Nothing is sent anywhere and nothing is charged." };
  }
  if (!settings.freepik_api_key) return { ok: false, detail: "No API key set." };
  const url = (settings.base_url || "").replace(/\/+$/, "") + settings.image_path;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "x-freepik-api-key": settings.freepik_api_key, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // Any readable status means the browser was allowed to see the response,
    // which is the thing being tested. A 4xx on an empty body is the expected
    // healthy answer; 401 and 403 mean the key itself is the problem.
    if (r.status === 401 || r.status === 403) {
      return { ok: false, detail: `The API is reachable from this browser, but it rejected the key (${r.status}).` };
    }
    return {
      ok: true,
      detail: `Reachable from this browser: the API replied ${r.status} and the response was readable, ` +
        "so cross-origin calls are allowed. A real generation should work.",
    };
  } catch (e) {
    return { ok: false, detail: explain(e, url).message };
  }
}
