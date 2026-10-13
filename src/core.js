// Core math, RNG and utility helpers. Pure functions — testable in Node.

export const TAU = Math.PI * 2;

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
export function dist2(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }

export function angleLerp(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

// Mulberry32 seeded RNG
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Catmull-Rom spline (for smooth gridless roads through control points) ----
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

// Sample a Catmull-Rom curve through pts into an even-ish polyline.
// pts: [[x,y], ...]. Returns { pts: [[x,y]...], segIdx: [i...] } where segIdx[k]
// is the index of the control segment (pts[i] -> pts[i+1]) that sample k lies on.
export function splinePoints(pts, segLen = 14) {
  if (pts.length < 2) return { pts: pts.map(p => p.slice()), segIdx: pts.map(() => 0) };
  if (pts.length === 2) return { pts: pts.map(p => p.slice()), segIdx: [0, 0] };
  const out = [];
  const segIdx = [];
  const ext = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = ext[i], p1 = ext[i + 1], p2 = ext[i + 2], p3 = ext[i + 3];
    const segD = dist(p1[0], p1[1], p2[0], p2[1]);
    const steps = Math.max(2, Math.ceil(segD / segLen));
    for (let s = 0; s < steps; s++) {
      out.push(catmullRom(p0, p1, p2, p3, s / steps));
      segIdx.push(i);
    }
  }
  out.push(pts[pts.length - 1].slice());
  segIdx.push(pts.length - 2);
  return { pts: out, segIdx };
}

// Cumulative arc lengths of a polyline. Returns {pts, cum, total}
export function polylineLengths(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return { cum, total: cum[cum.length - 1] };
}

// Point + tangent at arc-length s along polyline. Returns {x, y, dir} dir in radians.
export function pointAt(pts, cum, s) {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0, dir: 0 };
  if (s <= 0) {
    const d = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]);
    return { x: pts[0][0], y: pts[0][1], dir: d };
  }
  if (s >= cum[n - 1]) {
    const a = pts[n - 2], b = pts[n - 1];
    return { x: b[0], y: b[1], dir: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }
  // binary search
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
  const a = pts[lo], b = pts[hi];
  return { x: lerp(a[0], b[0], t), y: lerp(a[1], b[1], t), dir: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

// Project point onto polyline; returns {s, d} arc-length position and distance.
export function projectOnPolyline(pts, cum, px, py) {
  let best = { s: 0, d: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1];
    const abx = bx - ax, aby = by - ay;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
    t = clamp(t, 0, 1);
    const qx = ax + abx * t, qy = ay + aby * t;
    const d = dist(px, py, qx, qy);
    if (d < best.d) best = { s: cum[i - 1] + Math.sqrt(len2) * t, d };
  }
  return best;
}

// ---- Value noise (smooth seeded field for terrain) ----
export function makeNoise2D(rng, size = 256) {
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const at = (x, y) => grid[((y & (size - 1)) * size + (x & (size - 1)))];
  const smooth = (t) => t * t * (3 - 2 * t);
  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    return lerp(
      lerp(at(xi, yi), at(xi + 1, yi), u),
      lerp(at(xi, yi + 1), at(xi + 1, yi + 1), u),
      v
    );
  };
}

// Fractal (multi-octave) noise
export function fbm(noise, x, y, octaves = 4, lac = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / norm;
}

// Point-segment distance (for snapping / hit tests)
export function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = clamp(t, 0, 1);
  return { d: dist(px, py, ax + abx * t, ay + aby * t), t };
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}
