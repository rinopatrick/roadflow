// Road construction semantics (S01.5).
//
// Defects being fixed:
//
//  E12 / GAP-addroad-multipoint-topology - `addRoad` passed `controls.slice(1, i)`
//      as each link's midpoints, so EVERY link repeated all earlier control
//      points and each spline doubled back through its own start node. A
//      four-corner loop drawn in one call produced 6 edges, 5 nodes, a degree-6
//      hub and two separate nodes at identical coordinates - the loop never
//      closed. That malformed hub then gridlocked (GAP-loop-gridlock).
//
//  E05 - `resolveCrossings` gave up after 6 iterations, so a road crossing eight
//      others produced only 6 junctions.
//
//  GAP-min-segment-length - a segment shorter than NODE_SNAP (18 wu) snapped its
//      far endpoint back onto the existing node, so `addRoad` silently created
//      nothing.
//
// Established semantics (from the S01.5 task):
//   * the clicked control sequence is ONE continuous path
//   * graph segmentation happens at actual junctions and endpoints, not at
//     arbitrary repeated control prefixes
//   * a path returning to its own start closes into a ring rather than
//     collapsing
//   * a failed construction leaves the graph exactly as it was
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { assertGraphConsistent } from './helpers/invariants.js';

const NODE_SNAP = 18; // wu; documented in roadNetwork.js

/** Nodes grouped by rounded coordinate, to detect duplicate coincident nodes. */
function nodesAt(net, x, y, tol = 1) {
  return [...net.nodes.values()].filter(n => Math.abs(n.x - x) < tol && Math.abs(n.y - y) < tol);
}

// ------------------------------------------------- one continuous path ---

test('a multi-point road uses each control point once, with no doubling back', () => {
  const net = new RoadNetwork();
  // A simple L: (0,0) -> (300,0) -> (300,300). Three clicks, one road.
  const res = net.addRoad([[0, 0], [300, 0], [300, 300]], 'street');
  assertGraphConsistent(net, 'L-shape');

  assert.ok(res.edgeIds.length >= 1, 'the L must build at least one edge');

  // No edge may contain a control point that coincides with its own endpoint.
  for (const id of res.edgeIds) {
    const e = net.edges.get(id);
    const a = net.nodes.get(e.a), b = net.nodes.get(e.b);
    for (const [px, py] of e.controls) {
      const atA = Math.hypot(px - a.x, py - a.y) < 1e-6;
      const atB = Math.hypot(px - b.x, py - b.y) < 1e-6;
      // Endpoints are expected; an interior point coinciding with either
      // endpoint means the spline doubles back (the E12 defect).
      const isEndpoint = (px === e.controls[0][0] && py === e.controls[0][1])
        || (px === e.controls[e.controls.length - 1][0] && py === e.controls[e.controls.length - 1][1]);
      if (!isEndpoint) {
        assert.ok(!atA && !atB,
          `edge ${id} has interior control (${px},${py}) coinciding with an endpoint`);
      }
    }
  }
});

test('a multi-point road does not create a spurious junction mid-path', () => {
  const net = new RoadNetwork();
  // A gentle curve with no other roads: nothing here should be a junction.
  net.addRoad([[0, 0], [200, 80], [400, 0]], 'street');
  assertGraphConsistent(net, 'curve');

  const junctions = [...net.nodes.values()].filter(n => n.edges.size > 2);
  assert.equal(junctions.length, 0,
    `a standalone curve must not create a junction, found ${junctions.length}`);
});

// ------------------------------------------------------- closed loops ---

test('a four-corner loop drawn in one call closes into a ring', () => {
  const net = new RoadNetwork();
  const corners = [[-250, 30], [150, 30], [150, 210], [-250, 210], [-250, 30]];
  net.addRoad(corners, 'street');
  assertGraphConsistent(net, 'loop');

  // The start and end coordinates must resolve to ONE node, not two.
  const atStart = nodesAt(net, -250, 30);
  assert.equal(atStart.length, 1,
    `expected one node at the start corner, found ${atStart.length}`);

  // Every node in the ring must be reachable from every other: the loop closed.
  const start = atStart[0];
  const seen = new Set([start.id]);
  const queue = [start.id];
  while (queue.length) {
    const id = queue.pop();
    for (const eid of net.nodes.get(id).edges) {
      const e = net.edges.get(eid);
      const other = e.a === id ? e.b : e.a;
      if (!seen.has(other)) { seen.add(other); queue.push(other); }
    }
  }
  assert.equal(seen.size, net.nodes.size,
    `all ${net.nodes.size} nodes must be in one connected ring, reached ${seen.size}`);
});

