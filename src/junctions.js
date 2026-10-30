// Junction connectors — S04.2.
//
// A connector maps one incoming lane vertex to one outgoing lane vertex:
//   vertex key = `edgeId:dir:lane` (traversing that lane entry → exit).
//   connector id = stable tuple `${fromKey}>${toKey}`.
// Geometry: short swept curve between trimmed lane endpoints. Same input →
// same geometry. Conflicts: conservative swept-corridor intersection with
// vehicle half-width margin; opposing non-crossing right turns may coexist.
import { laneCenterOffset } from './roadProfiles.js';
import { profileFor, lanesAvailable } from './roadProfiles.js';
import { JUNCTION_Z_TOL, gradeHeightAt } from './grades.js';
import { pointAt } from './core.js';
const JUNCTION_Z_TOL_GRADE = JUNCTION_Z_TOL;

export const VEHICLE_HALF_WIDTH = 1.8;
const CONFLICT_MARGIN = 0.5;
const TRIM_WU = 14;

export function vertexKey(edgeId, dir, lane) {
  return `${edgeId}:${dir}:${lane}`;
}

export function connectorId(from, to) {
  return `${vertexKey(from.edgeId, from.dir, from.lane)}>${vertexKey(to.edgeId, to.dir, to.lane)}`;
}

/** Tangent (unit) of travel at the node end of an edge. */
function exitTangent(edge, nodeId) {
  const pts = edge.pts;
  if (nodeId === edge.b) {
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
  }
  const a = pts[1], b = pts[0];
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
}

function entryTangent(edge, nodeId) {
  const [x, y] = exitTangent(edge, nodeId);
  return [-x, -y];
}

function turnType(inTan, outTan) {
  // y-down screen: cross > 0 = left turn, < 0 = right turn.
  const cross = inTan[0] * outTan[1] - inTan[1] * outTan[0];
  const dot = inTan[0] * outTan[0] + inTan[1] * outTan[1];
  if (dot > 0.7) return 'through';
  if (dot < -0.5) return 'uturn';
  return cross > 0 ? 'left' : 'right';
}

/** Lane endpoint trimmed back from the node by TRIM_WU. */
function trimmedLanePoint(net, edge, dir, lane, nodeId) {
  const s = dir === 1
    ? (nodeId === edge.b ? edge.total - TRIM_WU : TRIM_WU)
    : (nodeId === edge.a ? edge.total - TRIM_WU : TRIM_WU);
  const sc = Math.max(0, Math.min(edge.total, s));
  return net.lanePoint(edge, dir, lane, sc);
}

/**
 * Pure: enumerate every legal lane-to-lane movement through a junction.
 * Sorted by stable tuple ID. No same-edge U-turn, no zero-lane directions,
 * no out-of-range lanes. `restrictions` (Set of connector ids, or '*' for
 * all) marks user-blocked movements which are omitted from the result.
 */
