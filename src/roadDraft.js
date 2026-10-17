// One authoritative road draft and predictable snapping — S03.2.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The preview and the commit used to be two different geometry paths: the
// renderer drew a rubber band from the raw control points while `addRoad`
// re-derived a spline internally, and neither validated the road's FOOTPRINT
// (only its control points). So a road could look valid and then fail, or worse,
// be accepted while crossing water between two legal endpoints.
//
// `evaluateRoadDraft` produces the ONE record that both the preview and the
// commit consume:
//
//   { ok, reason, controls, polyline, length, intersections, cost, failAt }
//
// `addRoad` accepts that polyline through its options argument, so the committed
// geometry is byte-identical to the previewed geometry rather than merely
// similar. That is what makes the Hausdorff distance zero instead of "small".
//
// Everything here is pure: no mutation, no RNG, no DOM.
import { splinePoints, polylineLengths, projectOnPolyline, dist } from './core.js';
import { roadDimensions } from './roadProfiles.js';
import { BUILDING_DEFS } from './economy.js';

/** Arc length used when sampling the curve. Must match `addRoad`'s own value. */
export const SPLINE_SEG_LEN = 12;

/** Every straight/curved segment is sampled at most this far apart, in wu. */
export const MAX_SAMPLE_STEP = 4;

/** Snap radii in CSS pixels, converted to world units with a hard cap. */
export const SNAP = {
  nodePx: 12,
  nodeCapWu: 18,
  edgePx: 8,
  edgeCapWu: 12,
};

/** Angle snapping increment, in degrees, when the modifier is held. */
export const ANGLE_SNAP_DEG = 15;

/** Road drafting modes. */
export const DRAFT_MODE = { STRAIGHT: 'straight', CURVE: 'curve' };

/**
 * Converts a CSS-pixel snap radius into world units for the current zoom.
 *
 * CSS pixels are already device-independent, so the DPR must NOT appear here:
 * 1 wu is `zoom` CSS px regardless of how many device pixels that is. The cap
 * stops a very zoomed-out camera from snapping to something far away on screen.
 */
export function snapRadiusWu(px, zoom, capWu) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.min(px / z, capWu);
}

/**
 * The closest node to a point, within a world radius.
 *
 * Ties are broken by ID so the result does not depend on Map iteration order.
 *
 * @returns {{nodeId:string, x:number, y:number, d:number}|null}
 */
export function nearestNode(net, x, y, radiusWu) {
  let best = null;
  for (const n of net.nodes.values()) {
    const d = dist(x, y, n.x, n.y);
    if (d > radiusWu) continue;
    if (!best || d < best.d || (d === best.d && n.id < best.nodeId)) {
      best = { nodeId: n.id, x: n.x, y: n.y, d };
    }
  }
  return best;
}

/**
 * The closest point on any edge, within a world radius.
 *
 * Ties are broken by edge ID, then by arc position, so the target is stable.
 *
 * @returns {{edgeId:string, x:number, y:number, s:number, d:number}|null}
 */
export function nearestEdgePoint(net, x, y, radiusWu) {
  let best = null;
  for (const e of net.edges.values()) {
    if (!Array.isArray(e.pts) || e.pts.length < 2) continue;
    const { s, d } = projectOnPolyline(e.pts, e.cum, x, y);
    if (d > radiusWu) continue;
    if (!best || d < best.d || (d === best.d && e.id < best.edgeId)) {
      const p = pointAtArcLocal(e.pts, e.cum, s);
      best = { edgeId: e.id, x: p[0], y: p[1], s, d };
    }
  }
  return best;
}

