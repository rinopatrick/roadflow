// Three-click rotated road grid — S03.3.
//
// WHY THIS MODULE EXISTS
// ----------------------
// Laying a street grid by hand is a dozen separate road drafts, each of which
// has to be undone individually and each of which can fail halfway and leave a
// half-built grid. This module turns three clicks into ONE evaluated record:
//
//   A        the origin corner
//   B        the base axis endpoint (direction and length)
//   C        a point whose projection onto the base NORMAL gives the width
//
// Everything is built in a LOCAL frame (u along the base, v along the normal)
// and then transformed to world space, so a grid at 30 degrees is the same
// arithmetic as a grid at 0 degrees. That is why the rotated cases can be
// asserted analytically rather than by looking at a picture.
//
// Pure: no mutation, no RNG, no DOM.
import { evaluateRoadDraft } from './roadDraft.js';
import { roadDimensions } from './roadProfiles.js';

/** Shortest accepted base axis, in wu. */
export const MIN_BASE_WU = 40;

/** Narrowest accepted grid, in wu. */
export const MIN_WIDTH_WU = 40;

/** Largest number of road segments one grid may contain. */
export const MAX_GRID_SEGMENTS = 100;

/** Block-length and row-spacing bounds, matching the UI settings. */
export const GRID_LIMITS = {
  blockMin: 120, blockMax: 400, blockDefault: 200,
  rowMin: 120, rowMax: 400, rowDefault: 160,
};

/**
 * Evenly spaced grid-line positions from 0 to `span`.
 *
 * The spacing is `span / round(span / step)` rather than a fixed `step` with a
 * remainder stub. A fixed step leaves a sliver at the far edge (a 410 wu span at
 * 200 wu steps would end in a 10 wu stub, too short to build), so the count is
 * rounded and the spacing adjusted to fit exactly.
 *
 * @returns {number[]} ascending positions, always including 0 and `span`
 */
export function axisStops(span, step) {
  if (!(span > 0) || !(step > 0)) return [0];
  const n = Math.max(1, Math.round(span / step));
  const s = span / n;
  const out = [];
  for (let i = 0; i <= n; i++) out.push(i === n ? span : i * s);
  return out;
}

/**
 * The grid's local frame and line positions, without touching the world.
 *
 * @param {{a:[number,number], b:[number,number], c:[number,number],
 *          blockLength?:number, rowSpacing?:number}} request
 * @returns {{ok:true, origin:[number,number], dir:[number,number],
 *            normal:[number,number], baseLen:number, width:number,
 *            uStops:number[], vStops:number[]}
 *          | {ok:false, reason:string}}
 */
export function gridFrame({ a, b, c, blockLength, rowSpacing } = {}) {
  for (const [name, p] of [['a', a], ['b', b], ['c', c]]) {
    if (!Array.isArray(p) || !Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) {
      return { ok: false, reason: `grid point ${name} must be finite numbers` };
    }
  }

  const bl = blockLength ?? GRID_LIMITS.blockDefault;
  const rs = rowSpacing ?? GRID_LIMITS.rowDefault;
  if (!(Number.isFinite(bl) && bl >= GRID_LIMITS.blockMin && bl <= GRID_LIMITS.blockMax)) {
    return {
      ok: false,
      reason: `block length must be between ${GRID_LIMITS.blockMin} and ${GRID_LIMITS.blockMax} wu`,
    };
  }
  if (!(Number.isFinite(rs) && rs >= GRID_LIMITS.rowMin && rs <= GRID_LIMITS.rowMax)) {
    return {
      ok: false,
      reason: `row spacing must be between ${GRID_LIMITS.rowMin} and ${GRID_LIMITS.rowMax} wu`,
    };
  }

  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const baseLen = Math.hypot(bx, by);
  if (baseLen < MIN_BASE_WU) {
    return { ok: false, reason: `the base axis must be at least ${MIN_BASE_WU} wu long` };
  }
  // Normalise -0 to 0: a basis component of -0 is mathematically the same but
  // compares unequal under deepEqual, which makes every frame assertion fragile.
  const dir = [(bx / baseLen) + 0 || 0, (by / baseLen) + 0 || 0];

  // The normal is the base direction rotated 90 degrees. Flipping it when C
  // falls on the negative side means "drag the other way" produces the same
  // grid instead of a mirrored failure.
  let normal = [(-dir[1]) + 0 || 0, dir[0] + 0 || 0];
  const signedWidth = (c[0] - a[0]) * normal[0] + (c[1] - a[1]) * normal[1];
  const width = Math.abs(signedWidth);
  if (signedWidth < 0) normal = [(-normal[0]) + 0 || 0, (-normal[1]) + 0 || 0];

  if (width < MIN_WIDTH_WU) {
    return { ok: false, reason: `the grid must be at least ${MIN_WIDTH_WU} wu wide` };
  }

  const uStops = axisStops(baseLen, bl);
  const vStops = axisStops(width, rs);

  // Every u line runs the full width and every v line the full base, so the
  // segment count is simply the number of lines.
  const count = uStops.length + vStops.length;
  if (count > MAX_GRID_SEGMENTS) {
    return {
      ok: false,
      reason: `that grid needs ${count} roads; the limit is ${MAX_GRID_SEGMENTS}`,
    };
  }

  return { ok: true, origin: [a[0], a[1]], dir, normal, baseLen, width, uStops, vStops };
}

