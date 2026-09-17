/* Pixel maths. A port of backend/app/services/analysis/frames.py with no
   dependencies: every operation here is written against a plain
   {w, h, data: Uint8ClampedArray RGBA} image so the whole engine runs from a
   static host with nothing to download.

   Where the Python used OpenCV the substitute is named in the comment, along
   with what it costs. Canny is reimplemented in full, suppression included,
   because the thresholds it is called with are absolute and a looser edge
   detector does not just add noise, it moves every similarity score; those
   numbers are checked against the server's on the same images. HoughLinesP for
   the vertical check became a median over edge-pixel gradient orientations,
   which answers that question directly. ECC affine alignment became a coarse
   search over translation and scale, which covers the slow push and sway an
   image-to-video model produces and nothing more. */

export function imgFromCanvas(cv) {
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, cv.width, cv.height);
  return { w: cv.width, h: cv.height, data: d.data };
}

export function blankCanvas(w, h) {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
}

export function drawToImg(source, maxW) {
  // source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
  const sw = source.naturalWidth || source.videoWidth || source.width;
  const sh = source.naturalHeight || source.videoHeight || source.height;
  const s = sw > maxW ? maxW / sw : 1;
  const cv = blankCanvas(Math.round(sw * s), Math.round(sh * s));
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, cv.width, cv.height);
  return imgFromCanvas(cv);
}

export function imgToCanvas(img) {
  const cv = blankCanvas(img.w, img.h);
  cv.getContext("2d").putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  return cv;
}

// ---------------------------------------------------------------- basics

/** Float32 luminance plane, 0..255, BT.601 like cv2.COLOR_BGR2GRAY. */
export function gray(img) {
  const n = img.w * img.h, g = new Float32Array(n), d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return g;
}

export function luminance(img) {
  const g = gray(img);
  let s = 0;
  for (let i = 0; i < g.length; i++) s += g[i];
  return s / g.length / 255;
}

/** HSV per pixel, matching OpenCV ranges rescaled to h 0..360, s 0..1, v 0..1. */
function hsvAt(d, j) {
  const r = d[j] / 255, g = d[j + 1] / 255, b = d[j + 2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  let h = 0;
  if (c > 1e-6) {
    if (mx === r) h = 60 * (((g - b) / c) % 6);
    else if (mx === g) h = 60 * ((b - r) / c + 2);
    else h = 60 * ((r - g) / c + 4);
  }
  if (h < 0) h += 360;
  return [h, mx > 0 ? c / mx : 0, mx];
}

export function saturation(img) {
  const d = img.data;
  let s = 0;
  for (let j = 0; j < d.length; j += 4) s += hsvAt(d, j)[1];
  return s / (d.length / 4);
}

/** Red minus blue, normalised to -1..1. Positive is warm. */
export function warmth(img) {
  const d = img.data;
  let r = 0, b = 0;
  for (let j = 0; j < d.length; j += 4) { r += d[j]; b += d[j + 2]; }
  const n = d.length / 4;
  return (r / n - b / n) / 255;
}

/** Saturation-weighted circular mean hue, in degrees. */
export function meanHueDeg(img) {
  const d = img.data;
  let x = 0, y = 0;
  for (let j = 0; j < d.length; j += 4) {
    const [h, s] = hsvAt(d, j);
    const a = (h * Math.PI) / 180;
    x += Math.cos(a) * s; y += Math.sin(a) * s;
  }
  if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6) return 0;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function hueDiffDeg(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** Fraction of the top band that reads as sky: bluish, or a very bright flat
    unsaturated area clearly brighter than the rest. A neutral ceiling fails
    both tests, which is what keeps an interior from being read as exterior. */
export function skyFraction(img, band = 0.35) {
  const bandH = Math.max(1, Math.round(img.h * band));
  const d = img.data;
  let whole = 0;
  for (let j = 0; j < d.length; j += 4) whole += 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  whole = whole / (d.length / 4) / 255;
  let vSum = 0, count = 0;
  const vals = new Float32Array(bandH * img.w);
  const sats = new Float32Array(bandH * img.w);
  const bluish = new Uint8Array(bandH * img.w);
  for (let y = 0; y < bandH; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x, j = i * 4;
      const [, s, v] = hsvAt(d, j);
      vals[i] = v; sats[i] = s; vSum += v; count++;
      if (d[j + 2] > d[j] + 8 && d[j + 2] >= d[j + 1] && v > 0.35) bluish[i] = 1;
    }
  }
  const margin = vSum / count - whole;
  let hit = 0;
  for (let i = 0; i < bluish.length; i++) {
    if (bluish[i] || (margin > 0.2 && vals[i] > 0.78 && sats[i] < 0.12)) hit++;
  }
  return hit / bluish.length;
}

/** k-means on a 64x64 thumbnail; returns hex strings, most common first. */
export function dominantColours(img, k = 4) {
  const cv = imgToCanvas(img), small = blankCanvas(64, 64);
  small.getContext("2d").drawImage(cv, 0, 0, 64, 64);
  const d = small.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, 64, 64).data;
  const pts = [];
  for (let j = 0; j < d.length; j += 4) pts.push([d[j], d[j + 1], d[j + 2]]);
  let cent = [];
  for (let i = 0; i < k; i++) cent.push(pts[Math.floor((i + 0.5) * pts.length / k)].slice());
  let labels = new Int32Array(pts.length);
  for (let iter = 0; iter < 12; iter++) {
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = (pts[i][0] - cent[c][0]) ** 2 + (pts[i][1] - cent[c][1]) ** 2 + (pts[i][2] - cent[c][2]) ** 2;
        if (dd < bd) { bd = dd; best = c; }
      }
      labels[i] = best;
    }
    const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const c = labels[i];
      sum[c][0] += pts[i][0]; sum[c][1] += pts[i][1]; sum[c][2] += pts[i][2]; sum[c][3]++;
    }
    cent = sum.map((s, c) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cent[c]));
  }
  const counts = new Array(k).fill(0);
  for (let i = 0; i < labels.length; i++) counts[labels[i]]++;
  return cent
    .map((c, i) => [counts[i], c])
    .sort((a, b) => b[0] - a[0])
    .map(([, c]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""));
}

