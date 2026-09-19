/* Canvas composition helpers: aspect cropping (Law 6), thumbnails, and the
   title and end cards the final render needs. Nothing here ever extends a
   canvas; a ratio change is always a crop. */

export const RES = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350] };
export const RATIO = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 0.8 };
export const OUTPUT_FPS = 30;

export function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(w) & ~1);
  c.height = Math.max(2, Math.round(h) & ~1);
  return c;
}

/** Law 6: crop, never outpaint. Returns the source rectangle that fills the
    target ratio from the centre. */
export function cropRect(sw, sh, aspect) {
  const want = RATIO[aspect] || sw / sh;
  const have = sw / sh;
  if (Math.abs(have - want) < 1e-3) return { x: 0, y: 0, w: sw, h: sh };
  if (have > want) { const w = Math.round(sh * want); return { x: Math.round((sw - w) / 2), y: 0, w, h: sh }; }
  const h = Math.round(sw / want);
  return { x: 0, y: Math.round((sh - h) / 2), w: sw, h };
}

/** How much of the frame a crop to `aspect` would throw away, as a fraction.
    The intake warns above 15%, which is the point where a designer's framing
    stops surviving the change. */
export function cropLoss(sw, sh, aspect) {
  const r = cropRect(sw, sh, aspect);
  return 1 - (r.w * r.h) / (sw * sh);
}

/** Draw a source cropped to the target ratio, scaled to cover, into a canvas
    of exactly (w, h). */
export function drawCropped(ctx, src, sw, sh, aspect, w, h) {
  const r = cropRect(sw, sh, aspect);
  ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, w, h);
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode that image"));
    img.src = url;
  });
}

