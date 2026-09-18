/* Turning a canvas into a video file.

   The server pipeline shelled out to ffmpeg. In a browser the equivalent that
   needs nothing downloaded is MediaRecorder over a canvas capture stream, so
   every clip and the final film are recorded in real time from what is drawn.

   Real time is the honest cost of this: a 45 second film takes 45 seconds to
   write out, and the page shows it happening rather than pretending otherwise.
   The container is whatever the browser will encode. mp4/H.264 is asked for
   first because that is what a client can drop into a slide deck; Chrome and
   Safari give it, Firefox falls back to WebM and the UI says which one it
   produced instead of leaving the designer to discover it at the other end. */

const MP4 = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.42E01E", "video/mp4"];
const WEBM = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9", "video/webm"];

/** What a recording actually turned out to be.

    isTypeSupported is not a promise about the bytes. A Chromium built without
    the proprietary encoders answers true for an H.264 mp4 and then writes VP9
    into an mp4 container, which is a file QuickTime, PowerPoint and most
    editors refuse while its name says they should not. So the produced file is
    read back and its codec taken from the bytes. The fourcc sits in the sample
    description near the front of a fragmented mp4; WebM names its codec in
    plain ASCII in the track entry. */
export async function sniff(blob) {
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const ascii = (() => {
    let s = "";
    for (let i = 0; i < head.length; i++) s += String.fromCharCode(head[i]);
    return s;
  })();
  const isMp4 = ascii.indexOf("ftyp") === 4 || ascii.includes("ftyp");
  const isWebm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  let codec = "unknown";
  if (ascii.includes("avc1") || ascii.includes("avcC")) codec = "h264";
  else if (ascii.includes("hvc1") || ascii.includes("hev1")) codec = "h265";
  else if (ascii.includes("vp09") || ascii.includes("V_VP9")) codec = "vp9";
  else if (ascii.includes("V_VP8")) codec = "vp8";
  else if (ascii.includes("av01") || ascii.includes("V_AV1")) codec = "av1";
  const container = isWebm ? "webm" : isMp4 ? "mp4" : "unknown";
  return {
    container, codec,
    // an mp4 is only worth the name when it holds a codec an mp4 is expected
    // to hold; anything else belongs in a WebM so the extension does not lie
    interoperable: container === "mp4" && (codec === "h264" || codec === "h265"),
    label: `${codec.toUpperCase()} in ${container.toUpperCase()}`,
  };
}

let _probe = null;

/** Record a fraction of a second and look at the result, so the real answer is
    known before a film is committed to. Done once per page. */
export async function probe() {
  if (_probe) return _probe;
  if (typeof MediaRecorder === "undefined") return (_probe = { mime: null, info: null });
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const ctx = cv.getContext("2d");
  const candidates = [...MP4, ...WEBM].filter((m) => MediaRecorder.isTypeSupported(m));
  let webmFallback = null, anyFallback = null;
  for (const mime of candidates) {
    try {
      const stream = cv.captureStream(10);
      const chunks = [];
      const rec = new MediaRecorder(stream, { mimeType: mime });
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const done = new Promise((r) => { rec.onstop = r; });
      rec.start();
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i % 2 ? "#fff" : "#000";
        ctx.fillRect(0, 0, 64, 64);
        await new Promise((r) => setTimeout(r, 40));
      }
      rec.stop();
      await done;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size) continue;
      const info = await sniff(blob);
      if (info.interoperable) return (_probe = { mime, info });
      // A VP9 stream inside an mp4 is the worst outcome: the extension promises
      // something the file cannot deliver. The same codec in a WebM is at least
      // honest and plays everywhere a browser does, so it wins the fallback.
      if (!webmFallback && info.container === "webm") webmFallback = { mime, info };
      if (!anyFallback && info.container !== "unknown") anyFallback = { mime, info };
    } catch { /* try the next candidate */ }
  }
  return (_probe = webmFallback || anyFallback || { mime: candidates[0] || null, info: null });
}

/** The container this browser can record, as far as isTypeSupported knows.
    Prefer `probe` where the real answer matters. */
export function pickMime(withAudio = true) {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of [...MP4, ...WEBM]) {
    if (MediaRecorder.isTypeSupported(m)) {
      if (!withAudio && m.includes("opus")) continue;
      return m;
    }
  }
  return null;
}

export const extFor = (mime) => (mime && mime.startsWith("video/mp4") ? "mp4" : "webm");

/** Record `draw(t)` for `seconds` at `fps` into a video Blob.

    `draw` is called once per animation frame with the elapsed time in seconds
    and must paint the whole canvas. An optional audio MediaStreamTrack is
    mixed in, which is how the ambience bed reaches the final film. */
export async function record(canvas, seconds, fps, draw, { audioTrack = null, onProgress = null } = {}) {
  const { mime } = await probe();
  if (!mime) throw new Error("this browser cannot record video (MediaRecorder is unavailable)");
  const stream = canvas.captureStream(fps);
  if (audioTrack) stream.addTrack(audioTrack);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const stopped = new Promise((resolve, reject) => {
    rec.onstop = resolve;
    rec.onerror = (e) => reject(new Error("recording failed: " + (e.error && e.error.name)));
  });

  rec.start(200);
  // A background tab has its animation frames throttled to roughly one a
  // second, so the canvas stops changing while the recorder keeps running in
  // wall-clock time: the file comes out the right length with the picture
  // frozen. That is worth catching and saying rather than shipping.
  //
  // On a phone this is not an edge case, it is what happens when the screen
  // times out halfway through a 45-second render. A wake lock keeps the screen
  // on for the duration and is released whatever happens next. It is not
  // available everywhere, and where it is missing the visibility check below
  // still catches the damage rather than saving a frozen film.
  let lock = null;
  try {
    if (navigator.wakeLock && !document.hidden) lock = await navigator.wakeLock.request("screen");
  } catch { /* denied or unsupported: the visibility check is the backstop */ }

  let wasHidden = document.hidden;
  const watch = () => { if (document.hidden) wasHidden = true; };
  document.addEventListener("visibilitychange", watch);

  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= seconds) { draw(seconds); resolve(); return; }
      draw(t);
      if (onProgress) onProgress(t / seconds);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  document.removeEventListener("visibilitychange", watch);
  if (lock) { try { await lock.release(); } catch { /* already gone */ } }
  // let the encoder drain the last frames before the track is torn down
  await new Promise((r) => setTimeout(r, 250));
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => { if (t.kind === "video") t.stop(); });
  const blob = new Blob(chunks, { type: mime });
  if (!blob.size) throw new Error("the recorder produced an empty file");
  if (wasHidden) {
    throw new Error(
      "this tab left the foreground while the video was being written, so the picture will have frozen " +
      "while the clock kept running. Nothing was kept. On a phone that usually means the screen locked or " +
      "you switched apps: start it again and leave it on screen."
    );
  }
  // Name the file after what is actually inside it, not what was asked for.
  const info = await sniff(blob);
  const ext = info.container === "mp4" && info.interoperable ? "mp4" : (info.container === "webm" ? "webm" : extFor(mime));
  return { blob, mime, ext, info };
}
