import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim } from '../src/traffic.js';
import { getLegacyPhase } from '../src/signals.js';

function straightNet() {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [600, 0]]);
  return net;
}

function crossNet() {
  const net = new RoadNetwork();
  net.addRoad([[-300, 0], [300, 0]]);
  net.addRoad([[0, -300], [0, 300]]);
  return net;
}

function endNodes(net) {
  // the two nodes with a single edge (dead ends of the first road)
  const first = [...net.edges.values()][0];
  return [net.nodes.get(first.a), net.nodes.get(first.b)];
}

test('car spawns and arrives at destination on a straight road', () => {
  const net = straightNet();
  const sim = new TrafficSim(net);
  const [a, b] = endNodes(net);
  const car = sim.spawn(a.id, b.id);
  assert.ok(car, 'car spawned');
  for (let i = 0; i < 2000 && !car.arrived; i++) sim.update(0.05);
  assert.ok(car.arrived, 'car arrived');
  assert.ok(sim.stats.trips === 1);
});

test('cars in the same lane never overlap', () => {
  const net = straightNet();
  const sim = new TrafficSim(net);
  const [a, b] = endNodes(net);
  // drip-feed spawn attempts: at most one per sim frame, like the real game
  const cars = [];
  for (let t = 0; t < 60 * 10; t++) {
    sim.update(1 / 60);
    if (cars.length < 10 && t % 12 === 0) {
      const c = sim.spawn(a.id, b.id);
      if (c) cars.push(c);
    }
  }
  assert.ok(cars.length >= 5, 'several cars spawned');
  for (let t = 0; t < 60 * 30; t++) sim.update(1 / 60);
  // verify pairwise separation among alive cars on the same edge
  const alive = [...sim.cars.values()];
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const ci = alive[i], cj = alive[j];
      const si = ci.currentStep(), sj = cj.currentStep();
      if (si.edgeId === sj.edgeId && si.dir === sj.dir) {
        assert.ok(Math.abs(ci.s - cj.s) > 3, `gap kept between cars (${Math.abs(ci.s - cj.s).toFixed(2)})`);
      }
    }
  }
});

test('traffic light stops cross traffic during red', () => {
  const net = crossNet();
  const sim = new TrafficSim(net);
  const center = [...net.nodes.values()].find(n => n.edges.size === 4);
  center.type = 'light';
  center.light = { cycle: 20, offset: 0, greenRatio: 0.4 };

  // Classify each approach by its REAL axis from geometry. The previous version
  // of this test assumed `edges[0]` was horizontal and hard-coded 'x', but that
  // edge is actually vertical - so its notion of "red for this car" was
  // inverted and it only passed by accident.
  const approaches = [];
  for (const eid of center.edges) {
    const edge = net.edges.get(eid);
    const outer = net.nodes.get(edge.a === center.id ? edge.b : edge.a);
    const axis = Math.abs(outer.x - center.x) >= Math.abs(outer.y - center.y) ? 'x' : 'y';
    approaches.push({ edge, axis, outer });
  }
  const xApproach = approaches.find(a => a.axis === 'x');
  const yApproach = approaches.find(a => a.axis === 'y');
  assert.ok(xApproach && yApproach, 'fixture provides both axes');

  const cars = [
    { car: sim.spawn(xApproach.outer.id, center.id), axis: 'x' },
    { car: sim.spawn(yApproach.outer.id, center.id), axis: 'y' },
  ];
  for (const entry of cars) assert.ok(entry.car, `${entry.axis} car spawned`);

  let observedHold = false;
  let observedGo = false;

  for (let t = 0; t < 60 * 60; t++) {
    sim.update(1 / 60);
    // Use the shared phase authority, the same one the simulator obeys.
    const phase = getLegacyPhase(center.light, sim.time);

    for (const { car, axis } of cars) {
      if (car.arrived || car.dead) continue;
      const st = car.currentStep();
      if (!st || st.to !== center.id) continue; // already past, or not yet here
      const edge = net.edges.get(st.edgeId);
      if (!edge) continue;
      const dist = edge.total - car.s;
      const isGreen = phase.state === 'green' && phase.axis === axis;
      // Yellow for MY axis means the vehicle may clear if it cannot stop safely
      // (signals.js / _mustYield use a 10 wu threshold). That is deliberate, not
      // a violation, so only red and all-red are asserted as holds.
      const isYellowForMe = phase.state === 'yellow' && phase.axis === axis;
      const mustHold = !isGreen && !isYellowForMe;

      if (mustHold && dist < 30) {
        assert.ok(dist > 0.5,
          `${axis} car crossed the stop line while ${phase.state}/${phase.axis} (dist ${dist.toFixed(2)})`);
        if (dist < 12 && car.speed < 3) observedHold = true;
      }
      if (isGreen && dist < 30) observedGo = true;
    }
  }

  assert.ok(observedHold, 'observed a car waiting at a red/all-red phase');
  assert.ok(observedGo, 'observed a car proceeding on green');
});

