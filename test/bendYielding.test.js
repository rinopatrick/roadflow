// Junction yielding vs. bends (S01.5b).
//
// Defect being fixed (EVIDENCE E14 / GAP-loop-gridlock): `_mustYield` applied
// intersection logic at every node with more than one edge, including DEGREE-2
// nodes. A degree-2 node is a bend, not an intersection - there is no cross
// traffic to yield to.
//
// The specific failure: two opposing cars on a two-way road meeting at a bend
// each waited for the other, forever. Car 7 on one edge and car 10 on the other
// both stopped 1.5 wu short of the same node, because
//
//   * the occupied-intersection-zone check treats any car within 10 wu of the
//     node as crossing, and `_crosses(a, b)` is just `a !== b`, so at a corner
//     the two edges always count as crossing, and
//   * the yield-to-the-right scan treats the other arm as coming from the right.
//
// In the four-building soak fixture that produced 3 of 7 vehicles stopped with a
// 131 s maximum wait and city congestion climbing to 43%. Exempting degree-2
// nodes from the cross-traffic logic took it to 0 stopped, 0.1 s maximum wait,
// 1.4% congestion and 11 completed trips instead of 8.
//
// What is deliberately NOT removed: the anti-gridlock check ("do not enter a
// continuation that is jammed at its start") still applies at degree-2 nodes,
// because it prevents rear-ending a stopped car across an edge boundary, where
// per-lane car-following cannot see it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim } from '../src/traffic.js';
import { assertGraphConsistent } from './helpers/invariants.js';

/** A 90-degree bend: (0,0) -> (200,0) -> (200,200). The middle node is degree 2. */
function bend() {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [200, 0]], 'street');
  net.addRoad([[200, 0], [200, 200]], 'street');
  const corner = [...net.nodes.values()].find(n => n.edges.size === 2);
  const west = [...net.nodes.values()].find(n => Math.abs(n.x) < 1 && Math.abs(n.y) < 1);
  const north = [...net.nodes.values()].find(n => Math.abs(n.y - 200) < 1 && Math.abs(n.x - 200) < 1);
  return { net, corner, west, north };
}

// ------------------------------------------------------- bend exemption ---

test('a degree-2 node is recognised as a bend, not an intersection', () => {
  const { net, corner } = bend();
  assertGraphConsistent(net, 'bend');
  assert.ok(corner, 'the bend node exists');
  assert.equal(corner.edges.size, 2,
    `a bend has exactly two edges, got ${corner.edges.size}`);
});

test('two opposing cars pass through a bend instead of blocking each other', () => {
  const { net, corner, west, north } = bend();
  const sim = new TrafficSim(net, { seed: 5 });

  // Opposite directions through the same bend: the classic mutual-yield trap.
  const eastbound = sim.spawn(west.id, north.id);
  const westbound = sim.spawn(north.id, west.id);
  assert.ok(eastbound, 'eastbound car spawned');
  assert.ok(westbound, 'westbound car spawned');

  let ticks = 0;
  const maxTicks = 60 * 120;
  while (ticks < maxTicks && !(eastbound.arrived && westbound.arrived)) {
    sim.update(1 / 60);
    ticks++;
  }

  assert.ok(eastbound.arrived,
    `eastbound car must clear the bend (ran ${ticks} ticks, s=${eastbound.s.toFixed(1)}, speed=${eastbound.speed.toFixed(2)})`);
  assert.ok(westbound.arrived,
    `westbound car must clear the bend (ran ${ticks} ticks, s=${westbound.s.toFixed(1)}, speed=${westbound.speed.toFixed(2)})`);
});

test('a bend does not make a car yield when nothing is in its way', () => {
  const { net, corner, west, north } = bend();
  const sim = new TrafficSim(net, { seed: 1 });
  const car = sim.spawn(west.id, north.id);
  assert.ok(car);

  // Walk the car up to the bend and ask the yielding logic directly.
  let asked = false;
  for (let t = 0; t < 60 * 30; t++) {
    sim.update(1 / 60);
    const st = car.currentStep();
    if (!st || st.to !== corner.id) continue;
    const edge = net.edges.get(st.edgeId);
    const stopDist = sim._mustYield(car, edge, corner, false, car.route.steps[car.step + 1] || null);
    assert.equal(stopDist, null,
      `a lone car must not be held at a bend (got stop distance ${stopDist})`);
    asked = true;
    break;
  }
  assert.ok(asked, 'the car reached the bend within the time budget');
});

