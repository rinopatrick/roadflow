// RoadNetwork — nodes, edges, lanes, intersections. The heart of the game.
//
// Model:
//  - Node: junction point. type: 'plain' | 'light' | 'roundabout' | 'driveway'
//  - Edge: road between two nodes. Geometry = Catmull-Rom spline through control
//    points, resampled to a polyline with cumulative arc lengths.
//  - Lane: derived. Right-hand traffic. Lane 0 = innermost (next to center line).
//
// Roads are drawn by the player as sequences of control points; new roads snap
// to existing nodes and can split existing edges, producing real junctions.
import { dist, splinePoints, polylineLengths, projectOnPolyline, pointAt, uid } from './core.js';
import { roadDimensions, laneCenterOffset, outerLaneOffset } from './roadProfiles.js';

// `width` and `lanesPerDir` are kept for backwards compatibility with existing
// callers and tests, but they are DERIVED from roadProfiles so there is only
// one set of numbers. `laneW` is retained for the same reason.
export const ROAD_CLASS = {
  street:  { lanesPerDir: 1, speed: 14, width: 11, laneW: 6.5, color: '#ffffff' },
  avenue:  { lanesPerDir: 2, speed: 18, width: 16, laneW: 6.0, color: '#ffffff' },
  highway: { lanesPerDir: 3, speed: 30, width: 24, laneW: 6.0, color: '#ffffff' },
};

// Recompute the derived fields from the profile model at module load, so a
// change in roadProfiles cannot leave ROAD_CLASS disagreeing with it.
for (const cls of Object.keys(ROAD_CLASS)) {
  const d = roadDimensions({ cls });
  ROAD_CLASS[cls].width = d.width;
  ROAD_CLASS[cls].lanesPerDir = d.forward;
  ROAD_CLASS[cls].laneW = d.laneWidth;
}

const NODE_SNAP = 18;      // snap to existing node within this dist
const EDGE_SNAP = 12;      // split existing edge within this dist

/** Shortest edge a construction path will create, in wu. */
const MIN_EDGE_LENGTH = 1;

/**
 * Interpolated polyline slice from arc `s0` to arc `s1`, inclusive of both ends.
 *
 * Used instead of re-splining a subset of control points, because re-splining a
 * subset produces a DIFFERENT curve from the one the player drew (EVIDENCE E12).
 * Returns null when the slice would have fewer than two distinct points.
 */
function slicePolyline(pts, cum, s0, s1) {
  const out = [];
  const a = pointAt(pts, cum, s0);
  out.push([a.x, a.y]);
  for (let i = 0; i < pts.length; i++) {
    const c = cum[i];
    if (c > s0 + 1e-6 && c < s1 - 1e-6) out.push([pts[i][0], pts[i][1]]);
  }
  const b = pointAt(pts, cum, s1);
  out.push([b.x, b.y]);

  // Collapse consecutive duplicates so the polyline has no zero-length runs.
  const dedup = [];
  for (const p of out) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) dedup.push(p);
  }
  return dedup.length >= 2 ? dedup : null;
}

/**
 * Arc position of each control point along the sampled path.
 * `splinePoints` emits samples per control SEGMENT, so the first sample whose
 * `segIdx` equals `i` is where control point `i` sits; the final control point is
 * the last sample.
 */
function controlArcPositions(controlCount, segIdx, cum, pts) {
  const sampleOf = new Array(controlCount).fill(undefined);
  for (let k = 0; k < segIdx.length; k++) {
    const si = segIdx[k];
    if (si >= 0 && si < controlCount && sampleOf[si] === undefined) sampleOf[si] = k;
  }
  sampleOf[controlCount - 1] = pts.length - 1;
  return sampleOf.map(k => cum[k === undefined ? pts.length - 1 : k]);
}

/**
 * Arc position of each control point, derived by PROJECTING each control onto an
 * authored polyline.
 *
 * Used when the caller supplies the geometry (S03.2): there is no `segIdx` to
 * read, so each control's position is where it lies on the polyline. The result
 * is forced monotonic non-decreasing, so a polyline that doubles back still
 * yields ordered stations rather than two nodes in the wrong order.
 */
export function controlArcByProjection(controls, pts, cum) {
  const total = cum[cum.length - 1];
  let previous = 0;
  return controls.map((c, i) => {
    if (i === 0) return 0;
    if (i === controls.length - 1) return total;
    const { s } = projectOnPolyline(pts, cum, c[0], c[1]);
    const clamped = Math.max(previous, Math.min(s, total));
    previous = clamped;
    return clamped;
  });
}

