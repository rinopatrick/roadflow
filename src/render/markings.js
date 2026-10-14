// Lane marking decisions for road rendering (S02.3a).
//
// Why this is a separate pure module
// ----------------------------------
// The marking rules were inline in `_drawEdgeFill` and violated two explicit
// DESIGN section 3 rules:
//
//   1. "do not paint lane lines beyond pavement or through intersection centre"
//      — lane dashes were drawn along the FULL polyline, while only the yellow
//      centreline was trimmed, so dashes ran into every junction mouth.
//   2. "At low zoom hide dashes rather than painting noisy hairlines" — the dash
//      pattern was `6 * zoom` wide with no lower bound, so at zoom 0.12 a dash
//      was 0.72px and the road dissolved into speckle.
//
// Keeping the decisions here (offsets, trim, zoom gating) means they can be
// tested numerically without a canvas, and the renderer only decides how to
// stroke them. Every value still comes from `roadDimensions`, which remains the
// single source of pavement and lane geometry.
import { roadDimensions } from '../roadProfiles.js';

/**
 * Below this zoom, lane divider dashes are omitted entirely.
 *
 * Chosen above the minimum camera zoom (0.12) so the speckle range is excluded,
 * and below 1 so normal play always shows dashes.
 */
export const DASH_MIN_ZOOM = 0.35;

/** Dash pattern length in world units (on, off). Scaled by zoom when stroked. */
export const DASH_ON = 6;
export const DASH_OFF = 6;

/** Stroke widths in world units. Scaled by zoom when stroked. */
export const DASH_WIDTH = 1.1;
export const CENTRELINE_WIDTH = 1.2;

/**
 * Distance to pull markings back from each end of an edge, in world units.
 *
 * Grows with pavement width because a wider road occupies more of the junction
 * mouth it meets. S02.3b replaces this with a per-endpoint trim derived from the
 * connected edges' widths and tangent directions; this is the conservative
 * width-only rule that keeps markings out of the junction in the meantime.
 */
export function markingTrim(dim) {
  return dim.width * 0.75 + 3;
}

/**
 * Clamps a trim so markings can never invert or disappear on a short edge.
 *
 * Without this, an edge shorter than `2 * trim` produced `endTrim < trim` and
 * the marking silently vanished instead of being drawn short.
 */
export function clampTrim(trim, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  return Math.max(0, Math.min(trim, length / 2 - 0.5));
}

/**
 * Lateral offsets of the interior lane dividers, in world units.
 *
 * Empty when there is nothing to divide: a one-way road has no centre division,
 * and a two-lane two-way road's median IS its centreline. For asymmetric
 * profiles the wider side decides how many dividers exist.
 */
export function laneDividerOffsets(dim) {
  if (dim.medianWidth <= 0) return [];
  // A two-lane two-way road needs no guard here: `perSide` is 1, so the loop
  // below never runs and the median IS its centreline.
  const offsets = [];
  const perSide = Math.max(dim.forward, dim.backward);
  for (let i = 1; i < perSide; i++) {
    offsets.push(dim.medianWidth / 2 + i * dim.laneWidth);
  }
  return offsets;
}

/**
 * Everything the renderer needs to stroke an edge's markings.
 *
 * @param {object|string} edgeOrClass edge (with `.cls`) or class name
 * @param {number} zoom current camera zoom
 * @param {number} [length] edge length in world units, for trim clamping
 */
export function laneMarkings(edgeOrClass, zoom, length = Infinity) {
  const dim = roadDimensions(edgeOrClass);
  return {
    trim: clampTrim(markingTrim(dim), length),
    showDashes: zoom >= DASH_MIN_ZOOM,
    dash: [DASH_ON * zoom, DASH_OFF * zoom],
    dashWidth: DASH_WIDTH * zoom,
    dividerOffsets: laneDividerOffsets(dim),
    showCentreline: dim.medianWidth > 0,
    centrelineWidth: CENTRELINE_WIDTH * zoom,
  };
}

// --------------------------------------------------------------- polyline ---

/**
 * The point at arc length `s` along a polyline, interpolating within a segment.
 *
 * `cum` is the running arc length at each vertex, as `RoadNetwork` stores it.
 */