// -------------------------------------- safety that must NOT be removed ---

test('the anti-gridlock check still applies at a degree-2 node', () => {
  // A car must not enter a continuation whose start is jammed: once across the
  // node it is a different (edgeId, dir, lane) group, so per-lane car following
  // cannot see the stopped car ahead and a rear-end overlap would be possible.
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [400, 0]], 'street');
  net.addRoad([[400, 0], [1200, 0]], 'street'); // straight continuation: degree 2
  const nA = [...net.nodes.values()].find(n => Math.abs(n.x) < 1);
  const nJ = [...net.nodes.values()].find(n => Math.abs(n.x - 400) < 1);
  const nB = [...net.nodes.values()].find(n => Math.abs(n.x - 1200) < 1);
  assert.equal(nJ.edges.size, 2, 'the middle node is a degree-2 bend');

  const sim = new TrafficSim(net, { seed: 2 });
  const blocker = sim.spawn(nJ.id, nB.id);
  const car = sim.spawn(nA.id, nB.id);
  assert.ok(blocker && car, 'both cars spawned');

  let stoppedBefore = false;
  for (let t = 0; t < 60 * 40 && !stoppedBefore; t++) {
    sim.update(1 / 60);
    // Pin the blocker at the start of the next edge as a permanent jam.
    blocker.speed = 0; blocker.s = 8; blocker.waiting = 1; blocker._updatePos();
    const st = car.currentStep();
    if (!st) break;
    if (st.to === nJ.id) {
      const e = net.edges.get(st.edgeId);
      if (e.total - car.s < 30 && car.speed < 0.5) stoppedBefore = true;
    }
  }
  assert.ok(stoppedBefore,
    'a car must still hold before a jammed continuation at a degree-2 node');
});

// ------------------------------------------- real junctions still yield ---

test('a real junction still applies yield logic', () => {
  // Guards against over-broadening the exemption: degree 3 and above must keep
  // the cross-traffic rules.
  const net = new RoadNetwork();
  net.addRoad([[-300, 0], [300, 0]], 'street');
  net.addRoad([[0, -300], [0, 300]], 'street');
  const junction = [...net.nodes.values()].find(n => n.edges.size === 4);
  assert.ok(junction, 'fixture built a 4-way junction');
  assert.ok(junction.edges.size > 2, 'a real junction is degree 4');

  const arms = [...junction.edges].map((eid) => {
    const e = net.edges.get(eid);
    const outerId = e.a === junction.id ? e.b : e.a;
    return { edge: e, outer: net.nodes.get(outerId) };
  });
  const westArm = arms.find(a => a.outer.x < -100);
  const southArm = arms.find(a => a.outer.y > 100);
  assert.ok(westArm && southArm, 'found a horizontal and a vertical approach');

  const sim = new TrafficSim(net, { seed: 3 });

  // A car stopped just inside the junction on the CROSSING axis.
  const crossing = sim.spawn(southArm.outer.id, junction.id);
  assert.ok(crossing, 'crossing car spawned');
  const cStep = crossing.currentStep();
  const cEdge = net.edges.get(cStep.edgeId);
  crossing.s = cEdge.total - 5; // 5 wu short of the junction
  crossing.speed = 0;
  crossing._updatePos();

  // A car approaching on the other axis must be held.
  const approaching = sim.spawn(westArm.outer.id, junction.id);
  assert.ok(approaching, 'approaching car spawned');
  const aStep = approaching.currentStep();
  const aEdge = net.edges.get(aStep.edgeId);
  approaching.s = aEdge.total - 20; // close enough to have to decide
  approaching._updatePos();

  const stopDist = sim._mustYield(
    approaching, aEdge, junction, false, approaching.route.steps[approaching.step + 1] || null);
  assert.notEqual(stopDist, null,
    'a car must still yield to traffic occupying a real junction');
  assert.ok(stopDist > 0, `stop distance must be positive, got ${stopDist}`);
});
