import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { findPath, pathToSteps } from '../src/pathfinding.js';

function squareNet() {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [100, 0]]);    // A-B
  net.addRoad([[100, 0], [100, 100]]); // B-C
  net.addRoad([[100, 100], [0, 100]]); // C-D
  net.addRoad([[0, 100], [0, 0]]);     // D-A
  return net;
}

function nodeAt(net, x, y) {
  return [...net.nodes.values()].find(n => Math.abs(n.x - x) < 1 && Math.abs(n.y - y) < 1);
}

test('findPath routes around the square', () => {
  const net = squareNet();
  const a = nodeAt(net, 0, 0), c = nodeAt(net, 100, 100);
  const path = findPath(net, a.id, c.id);
  assert.ok(path, 'path found');
  assert.equal(path.nodes.length, 3, 'A -> corner -> C (two ways, both length 2)');
  assert.ok(path.time > 0);
});

test('findPath prefers faster roads', () => {
  const net = squareNet();
  // upgrade bottom edge D->C to highway: A->D->C should now beat A->B->C? 
  // Both are 200 units; but highway portion is faster.
  const edges = [...net.edges.values()];
  // find edge touching (0,100) and (100,100)
  const hw = edges.find(e => {
    const a = net.nodes.get(e.a), b = net.nodes.get(e.b);
    return (Math.abs(a.x) < 1 && Math.abs(a.y - 100) < 1 && Math.abs(b.x - 100) < 1 && Math.abs(b.y - 100) < 1) ||
           (Math.abs(b.x) < 1 && Math.abs(b.y - 100) < 1 && Math.abs(a.x - 100) < 1 && Math.abs(a.y - 100) < 1);
  });
  hw.cls = 'highway';
  const a = nodeAt(net, 0, 0), c = nodeAt(net, 100, 100);
  const path = findPath(net, a.id, c.id);
  // A -> D (street 100) -> C (highway 100): time = 100/14 + 100/30 = 10.476
  const viaHighway = 100 / 14 + 100 / 30;
  assert.ok(Math.abs(path.time - viaHighway) < 0.01, `uses highway route (${path.time} vs ${viaHighway})`);
});

test('findPath avoids congestion penalty when alternative exists', () => {
  const net = squareNet();
  // congest the top route A-B-C
  for (const e of net.edges.values()) {
    const a = net.nodes.get(e.a), b = net.nodes.get(e.b);
    const isTop = (a.y < 1 && b.y < 1);
    if (isTop) e._congestion = 1.0;
  }
  const a = nodeAt(net, 0, 0), c = nodeAt(net, 100, 100);
  const path = findPath(net, a.id, c.id);
  const nodes = path.nodes.map(id => net.nodes.get(id));
  const goesDown = nodes.some(n => n.y > 50);
  assert.ok(goesDown, 'routes via bottom when top is congested');
});

test('pathToSteps produces drivable steps with direction', () => {
  const net = squareNet();
  const a = nodeAt(net, 0, 0), b = nodeAt(net, 100, 0), c = nodeAt(net, 100, 100);
  const steps = pathToSteps(net, [a.id, b.id, c.id]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].dir, 1, 'a->b follows edge direction');
  assert.equal(steps[0].edgeId, steps[1].edgeId ? steps[0].edgeId : steps[0].edgeId);
  assert.equal(steps[1].dir, 1);
  assert.equal(steps[1].to, c.id);
});

test('findPath returns null when disconnected', () => {
  const net = squareNet();
  net.addRoad([[5000, 5000], [5100, 5000]]);
  const a = nodeAt(net, 0, 0);
  const isolated = nodeAt(net, 5000, 5000);
  assert.equal(findPath(net, a.id, isolated.id), null);
});

// ---------- one-way (roundabout ring) traversal ----------

test('findPath respects oneway ring edges (circulates, never reverses)', async () => {
  const { RoadNetwork } = await import('../src/roadNetwork.js');
  const { findPath, pathToSteps } = await import('../src/pathfinding.js');
  const net = new RoadNetwork();
  net.addRoad([[-400, 0], [400, 0]]);
  net.addRoad([[0, -400], [0, 400]]);
  const center = [...net.nodes.values()].find(n => n.edges.size === 4);
  net.makeRoundabout(center.id);
  const ringEdges = [...net.edges.values()].filter(e => e.ring);
  assert.ok(ringEdges.length >= 3);
  // adjacent ring nodes: path A->B is direct; B->A must go around (not use the reverse edge)
  const e0 = ringEdges[0];
  const A = e0.a, B = e0.b;
  const p1 = findPath(net, A, B);
  assert.ok(p1, 'path A->B exists');
  const steps1 = pathToSteps(net, p1.nodes);
  assert.ok(steps1, 'steps resolved A->B');
  // every step in steps1 must traverse ring edges only in dir=1 (a->b)
  for (const st of steps1) {
    const e = net.edges.get(st.edgeId);
    if (e.ring) assert.equal(st.dir, 1, 'ring edge traversed only forward');
  }
  // reverse pair must still be reachable (the long way around)
  const p2 = findPath(net, B, A);
  assert.ok(p2, 'path B->A exists (around the ring)');
});