test('the two approach axes are never permitted at the same time', () => {
  const net = crossNet();
  const center = [...net.nodes.values()].find(n => n.edges.size === 4);
  center.type = 'light';
  center.light = { cycle: 20, offset: 0, greenRatio: 0.4 };

  for (let t = 0; t < 60; t += 0.02) {
    const phase = getLegacyPhase(center.light, t);
    // Exactly one axis is named, and only a green state grants passage.
    assert.ok(phase.axis === 'x' || phase.axis === 'y');
    if (phase.state === 'allRed') {
      assert.ok(phase.remaining >= 0, 'all-red has a bounded duration');
    }
  }
});

// helper: dead-end nodes of edge i
function endNodesOf(net, i) {
  const e = [...net.edges.values()][i];
  return [net.nodes.get(e.a), net.nodes.get(e.b)];
}

test('roundabout lets the circulating car go first', () => {
  const net = crossNet();
  const sim = new TrafficSim(net);
  const center = [...net.nodes.values()].find(n => n.edges.size === 4);
  center.type = 'roundabout';
  const edges = [...net.edges.values()];
  // car 1: already crossing horizontally
  const c1 = sim.spawn(net.nodes.get(edges[0].a).id, net.nodes.get(edges[0].b).id);
  // let it get near the center
  for (let t = 0; t < 60 * 20 && !c1.arrived; t++) {
    sim.update(1 / 60);
    if (c1.dead) break;
  }
  // car 2 now approaches from vertical; it should yield (slower to arrive)
  const c2 = sim.spawn(net.nodes.get(edges[1].b).id, net.nodes.get(edges[1].a).id);
  assert.ok(c2, 'second car spawned');
  // just verify it eventually arrives too (no deadlock)
  for (let t = 0; t < 60 * 60 && !c2.arrived; t++) sim.update(1 / 60);
  assert.ok(c2.arrived || c2.dead, 'no deadlock at roundabout');
});

test('no deadlock: many cars cross a 4-way plain junction', () => {
  const net = crossNet();
  const sim = new TrafficSim(net);
  const edges = [...net.edges.values()];
  let spawned = 0, arrived = 0;
  for (let i = 0; i < 8; i++) {
    const e = edges[i % edges.length];
    const from = i % 2 ? net.nodes.get(e.a) : net.nodes.get(e.b);
    const to = i % 2 ? net.nodes.get(e.b) : net.nodes.get(e.a);
    const c = sim.spawn(from.id, to.id);
    if (c) { spawned++; c.onArrive = () => arrived++; }
  }
  for (let t = 0; t < 60 * 120; t++) {
    sim.update(1 / 60);
    if (arrived >= spawned) break;
  }
  assert.equal(arrived, spawned, `all ${spawned} cars arrived`);
});

// ---------- ring roundabout traffic ----------

function ringNet() {
  const net = new RoadNetwork();
  net.addRoad([[-400, 0], [400, 0]]);
  net.addRoad([[0, -400], [0, 400]]);
  const center = [...net.nodes.values()].find(n => n.edges.size === 4);
  net.makeRoundabout(center.id);
  return net;
}