// ---------------------------------------------------------------- edges

/** Sobel magnitude and orientation on a Float32 gray plane. */
export function sobel(g, w, h) {
  const mag = new Float32Array(w * h), ang = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = g[i - w - 1], t = g[i - w], tr = g[i - w + 1];
      const l = g[i - 1], r = g[i + 1];
      const bl = g[i + w - 1], b = g[i + w], br = g[i + w + 1];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * b + br - tl - 2 * t - tr;
      mag[i] = Math.hypot(gx, gy);
      ang[i] = Math.atan2(gy, gx);
    }
  }
  return { mag, ang };
}

/** A true 3x3 Gaussian, matching cv2.GaussianBlur(g, (3,3), 0) where OpenCV
    derives sigma 0.8 from the kernel size. The generic box blur below is much
    wider than that, and using it here smeared a facade edge across seven
    pixels, which cut the measured gradient by roughly three and made the edge
    map collapse on any darker frame. */
export function gaussianSmall(g, w, h) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = x > 0 ? g[i - 1] : g[i], r = x < w - 1 ? g[i + 1] : g[i];
      tmp[i] = (l + 2 * g[i] + r) / 4;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = y > 0 ? tmp[i - w] : tmp[i], b = y < h - 1 ? tmp[i + w] : tmp[i];
      out[i] = (t + 2 * tmp[i] + b) / 4;
    }
  }
  return out;
}

/** Binary edge map: cv2.Canny, reimplemented. Gaussian, Sobel, the L1
    gradient OpenCV uses by default, non-maximum suppression, then hysteresis
    between a low and a high threshold. Returns Uint8Array of 0/1.

    The suppression step is what keeps this comparable to the server's
    numbers. Without it the edges come out several pixels thick, which inflates
    every similarity score on a bright image and leaves nothing to match on a
    dark one. */
