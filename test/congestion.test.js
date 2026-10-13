// Congestion metric tests (S01.4).
//
// Defect being fixed (EVIDENCE E03): the EMA in `TrafficSim.update` was
// `old * 0.98 + frac * 0.02 * (dt * 60) * 0.05`. Two problems:
//
//  1. The `0.02 * 0.05` factor meant the input was scaled to 0.001 per step, so
//     with EVERY vehicle stopped the value settled at 0.05, not 1. The HUD then
//     multiplied by 100 and divided by 0.6, so a fully jammed road displayed as
//     about 8%.
//  2. `(dt * 60)` made the smoothing depend on timestep, so the same traffic at
//     30 Hz and 60 Hz produced different readings.
//
// The fix uses `alpha = 1 - exp(-dt / tau)`, which is exactly timestep
// independent: after simulated time T the value is `1 - exp(-T / tau)` no matter
// how T was subdivided.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim, CONGESTION_TAU } from '../src/traffic.js';
import { cityCongestion, simulationStats, clamp01 } from '../src/metrics.js';

/** Builds a 600 wu street and returns the single edge. */
function street() {
  const net = new RoadNetwork();
  const built = net.addRoad([[0, 0], [600, 0]], 'street');
  return { net, edge: net.edges.get(built.edgeIds[0]) };
}

/**
 * Holds one car completely stopped for `seconds` of simulated time, stepping in
 * `dt` increments, and returns the resulting congestion value.
 */
function stoppedCongestion(dt, seconds = 60) {
  const { net, edge } = street();
  const sim = new TrafficSim(net, { seed: 1 });
  const car = sim.spawn(edge.a, edge.b);
  assert.ok(car, 'fixture must spawn a car');
  sim._desiredSpeed = () => 0; // hold it still regardless of junction logic

  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) sim.update(dt);

  assert.equal(sim.cars.size, 1, 'the stopped car must remain in the simulation');
  return edge._congestion;
}

// ------------------------------------------------------- magnitude is real ---

test('a fully stopped edge converges to 1, not to a small fraction', () => {
  const value = stoppedCongestion(1 / 60);
  assert.ok(value > 0.99, `all-stopped traffic should read ~1, got ${value}`);
  assert.ok(value <= 1 + 1e-9, `congestion must not exceed 1, got ${value}`);
});

test('the old scaling bug would have settled near 0.05', () => {
  // Guards the specific E03 symptom so the regression cannot return silently.
  const value = stoppedCongestion(1 / 60, 30);
  assert.ok(value > 0.9,
    `after 30s of full standstill the value must be high; 0.05 was the old bug (got ${value})`);
});

// ----------------------------------------------------- timestep independence ---

test('the result does not depend on the timestep', () => {
  const at60 = stoppedCongestion(1 / 60);
  const at30 = stoppedCongestion(1 / 30);
  const at120 = stoppedCongestion(1 / 120);
  assert.ok(Math.abs(at60 - at30) < 1e-6,
    `60 Hz ${at60} and 30 Hz ${at30} must agree`);
  assert.ok(Math.abs(at60 - at120) < 1e-6,
    `60 Hz ${at60} and 120 Hz ${at120} must agree`);
});

test('the value matches the closed-form EMA after a known duration', () => {
  const seconds = 10;
  const value = stoppedCongestion(1 / 60, seconds);
  const expected = 1 - Math.exp(-seconds / CONGESTION_TAU);
  assert.ok(Math.abs(value - expected) < 1e-4,
    `after ${seconds}s expected ${expected.toFixed(6)}, got ${value.toFixed(6)}`);
});

// ------------------------------------------------------------------ decay ---

test('an empty edge decays back toward zero', () => {
  const { net, edge } = street();
  const sim = new TrafficSim(net, { seed: 1 });
  const car = sim.spawn(edge.a, edge.b);
  assert.ok(car);
  sim._desiredSpeed = () => 0;
  for (let i = 0; i < 60 * 30; i++) sim.update(1 / 60);

  const jammed = edge._congestion;
  assert.ok(jammed > 0.9, `should be jammed first, got ${jammed}`);

  // Remove the traffic and keep stepping.
  sim.cars.clear();
  for (let i = 0; i < 60 * 30; i++) sim.update(1 / 60);

  assert.ok(edge._congestion < 0.05,
    `congestion must decay once the edge is empty, got ${edge._congestion}`);
});