/** Transforms a local (u, v) pair into world coordinates. */
export function localToWorld(frame, u, v) {
  return [
    frame.origin[0] + frame.dir[0] * u + frame.normal[0] * v,
    frame.origin[1] + frame.dir[1] * u + frame.normal[1] * v,
  ];
}

/**
 * The world-space road segments for a grid, in a deterministic order.
 *
 * Lines perpendicular to the base come first (in ascending u), then lines
 * parallel to it (in ascending v). That order matters for crossings: each
 * segment is committed against the graph the previous ones produced, so a later
 * segment sees the junctions the earlier ones created.
 *
 * @returns {Array<{from:[number,number], to:[number,number], axis:'u'|'v', index:number}>}
 */
export function gridSegments(frame) {
  const out = [];
  for (const u of frame.uStops) {
    out.push({
      from: localToWorld(frame, u, 0),
      to: localToWorld(frame, u, frame.width),
      axis: 'u',
      index: out.length,
    });
  }
  for (const v of frame.vStops) {
    out.push({
      from: localToWorld(frame, 0, v),
      to: localToWorld(frame, frame.baseLen, v),
      axis: 'v',
      index: out.length,
    });
  }
  return out;
}

/**
 * Evaluates a whole grid WITHOUT mutating the world.
 *
 * Each segment is validated with the same `evaluateRoadDraft` the single-road
 * tool uses, so a grid cannot be accepted where one road would be refused. One
 * failing segment rejects the whole grid and reports which one, because a
 * half-built grid is worse than no grid.
 *
 * @param {object} world
 * @param {{a, b, c, blockLength?, rowSpacing?, cls?}} request
 * @returns {{ok:boolean, reason:string|null, segments:Array, failIndex:number|null,
 *            count:number, frame:object|null, totalLength:number,
 *            bounds:{minX,minY,maxX,maxY}|null}}
 */
export function evaluateGridDraft(world, request = {}) {
  const empty = {
    ok: false, reason: null, segments: [], failIndex: null,
    count: 0, frame: null, totalLength: 0, bounds: null,
  };

  const cls = request.cls ?? 'street';
  try {
    roadDimensions(cls);
  } catch {
    return { ...empty, reason: `unknown road class: ${cls}` };
  }

  const frame = gridFrame(request);
  if (!frame.ok) return { ...empty, reason: frame.reason };

  const raw = gridSegments(frame);
  const segments = [];
  let totalLength = 0;

  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i];
    // A grid segment is a straight run between two grid lines, so it is
    // evaluated in straight mode: splining it would bulge the street off the
    // line the player drew.
    const rec = evaluateRoadDraft(world, {
      points: [seg.from, seg.to],
      cls,
      mode: 'straight',
      snap: false,
    });
    segments.push({
      from: seg.from,
      to: seg.to,
      axis: seg.axis,
      ok: rec.ok,
      reason: rec.reason,
      polyline: rec.polyline,
      length: rec.length,
    });
    if (!rec.ok) {
      return { ...empty, frame, segments, failIndex: i, count: raw.length, reason: rec.reason };
    }
    totalLength += rec.length;
  }

  return {
    ok: true,
    reason: null,
    segments,
    failIndex: null,
    count: segments.length,
    frame,
    totalLength,
    bounds: gridBounds(segments),
  };
}

/** The world bounding box of a set of segments. */
export function gridBounds(segments) {
  if (!segments?.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const s of segments) {
    for (const [x, y] of [s.from, s.to]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}