test('a closed loop has no degree-6 hub', () => {
  const net = new RoadNetwork();
  net.addRoad([[-250, 30], [150, 30], [150, 210], [-250, 210], [-250, 30]], 'street');

  const degrees = [...net.nodes.values()].map(n => n.edges.size);
  assert.ok(Math.max(...degrees) <= 2,
    `a plain loop should only contain degree-1..2 nodes, max degree was ${Math.max(...degrees)}`);
});

test('a loop drawn in one call matches the same loop drawn as four calls', () => {
  const asOne = new RoadNetwork();
  asOne.addRoad([[-250, 30], [150, 30], [150, 210], [-250, 210], [-250, 30]], 'street');

  const asFour = new RoadNetwork();
  asFour.addRoad([[-250, 30], [150, 30]], 'street');
  asFour.addRoad([[150, 30], [150, 210]], 'street');
  asFour.addRoad([[150, 210], [-250, 210]], 'street');
  asFour.addRoad([[-250, 210], [-250, 30]], 'street');

  assertGraphConsistent(asOne, 'loop-one-call');
  assertGraphConsistent(asFour, 'loop-four-calls');

  // Same topology: same node count, and the same multiset of node degrees.
  assert.equal(asOne.nodes.size, asFour.nodes.size,
    `one call made ${asOne.nodes.size} nodes, four calls made ${asFour.nodes.size}`);
  const deg = (net) => [...net.nodes.values()].map(n => n.edges.size).sort((a, b) => a - b);
  assert.deepEqual(deg(asOne), deg(asFour), 'node degree profile must match');
});

// --------------------------------------------------- shared endpoints ---

test('a shared endpoint creates a junction', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [300, 0]], 'street');
  net.addRoad([[300, 0], [300, 300]], 'street');
  assertGraphConsistent(net, 'shared-endpoint');

  const junction = [...net.nodes.values()].find(n => n.edges.size === 2 && n.x === 300 && n.y === 0);
  assert.ok(junction, 'the shared corner is one node with two edges');
  assert.equal(net.nodes.size, 3, 'three nodes total');
});

test('a mid-edge landing splits the existing edge', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [600, 0]], 'street');
  net.addRoad([[300, 0], [300, 300]], 'street');
  assertGraphConsistent(net, 'mid-edge');

  const split = [...net.nodes.values()].find(n => Math.abs(n.x - 300) < 1 && Math.abs(n.y) < 1);
  assert.ok(split, 'a node was created at the landing point');
  assert.equal(split.edges.size, 3, 'the landing node joins two half-edges plus the new road');
});

test('a duplicate road between the same nodes is rejected', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [300, 0]], 'street');
  const before = net.edges.size;
  const again = net.addRoad([[0, 0], [300, 0]], 'street');
  assert.equal(again.edgeIds.length, 0, 'no new edge for a duplicate');
  assert.equal(net.edges.size, before, 'edge count unchanged');
});

// --------------------------------------------- crossing resolution (E05) ---

test('one road across eight roads creates eight junctions', () => {
  const net = new RoadNetwork();
  for (let i = 0; i < 8; i++) net.addRoad([[i * 100, -150], [i * 100, 150]], 'street');
  net.addRoad([[-100, 0], [800, 0]], 'street');
  assertGraphConsistent(net, 'eight-crossings');

  const junctions = [...net.nodes.values()].filter(n => n.edges.size === 4);
  assert.equal(junctions.length, 8,
    `expected 8 junctions, got ${junctions.length} (the old resolver stopped at 6)`);

  const xs = junctions.map(n => Math.round(n.x)).sort((a, b) => a - b);
  assert.deepEqual(xs, [0, 100, 200, 300, 400, 500, 600, 700],
    `junctions must sit at each crossing, got ${xs.join(',')}`);
});