export async function blobToImage(blob) {
  const url = URL.createObjectURL(blob);
  try { return await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

export function canvasToBlob(cv, type = "image/jpeg", quality = 0.92) {
  // toBlob hands back null rather than throwing when the browser cannot encode
  // the canvas, which on a phone means it ran out of memory: exactly the case
  // this function exists to handle. Left as null it surfaces three frames later
  // as "could not be decoded as an image", which sends the designer looking at
  // their photo instead of at their device.
  return new Promise((res, rej) => cv.toBlob((b) => {
    if (b) return res(b);
    const e = new Error(`this browser could not encode a ${cv.width}×${cv.height} image, which usually means it has run out of memory. Close other tabs, or add the photos a few at a time.`);
    e.code = "encode";
    rej(e);
  }, type, quality));
}

/** Broadly readable still formats. Anything else is re-encoded on the way in,
    so a project exported from one device opens on another. */
const PORTABLE = /^image\/(jpeg|png|webp)$/i;

/** Prepare a picked photo for use as a hub render.

    A phone camera hands over a 12-megapixel image, and everything downstream
    draws that into a canvas: the analysis, two hero variants, a still per
    shot, then a clip per still. iOS caps how much canvas memory a page may
    hold, so a few full-size photos are enough to have the tab killed with no
    error worth reading. Anything above `maxDim` on its long edge is therefore
    resampled once, here, and the smaller image is what the project keeps.

    That is a resolution change, not a reframe: the whole picture is kept and
    Law 6 is untouched. The caller is told so it can say so.

    An orientation tag is applied by the decode, because an <img> element
    honours EXIF, which is why a photo taken sideways is not stored sideways. */
export async function prepareUpload(file, maxDim = 2048) {
  const img = await blobToImage(file);
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error("that image decoded to nothing");
  const longEdge = Math.max(w, h);
  const s = longEdge > maxDim ? maxDim / longEdge : 1;
  if (s === 1 && PORTABLE.test(file.type)) return { blob: file, img, width: w, height: h, from: null };
  const cv = canvasOf(Math.round(w * s), Math.round(h * s));
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  const blob = await canvasToBlob(cv, "image/jpeg", 0.92);
  return { blob, img: await blobToImage(blob), width: cv.width, height: cv.height, from: s === 1 ? null : [w, h] };
}

/** A thumbnail at a fixed width, used everywhere the UI shows a tile. */
export async function thumbnail(src, sw, sh, maxW = 480) {
  const s = sw > maxW ? maxW / sw : 1;
  const cv = canvasOf(sw * s, sh * s);
  cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);
  return canvasToBlob(cv, "image/jpeg", 0.82);
}

// ------------------------------------------------------------------ cards

const SERIF = '"Iowan Old Style", "Palatino Linotype", Georgia, serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';

const spaced = (s) => (s && s.length < 40 ? s.toUpperCase().split("").join(" ") : s);

function text(ctx, str, x, y, font, colour, alpha, align = "left", baseline = "alphabetic") {
  if (!str) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(str, x, y);
  ctx.restore();
}

/** The spec's card scale: sizes are given for a 1080-wide portrait frame, and
    a 16:9 frame uses its height so the title reads the same size either way. */
const cardScale = (w, h) => (Math.abs(w / h - 16 / 9) < 0.05 ? h / 1080 : w / 1080);

/** Paint the title card content onto a context sized (w, h), following the
    spec's Part 11 defaults: spaced uppercase title at 88px on a 1080-wide
    frame, a smaller subtitle above, a spaced location line near the foot,
    small credits in the top corners at 60%, the disclaimer low and centred,
    the stage stamp boxed bottom-right, and the logo below the title on the end
    card. `alpha` fades the whole card, which is how the minimal style sits
    over footage. `logo` is a decoded Image or null. */
export function paintTitle(ctx, b, w, h, which = "start", alpha = 1, logo = null) {
  const s = cardScale(w, h);
  const cx = w / 2, cy = h / 2;
  const white = "#ffffff", dim = "#e8e2d6";
  const title = which === "start" ? (b.project_name || "Untitled project") : (b.practice_name || b.project_name || "");
  if (b.subtitle && which === "start") {
    text(ctx, b.subtitle, cx, cy - 110 * s, `${Math.round(34 * s)}px ${SANS}`, dim, alpha * 0.6, "center", "middle");
  }
  text(ctx, spaced(title), cx, cy - 10 * s, `${Math.round(88 * s)}px ${SERIF}`, white, alpha * 0.92, "center", "middle");
  if (b.location_line) {
    text(ctx, spaced(b.location_line), cx, h - 140 * s, `${Math.round(26 * s)}px ${SANS}`, dim, alpha * 0.6, "center", "middle");
  }
  // credits in the top corners at 60%
  if (b.practice_name && which === "start") text(ctx, b.practice_name, 48 * s, 48 * s, `${Math.round(26 * s)}px ${SANS}`, dim, alpha * 0.6, "left", "top");
  if (b.year) text(ctx, String(b.year), w - 48 * s, 48 * s, `${Math.round(26 * s)}px ${SANS}`, dim, alpha * 0.6, "right", "top");
  // The disclaimer is what keeps a visualisation from being read as evidence,
  // so it is drawn on the card itself and not left to a caption someone strips.
  if (b.disclaimer) text(ctx, b.disclaimer, cx, h - 96 * s, `${Math.round(22 * s)}px ${SANS}`, white, alpha * 0.55, "center", "middle");
  if (b.stage_stamp) {
    ctx.save();
    ctx.globalAlpha = alpha * 0.85;
    ctx.font = `${Math.round(28 * s)}px ${SANS}`;
    const label = b.stage_stamp.toUpperCase();
    const tw = ctx.measureText(label).width;
    ctx.strokeStyle = white; ctx.lineWidth = Math.max(2, 2 * s);
    ctx.strokeRect(w - tw - 80 * s, h - 90 * s, tw + 40 * s, 50 * s);
    ctx.fillStyle = white; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(label, w - tw - 60 * s, h - 65 * s);
    ctx.restore();
  }
  if (which === "end" && logo && logo.naturalWidth) {
    const lw = Math.round(w * 0.18), lh = Math.round((logo.naturalHeight * lw) / logo.naturalWidth);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(logo, Math.round((w - lw) / 2), Math.round(cy + 80 * s), lw, lh);
    ctx.restore();
  }
}

/** The solid card style: paint the background first, then the same content. */
export function paintSolidCard(ctx, b, w, h, which, alpha, logo) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#0e0e10";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  paintTitle(ctx, b, w, h, which, alpha, logo);
}

/** The persistent lower-third variant, and the every-frame disclaimer. */
export function paintOverlay(ctx, b, w, h, showLowerThird, everyFrame) {
  const k = w / 1920;
  if (showLowerThird && (b.project_name || b.practice_name)) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.round(34 * k)}px ${SERIF}`;
    ctx.fillText(b.project_name || "", 70 * k, h - 96 * k);
    ctx.fillStyle = "#d9b46a";
    ctx.font = `${Math.round(19 * k)}px ${SANS}`;
    ctx.fillText(spaced(b.practice_name || ""), 70 * k, h - 62 * k);
    ctx.restore();
  }
  if (everyFrame && b.disclaimer) {
    // lower corner at 50%, as the spec has it for planning and consultation films
    const s = cardScale(w, h);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.round(22 * s)}px ${SANS}`;
    ctx.fillText(b.disclaimer, 40 * s, h - 40 * s);
    ctx.restore();
  }
}