export function edgeMap(g, w, h, lo = 60, hi = 160) {
  const sm = gaussianSmall(g, w, h);
  const mag = new Float32Array(w * h), dir = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = sm[i - w - 1], t = sm[i - w], tr = sm[i - w + 1];
      const l = sm[i - 1], r = sm[i + 1];
      const bl = sm[i + w - 1], b = sm[i + w], br = sm[i + w + 1];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * b + br - tl - 2 * t - tr;
      mag[i] = Math.abs(gx) + Math.abs(gy);    // L1, as cv2.Canny(L2gradient=False)
      const a = (Math.atan2(gy, gx) * 180) / Math.PI;
      const q = ((a % 180) + 180) % 180;
      dir[i] = q < 22.5 || q >= 157.5 ? 0 : q < 67.5 ? 1 : q < 112.5 ? 2 : 3;
    }
  }
  const thin = new Float32Array(w * h);
  const step = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const [dx, dy] = step[dir[i]];
      const a = mag[i - dy * w - dx], b = mag[i + dy * w + dx];
      if (mag[i] >= a && mag[i] >= b) thin[i] = mag[i];
    }
  }
  const out = new Uint8Array(w * h);
  const stack = [];
  for (let i = 0; i < thin.length; i++) if (thin[i] >= hi) { out[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!out[j] && thin[j] >= lo) { out[j] = 1; stack.push(j); }
      }
    }
  }
  return out;
}

/** Separable box blur repeated 3 times: a cheap Gaussian. */
export function blur(g, w, h, radius) {
  if (radius <= 0) return g;
  let src = g;
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= w) continue;
          s += src[y * w + xx]; n++;
        }
        tmp[y * w + x] = s / n;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= h) continue;
          s += tmp[yy * w + x]; n++;
        }
        out[y * w + x] = s / n;
      }
    }
    src = out;
  }
  return src;
}

export function dilate(mask, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

/** IoU of dilated edge maps after aligning g1 onto g0. Tolerates a few pixels
    of handheld drift, catches structural change. `exclude` masks pixels that
    should not count (moving particles). */
export function edgeSimilarity(g0, g1, w, h, tolPx = 3, exclude = null) {
  const a = alignTo(g0, g1, w, h);
  const e0 = edgeMap(g0, w, h), e1 = edgeMap(a, w, h);
  if (exclude) {
    for (let i = 0; i < e0.length; i++) if (exclude[i]) { e0[i] = 0; e1[i] = 0; }
  }
  const d0 = dilate(e0, w, h, tolPx), d1 = dilate(e1, w, h, tolPx);
  let inter = 0, union = 0;
  for (let i = 0; i < e0.length; i++) {
    if (e0[i] && d1[i]) inter++;
    if (e1[i] && d0[i]) inter++;
    union += e0[i] + e1[i];
  }
  return union ? inter / union : 1;
}

/** Fraction of edges in gNew with no counterpart in gRef: a proxy for
    invented elements. */
export function newEdgeFraction(gRef, gNew, w, h, tolPx = 4) {
  const eRef = edgeMap(gRef, w, h), eNew = edgeMap(gNew, w, h);
  const dRef = dilate(eRef, w, h, tolPx);
  let n = 0, fresh = 0;
  for (let i = 0; i < eNew.length; i++) {
    if (!eNew[i]) continue;
    n++;
    if (!dRef[i]) fresh++;
  }
  return n ? fresh / n : 0;
}

/** Median angle of near-vertical edges, in degrees from vertical, or null
    when there is no vertical structure to measure.

    The Python used HoughLinesP and took the median line angle. Here the same
    question is answered from gradient orientation: a vertical edge has a
    horizontal gradient. Strong edges whose orientation is within 15 degrees
    of that are collected and their median deviation returned. `exclude` masks
    pixels that are not building structure, because rain and snow are
    near-vertical by construction and would otherwise be measured as a
    leaning facade. */
export function verticalAngleDeg(g, w, h, exclude = null) {
  const { mag, ang } = sobel(gaussianSmall(g, w, h), w, h);
  // only pixels the edge detector actually kept, so the median is taken over
  // real structure rather than over every mildly textured pixel
  const edges = edgeMap(g, w, h);
  const angs = [];
  for (let i = 0; i < mag.length; i++) {
    if (!edges[i]) continue;
    if (exclude && exclude[i]) continue;
    // gradient angle 0 or 180 means a vertical edge; convert to degrees off vertical
    let a = (ang[i] * 180) / Math.PI;
    a = ((a + 90) % 180) - 90;   // -90..90, 0 = horizontal gradient = vertical edge
    if (Math.abs(a) < 15) angs.push(a);
  }
  if (angs.length < 40) return null;
  angs.sort((x, y) => x - y);
  return angs[angs.length >> 1];
}

/** Coarse alignment of `img` onto `ref` over translation and uniform scale.
    Stands in for cv2.findTransformECC with MOTION_AFFINE. An image-to-video
    model produces a slow push and a few pixels of sway, which is exactly
    translation plus scale; anything beyond that is the structural change the
    QC is trying to catch, so not modelling it is deliberate. */
export function alignTo(ref, img, w, h) {
  const step = Math.max(1, Math.round(Math.min(w, h) / 80));
  const sw = Math.ceil(w / step), sh = Math.ceil(h / step);
  // Normalise both planes to zero mean and unit variance before matching.
  // ECC, which this replaces, is invariant to a change in brightness and
  // contrast by construction; a raw difference is not, so a season regrade
  // dominated the score and the search settled on a wrong scale, which threw
  // the edges apart and read as a structural change that had not happened.
  const dsRef = normalise(downsample(ref, w, h, step));
  const dsImg = normalise(downsample(img, w, h, step));
  let best = { dx: 0, dy: 0, s: 1, cost: Infinity };
  for (const s of [0.98, 0.99, 1.0, 1.01, 1.02]) {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const c = sad(dsRef, dsImg, sw, sh, dx, dy, s, best.cost);
        if (c < best.cost) best = { dx, dy, s, cost: c };
      }
    }
  }
  if (best.cost === Infinity) return img;
  return warp(img, w, h, best.dx * step, best.dy * step, best.s);
}