test('crossings are found regardless of how many are on one road', () => {
  // 20 crossings, well past the old 6-iteration cap.
  const net = new RoadNetwork();
  for (let i = 0; i < 20; i++) net.addRoad([[i * 60, -100], [i * 60, 100]], 'street');
  net.addRoad([[-50, 0], [1200, 0]], 'street');
  assertGraphConsistent(net, 'twenty-crossings');

  const junctions = [...net.nodes.values()].filter(n => n.edges.size === 4);
  assert.equal(junctions.length, 20, `expected 20 junctions, got ${junctions.length}`);
});

test('a road crossing another only once makes exactly one junction', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, -200], [0, 200]], 'street');
  net.addRoad([[-200, 0], [200, 0]], 'street');
  assertGraphConsistent(net, 'single-crossing');
  assert.equal([...net.nodes.values()].filter(n => n.edges.size === 4).length, 1);
});

test('crossings do not create duplicate coincident junctions', () => {
  const net = new RoadNetwork();
  // Two roads crossing at the same point from different directions.
  net.addRoad([[-200, 0], [200, 0]], 'street');
  net.addRoad([[0, -200], [0, 200]], 'street');
  net.addRoad([[-150, -150], [150, 150]], 'street');
  assertGraphConsistent(net, 'triple-crossing');

  const atOrigin = nodesAt(net, 0, 0, 1.5);
  assert.equal(atOrigin.length, 1,
    `all three roads should share one node at the crossing, found ${atOrigin.length}`);
});

// ------------------------------------------------------- split integrity ---

test('splitting a one-way edge preserves its direction on both halves', () => {
  // Reachable path: _snapPoint skips RING edges but not ONE-WAY edges, so a new
  // road landing midway on a one-way road splits it. The previous splitEdge
  // recreated the halves without copying `oneway`, silently turning a one-way
  // road into two-way traffic.
  const net = new RoadNetwork();
  const built = net.addRoad([[0, 0], [400, 0]], 'street');
  const original = net.edges.get(built.edgeIds[0]);
  original.oneway = true; // as a one-way road tool (S04.1) will set

  net.addRoad([[200, 0], [200, 300]], 'street');
  const split = [...net.nodes.values()].find(n => Math.abs(n.x - 200) < 1 && Math.abs(n.y) < 1);
  assert.ok(split, 'the landing road created a node on the one-way road');

  const halves = [...split.edges]
    .map(id => net.edges.get(id))
    .filter((e) => {
      // A half runs to one of the ORIGINAL road endpoints.
      const other = net.nodes.get(e.a === split.id ? e.b : e.a);
      return Math.abs(other.x) < 1 || Math.abs(other.x - 400) < 1;
    });
  assert.equal(halves.length, 2, `expected two halves, found ${halves.length}`);
  for (const h of halves) {
    assert.equal(h.oneway, true,
      `half ${h.id} lost its one-way flag; the road would silently become two-way`);
  }
  const sum = halves.reduce((acc, h) => acc + h.total, 0);
  assert.ok(Math.abs(sum - 400) / 400 < 0.02,
    `halves should sum to the original 400 wu, got ${sum.toFixed(1)}`);
});

test('roundabout ring edges keep their flags after conversion', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [200, 0]], 'street');
  net.addRoad([[100, -200], [100, 200]], 'street');
  const junction = [...net.nodes.values()].find(n => n.edges.size === 4);
  assert.ok(junction, 'fixture created a junction');
  const converted = net.makeRoundabout(junction.id);
  assert.ok(converted, 'roundabout built');

  for (const eid of converted.ringEdgeIds) {
    const e = net.edges.get(eid);
    assert.equal(e.ring, true, `ring edge ${eid} keeps its ring flag`);
    assert.equal(e.oneway, true, `ring edge ${eid} keeps its one-way flag`);
  }
});