test('congestion is clamped into 0..1', () => {
  const { net, edge } = street();
  const sim = new TrafficSim(net, { seed: 1 });
  sim.spawn(edge.a, edge.b);
  sim._desiredSpeed = () => 0;
  for (let i = 0; i < 60 * 120; i++) sim.update(1 / 60);
  assert.ok(edge._congestion >= 0 && edge._congestion <= 1,
    `congestion out of range: ${edge._congestion}`);
});

// --------------------------------------------------------- city aggregate ---

test('city congestion is a share, not an arbitrary rescaled number', () => {
  const { net, edge } = street();
  const sim = new TrafficSim(net, { seed: 1 });
  sim.spawn(edge.a, edge.b);
  sim._desiredSpeed = () => 0;
  for (let i = 0; i < 60 * 60; i++) sim.update(1 / 60);

  const value = cityCongestion(net);
  assert.ok(value > 0.9 && value <= 1,
    `a single jammed road should read near 1, got ${value}`);
});

test('city congestion is 0 when nothing is driving', () => {
  const { net } = street();
  assert.equal(cityCongestion(net), 0, 'an empty network has no congestion');
});

test('city congestion ignores edges without vehicles', () => {
  // A jammed edge with cars plus a quiet edge must not be diluted by the quiet
  // one: the figure is weighted by present vehicles.
  const { net, edge } = street();
  const second = net.addRoad([[0, 200], [600, 200]], 'street');
  const quiet = net.edges.get(second.edgeIds[0]);

  const sim = new TrafficSim(net, { seed: 1 });
  sim.spawn(edge.a, edge.b);
  sim._desiredSpeed = () => 0;
  for (let i = 0; i < 60 * 60; i++) sim.update(1 / 60);

  assert.ok(edge._congestion > 0.9, 'the busy edge is jammed');
  assert.equal(quiet._congestion ?? 0, 0, 'the quiet edge has no congestion');
  const value = cityCongestion(net);
  assert.ok(value > 0.9, `vehicle-weighted figure should stay near 1, got ${value}`);
});

test('city congestion is 0..1 for a mixed network', () => {
  const { net, edge } = street();
  const sim = new TrafficSim(net, { seed: 1 });
  sim.spawn(edge.a, edge.b);
  for (let i = 0; i < 60 * 20; i++) sim.update(1 / 60);
  const value = cityCongestion(net);
  assert.ok(value >= 0 && value <= 1, `out of range: ${value}`);
});

test('clamp01 handles the edge cases', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(0), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(1), 1);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(NaN), 0, 'NaN must not propagate into the HUD');
  assert.equal(clamp01(undefined), 0);
});

// ---------------------------------------------------------------- stats ---

test('simulationStats reports only counts that actually exist', () => {
  const { net, edge } = street();
  const sim = new TrafficSim(net, { seed: 1 });
  sim.spawn(edge.a, edge.b);

  const eco = { pendingReturnCount: 3, cancelledReturns: 2 };
  const stats = simulationStats(sim, eco);

  assert.equal(stats.active, sim.cars.size, 'active is the live vehicle count');
  assert.equal(stats.pending, 3, 'pending is the queued return count');
  assert.equal(stats.cancelled, 2, 'cancelled is the cancelled return count');
  assert.equal(stats.completed, sim.stats.trips, 'completed is finished car trips');

  // No invented demand accounting: every field maps to a real counter.
  assert.deepEqual(Object.keys(stats).sort(), ['active', 'cancelled', 'completed', 'pending']);
});

test('simulationStats tolerates a missing economy', () => {
  const { net } = street();
  const sim = new TrafficSim(net);
  const stats = simulationStats(sim, null);
  assert.equal(stats.pending, 0);
  assert.equal(stats.cancelled, 0);
  assert.equal(stats.active, 0);
});

test('every stats field is a finite non-negative integer', () => {
  const { net, edge } = street();
  const sim = new TrafficSim(net, { seed: 1 });
  sim.spawn(edge.a, edge.b);
  for (let i = 0; i < 60 * 5; i++) sim.update(1 / 60);
  const stats = simulationStats(sim, { pendingReturnCount: 1, cancelledReturns: 0 });
  for (const [key, value] of Object.entries(stats)) {
    assert.ok(Number.isInteger(value) && value >= 0, `${key} must be a non-negative integer, got ${value}`);
  }
});
