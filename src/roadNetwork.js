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
import { dist, splinePoints, polylineLengths, projectOnPolyline, pointAt, clamp, segDist, uid } from './core.js';

export const ROAD_CLASS = {
  street:  { lanesPerDir: 1, speed: 14, width: 11, laneW: 6.5, color: '#ffffff' },  // px/s at 1x
  avenue:  { lanesPerDir: 2, speed: 18, width: 16, laneW: 6.0, color: '#ffffff' },
  highway: { lanesPerDir: 3, speed: 30, width: 24, laneW: 6.0, color: '#ffffff' },
};

const NODE_SNAP = 18;      // snap to existing node within this dist
const EDGE_SNAP = 12;      // split existing edge within this dist

export class RoadNetwork {
  constructor() {
    this.clear();
  }

  clear() {
    this.nodes = new Map();  // id -> node
    this.edges = new Map();  // id -> edge
    this.version = 0;        // bumped on any topology change (path invalidation)
  }

  // ---------- construction ----------

  // controls: [[x,y], ...] world coords. cls: 'street'|'avenue'|'highway'
  // Returns { nodeIds, edgeIds } created/touched.
  addRoad(controls, cls = 'street') {
    const created = { nodeIds: [], edgeIds: [] };
    if (controls.length < 2) return created;

    // Resolve endpoints (and intermediate points) with snapping
    const resolved = [];
    for (let i = 0; i < controls.length; i++) {
      const [x, y] = controls[i];
      const snap = this._snapPoint(x, y);
      resolved.push({ x, y, snap });
    }

    let prev = this._resolveEndpoint(resolved[0], created);

    for (let i = 1; i < resolved.length; i++) {
      const r = resolved[i];
      const isLast = i === resolved.length - 1;

      // intermediate points never snap to edges (only endpoints do)
      const snap = isLast ? r.snap : (this._snapNode(r.x, r.y));

      if (snap && snap.kind === 'node') {
        const node = this.nodes.get(snap.id);
        if (node && node.id !== prev) {
          this._link(prev, node.id, controls.slice(1, i), cls, created, i);
          prev = node.id;
        }
        continue;
      }
      if (snap && snap.kind === 'edgeSplit') {
        const newNode = this.splitEdge(snap.edgeId, snap.s);
        this._link(prev, newNode.id, controls.slice(1, i), cls, created, i);
        prev = newNode.id;
        continue;
      }

      // plain new node
      const node = this._makeNode(r.x, r.y, 'plain');
      created.nodeIds.push(node.id);
      this._link(prev, node.id, controls.slice(1, i), cls, created, i);
      prev = node.id;
    }
    this.resolveCrossings(created.edgeIds);
    this.version++;
    return created;
  }