export class RoadNetwork {
  // ids: optional createIdSource(). When supplied, generated node/edge IDs are
  // deterministic and survive save/load; without it, legacy uid() behaviour is
  // kept so existing callers and tests are unaffected.
  constructor(options = {}) {
    this.ids = options.ids ?? null;
    this.clear();
  }

  clear() {
    this.nodes = new Map();  // id -> node
    this.edges = new Map();  // id -> edge
    this.version = 0;        // bumped on any topology change (path invalidation)
  }

  /** Allocates an ID from the world source, or falls back to the legacy uid(). */
  _newId(prefix) {
    return this.ids ? this.ids.next(prefix) : uid();
  }

  // ---------- construction ----------

  /**
   * Build a road from a sequence of clicked control points.
   *
   * Semantics (S01.5):
   *  - the control sequence is ONE continuous path, not a chain of overlapping
   *    sub-splines. The previous implementation passed `controls.slice(1, i)` as
   *    each link's midpoints, so every link repeated all earlier points and each
   *    spline doubled back through its own start node (EVIDENCE E12).
   *  - graph segmentation happens at real junctions and endpoints only: the two
   *    ends, plus any control point that lands on existing topology.
   *  - a path that returns to its own start is treated as a closed loop and is
   *    segmented at its clicked corners, so it forms a proper ring.
   *  - on failure the graph is left exactly as it was, and `reason` explains why.
   *
   * @param {Array<[number,number]>} controls world coordinates
   * @param {'street'|'avenue'|'highway'} [cls]
   * @returns {{nodeIds:string[], edgeIds:string[], reason:null|string}}
   */
  /**
   * Builds a road.
   *
   * @param {Array<[number, number]>} controls control points
   * @param {string} [cls] road class
   * @param {{pts?: Array<[number, number]>}} [options] `pts` supplies the
   *   AUTHORITATIVE sampled geometry, so a caller that already evaluated a draft
   *   (src/roadDraft.js) commits exactly what it previewed instead of
   *   re-deriving a spline. This is the backward-compatible options argument
   *   CONTRACTS section 4 reserves for S03.2; omitting it keeps the old
   *   behaviour of splining the controls.
   */
  addRoad(controls, cls = 'street', options = {}) {
    const created = { nodeIds: [], edgeIds: [], reason: null };
    const versionBefore = this.version;

    if (!Array.isArray(controls) || controls.length < 2) {
      created.reason = 'a road needs at least two points';
      return created;
    }

    const n = controls.length;
    const first = controls[0];
    const last = controls[n - 1];
    const span = Math.hypot(last[0] - first[0], last[1] - first[1]);

    // Reject a path whose points are all in one place.
    const anyDistinct = controls.some(p =>
      Math.hypot(p[0] - first[0], p[1] - first[1]) >= MIN_EDGE_LENGTH);
    if (!anyDistinct) {
      created.reason = 'all points are at the same location';
      return created;
    }

    // 1. Authoritative geometry for the whole path. When the caller supplies
    // `options.pts`, that IS the authority: re-splining it here would silently
    // commit different geometry from what was previewed.
    const authored = Array.isArray(options?.pts) && options.pts.length >= 2 ? options.pts : null;
    const { pts, segIdx } = authored
      ? { pts: authored.map(p => [p[0], p[1]]), segIdx: null }
      : splinePoints(controls, 12);
    const { cum, total } = polylineLengths(pts);
    if (!(total >= MIN_EDGE_LENGTH)) {
      created.reason = 'the road is too short to build';
      return created;
    }
    const ctrlArc = authored
      ? controlArcByProjection(controls, pts, cum)
      : controlArcPositions(n, segIdx, cum, pts);

    // 2. Decide where to segment.
    const closed = span < NODE_SNAP;

    // Every clicked control point is a station, so the drawn shape becomes a
    // chain of drivable edges with a bend node at each corner.
    //
    // Segmenting only at the ENDPOINTS was wrong: a multi-point path whose two
    // ends already shared an edge collapsed into a single candidate edge,
    // `edgeBetween` then treated it as a duplicate and the whole road was
    // silently dropped. Drawing a bypass between two already-connected junctions
    // built nothing at all.
    const candidates = [];
    for (let i = 0; i < n; i++) candidates.push(i);

    const stations = candidates.map((i) => {
      const at = pointAt(pts, cum, ctrlArc[i]);
      return {
        s: ctrlArc[i],
        at: [at.x, at.y],
        snap: this._snapPoint(controls[i][0], controls[i][1]),
        node: null,
      };
    });

    // 3. Create nodes and edges between consecutive stations.
    const lastIndex = stations.length - 1;
    for (let j = 0; j < lastIndex; j++) {
      const A = stations[j];
      const B = stations[j + 1];
      if (!(B.s - A.s >= MIN_EDGE_LENGTH)) continue;

      if (!A.node) A.node = this._stationNode(A, created);
      if (!B.node) {
        // A closed loop ends where it began, so reuse the first station's node
        // rather than creating a second node at the same coordinates.
        B.node = (closed && j + 1 === lastIndex && stations[0].node)
          ? stations[0].node
          : this._stationNode(B, created);
      }
      if (!A.node || !B.node || A.node.id === B.node.id) continue;
      if (this.edgeBetween(A.node.id, B.node.id)) continue;

      const slice = slicePolyline(pts, cum, A.s, B.s);
      if (!slice) continue;

      const edge = this._makeEdgeFromPts(A.node.id, B.node.id, cls, slice);
      created.edgeIds.push(edge.id);
    }

    if (!created.edgeIds.length) {
      this._rollback(created, versionBefore);
      created.reason = `the road is shorter than the snapping distance `
        + `(${NODE_SNAP} wu), so its ends would land on the same node`;
      return created;
    }

    const resolved = this.resolveCrossings(created.edgeIds);
    if (!resolved) {
      this._rollback(created, versionBefore);
      created.reason = 'the road could not be resolved against existing roads';
      return created;
    }

    this.version++;
    return created;
  }