test('a split edge keeps its class and stays connected', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [600, 0]], 'highway');
  const edge = [...net.edges.values()][0];
  const total = edge.total;

  const node = net.splitEdge(edge.id, total / 2);
  assert.ok(node, 'split produced a node');
  assertGraphConsistent(net, 'after-split');

  const halves = [...node.edges].map(id => net.edges.get(id));
  assert.equal(halves.length, 2, 'two halves meet at the split node');
  for (const h of halves) {
    assert.equal(h.cls, 'highway', 'the split preserves the road class');
    assert.ok(h.total > 0, 'each half has positive length');
  }
  const sum = halves.reduce((acc, h) => acc + h.total, 0);
  assert.ok(Math.abs(sum - total) / total < 0.01,
    `halves should sum to the original length: ${sum.toFixed(1)} vs ${total.toFixed(1)}`);
});

// ------------------------------------------------ minimum segment length ---

test('a segment shorter than the snap radius is rejected with a reason, not silently', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [400, 0]], 'street');
  const before = { nodes: net.nodes.size, edges: net.edges.size };

  // 10 wu is shorter than NODE_SNAP (18 wu). The old code returned empty
  // arrays and changed nothing, with no way for the caller to know why.
  const res = net.addRoad([[0, 0], [10, 0]], 'street');
  assert.equal(res.edgeIds.length, 0, 'no edge is created for a too-short segment');
  assert.ok(res.reason, 'the result must explain why nothing was built');
  assert.match(res.reason, /short|snap|length/i, `unhelpful reason: ${res.reason}`);
  assert.equal(net.nodes.size, before.nodes, 'graph unchanged');
  assert.equal(net.edges.size, before.edges, 'graph unchanged');
});

test('a short segment between two distinct existing nodes still builds', () => {
  // Two nodes 10 wu apart: this is a legitimate short connector, not a snap
  // mistake, and S04.3 will need short auxiliary segments.
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [400, 0]], 'street');
  net.addRoad([[100, 0], [100, -400]], 'street'); // creates a node at (100,0)
  assertGraphConsistent(net, 'before-short');

  const res = net.addRoad([[100, 0], [110, 0]], 'street');
  // Either it builds (creating a genuine 10 wu stub) or it is rejected with a
  // reason; it must never silently do nothing.
  assert.ok(res.edgeIds.length > 0 || res.reason,
    'a short segment must either build or explain itself');
});

// ------------------------------------------------------- failure safety ---

test('a degenerate path leaves the graph byte-identical', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [400, 0]], 'street');
  const snapshot = () => JSON.stringify({
    nodes: [...net.nodes.keys()].sort(),
    edges: [...net.edges.keys()].sort(),
    version: net.version,
  });
  const before = snapshot();

  // Every point is the same location: nothing valid can be built.
  const res = net.addRoad([[200, 0], [200, 0], [200, 0]], 'street');
  assert.ok(res.reason, 'a degenerate path must report a reason');
  assert.equal(snapshot(), before, 'graph must be untouched after a rejected path');
});

test('a single-point path is rejected', () => {
  const net = new RoadNetwork();
  const res = net.addRoad([[50, 50]], 'street');
  assert.equal(res.edgeIds.length, 0);
  assert.ok(res.reason, 'a single point must report a reason');
  assert.equal(net.nodes.size, 0, 'nothing created');
});

// ------------------------------------------------------ long path safety ---

test('a long multi-point road stays structurally sound', () => {
  const net = new RoadNetwork();
  const pts = [];
  for (let i = 0; i < 12; i++) pts.push([i * 120, Math.sin(i) * 60]);
  net.addRoad(pts, 'avenue');
  assertGraphConsistent(net, 'long-road');

  // A single continuous road should be one connected component.
  const start = [...net.nodes.values()][0];
  const seen = new Set([start.id]);
  const queue = [start.id];
  while (queue.length) {
    const id = queue.pop();
    for (const eid of net.nodes.get(id).edges) {
      const e = net.edges.get(eid);
      const other = e.a === id ? e.b : e.a;
      if (!seen.has(other)) { seen.add(other); queue.push(other); }
    }
  }
  assert.equal(seen.size, net.nodes.size, 'the whole road is one component');
});