  // Roads that geometrically cross must become real junctions (like the genre
  // standard). Detect polyline intersections between new edges and all others;
  // split both edges at the crossing point so cars can pass through.
  resolveCrossings(edgeIds) {
    let frontier = new Set(edgeIds);
    for (let iter = 0; iter < 6; iter++) {
      let changed = false;
      outer:
      for (const aId of frontier) {
        const a = this.edges.get(aId);
        if (!a) continue;
        for (const bId of this.edges.keys()) {
          if (aId === bId) continue;
          const b = this.edges.get(bId);
          if (!b) continue;
          if (a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b) continue;
          const x = this._crossPoint(a, b);
          if (x) {
            this.splitEdge(aId, x.s1);
            this.splitEdge(bId, x.s2);
            changed = true;
            frontier = new Set([...this.edges.keys()]); // rescan after topology change
            break outer;
          }
        }
      }
      if (!changed) break;
    }
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

  // Create edge between two node ids. controlsForSpline: control points between
  // the endpoints (endpoints implied). We rebuild full control list.
  _link(aId, bId, midControls, cls, created, upTo) {
    if (aId === bId) return;
    // skip if edge already exists
    const a = this.nodes.get(aId), b = this.nodes.get(bId);
    if (!a || !b) return;
    if (this.edgeBetween(aId, bId)) return; // edge already exists (either direction)
    const edge = this._makeEdge(aId, bId, cls, midControls);
    created.edgeIds.push(edge.id);
  }

  // Resolve the first point of a road: use snapped node or create a new one.
  _resolveEndpoint(r, created) {
    if (r.snap && r.snap.kind === 'node') {
      const n = this.nodes.get(r.snap.id);
      if (n) return n.id;
    }
    if (r.snap && r.snap.kind === 'edgeSplit') {
      const node = this.splitEdge(r.snap.edgeId, r.snap.s);
      created.nodeIds.push(node.id);
      return node.id;
    }
    const node = this._makeNode(r.x, r.y, 'plain');
    created.nodeIds.push(node.id);
    return node.id;
  }

  _makeNode(x, y, type = 'plain') {
    const id = uid();
    const node = { id, x, y, type, edges: new Set(), light: null };
    if (type === 'light') node.light = { cycle: 14, offset: 0, greenRatio: 0.42 };
    this.nodes.set(id, node);
    return node;
  }

  _makeEdge(aId, bId, cls, midControls) {
    const id = uid();
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
  // Reuses an existing node if one already sits at the split point.
  splitEdge(edgeId, s) {
    const edge = this.edges.get(edgeId);
    if (!edge) return null;
    const p = pointAt(edge.pts, edge.cum, s);
    let node = this._snapNodeWithin(p.x, p.y, 4);
    if (node && (node.id === edge.a || node.id === edge.b)) return node; // already at endpoint
    if (!node) node = this._makeNode(p.x, p.y, 'plain');

    // Find the control-point index where the split happens
    const sampleK = edge.cum.findIndex(c => c >= s);
    const kIdx = edge.segIdx[clamp(sampleK, 0, edge.segIdx.length - 1)];
    const ctrlA = edge.controls.slice(0, kIdx + 1).map(c => c.slice());
    const ctrlB = edge.controls.slice(kIdx + 1).map(c => c.slice());
    ctrlA.push([p.x, p.y]);
    ctrlB.unshift([p.x, p.y]);

    // Rebuild as two edges
    this.removeEdge(edgeId, true);
    const eA = this._makeEdge(edge.a, node.id, edge.cls, ctrlA.slice(1, -1));
    const eB = this._makeEdge(node.id, edge.b, edge.cls, ctrlB.slice(1, -1));
    // carry over driveways to whichever side is nearer
    for (const bId of edge.driveways) eA.driveways.push(bId); // reattached by caller if needed
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

    const maxW = Math.max(...armIds.map(id => ROAD_CLASS[this.edges.get(id).cls].width));
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
      .reduce((acc, c) => (ROAD_CLASS[c].width > ROAD_CLASS[acc].width ? c : acc), 'street');
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

  // Attach building to road: creates a driveway node by splitting the edge.
  attachDriveway(buildingId, x, y) {
    const near = this.nearestRoadPoint(x, y);
    if (!near) return null;
    let node;
    if (near.s < 20 || near.s > this.edges.get(near.edgeId).total - 20) {
      // attach to nearest end node instead of splitting tiny edge
      const e = this.edges.get(near.edgeId);
      const a = this.nodes.get(e.a), b = this.nodes.get(e.b);
      node = dist(x, y, a.x, a.y) < dist(x, y, b.x, b.y) ? a : b;
    } else {
      node = this.splitEdge(near.edgeId, near.s);
      node.type = 'driveway';
    }
    node.drivewayFor = buildingId;
    return node;
  }

  detachDriveway(nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n || n.type !== 'driveway') return;
    n.drivewayFor = null;
    // merge back if plain degree-2 passthrough
    this._maybeRemoveDrivewayNode(n);
  }

  _maybeRemoveDrivewayNode(n) {
    if (n.type !== 'driveway' || n.drivewayFor) return;
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
  laneOffset(edge, i) {
    const c = ROAD_CLASS[edge.cls];
    const centerGap = 1.2;
    return centerGap / 2 + (i + 0.5) * c.laneW;
  }

  // Point on lane: direction a->b (dir=1) or b->a (dir=-1), lane index i, arc s.
  // Screen coords are y-down, so the driver's right-hand normal of direction
  // (dx,dy) is (-dy,dx). For reverse travel, the right side flips sign.
  lanePoint(edge, dir, i, s) {
    const p = pointAt(edge.pts, edge.cum, dir === 1 ? s : edge.total - s);
    const off = this.laneOffset(edge, i);
    const nx = -Math.sin(p.dir), ny = Math.cos(p.dir); // right-hand normal (y-down)
    const sgn = dir === 1 ? 1 : -1;
    return { x: p.x + nx * off * sgn, y: p.y + ny * off * sgn, dir: p.dir };
  }

  // Serialize / restore (topology only; cars are not saved)
  toJSON() {
    return {
      nodes: [...this.nodes.values()].map(n => ({ id: n.id, x: n.x, y: n.y, type: n.type, light: n.light, drivewayFor: n.drivewayFor || null, isRing: n.isRing || false })),
      edges: [...this.edges.values()].map(e => ({ id: e.id, a: e.a, b: e.b, cls: e.cls, controls: e.controls, driveways: e.driveways, ring: e.ring || false, oneway: e.oneway || false })),
    };
  }

  static fromJSON(data) {
    const net = new RoadNetwork();
    for (const n of data.nodes) {
      const node = { id: n.id, x: n.x, y: n.y, type: n.type, edges: new Set(), light: n.light, drivewayFor: n.drivewayFor || null, isRing: n.isRing || false };
      net.nodes.set(node.id, node);
    }
    for (const e of data.edges) {
      const edge = { id: e.id, a: e.a, b: e.b, cls: e.cls, controls: e.controls, pts: null, cum: null, total: 0, segIdx: null, driveways: e.driveways || [], ring: e.ring || false, oneway: e.oneway || false };
      net.edges.set(edge.id, edge);
      net.nodes.get(e.a)?.edges.add(e.id);
      net.nodes.get(e.b)?.edges.add(e.id);
      net.resampleEdge(edge);
    }
    // upgrade legacy point roundabouts into real rings
    for (const n of [...net.nodes.values()]) {
      if (n.type === 'roundabout') net.makeRoundabout(n.id);
    }
    return net;
  }
}