  /** Node for a segmentation station: reuse a snapped node, split an edge, or create one. */
  _stationNode(station, created) {
    if (station.node) return station.node;

    if (station.snap && station.snap.kind === 'node') {
      const existing = this.nodes.get(station.snap.id);
      if (existing) { station.node = existing; return existing; }
    }
    if (station.snap && station.snap.kind === 'edgeSplit') {
      const split = this.splitEdge(station.snap.edgeId, station.snap.s);
      if (split) { station.node = split; return split; }
    }

    const node = this._makeNode(station.at[0], station.at[1], 'plain');
    created.nodeIds.push(node.id);
    station.node = node;
    return node;
  }

  /** Undoes the nodes/edges a failed construction created, and restores `version`. */
  _rollback(created, versionBefore) {
    for (const eid of [...created.edgeIds]) this.removeEdge(eid, true);
    for (const nid of [...created.nodeIds]) {
      const node = this.nodes.get(nid);
      if (node && node.edges.size === 0) this.nodes.delete(nid);
    }
    created.edgeIds.length = 0;
    created.nodeIds.length = 0;
    this.version = versionBefore;
  }

  /**
   * Turns every geometric crossing between the given edges and the rest of the
   * network into a real junction.
   *
   * The previous version stopped after a fixed six iterations, so a road crossing
   * eight others produced only six junctions (EVIDENCE E05). This walks a frontier
   * of edges and keeps splitting until no crossing remains, bounded by a budget
   * derived from the network size. Each split replaces one edge with two, so the
   * edge count strictly increases and the loop terminates.
   *
   * @returns {boolean} false when the budget was exhausted (caller must roll back)
   */
  resolveCrossings(edgeIds) {
    const budget = Math.max(200, this.edges.size * 8);
    let splits = 0;
    const frontier = new Set(edgeIds.filter(id => this.edges.has(id)));

    let changed = true;
    while (changed) {
      changed = false;
      const allIds = [...this.edges.keys()];

      scan:
      for (const aId of [...frontier]) {
        const a = this.edges.get(aId);
        if (!a) { frontier.delete(aId); continue; }

        for (const bId of allIds) {
          if (aId === bId) continue;
          const b = this.edges.get(bId);
          if (!b) continue;
          // Edges already sharing a node meet there, not at a crossing.
          if (a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b) continue;

          const x = this._crossPoint(a, b);
          if (!x) continue;

          const n1 = this.splitEdge(aId, x.s1);
          const n2 = this.splitEdge(bId, x.s2);
          splits += 2;
          changed = true;

          // `a` and `b` were replaced by their halves; rescan the children.
          frontier.delete(aId);
          if (n1) for (const eid of n1.edges) frontier.add(eid);
          if (n2) for (const eid of n2.edges) frontier.add(eid);

          if (splits >= budget) return false;
          break scan; // topology changed: restart the scan
        }
      }
    }
    return true;
  }