function normalise(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length || 1;
  let v = 0;
  for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2;
  const sd = Math.sqrt(v / (a.length || 1)) || 1;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - m) / sd;
  return out;
}

function downsample(g, w, h, step) {
  const sw = Math.ceil(w / step), sh = Math.ceil(h / step);
  const out = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) out[y * sw + x] = g[Math.min(h - 1, y * step) * w + Math.min(w - 1, x * step)];
  return out;
}

function sad(a, b, w, h, dx, dy, s, bail) {
  let total = 0, n = 0;
  const cx = w / 2, cy = h / 2;
  for (let y = 2; y < h - 2; y += 2) {
    for (let x = 2; x < w - 2; x += 2) {
      const sx = Math.round((x - cx) * s + cx + dx), sy = Math.round((y - cy) * s + cy + dy);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      total += Math.abs(a[y * w + x] - b[sy * w + sx]);
      n++;
    }
    if (n > 200 && total / n > bail) return Infinity;
  }
  return n ? total / n : Infinity;
}

function warp(g, w, h, dx, dy, s) {
  const out = new Float32Array(w * h);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx = Math.round((x - cx) * s + cx + dx), sy = Math.round((y - cy) * s + cy + dy);
      sx = Math.min(w - 1, Math.max(0, sx)); sy = Math.min(h - 1, Math.max(0, sy));
      out[y * w + x] = g[sy * w + sx];
    }
  }
  return out;
}

// ---------------------------------------------------------------- shapes

/** Connected components on a binary mask. Returns {labels, stats:[{x,y,w,h,area}]}
    with label 0 reserved for background, matching connectedComponentsWithStats. */
export function connectedComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stats = [{ x: 0, y: 0, w: 0, h: 0, area: 0 }];
  const q = new Int32Array(w * h);
  let next = 1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    const id = next++;
    let head = 0, tail = 0;
    q[tail++] = i; labels[i] = id;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
    while (head < tail) {
      const p = q[head++], px = p % w, py = (p / w) | 0;
      area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (mask[j] && !labels[j]) { labels[j] = id; q[tail++] = j; }
        }
      }
    }
    stats.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return { labels, stats, count: next };
}

/** High-pass energy: |g - blur(g)|. */
export function highpass(g, w, h, radius = 2) {
  const b = blur(g, w, h, radius), out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = Math.abs(g[i] - b[i]);
  return out;
}