/** The point at arc length `s` along a polyline. Local copy to stay pure. */
function pointAtArcLocal(pts, cum, s) {
  if (s <= 0) return [pts[0][0], pts[0][1]];
  const total = cum[cum.length - 1];
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
 * Resolves one raw draft point to its snapped position.
 *
 * Priority, highest first (S03.2 item 2):
 *   1. an explicit locked target (the caller already knows where it wants)
 *   2. the closest node, within 12 CSS px capped at 18 wu
 *   3. the closest point on an edge, within 8 CSS px capped at 12 wu
 *   4. an angle snapped to a multiple of 15 degrees, when the modifier is held
 *
 * Snapping can be disabled entirely (Alt), in which case the raw point is
 * returned untouched.
 *
 * @returns {{x:number, y:number, target:null|{kind:string,id:string}}}
 */
export function snapPoint(world, raw, opts = {}) {
  const {
    zoom = 1, snap = true, angleSnap = false, locked = null, previous = null,
  } = opts;

  if (!snap) return { x: raw[0], y: raw[1], target: null };

  // 1. An explicit lock wins outright.
  if (locked && Number.isFinite(locked.x) && Number.isFinite(locked.y)) {
    return { x: locked.x, y: locked.y, target: { kind: locked.kind ?? 'locked', id: locked.id ?? 'locked' } };
  }

  // 2. A node.
  const node = nearestNode(world.net, raw[0], raw[1], snapRadiusWu(SNAP.nodePx, zoom, SNAP.nodeCapWu));
  if (node) return { x: node.x, y: node.y, target: { kind: 'node', id: node.nodeId } };

  // 3. A point on an edge.
  const edge = nearestEdgePoint(world.net, raw[0], raw[1], snapRadiusWu(SNAP.edgePx, zoom, SNAP.edgeCapWu));
  if (edge) return { x: edge.x, y: edge.y, target: { kind: 'edge', id: edge.edgeId } };

  // 4. Angle snapping relative to the previous point.
  if (angleSnap && previous) {
    const dx = raw[0] - previous[0];
    const dy = raw[1] - previous[1];
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      const step = (ANGLE_SNAP_DEG * Math.PI) / 180;
      const a = Math.round(Math.atan2(dy, dx) / step) * step;
      return {
        x: previous[0] + Math.cos(a) * len,
        y: previous[1] + Math.sin(a) * len,
        target: { kind: 'angle', id: String(Math.round((a * 180) / Math.PI)) },
      };
    }
  }

  return { x: raw[0], y: raw[1], target: null };
}

/**
 * Samples a polyline so no gap exceeds `MAX_SAMPLE_STEP`, for footprint checks.
 *
 * Endpoint-only validation is not enough (S03.2 item 3): a road whose two
 * endpoints are on land can still cross a river between them.
 */