export function pointAtArc(pts, cum, s) {
  if (!Array.isArray(pts) || pts.length === 0) return null;
  if (pts.length === 1) return [pts[0][0], pts[0][1]];
  const total = cum[cum.length - 1];
  if (s <= 0) return [pts[0][0], pts[0][1]];
  // States the clamp explicitly. Without it the loop below falls through to the
  // same answer, but the contract "beyond the end clamps" would then depend on
  // an accident of the loop rather than on a line that says so.
  if (s >= total) { const p = pts[pts.length - 1]; return [p[0], p[1]]; }
  for (let k = 1; k < pts.length; k++) {
    if (cum[k] < s) continue;
    const span = cum[k] - cum[k - 1];
    const t = span > 0 ? (s - cum[k - 1]) / span : 0;
    return [
      pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t,
      pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t,
    ];
  }
  const p = pts[pts.length - 1];
  return [p[0], p[1]];
}

/**
 * A polyline restricted to `[trim, total - trim]`, with both ends interpolated.
 *
 * Why interpolation matters: an earlier version kept only EXISTING vertices that
 * fell inside the range. On a straight two-point road (`cum = [0, 450]`) both
 * endpoints sit outside the range, so nothing was stroked and the road drew with
 * no lane markings at all. DESIGN section 3 requires lanes be painted
 * "continuously through normal segments, trim at junction mouths", so the ends
 * must be cut at an exact distance rather than snapped to vertices.
 *
 * Returns [] when there is nothing to draw, rather than an inverted line.
 */
export function trimPolyline(pts, cum, trim) {
  if (!Array.isArray(pts) || pts.length < 2) return [];
  if (!Array.isArray(cum) || cum.length !== pts.length) return [];
  const total = cum[cum.length - 1];
  if (!Number.isFinite(total) || total <= 0) return [];

  const t = clampTrim(trim, total);
  const start = t;
  const end = total - t;
  if (!(end > start)) return [];

  const out = [pointAtArc(pts, cum, start)];
  for (let k = 0; k < pts.length; k++) {
    if (cum[k] > start && cum[k] < end) out.push([pts[k][0], pts[k][1]]);
  }
  out.push(pointAtArc(pts, cum, end));
  return out;
}

/**
 * A polyline restricted to `[start, total - end]`, both interpolated.
 *
 * A junction at one end and a dead end at the other need different clearances,
 * so the two trims are supplied separately. See `trimPolyline` for why the ends
 * are interpolated rather than snapped to the nearest vertex.
 */
export function trimPolylineEnds(pts, cum, startTrim, endTrim) {
  if (!Array.isArray(pts) || pts.length < 2) return [];
  if (!Array.isArray(cum) || cum.length !== pts.length) return [];
  const total = cum[cum.length - 1];
  if (!Number.isFinite(total) || total <= 0) return [];

  const s = clampTrim(startTrim, total);
  const e = clampTrim(endTrim, total);
  const from = s;
  const to = total - e;
  if (!(to > from)) return [];

  const out = [pointAtArc(pts, cum, from)];
  for (let k = 0; k < pts.length; k++) {
    if (cum[k] > from && cum[k] < to) out.push([pts[k][0], pts[k][1]]);
  }
  out.push(pointAtArc(pts, cum, to));
  return out;
}

/**
 * Shifts every point of a polyline sideways by `off` world units.
 *
 * The normal is taken from the segment through each point, so a lane keeps a
 * constant lateral distance from the centreline across bends instead of cutting
 * the corner.
 */
export function offsetPolyline(pts, off) {
  if (!Array.isArray(pts) || pts.length < 2) return [];
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const a = k < pts.length - 1 ? pts[k + 1] : p;
    const b = k < pts.length - 1 ? p : pts[k - 1];
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const len = Math.hypot(dx, dy);
    // A zero-length segment has no direction, so it contributes no offset
    // rather than producing NaN.
    if (len === 0) { out.push([p[0], p[1]]); continue; }
    const ang = Math.atan2(dy, dx);
    out.push([p[0] + Math.sin(ang) * off, p[1] - Math.cos(ang) * off]);
  }
  return out;
}