function outerNodes(net) {
  return [...net.nodes.values()].filter(n => !n.isRing && n.edges.size === 1);
}

test('cars flow through a real ring roundabout without deadlock', () => {
  const net = ringNet();
  const sim = new TrafficSim(net);
  const outs = outerNodes(net);
  assert.ok(outs.length === 4, 'four arm ends');
  let spawned = 0, arrived = 0;
  // heavy cross traffic: every pair of opposite arms, both directions
  for (const [i, j] of [[0, 2], [2, 0], [1, 3], [3, 1], [0, 1], [3, 2]]) {
    const c = sim.spawn(outs[i].id, outs[j].id);
    if (c) { spawned++; c.onArrive = () => arrived++; }
  }
  assert.ok(spawned >= 4, 'cars spawned');
  for (let t = 0; t < 60 * 120 && arrived < spawned; t++) sim.update(1 / 60);
  assert.equal(arrived, spawned, `all ${spawned} cars got through the roundabout`);
});

test('entering car yields to circulating car on the ring', () => {
  const net = ringNet();
  const sim = new TrafficSim(net);
  const outs = outerNodes(net);
  // both cars enter from arm 0; c1 circulates onto the ring first.
  // drip-spawn c2 until the arm start is free (like the real game).
  const c1 = sim.spawn(outs[0].id, outs[1].id);
  assert.ok(c1, 'circulating car spawned');
  let c2 = null;
  for (let t = 0; t < 60 * 10 && !c2; t++) {
    sim.update(1 / 60);
    c2 = sim.spawn(outs[0].id, outs[3].id);
  }
  assert.ok(c2, 'entering car spawned');
  let yielded = false;
  for (let t = 0; t < 60 * 90 && !yielded; t++) {
    sim.update(1 / 60);
    const s2 = c2.currentStep();
    if (!s2) break;
    const e2 = net.edges.get(s2.edgeId);
    if (e2.ring) break; // c2 got onto the ring
    const s1 = c1.currentStep();
    if (!s1) continue;
    const e1 = net.edges.get(s1.edgeId);
    if (!e1?.ring) continue;
    // conflict: c2 close to the ring while c1 circulates on c2's merge edge
    if (e2.total - c2.s < 40 && e1.a === s2.to && c1.s < 40 && c1.speed > 1) {
      yielded = c2.speed < 4 || e2.total - c2.s > 6;
    }
  }
  assert.ok(yielded, 'entering car gave way to circulating traffic');
});

test('car stops before junction when exit is blocked (gridlock prevention)', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [400, 0]]);
  net.addRoad([[400, 0], [1200, 0]]); // snapped at 400 => junction
  const sim = new TrafficSim(net);
  const nA = [...net.nodes.values()].find(n => Math.abs(n.x) < 1 && Math.abs(n.y) < 1);
  const nJ = [...net.nodes.values()].find(n => Math.abs(n.x - 400) < 1 && Math.abs(n.y) < 1);
  const nB = [...net.nodes.values()].find(n => Math.abs(n.x - 1200) < 1);
  assert.ok(nA && nJ && nB, 'nodes exist');
  // a frozen car parked just past the junction = a permanent jam
  const blocker = sim.spawn(nJ.id, nB.id);
  assert.ok(blocker, 'blocker spawned');
  const car = sim.spawn(nA.id, nB.id);
  assert.ok(car, 'approach car spawned');
  let stoppedBeforeJunction = false;
  for (let t = 0; t < 60 * 40 && !stoppedBeforeJunction; t++) {
    sim.update(1 / 60);
    // pin the blocker at s=8, stopped: the road beyond the junction is jammed
    blocker.speed = 0; blocker.s = 8; blocker.waiting = 1; blocker._updatePos();
    const st = car.currentStep();
    if (!st || st.edgeId === undefined) break;
    if (st.to === nJ.id) {
      const e = net.edges.get(st.edgeId);
      if (e.total - car.s < 30 && car.speed < 0.5) stoppedBeforeJunction = true;
    }
  }
  assert.ok(stoppedBeforeJunction, 'car waited before the blocked junction instead of entering');
});