export function samplePolyline(pts, maxStep = MAX_SAMPLE_STEP) {
  const out = [];
  if (!Array.isArray(pts) || pts.length === 0) return out;
  out.push([pts[0][0], pts[0][1]]);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = dist(a[0], a[1], b[0], b[1]);
    const steps = Math.max(1, Math.ceil(d / maxStep));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * The authoritative polyline for a set of control points.
 *
 * Straight mode joins the controls directly; curve mode uses the SAME
 * `splinePoints` call that `addRoad` uses, with the same segment length, so the
 * preview cannot diverge from the commit.
 */
export function draftPolyline(controls, mode) {
  if (!Array.isArray(controls) || controls.length < 2) return controls ? controls.map(p => [p[0], p[1]]) : [];
  if (mode === DRAFT_MODE.CURVE) return splinePoints(controls, SPLINE_SEG_LEN).pts;
  return controls.map(p => [p[0], p[1]]);
}

/**
 * Validates a road's footprint against terrain and existing buildings.
 *
 * Checks every sample, not just the endpoints, and reports the first offending
 * point so the preview can mark it.
 *
 * @returns {{ok:true} | {ok:false, reason:string, at:[number,number]}}
 */
export function validateFootprint(world, polyline, cls) {
  const dim = roadDimensions(cls);
  const halfWidth = dim.width / 2;
  const samples = samplePolyline(polyline);

  // Terrain: every sample must be roadable.
  for (const p of samples) {
    if (!world.terrain.isRoadable(p[0], p[1])) {
      return { ok: false, reason: 'the road would cross water or rock', at: p };
    }
  }

  // Buildings: the road's half-width must not eat into a building footprint.
  if (world.eco?.buildings?.size) {
    for (const b of world.eco.buildings.values()) {
      const def = BUILDING_DEFS[b.type];
      if (!def) continue;
      let nearest = Infinity;
      for (const p of samples) {
        const d = dist(p[0], p[1], b.x, b.y);
        if (d < nearest) nearest = d;
      }
      // Half the building's square footprint plus the road's half-width.
      if (nearest < def.size / 2 + halfWidth) {
        return {
          ok: false,
          reason: `the road would cut through a ${def.label.toLowerCase()}`,
          at: [b.x, b.y],
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Evaluates a road draft WITHOUT mutating the world.
 *
 * This is the single authority for what a road will be: the renderer previews
 * this record and the commit applies it, so the two cannot disagree.
 *
 * @param {object} world
 * @param {{points:Array<[number,number]>, cls?:string, mode?:string,
 *          snap?:boolean, angleSnap?:boolean, locked?:object,
 *          zoom?:number}} draft
 * @returns {{ok:boolean, reason:string|null, controls:Array, polyline:Array,
 *            length:number, intersections:Array, cost:null, failAt:Array|null,
 *            targets:Array}}
 */
export function evaluateRoadDraft(world, draft = {}) {
  const {
    points = [], cls = 'street', mode = DRAFT_MODE.CURVE,
    snap = true, angleSnap = false, locked = null, zoom = 1,
  } = draft;

  const empty = {
    ok: false, reason: null, controls: [], polyline: [],
    length: 0, intersections: [], cost: null, failAt: null, targets: [],
  };

  if (!Array.isArray(points) || points.length < 2) {
    return { ...empty, reason: 'a road needs at least two points' };
  }
  for (const p of points) {
    if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) {
      return { ...empty, reason: 'road points must be finite numbers' };
    }
  }
  try {
    roadDimensions(cls);
  } catch {
    return { ...empty, reason: `unknown road class: ${cls}` };
  }

  // Snap each point in turn, so the second point can angle-snap from the first.
  const controls = [];
  const targets = [];
  for (let i = 0; i < points.length; i++) {
    const snapped = snapPoint(world, points[i], {
      zoom,
      snap,
      angleSnap: angleSnap && i > 0,
      locked: i === points.length - 1 ? locked : null,
      previous: i > 0 ? controls[i - 1] : null,
    });
    controls.push([snapped.x, snapped.y]);
    targets.push(snapped.target);
  }

  // A draft that collapses to a point is not a road.
  const first = controls[0];
  const anyDistinct = controls.some(p => dist(p[0], p[1], first[0], first[1]) >= 1);
  if (!anyDistinct) {
    return { ...empty, controls, targets, reason: 'all points are at the same location' };
  }

  const polyline = draftPolyline(controls, mode);
  const { total } = polylineLengths(polyline);

  const footprint = validateFootprint(world, polyline, cls);
  if (!footprint.ok) {
    return {
      ...empty, controls, targets, polyline, length: total,
      reason: footprint.reason, failAt: footprint.at,
    };
  }

  // Preview of the crossings this road would resolve. Cheap: the authoritative
  // resolution still happens in addRoad, this is for the preview only.
  const intersections = previewIntersections(world.net, polyline);

  return {
    ok: true,
    reason: null,
    controls,
    polyline,
    length: total,
    intersections,
    // No currency exists yet: DESIGN section 5 says show length only, never a
    // fictional cost.
    cost: null,
    failAt: null,
    targets,
  };
}

/**
 * How many existing edges the draft would cross, for the preview badge.
 *
 * Reports edge IDs only; `addRoad` remains the authority that actually splits
 * them, so this cannot disagree about the RESULT, only about the preview count.
 */
export function previewIntersections(net, polyline) {
  const hits = [];
  if (!Array.isArray(polyline) || polyline.length < 2) return hits;
  for (const e of net.edges.values()) {
    if (!Array.isArray(e.pts) || e.pts.length < 2) continue;
    if (polylinesCross(polyline, e.pts)) hits.push(e.id);
  }
  hits.sort();
  return hits;
}

/** True when two polylines properly intersect. Segment-pair orientation test. */
function polylinesCross(a, b) {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      if (segmentsIntersect(a[i - 1], a[i], b[j - 1], b[j])) return true;
    }
  }
  return false;
}

function orientation(p, q, r) {
  const v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  if (Math.abs(v) < 1e-12) return 0;
  return v > 0 ? 1 : 2;
}

function onSegment(p, q, r) {
  return q[0] <= Math.max(p[0], r[0]) + 1e-12 && q[0] >= Math.min(p[0], r[0]) - 1e-12
    && q[1] <= Math.max(p[1], r[1]) + 1e-12 && q[1] >= Math.min(p[1], r[1]) - 1e-12;
}

function segmentsIntersect(p1, q1, p2, q2) {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

/**
 * The largest distance from any point of `a` to the nearest point of `b`.
 *
 * A one-sided Hausdorff distance, which is what the acceptance criterion needs:
 * every previewed point must be close to the committed geometry. Symmetric
 * Hausdorff is the max of both directions.
 */
export function hausdorff(a, b) {
  const oneWay = (from, to) => {
    let worst = 0;
    for (const p of from) {
      let nearest = Infinity;
      for (let i = 1; i < to.length; i++) {
        const { d } = projectOnPolyline([to[i - 1], to[i]], [0, dist(to[i - 1][0], to[i - 1][1], to[i][0], to[i][1])], p[0], p[1]);
        if (d < nearest) nearest = d;
      }
      if (to.length === 1) nearest = dist(p[0], p[1], to[0][0], to[0][1]);
      if (nearest > worst) worst = nearest;
    }
    return worst;
  };
  if (!a?.length || !b?.length) return Infinity;
  return Math.max(oneWay(a, b), oneWay(b, a));
}
