// Vehicle advance and determinism tests (S01.1).
//
// Two defects are covered here:
//
//  1. Residual distance was discarded at edge boundaries. The old code did
//     `car.s = 0` after incrementing the step, so any overshoot vanished. Over
//     a long trip that silently shortens every journey and desynchronises the
//     vehicle from the travel time the router promised.
//
//  2. `Car.maxSpeed = 12 + Math.random() * 4` was assigned and never used, and
//     spawn used Math.random for colour and lane. Terrain was seeded but the
//     simulation was not reproducible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim } from '../src/traffic.js';
import { makeRng } from '../src/core.js';

/**
 * Two chained edges, each `len` wu long.
 *
 * `len` must exceed NODE_SNAP (18 wu). A shorter segment snaps its far endpoint
 * back onto the existing node and `addRoad` creates nothing at all — see
 * trackedGap GAP-min-segment-length in status.json.
 */
function twoShortEdges(len = 40) {
  const net = new RoadNetwork();
  const first = net.addRoad([[0, 0], [len, 0]], 'street');
  assert.equal(first.edgeIds.length, 1, `first segment of ${len} wu must build`);
  const mid = net.edges.get(first.edgeIds[0]).b;
  const second = net.addRoad([[len, 0], [len * 2, 0]], 'street');
  assert.equal(second.edgeIds.length, 1, `second segment of ${len} wu must build`);
  return {
    net,
    n0: net.edges.get(first.edgeIds[0]).a,
    n1: mid,
    n2: net.edges.get(second.edgeIds[0]).b,
    e0: net.edges.get(first.edgeIds[0]),
    e1: net.edges.get(second.edgeIds[0]),
  };
}

/** A chain of `count` edges, each `len` wu long (len must exceed NODE_SNAP). */
function chain(count, len = 40) {
  const net = new RoadNetwork();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const r = net.addRoad([[i * len, 0], [(i + 1) * len, 0]], 'street');
    assert.equal(r.edgeIds.length, 1, `chain segment ${i} of ${len} wu must build`);
    ids.push(r.edgeIds[0]);
  }
  const first = net.edges.get(ids[0]);
  const last = net.edges.get(ids[ids.length - 1]);
  return { net, start: first.a, end: last.b, edgeIds: ids, len };
}

/** Absolute distance along the route: completed edges plus current offset. */
function pathPosition(net, car) {
  let done = 0;
  for (let i = 0; i < car.step; i++) {
    const e = net.edges.get(car.route.steps[i].edgeId);
    done += e ? e.total : 0;
  }
  return done + car.s;
}

// ------------------------------------------------------- residual distance ---

test('overshoot is carried across an edge boundary, not discarded', () => {
  const { net, n0, n2, e0 } = twoShortEdges(40);
  const sim = new TrafficSim(net);
  const car = sim.spawn(n0, n2);
  assert.ok(car, 'car spawned across two edges');
  assert.equal(e0.total, 40, `first edge is 40 wu, got ${e0.total}`);

  // Start 5 wu before the boundary, then travel ~15 wu in one tick. The car
  // should end ~10 wu into the second edge. The old code reset s to 0 and lost
  // the whole 10 wu of overshoot.
  car.s = e0.total - 5;
  car.speed = 900;
  sim.update(1 / 60);

  assert.equal(car.step, 1, 'car advanced to the second edge');
  assert.ok(Math.abs(car.s - 10) < 0.05,
    `residual must be preserved: expected s ~ 10 on the second edge, got ${car.s}`);
  assert.ok(car.s > 0, 'overshoot must not be discarded as s = 0');
});

