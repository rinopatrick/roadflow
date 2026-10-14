// Junction geometry and shadow direction (S02.3b).
//
// Why this module exists
// ----------------------
// Two DESIGN section 3 rules were not being met:
//
//   1. "Junction visual fill uses actual connected footprint... do not merely
//      paint a circular disk over every junction at every scale."
//      Every edge was stroked with a ROUND cap. Because all edges meeting at a
//      node share that node's centre, a round cap extends half the pavement
//      width in every direction from the centre — so the union of round caps at
//      a junction IS a circular disk of radius = the widest connected pavement.
//      A wide avenue meeting a narrow street therefore painted a blob wider than
//      the street.
//
//   2. "One shadow direction across all geometry, e.g. screen (+3,+4) wu."
//      Building and car shadows were drawn INSIDE `ctx.rotate(...)`, so the
//      shadow direction rotated with the object. A building rotated 180 degrees
//      cast its shadow up-and-left while its neighbour cast down-and-right.
//
// Everything here is pure geometry over node/edge records, so the rules are
// tested numerically without a canvas.
import { roadDimensions } from '../roadProfiles.js';

/**
 * Cap style for an edge's pavement stroke.
 *
 * A degree-2 node is a BEND, not a junction (S01.5b), and a round join is
 * geometrically correct there: the pavement genuinely curves through it.
 *
 * At a real junction (3+ connected edges) a round cap is exactly the "circular
 * disk" DESIGN forbids, so the cap is squared and the junction's own footprint
 * polygon supplies the fill instead.
 */
export function capForNode(degree) {
  return degree <= 2 ? 'round' : 'butt';
}

/** Half the paved width of an edge, in world units. */
export function halfWidth(edge) {
  return roadDimensions(edge).width / 2;
}

/**
 * The direction an edge leaves a node, as a unit vector in world space.
 *
 * Returns null when the edge has no usable polyline or does not touch the node,
 * so callers can skip rather than draw from a guess.
 */
export function edgeDirectionAt(edge, node) {
  const pts = edge?.pts;
  if (!Array.isArray(pts) || pts.length < 2) return null;
  let dx, dy;
  if (edge.a === node.id) {
    dx = pts[1][0] - pts[0][0];
    dy = pts[1][1] - pts[0][1];
  } else if (edge.b === node.id) {
    const n = pts.length;
    dx = pts[n - 2][0] - pts[n - 1][0];
    dy = pts[n - 2][1] - pts[n - 1][1];
  } else {
    return null;
  }
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  return [dx / len, dy / len];
}

/** Every edge connected to a node, resolved from the network. */
export function connectedEdges(net, node) {
  const out = [];
  for (const eid of node.edges ?? []) {
    const e = net.edges.get(eid);
    if (e) out.push(e);
  }
  return out;
}

/**
 * How far a lane marking must stop short of a junction mouth, in world units.
 *
 * Derived from the CONNECTED edges, not from this edge's own width. The previous
 * rule was `width * 0.75 + 3`, which used the incoming road's width — so a
 * narrow street joining a wide highway trimmed by the street's own 15wu while
 * the highway's pavement reached 19.5wu from the centre, and the street's
 * centreline was painted straight into the junction.
 *
 * The mouth reaches as far as the widest connected pavement extends along this
 * edge, which is that pavement's half-width, plus a margin so the marking never
 * touches the mouth boundary.
 *
 * @param {object} net
 * @param {object} node the junction end
 * @param {string} edgeId the edge whose marking is being trimmed
 */
export function mouthTrim(net, node, edgeId) {
  const edges = connectedEdges(net, node);
  // A dead end or a BEND is not a junction. At degree 2 the only "other" edge is
  // the continuation of the same road, so treating it as a mouth would trim the
  // markings away in the middle of a straight road.
  if (edges.length < 3) return 0;

  let reach = 0;
  for (const other of edges) {
    if (other.id === edgeId) continue;
    reach = Math.max(reach, halfWidth(other));
  }
  if (reach === 0) return 0;
  return reach + MARKING_MARGIN;
}

/**
 * Extra clearance so a marking stops just outside the paved mouth rather than
 * exactly on its boundary, where it would visually touch the junction fill.
 */
export const MARKING_MARGIN = 1.5;

/**
 * Per-end trim for an edge's markings, in world units.
 *
 * `trimPolyline` takes one trim for both ends; a junction at one end and a dead
 * end at the other need different values, so they are computed separately.
 */
export function edgeEndTrims(net, edge) {
  const a = net.nodes.get(edge.a);
  const b = net.nodes.get(edge.b);
  return {
    start: a ? mouthTrim(net, a, edge.id) : 0,
    end: b ? mouthTrim(net, b, edge.id) : 0,
  };
}

/**
 * The paved footprint of a junction, as one quad per connected edge.
 *
 * Why quads rather than a single outline: the requirement is that the fill
 * follows the ACTUAL connected footprint, and the simplest way to be exactly
 * right is to sweep each connected edge's own pavement from the node centre out
 * to the junction's reach. A narrow street therefore contributes a narrow
 * rectangle and a wide avenue a wide one, so the union is a T, Y, X or skew
 * shape — never the circular disk that a round stroke cap produced.
 *
 * The renderer fills these, then the markings are drawn on top, so the fill only
 * has to cover the central region the edge strokes do not already reach.
 *
 * Returns { quads: [], reach: 0 } when there is nothing sensible to draw: fewer
 * than `minDegree` usable edges, or a plain bend, where the round stroke cap is
 * already geometrically correct.
 *
 * @returns {{quads: Array<Array<[number, number]>>, reach: number}}
 */
export function junctionFootprint(net, node, { minDegree = 3, inset = 0 } = {}) {
  const entries = [];
  for (const e of connectedEdges(net, node)) {
    const dir = edgeDirectionAt(e, node);
    if (!dir) continue;
    entries.push({ dir, hw: halfWidth(e) + inset });
  }
  if (entries.length < minDegree) return { quads: [], reach: 0 };

  // How far the junction reaches from its centre: the widest connected pavement.
  const reach = Math.max(...entries.map(en => en.hw));

  const quads = entries.map(({ dir, hw }) => {
    const [dx, dy] = dir;
    // Perpendicular in y-down screen space.
    const px = dy * hw;
    const py = -dx * hw;
    return [
      [node.x + px, node.y + py],
      [node.x + dx * reach + px, node.y + dy * reach + py],
      [node.x + dx * reach - px, node.y + dy * reach - py],
      [node.x - px, node.y - py],
    ];
  });

  return { quads, reach };
}

/**
 * Screen-space shadow offset for a given object scale.
 *
 * DESIGN section 3 fixes one direction for all geometry — screen (+3, +4) wu —
 * and scales it with physical height, so a taller object casts a longer shadow.
 */
export const SHADOW_DIR = [3, 4];

/** @param {number} height world-unit height of the object */
export function shadowOffset(height = 1) {
  return [SHADOW_DIR[0] * height, SHADOW_DIR[1] * height];
}

/**
 * Converts a SCREEN-space offset into the local coordinates of a frame rotated
 * by `rot`, so the offset can be applied inside a `ctx.rotate(rot)` block while
 * still pointing in a fixed screen direction.
 *
 * This is what keeps every shadow pointing the same way regardless of how its
 * object is oriented.
 */
export function offsetInRotatedFrame(rot, dx, dy) {
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  return [dx * cos - dy * sin, dx * sin + dy * cos];
}