  // First intersection between two edge polylines. Returns {s1, s2} arc lengths.
  _crossPoint(e1, e2) {
    const p1 = e1.pts, p2 = e2.pts;
    for (let i = 1; i < p1.length; i++) {
      const ax = p1[i - 1][0], ay = p1[i - 1][1], bx = p1[i][0], by = p1[i][1];
      for (let j = 1; j < p2.length; j++) {
        const cx = p2[j - 1][0], cy = p2[j - 1][1], dx = p2[j][0], dy = p2[j][1];
        const r1x = bx - ax, r1y = by - ay, r2x = dx - cx, r2y = dy - cy;
        const den = r1x * r2y - r1y * r2x;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((cx - ax) * r2y - (cy - ay) * r2x) / den;
        const u = ((cx - ax) * r1y - (cy - ay) * r1x) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          const len1 = Math.hypot(r1x, r1y), len2 = Math.hypot(r2x, r2y);
          return { s1: e1.cum[i - 1] + len1 * t, s2: e2.cum[j - 1] + len2 * u };
        }
      }
    }
    return null;
  }

  /**
   * Creates an edge from an AUTHORITATIVE polyline, rather than re-splining a set
   * of control points.
   *
   * Why: splitting or segmenting a path by re-splining a subset of its control
   * points produces a different curve from the one the player drew (EVIDENCE
   * E12). Slicing the already-sampled polyline keeps the geometry identical.
   *
   * `controls` is still populated (sparsely decimated) because the editor and the
   * roundabout code rebuild arms from controls, and v1 saves carry them. The
   * sampled `pts` is what the simulation and renderer use, and it is serialized
   * so a reload reproduces the exact same shape.
   */
  _makeEdgeFromPts(aId, bId, cls, pts) {
    const a = this.nodes.get(aId), b = this.nodes.get(bId);
    if (!a || !b) return null;

    // Drop consecutive duplicates so there are no zero-length runs.
    const clean = [];
    for (const p of pts) {
      const last = clean[clean.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) clean.push([p[0], p[1]]);
    }
    if (clean.length < 2) return null;

    const { cum, total } = polylineLengths(clean);
    const id = this._newId('e');
    const edge = {
      id, a: aId, b: bId, cls,
      controls: this._decimateForControls(clean, cum),
      pts: clean,
      cum,
      total,
      // Each sample is its own segment for a directly-built polyline.
      segIdx: clean.map((_, i) => i),
      driveways: [],       // building ids attached
    };
    this.edges.set(id, edge);
    a.edges.add(id);
    b.edges.add(id);
    return edge;
  }

  /**
   * Sparse control points for an explicit polyline, for editor round-tripping.
   * Always keeps both endpoints; interior points roughly every 30 wu.
   */
  _decimateForControls(pts, cum) {
    const out = [[pts[0][0], pts[0][1]]];
    let nextAt = 30;
    for (let i = 1; i < pts.length - 1; i++) {
      if (cum[i] >= nextAt) {
        out.push([pts[i][0], pts[i][1]]);
        nextAt = cum[i] + 30;
      }
    }
    out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
    return out;
  }

  _makeNode(x, y, type = 'plain') {
    const id = this._newId('n');
    // `buildingIds` is the authority for access-node ownership. It is a LIST
    // because two buildings on opposite sides of a road legitimately share one
    // access node, and a single field let them overwrite each other (EVIDENCE
    // E15). `drivewayFor` is kept in sync for legacy reads and v1 serialization
    // but must never gate access.
    const node = { id, x, y, type, edges: new Set(), light: null, buildingIds: [], drivewayFor: null };
    if (type === 'light') node.light = { cycle: 14, offset: 0, greenRatio: 0.42 };
    this.nodes.set(id, node);
    return node;
  }

  _makeEdge(aId, bId, cls, midControls) {
    const id = this._newId('e');
    const controls = [[this.nodes.get(aId).x, this.nodes.get(aId).y], ...midControls, [this.nodes.get(bId).x, this.nodes.get(bId).y]];
    const edge = {
      id, a: aId, b: bId, cls, controls,
      pts: null, cum: null, total: 0, segIdx: null,
      driveways: [],       // building ids attached
    };
    this.edges.set(id, edge);
    this.nodes.get(aId).edges.add(id);
    this.nodes.get(bId).edges.add(id);
    this.resampleEdge(edge);
    return edge;
  }

  resampleEdge(edge) {
    const { pts, segIdx } = splinePoints(edge.controls, 12);
    const { cum, total } = polylineLengths(pts);
    edge.pts = pts; edge.cum = cum; edge.total = total; edge.segIdx = segIdx;
  }

  // Split an existing edge at arc-length s; returns the junction node.
  //
  // Slices the edge's own polyline rather than re-splining a subset of control
  // points, so both halves follow the original curve exactly (EVIDENCE E12).
  // One-way and ring metadata are copied to both halves - previously they were
  // dropped, which silently turned roundabout segments into two-way roads.
  splitEdge(edgeId, s) {
    const edge = this.edges.get(edgeId);
    if (!edge) return null;
    if (!(s > 0) || !(s < edge.total)) return null; // must be strictly interior

    const p = pointAt(edge.pts, edge.cum, s);
    let node = this._snapNodeWithin(p.x, p.y, 4);
    if (node && (node.id === edge.a || node.id === edge.b)) return node; // already at an endpoint
    if (!node) node = this._makeNode(p.x, p.y, 'plain');

    const ptsA = slicePolyline(edge.pts, edge.cum, 0, s);
    const ptsB = slicePolyline(edge.pts, edge.cum, s, edge.total);
    if (!ptsA || !ptsB) return node; // degenerate slice: keep the node, change nothing

    const aId = edge.a;
    const bId = edge.b;
    const cls = edge.cls;
    const meta = { oneway: !!edge.oneway, ring: !!edge.ring };
    const carried = [...edge.driveways];

    this.removeEdge(edgeId, true); // keep the endpoint nodes
    const eA = this._makeEdgeFromPts(aId, node.id, cls, ptsA);
    const eB = this._makeEdgeFromPts(node.id, bId, cls, ptsB);

    for (const child of [eA, eB]) {
      if (!child) continue;
      if (meta.oneway) child.oneway = true;
      if (meta.ring) child.ring = true;
    }
    // Driveway bookkeeping follows the first half; the access NODES themselves
    // are preserved because keepNodes was true above.
    if (eA) eA.driveways.push(...carried);

    this.version++;
    return node;
  }

  removeEdge(edgeId, keepNodes = false) {
    const edge = this.edges.get(edgeId);
    if (!edge) return;
    this.edges.delete(edgeId);
    for (const nid of [edge.a, edge.b]) {
      const n = this.nodes.get(nid);
      if (n) n.edges.delete(edgeId);
    }
    if (!keepNodes) {
      for (const nid of [edge.a, edge.b]) {
        const n = this.nodes.get(nid);
        if (n && n.edges.size === 0 && n.type !== 'driveway') this.nodes.delete(nid);
      }
    }
    this.version++;
  }

  // Remove a node and its edges (bulldoze intersection)
  removeNode(nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    for (const eid of [...n.edges]) this.removeEdge(eid);
  }

  // ---------- roundabouts ----------

  // Convert a junction node into a real one-way ring. Arm roads are split at
  // the ring radius; the split nodes become ring nodes. Returns
  // { ringNodeIds, ringEdgeIds } or null.
  makeRoundabout(nodeId) {
    const center = this.nodes.get(nodeId);
    if (!center || center.type === 'driveway') return null;
    const armIds = [...center.edges].filter(eid => {
      const e = this.edges.get(eid);
      return e && !e.ring;
    });
    if (armIds.length < 2) return null;

    const maxW = Math.max(...armIds.map(id => roadDimensions(this.edges.get(id)).width));
    const R = 24 + maxW / 2;

    // 1. split every arm at radius R (measured from the center side) and drop
    // the stub between split node and center.
    const armNodes = [];
    for (const eid of armIds) {
      const e = this.edges.get(eid);
      if (!e) continue;
      const fromA = e.a === center.id;
      // arc length (from the center side) where distance from center >= R
      let s = 0;
      if (fromA) {
        for (let k = 0; k < e.cum.length; k++) {
          const p = e.pts[k];
          if (dist(p[0], p[1], center.x, center.y) >= R) { s = e.cum[k]; break; }
        }
      } else {
        for (let k = e.cum.length - 1; k >= 0; k--) {
          const p = e.pts[k];
          if (dist(p[0], p[1], center.x, center.y) >= R) { s = e.total - e.cum[k]; break; }
        }
      }
      s = Math.max(6, Math.min(s, e.total - 6));
      let node = this.splitEdge(eid, s);
      if (!node) continue;
      if (node.id === center.id) {
        // arm is shorter than R: drop the whole arm and use its far node as
        // the ring connection point
        const outerId = e.a === center.id ? e.b : e.a;
        const outer = this.nodes.get(outerId);
        this.removeEdge(eid, true);
        if (!outer) continue;
        node = outer;
      } else {
        // remove the stub that still connects the split node to the center
        const stub = [...node.edges].map(id => this.edges.get(id)).find(e2 => e2 && (e2.a === center.id || e2.b === center.id));
        if (stub) this.removeEdge(stub.id, true);
      }
      node.type = 'plain';
      node.light = null;
      armNodes.push(node);
    }
    this.nodes.delete(center.id); // center no longer needed

    // 2. filler ring nodes so small junctions still get a round ring
    const ringNodes = [...armNodes].filter(n => this.nodes.has(n.id)); // drop stale
    const need = Math.max(4 - ringNodes.length, 0);
    // arm angles (screen coords, y-down)
    const angles = ringNodes.map(n => Math.atan2(n.y - center.y, n.x - center.x));
    for (let i = 0; i < need; i++) {
      // largest angular gap -> filler in the middle of it
      let bi = 0, bg = -1, ba = 0;
      const sorted = [...angles].sort((a, b) => a - b);
      for (let k = 0; k < sorted.length; k++) {
        const nxt = k === sorted.length - 1 ? sorted[0] + Math.PI * 2 : sorted[k + 1];
        const gap = nxt - sorted[k];
        if (gap > bg) { bg = gap; bi = k; ba = sorted[k] + gap / 2; }
      }
      const n = this._makeNode(center.x + Math.cos(ba) * R, center.y + Math.sin(ba) * R, 'plain');
      ringNodes.push(n);
      angles.push(ba);
    }
    for (const n of ringNodes) {
      n.isRing = true;
      // pull arm nodes exactly onto the ring for a clean radial connection
      if (armNodes.includes(n)) {
        const a = Math.atan2(n.y - center.y, n.x - center.x);
        n.x = center.x + Math.cos(a) * R;
        n.y = center.y + Math.sin(a) * R;
        for (const eid of n.edges) {
          const e = this.edges.get(eid);
          if (e && !e.ring) this.resampleEdge(e);
        }
      }
    }

    // 3. one-way ring edges, circulated counterclockwise on screen
    // (y-down: right-hand traffic keeps the ring on the driver's left when
    // entering, so circulation order is DECREASING atan2 angle)
    const ordered = [...ringNodes].sort((p, q) =>
      Math.atan2(q.y - center.y, q.x - center.x) - Math.atan2(p.y - center.y, p.x - center.x));
    const widest = armIds.map(id => this.edges.get(id)?.cls).filter(Boolean)
      .reduce((acc, c) => (roadDimensions({ cls: c }).width > roadDimensions({ cls: acc }).width ? c : acc), 'street');
    const ringCls = widest === 'street' ? 'street' : 'avenue';
    const ringNodeIds = ordered.map(n => n.id);
    const ringEdgeIds = [];
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i], b = ordered[(i + 1) % ordered.length];
      const aAng = Math.atan2(a.y - center.y, a.x - center.x);
      let dAng = Math.atan2(b.y - center.y, b.x - center.x) - aAng;
      while (dAng > Math.PI) dAng -= Math.PI * 2;
      while (dAng < -Math.PI) dAng += Math.PI * 2;
      const mAng = aAng + dAng / 2;
      const mid = [center.x + Math.cos(mAng) * R, center.y + Math.sin(mAng) * R];
      const edge = this._makeEdge(a.id, b.id, ringCls, [mid]);
      edge.ring = true;
      edge.oneway = true;
      ringEdgeIds.push(edge.id);
    }
    this.resolveCrossings(ringEdgeIds);
    this.version++;
    return { ringNodeIds, ringEdgeIds };
  }

  // Bulldoze a whole roundabout given any node on/inside it. Restores a plain
  // junction at the center and reconnects all arms.
  removeRoundabout(nodeId) {
    const start = this.nodes.get(nodeId);
    if (!start) return false;
    // find the ring component containing this node (or one of its ring edges)
    let entry = null;
    if (start.isRing) entry = start.id;
    else for (const eid of start.edges) { const e = this.edges.get(eid); if (e?.ring) { entry = e.a; break; } }
    if (!entry) return false;
    const ringNodes = new Set();
    const ringEdges = new Set();
    const queue = [entry];
    while (queue.length) {
      const nid = queue.pop();
      if (ringNodes.has(nid)) continue;
      ringNodes.add(nid);
      for (const eid of this.nodes.get(nid).edges) {
        const e = this.edges.get(eid);
        if (!e?.ring || ringEdges.has(eid)) continue;
        ringEdges.add(eid);
        queue.push(e.a === nid ? e.b : e.a);
      }
    }
    // arms + their outer ends
    let cx = 0, cy = 0;
    for (const nid of ringNodes) { cx += this.nodes.get(nid).x; cy += this.nodes.get(nid).y; }
    cx /= ringNodes.size; cy /= ringNodes.size;
    const arms = [];
    for (const eid of ringEdges) this.removeEdge(eid, true);
    for (const nid of ringNodes) {
      const n = this.nodes.get(nid);
      for (const eid of [...n.edges]) {
        const e = this.edges.get(eid);
        if (!e) continue;
        const outerId = e.a === nid ? e.b : e.a;
        arms.push({ cls: e.cls, controls: e.controls.slice(1, -1), outerId });
        this.removeEdge(eid, true);
      }
      this.nodes.delete(nid);
    }
    const c = this._makeNode(cx, cy, 'plain');
    for (const arm of arms) {
      if (arm.outerId === c.id) continue;
      this._makeEdge(arm.outerId, c.id, arm.cls, arm.controls.slice().reverse());
    }
    this.resolveCrossings([c.id]);
    this.version++;
    return true;
  }

  // ---------- snapping ----------

  _snapNode(x, y) {
    return this._snapNodeWithin(x, y, NODE_SNAP);
  }

  _snapNodeWithin(x, y, radius) {
    let best = null, bd = radius;
    for (const n of this.nodes.values()) {
      const d = dist(x, y, n.x, n.y);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // Returns {kind:'node', id} | {kind:'edgeSplit', edgeId, s} | null
  _snapPoint(x, y) {
    const n = this._snapNode(x, y);
    if (n) return { kind: 'node', id: n.id };
    let best = null, bd = EDGE_SNAP;
    for (const e of this.edges.values()) {
      if (e.ring) continue; // never split the circulating lane of a roundabout
      const { s, d } = projectOnPolyline(e.pts, e.cum, x, y);
      if (d < bd) { bd = d; best = { kind: 'edgeSplit', edgeId: e.id, s }; }
    }
    return best;
  }

  // Find nearest road position for driveway attachment.
  // Returns {edgeId, s, x, y} or null.
  nearestRoadPoint(x, y, maxDist = 400) {
    let best = null, bd = maxDist;
    for (const e of this.edges.values()) {
      if (e.ring) continue; // no driveways onto a roundabout ring
      const { s, d } = projectOnPolyline(e.pts, e.cum, x, y);
      if (d < bd) { bd = d; best = { edgeId: e.id, s, d }; }
    }
    if (!best) return null;
    const e = this.edges.get(best.edgeId);
    const p = pointAt(e.pts, e.cum, best.s);
    return { edgeId: best.edgeId, s: best.s, x: p.x, y: p.y };
  }

  // Attach building access to the nearest road: creates a driveway node by
  // splitting the edge, or reuses a nearby end node.
  //
  // `maxDist` bounds how far a NEW building may reach. It is a placement policy,
  // so the caller supplies it (Economy uses ACCESS_MAX_DISTANCE).
  attachDriveway(buildingId, x, y, maxDist = 400) {
    const near = this.nearestRoadPoint(x, y, maxDist);
    if (!near) return null;
    let node;
    if (near.s < 20 || near.s > this.edges.get(near.edgeId).total - 20) {
      // attach to nearest end node instead of splitting a tiny edge
      const e = this.edges.get(near.edgeId);
      const a = this.nodes.get(e.a), b = this.nodes.get(e.b);
      node = dist(x, y, a.x, a.y) < dist(x, y, b.x, b.y) ? a : b;
    } else {
      node = this.splitEdge(near.edgeId, near.s);
      if (!node) return null;
      node.type = 'driveway';
    }
    if (buildingId) this.claimDriveway(node, buildingId);
    return node;
  }

  /**
   * Records `buildingId` as an owner of an access node.
   * Idempotent: claiming twice does not duplicate the entry.
   */
  claimDriveway(node, buildingId) {
    if (!node || !buildingId) return node;
    if (!Array.isArray(node.buildingIds)) node.buildingIds = [];
    if (!node.buildingIds.includes(buildingId)) node.buildingIds.push(buildingId);
    node.drivewayFor = node.buildingIds[0] ?? null;
    return node;
  }

  /**
   * Releases one owner (or every owner when `buildingId` is omitted).
   *
   * The access node is only merged away once NO building still uses it - that is
   * the fix for the silent corruption where removing one of two buildings
   * deleted a node the other still referenced.
   */
  detachDriveway(nodeId, buildingId) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    if (!Array.isArray(n.buildingIds)) n.buildingIds = [];

    if (buildingId === undefined) n.buildingIds.length = 0;
    else n.buildingIds = n.buildingIds.filter(id => id !== buildingId);

    n.drivewayFor = n.buildingIds[0] ?? null;
    this._maybeRemoveDrivewayNode(n);
  }

  _maybeRemoveDrivewayNode(n) {
    // An access node survives while ANY building still uses it.
    if (n.type !== 'driveway') return;
    if (Array.isArray(n.buildingIds) ? n.buildingIds.length > 0 : !!n.drivewayFor) return;
    if (n.edges.size !== 2) return;
    const [e1id, e2id] = [...n.edges];
    const e1 = this.edges.get(e1id), e2 = this.edges.get(e2id);
    if (!e1 || !e2) return;
    if (e1.cls !== e2.cls) return;
    // merge e1 + e2 through n
    const other1 = e1.a === n.id ? e1.b : e1.a;
    const other2 = e2.a === n.id ? e2.b : e2.a;
    if (other1 === other2) return; // would create duplicate edge/loop
    const midControls = e1.a === n.id
      ? [...e1.controls.slice(1, -1)]
      : [...e1.controls.slice(1, -1)].reverse();
    const mid2 = e2.a === n.id
      ? [...e2.controls.slice(1, -1)]
      : [...e2.controls.slice(1, -1)].reverse();
    this.removeEdge(e1id, true);
    this.removeEdge(e2id, true);
    this.nodes.delete(n.id);
    this._makeEdge(other1, other2, e1.cls, [...midControls, [n.x, n.y], ...mid2]);
    this.version++;
  }

  // ---------- queries ----------

  edgeBetween(aId, bId) {
    const n = this.nodes.get(aId);
    if (!n) return null;
    for (const eid of n.edges) {
      const e = this.edges.get(eid);
      if (e && (e.a === bId || e.b === bId)) return e;
    }
    return null;
  }

  otherEnd(edge, nodeId) { return edge.a === nodeId ? edge.b : edge.a; }

  // Lane center offset from the road centerline for direction travel, lane i.
  // Delegates to roadProfiles so the offset cannot drift from the pavement
  // width that rendering uses (EVIDENCE E02).
  laneOffset(edge, i) {
    return Math.abs(laneCenterOffset(edge, 1, i));
  }

  // Point on lane: direction a->b (dir=1) or b->a (dir=-1), lane index i, arc s.
  // Screen coords are y-down, so the driver's right-hand normal of direction
  // (dx,dy) is (-dy,dx). For reverse travel, the right side flips sign.
  lanePoint(edge, dir, i, s) {
    const p = pointAt(edge.pts, edge.cum, dir === 1 ? s : edge.total - s);
    const off = Math.abs(laneCenterOffset(edge, dir, i));
    const nx = -Math.sin(p.dir), ny = Math.cos(p.dir); // right-hand normal (y-down)
    const sgn = dir === 1 ? 1 : -1;
    return { x: p.x + nx * off * sgn, y: p.y + ny * off * sgn, dir: p.dir };
  }

  // Serialize / restore (topology only; cars are not saved)
  //
  // `pts` is serialized alongside `controls` so a reload reproduces the exact
  // sampled geometry. Re-splining controls on load would slightly change the
  // curve (EVIDENCE E12). v1 saves have no `pts`, so loading still falls back to
  // resampling from controls.
  toJSON() {
    return {
      nodes: [...this.nodes.values()].map(n => ({ id: n.id, x: n.x, y: n.y, type: n.type, light: n.light, buildingIds: n.buildingIds || [], drivewayFor: n.drivewayFor || null, isRing: n.isRing || false })),
      edges: [...this.edges.values()].map(e => ({ id: e.id, a: e.a, b: e.b, cls: e.cls, controls: e.controls, pts: e.pts, driveways: e.driveways, ring: e.ring || false, oneway: e.oneway || false })),
    };
  }

  static fromJSON(data, options = {}) {
    const net = new RoadNetwork(options);
    for (const n of data.nodes) {
      // Reserve loaded IDs so a later allocation cannot collide with them.
      net.ids?.reserve(n.id);
      const node = { id: n.id, x: n.x, y: n.y, type: n.type, edges: new Set(), light: n.light, buildingIds: Array.isArray(n.buildingIds) ? [...n.buildingIds] : [], drivewayFor: n.drivewayFor || null, isRing: n.isRing || false };
      net.nodes.set(node.id, node);
    }
    for (const e of data.edges) {
      net.ids?.reserve(e.id);
      const edge = { id: e.id, a: e.a, b: e.b, cls: e.cls, controls: e.controls, pts: null, cum: null, total: 0, segIdx: null, driveways: e.driveways || [], ring: e.ring || false, oneway: e.oneway || false };
      net.edges.set(edge.id, edge);
      net.nodes.get(e.a)?.edges.add(e.id);
      net.nodes.get(e.b)?.edges.add(e.id);
      if (Array.isArray(e.pts) && e.pts.length >= 2) {
        // Saved sampled geometry is authoritative: use it verbatim.
        const { cum, total } = polylineLengths(e.pts);
        edge.pts = e.pts.map(p => [p[0], p[1]]);
        edge.cum = cum;
        edge.total = total;
        edge.segIdx = edge.pts.map((_, i) => i);
      } else {
        // v1 save: no sampled geometry, so rebuild it from the control points.
        net.resampleEdge(edge);
      }
    }
    // upgrade legacy point roundabouts into real rings
    for (const n of [...net.nodes.values()]) {
      if (n.type === 'roundabout') net.makeRoundabout(n.id);
    }
    return net;
  }
}