export function buildJunctionConnectors(net, nodeId, options = {}) {
  const node = net.nodes.get(nodeId);
  if (!node) return [];
  const restrictions = options.restrictions ?? null;
  const out = [];
  const entries = [];
  const exits = [];
  for (const eid of node.edges) {
    const edge = net.edges.get(eid);
    if (!edge) continue;
    // S04.6 ring circulation: ring edges participate as exits (entry from an
    // arm into the ring) and as entries (ring into an arm, or ring-to-ring).
    // Plain junctions are unaffected: they have no ring edges.
    const prof = profileFor(edge);
    // Entry: arriving AT node. Exit: leaving node.
    if (nodeId === edge.b && lanesAvailable(prof, 1) > 0) {
      for (let l = 0; l < lanesAvailable(prof, 1); l++) {
        entries.push({ edge, edgeId: eid, dir: 1, lane: l });
      }
    }
    if (nodeId === edge.a && lanesAvailable(prof, 1) > 0) {
      exits.push({ edge, edgeId: eid, dir: 1, lanes: lanesAvailable(prof, 1) });
    }
    if (nodeId === edge.a && lanesAvailable(prof, -1) > 0) {
      for (let l = 0; l < lanesAvailable(prof, -1); l++) {
        entries.push({ edge, edgeId: eid, dir: -1, lane: l });
      }
    }
    if (nodeId === edge.b && lanesAvailable(prof, -1) > 0) {
      exits.push({ edge, edgeId: eid, dir: -1, lanes: lanesAvailable(prof, -1) });
    }
  }
  for (const from of entries) {
    const inTan = entryTangent(from.edge, nodeId);
    const fromRing = !!from.edge.ring;
    for (const exit of exits) {
      if (exit.edgeId === from.edgeId) continue; // no same-edge U-turn
      const toRing = !!exit.edge.ring;
      // Non-ring to non-ring at a ring node: arms never connect directly;
      // they must travel via the ring. Ring-to-ring is circulation.
      if (!fromRing && !toRing && node.isRing) continue;
      // S05.1: connectors only within equal height. Heights are measured at
      // the NODE end: entry arrives AT the node (t=1 side), exit leaves FROM
      // the node (t=0 side). A ground entry never connects to a bridge exit.
      const toT = nodeId === exit.edge.a ? 0 : 1;
      const fromT = nodeId === from.edge.a ? 0 : 1;
      const fromZn = from.edge.grade ? gradeHeightAt(from.edge.grade, fromT) : 0;
      const toZ = exit.edge.grade ? gradeHeightAt(exit.edge.grade, toT) : 0;
      if (Math.abs(fromZn - toZ) > JUNCTION_Z_TOL_GRADE) continue;
      const outTan = exitTangent(exit.edge, nodeId);
      const turn = turnType(inTan, outTan);
      if (turn === 'uturn' && !fromRing && !toRing) continue;
      // Lane mapping: through keeps lane when possible, turns take outer lanes.
      const toLane = turn === 'through'
        ? Math.min(from.lane, exit.lanes - 1)
        : 0;
      const to = { edgeId: exit.edgeId, dir: exit.dir, lane: toLane };
      const id = connectorId(from, to);
      if (restrictions === '*') continue;
      if (restrictions instanceof Set && restrictions.has(id)) continue;
      const p0 = trimmedLanePoint(net, from.edge, from.dir, from.lane, nodeId);
      const p1 = trimmedLanePoint(net, exit.edge, exit.dir, toLane, nodeId);
      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2;
      const pts = [[p0.x, p0.y], [mx, my], [p1.x, p1.y]];
      out.push({
        id, nodeId, from: { edgeId: from.edgeId, dir: from.dir, lane: from.lane },
        to, turn, pts, length: Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1,
        conflicts: [],
      });
    }
  }
  // Conservative conflicts: swept corridor (half vehicle width + margin)
  // intersection. Corridors are segment-vs-segment distances.
  const half = VEHICLE_HALF_WIDTH + CONFLICT_MARGIN;
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      // Same entry lane: following headway, not a crossing conflict — but the
      // first implementation serialises for safety (ALGORITHMS D).
      // Opposing non-crossing right turns: both right + entries opposite.
      const bothRight = a.turn === 'right' && b.turn === 'right';
      if (bothRight && !corridorsCross(a.pts, b.pts, half)) continue;
      if (corridorsCross(a.pts, b.pts, half * 2)) {
        a.conflicts.push(b.id);
        b.conflicts.push(a.id);
      } else if (a.from.edgeId === b.from.edgeId && a.from.lane === b.from.lane) {
        // Shared entry lane serialised.
        a.conflicts.push(b.id);
        b.conflicts.push(a.id);
      }
    }
  }
  out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const k of out) k.conflicts.sort();
  return out;
}

function corridorsCross(aPts, bPts, tol) {
  for (let i = 1; i < aPts.length; i++) {
    for (let j = 1; j < bPts.length; j++) {
      if (segDist(aPts[i - 1], aPts[i], bPts[j - 1], bPts[j]) <= tol) return true;
    }
  }
  return false;
}

function segDist(p1, p2, p3, p4) {
  // Min distance between two segments (2D).
  if (segsIntersect(p1, p2, p3, p4)) return 0;
  return Math.min(
    ptSeg(p1, p3, p4), ptSeg(p2, p3, p4), ptSeg(p3, p1, p2), ptSeg(p4, p1, p2),
  );
}

function segsIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function ptSeg(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby || 1;
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
}

/** Conflict adjacency derived from a connector list. */
export function connectorConflicts(connectors) {
  const m = new Map();
  for (const k of connectors) m.set(k.id, [...k.conflicts]);
  return m;
}

/** Distance from node centre to trimmed lane point, for footprint bounds. */
export function connectorTrim() {
  return TRIM_WU;
}

void laneCenterOffset;
void pointAt;