test('path progress is continuous across many short-edge transitions', () => {
  const { net, start, end } = chain(12, 40);
  const sim = new TrafficSim(net);
  const car = sim.spawn(start, end);
  assert.ok(car, 'car spawned across a 12-edge chain');

  let previous = pathPosition(net, car);
  let transitions = 0;

  for (let t = 0; t < 60 * 40; t++) {
    const speedBefore = car.speed;
    const stepBefore = car.step;   // captured BEFORE the update
    sim.update(1 / 60);

    const now = pathPosition(net, car);
    const moved = now - previous;

    if (!sim.cars.has(car.id)) break; // arrived
    if (car.step !== stepBefore) transitions++;

    // Distance moved must never be negative, and must not exceed what the
    // car's speed could produce this tick (plus the acceleration allowance).
    assert.ok(moved >= -1e-9,
      `progress must not go backwards: moved ${moved} at tick ${t}`);
    assert.ok(moved <= speedBefore / 60 + 0.2,
      `progress cannot exceed speed*dt: moved ${moved}, speed ${speedBefore}`);

    previous = now;
  }

  assert.ok(transitions >= 5,
    `car should cross several edges to exercise the boundary, crossed ${transitions}`);
});

test('a single tick can cross multiple short edges without hanging', () => {
  const { net, start, end } = chain(6, 40);
  const sim = new TrafficSim(net);
  const car = sim.spawn(start, end);
  assert.ok(car);

  // 6 edges * 40 wu = 240 wu. At 14400 wu/s one tick covers the whole route.
  car.speed = 14400;
  sim.update(1 / 60);

  // Either it arrived, or it is somewhere legal further along. The point is
  // that the transition loop is bounded by route length and returns.
  if (sim.cars.has(car.id)) {
    assert.ok(car.step >= 1 && car.step < car.route.steps.length,
      `step ${car.step} out of range for ${car.route.steps.length} steps`);
    assert.ok(car.s >= 0, `s must stay non-negative, got ${car.s}`);
  }
});

test('a car that overshoots the final edge arrives instead of looping', () => {
  const { net, start, end } = chain(2, 40);
  const sim = new TrafficSim(net);
  const car = sim.spawn(start, end);
  assert.ok(car);

  car.speed = 6000; // far more than the 80 wu route
  sim.update(1 / 60);

  assert.ok(!sim.cars.has(car.id), 'car completed its route and was cleaned up');
  assert.equal(sim.stats.trips, 1, 'arrival counted exactly once');
});

// ----------------------------------------------------------- determinism ---

test('vehicle speed is deterministic, with no unused random field', () => {
  const { net, n0, n2 } = twoShortEdges(40);
  const sim = new TrafficSim(net);
  const car = sim.spawn(n0, n2);
  assert.ok(car);

  assert.equal(car.speedFactor, 1,
    `speedFactor must default to 1, got ${car.speedFactor}`);
  assert.equal(car.maxSpeed, undefined,
    'the unused random maxSpeed field must be gone');
});

test('an injected RNG makes spawning reproducible and actually consulted', () => {
  const build = (seed) => {
    const { net, n0, n2 } = twoShortEdges(40);
    const sim = new TrafficSim(net, { rng: makeRng(seed) });
    const car = sim.spawn(n0, n2);
    return { color: car.color, lane: car.currentStep().lane };
  };

  const a = build(99);
  const b = build(99);
  assert.deepEqual(a, b, 'same seed must produce the same car appearance and lane');
  assert.ok(a.color, 'a colour is assigned');
  assert.ok(Number.isInteger(a.lane), 'a lane is assigned');

  // Across many seeds the appearance must vary. If it did not, the injected
  // generator would not be driving spawn at all.
  const colors = new Set();
  for (let seed = 0; seed < 40; seed++) colors.add(build(seed).color);
  assert.ok(colors.size > 1,
    `injected RNG must influence spawning; got ${colors.size} distinct colour(s)`);
});

test('two simulations with the same seed produce identical trajectories', () => {
  const run = () => {
    const { net, start, end } = chain(8, 40);
    const sim = new TrafficSim(net, { rng: makeRng(7) });
    const car = sim.spawn(start, end);
    const trace = [];
    for (let t = 0; t < 300 && sim.cars.has(car.id); t++) {
      sim.update(1 / 60);
      trace.push([car.step, Number(car.s.toFixed(6)), Number(car.speed.toFixed(6))]);
    }
    return trace;
  };

  const first = run();
  const second = run();
  assert.ok(first.length > 10, `trace should be substantive, got ${first.length} samples`);
  assert.deepEqual(second, first, 'identical seeds must produce identical trajectories');
});
