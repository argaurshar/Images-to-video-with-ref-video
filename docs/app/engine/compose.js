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
  return new Promise((r) => cv.toBlob(r, type, quality));
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

function centreText(ctx, text, x, y, font, colour, alpha = 1) {
  if (!text) return 0;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
  ctx.restore();
  return 1;
}

/** Paint the title card content onto a context sized (w, h). `alpha` fades the
    whole card, which is how the minimal style sits over the footage. */
export function paintTitle(ctx, b, w, h, which = "start", alpha = 1) {
  const k = w / 1920;
  const cx = w / 2;
  let y = h * (which === "start" ? 0.42 : 0.40);
  const name = which === "start" ? (b.project_name || "") : (b.practice_name || "");
  centreText(ctx, name, cx, y, `${Math.round(62 * k)}px ${SERIF}`, "#ffffff", alpha);
  y += 62 * k * 1.5;
  if (which === "start") {
    centreText(ctx, spaced(b.practice_name || ""), cx, y, `${Math.round(24 * k)}px ${SANS}`, "#e8e2d6", alpha * 0.92);
    y += 24 * k * 2;
    const line = [b.location_line, b.year].filter(Boolean).join("  ·  ");
    centreText(ctx, line, cx, y, `${Math.round(22 * k)}px ${SANS}`, "#cfc7b8", alpha * 0.85);
    y += 22 * k * 2;
    centreText(ctx, b.subtitle || "", cx, y, `${Math.round(22 * k)}px ${SANS}`, "#cfc7b8", alpha * 0.8);
  }
  if (b.stage_stamp) {
    centreText(ctx, spaced(b.stage_stamp), cx, h * 0.80, `${Math.round(20 * k)}px ${SANS}`, "#d9b46a", alpha * 0.95);
  }
  // The disclaimer is what keeps a visualisation from being read as evidence,
  // so it is drawn on the card itself and not left to a caption someone strips.
  centreText(ctx, b.disclaimer || "", cx, h * 0.88, `${Math.round(19 * k)}px ${SANS}`, "#b9b2a5", alpha * 0.9);
}

/** The persistent lower-third variant, and the every-frame disclaimer. */
export function paintOverlay(ctx, b, w, h, showLowerThird) {
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
  if (b.disclaimer_every_frame && b.disclaimer) {
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.round(17 * k)}px ${SANS}`;
    ctx.fillText(b.disclaimer, w - 40 * k, h - 32 * k);
    ctx.restore();
  }
}