/** Long straight lines in a frame: facade edges, joinery, roads. The Python
    used HoughLinesP; here a run-length scan along rows, columns and both
    diagonals finds runs of edge pixels longer than the same minimum length,
    which is what that Hough call was configured to return. */
export function structureMask(g, w, h, tolPx = 3) {
  const e = edgeMap(g, w, h);
  const minLen = Math.max(20, Math.floor(Math.min(w, h) / 5));
  const keep = new Uint8Array(w * h);
  const scan = (idxOf, steps, count) => {
    for (let s = 0; s < count; s++) {
      let run = 0;
      for (let t = 0; t < steps(s); t++) {
        const i = idxOf(s, t);
        if (i >= 0 && e[i]) run++;
        else {
          if (run >= minLen) for (let k = 1; k <= run; k++) keep[idxOf(s, t - k)] = 1;
          run = 0;
        }
      }
      if (run >= minLen) for (let k = 1; k <= run; k++) keep[idxOf(s, steps(s) - k)] = 1;
    }
  };
  scan((y, x) => y * w + x, () => w, h);                       // rows
  scan((x, y) => y * w + x, () => h, w);                       // columns
  scan((d, t) => { const x = t, y = t - d + h; return (y >= 0 && y < h && x < w) ? y * w + x : -1; }, () => Math.max(w, h), w + h);
  scan((d, t) => { const x = t, y = d - t; return (y >= 0 && y < h && x < w) ? y * w + x : -1; }, () => Math.max(w, h), w + h);
  return dilate(keep, w, h, tolPx);
}

/** Small high-pass components: rain streaks, snow flakes, petals, drifting
    leaves. Single-pixel grain and large blobs are excluded. Only meaningful
    inside the sky or glazing band, where facade texture does not reach. */
export function particleMask(g, w, h, structure, thr = 12) {
  const hp = highpass(g, w, h);
  const m = new Uint8Array(w * h);
  for (let i = 0; i < hp.length; i++) if (hp[i] > thr && !(structure && structure[i])) m[i] = 1;
  const { labels, stats } = connectedComponents(m, w, h);
  const keep = new Uint8Array(stats.length);
  for (let i = 1; i < stats.length; i++) {
    const s = stats[i];
    if (s.area >= 3 && s.area <= 300 && Math.max(s.w, s.h) <= 80) keep[i] = 1;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = keep[labels[i]];
  return out;
}

export function meanOf(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
}

export function percentile(arr, p) {
  const a = Float32Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor((p / 100) * a.length)))];
}

/** 16x8x8 HSV histogram, L1 normalised, for shot-boundary comparison. */
export function hsvHistogram(img) {
  const bins = new Float32Array(16 * 8 * 8), d = img.data;
  for (let j = 0; j < d.length; j += 4) {
    const [h, s, v] = hsvAt(d, j);
    const hi = Math.min(15, Math.floor((h / 360) * 16));
    const si = Math.min(7, Math.floor(s * 8));
    const vi = Math.min(7, Math.floor(v * 8));
    bins[hi * 64 + si * 8 + vi]++;
  }
  let t = 0;
  for (let i = 0; i < bins.length; i++) t += bins[i];
  if (t) for (let i = 0; i < bins.length; i++) bins[i] /= t;
  return bins;
}

/** Bhattacharyya distance, as cv2.HISTCMP_BHATTACHARYYA returns it. */
export function bhattacharyya(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]);
  return Math.sqrt(Math.max(0, 1 - s));
}

/** Translation between two gray planes, as cv2.phaseCorrelate is used in the
    reference analysis: only the magnitude of the shift is consumed there, so
    a coarse search is enough. */
export function shiftMagnitude(a, b, w, h) {
  const step = Math.max(1, Math.round(Math.min(w, h) / 60));
  const sw = Math.ceil(w / step), sh = Math.ceil(h / step);
  const da = normalise(downsample(a, w, h, step)), db = normalise(downsample(b, w, h, step));
  let best = { d: 0, cost: Infinity };
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const c = sad(da, db, sw, sh, dx, dy, 1, best.cost);
      if (c < best.cost) best = { d: Math.hypot(dx, dy) * step, cost: c };
    }
  }
  return best.cost === Infinity ? 0 : best.d;
}
