// Live-edit reconciliation (S01.6).
//
// Defect being fixed (EVIDENCE E16): removing a road deleted every vehicle whose
// route referenced it. `_updatePos` marked the car dead when its edge vanished,
// and `update` then dropped it from the map. There was no counter, no reason, and
// no attempt to reroute, so a destroyed trip was indistinguishable from a
// completed one.
//
// Rules established here:
//  - cars on unaffected edges keep driving
//  - cars whose edge was removed are REROUTED when a legal path still exists
//  - otherwise the trip is cancelled exactly once, with a recorded reason
//  - a cancelled trip never counts as completed and never awards XP
//  - a car is never teleported onto an unrelated road merely to keep a count
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { reconcileTrafficAfterEdit } from '../src/access.js';
import { assertGraphConsistent } from './helpers/invariants.js';

const mockTerrain = { isBuildable: () => true };

/**
 * A rectangle loop (0,0)-(400,0)-(400,200)-(0,200)-(0,0) plus a direct chord
 * along y=0 from (0,0) to (400,0). The chord is the shortest route, so a car
 * takes it; removing it leaves the loop as a legal alternative.
 */
function loopWithChord() {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  net.addRoad([[0, 0], [400, 0]], 'street');                       // chord
  net.addRoad([[0, 0], [0, 200], [400, 200], [400, 0]], 'street'); // loop
  assertGraphConsistent(net, 'loopWithChord');

  const at = (x, y) => [...net.nodes.values()].find(n => Math.abs(n.x - x) < 1 && Math.abs(n.y - y) < 1);
  const west = at(0, 0);
  const east = at(400, 0);
  assert.ok(west && east, 'fixture nodes exist');

  return { ids, net, west, east };
}

/** A single straight road: removing it leaves NO alternative. */
function loneRoad() {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  net.addRoad([[0, 0], [400, 0]], 'street');
  const west = [...net.nodes.values()].find(n => Math.abs(n.x) < 1);
  const east = [...net.nodes.values()].find(n => Math.abs(n.x - 400) < 1);
  return { ids, net, west, east };
}

/** Advances the simulation until `predicate` holds or the budget runs out. */
function runUntil(sim, predicate, maxTicks = 60 * 60) {
  for (let t = 0; t < maxTicks; t++) {
    if (predicate()) return true;
    sim.update(1 / 60);
  }
  return predicate();
}

// -------------------------------------------------- reroute when possible ---

test('a car whose road was removed is rerouted when a legal path remains', () => {
  const { net, west, east } = loopWithChord();
  const sim = new TrafficSim(net, { seed: 4 });

  const car = sim.spawn(west.id, east.id);
  assert.ok(car, 'car spawned');
  const chord = net.edges.get(car.currentStep().edgeId);
  assert.ok(chord, 'the car took the direct chord');

  // Drive a little way along the chord, then destroy it.
  for (let t = 0; t < 60; t++) sim.update(1 / 60);
  const before = sim.stats.cancelled;

  net.removeEdge(chord.id);
  const report = reconcileTrafficAfterEdit(sim, { removedEdgeIds: [chord.id] });

  assert.equal(report.cancelled.length, 0, 'a reroutable car must not be cancelled');
  assert.equal(report.rerouted, 1, `expected one reroute, got ${report.rerouted}`);
  assert.equal(sim.stats.cancelled, before, 'no cancellation counted');
  assert.ok(sim.cars.has(car.id), 'the car is still in the simulation');

  // Its new route must be legal and must not reference the destroyed edge.
  for (const st of car.route.steps) {
    assert.ok(net.edges.has(st.edgeId), `rerouted step ${st.edgeId} must exist`);
    assert.notEqual(st.edgeId, chord.id, 'the reroute must not use the removed edge');
  }
});

test('a rerouted car completes its journey normally', () => {
  const { net, west, east } = loopWithChord();
  const sim = new TrafficSim(net, { seed: 4 });
  const car = sim.spawn(west.id, east.id);
  assert.ok(car);
  for (let t = 0; t < 60; t++) sim.update(1 / 60);

  const chord = net.edges.get(car.currentStep().edgeId);
  net.removeEdge(chord.id);
  reconcileTrafficAfterEdit(sim, { removedEdgeIds: [chord.id] });

  const arrived = runUntil(sim, () => !!car.arrived, 60 * 180);
  assert.ok(arrived, 'the rerouted car reaches its destination');
  assert.equal(sim.stats.trips, 1, 'and it counts as one completed trip');
  assert.equal(sim.stats.cancelled, 0, 'with no cancellations');
});

// ------------------------------------------------ cancel when impossible ---

test('a car with no remaining route is cancelled once, with a reason', () => {
  const { net, west, east } = loneRoad();
  const sim = new TrafficSim(net, { seed: 4 });
  const car = sim.spawn(west.id, east.id);
  assert.ok(car);
  for (let t = 0; t < 30; t++) sim.update(1 / 60);

  const only = net.edges.get(car.currentStep().edgeId);
  net.removeEdge(only.id);

  const report = reconcileTrafficAfterEdit(sim, { removedEdgeIds: [only.id] });

  assert.equal(report.rerouted, 0, 'nothing to reroute onto');
  assert.equal(report.cancelled.length, 1, `expected one cancellation, got ${report.cancelled.length}`);
  assert.equal(report.cancelled[0].carId, car.id);
  assert.equal(report.cancelled[0].reason, 'routeRemoved', 'the reason is recorded');
  assert.equal(sim.stats.cancelled, 1, 'counted once in the stats');
  assert.equal(sim.stats.trips, 0, 'a cancelled trip is NOT a completed trip');
  assert.ok(!sim.cars.has(car.id), 'the car is gone from the simulation');
});

test('a cancellation does not award XP', () => {
  const { net, west, east } = loneRoad();
  const eco = new Economy(net, mockTerrain, 1);
  eco.onToast = () => {};
  const sim = new TrafficSim(net, { seed: 4 });
  const car = sim.spawn(west.id, east.id);
  assert.ok(car);

  const xpBefore = eco.xp;
  const tripsBefore = eco.totalTrips;

  net.removeEdge(car.currentStep().edgeId);
  reconcileTrafficAfterEdit(sim, { removedEdgeIds: [net.edges.keys().next().value].filter(Boolean) });

  assert.equal(eco.xp, xpBefore, 'XP must not change when a trip is cancelled');
  assert.equal(eco.totalTrips, tripsBefore, 'no completed trip counted');
});

test('reconciling twice does not cancel the same trip again', () => {
  const { net, west, east } = loneRoad();
  const sim = new TrafficSim(net, { seed: 4 });
  const car = sim.spawn(west.id, east.id);
  assert.ok(car);
  const only = net.edges.get(car.currentStep().edgeId);
  net.removeEdge(only.id);

  const first = reconcileTrafficAfterEdit(sim, { removedEdgeIds: [only.id] });
  const second = reconcileTrafficAfterEdit(sim, { removedEdgeIds: [only.id] });

  assert.equal(first.cancelled.length, 1);
  assert.equal(second.cancelled.length, 0, 'already-cancelled cars must not be recounted');
  assert.equal(sim.stats.cancelled, 1, 'the counter stays at one');
});

// ------------------------------------------- unaffected cars keep driving ---

test('cars on unaffected edges keep driving', () => {
  const { net, west, east } = loopWithChord();
  const sim = new TrafficSim(net, { seed: 4 });

  // One car on the chord, one on the loop's far side.
  const onChord = sim.spawn(west.id, east.id);
  const loopNode = [...net.nodes.values()].find(n => Math.abs(n.y - 200) < 1 && Math.abs(n.x) < 1);
  const far = sim.spawn(loopNode.id, east.id);
  assert.ok(onChord && far, 'both cars spawned');

  const chordId = onChord.currentStep().edgeId;
  const farEdgeId = far.currentStep().edgeId;
  assert.notEqual(chordId, farEdgeId, 'the two cars are on different edges');

  for (let t = 0; t < 30; t++) sim.update(1 / 60);
  const farS = far.s;

  net.removeEdge(chordId);
  const report = reconcileTrafficAfterEdit(sim, { removedEdgeIds: [chordId] });

  assert.ok(report.kept >= 1, `the unaffected car must be kept, report: ${JSON.stringify(report)}`);
  assert.ok(sim.cars.has(far.id), 'the unaffected car is still simulated');
  assert.equal(far.currentStep().edgeId, farEdgeId, 'and still on its original edge');

  // Progress requires stepping the simulation: reconcile only repairs routes.
  for (let t = 0; t < 60; t++) sim.update(1 / 60);
  assert.ok(far.s > farS, `the unaffected car must keep moving (${farS.toFixed(1)} -> ${far.s.toFixed(1)})`);
});

test('an edit that removes nothing changes nothing', () => {
  const { net, west, east } = loopWithChord();
  const sim = new TrafficSim(net, { seed: 4 });
  const car = sim.spawn(west.id, east.id);
  assert.ok(car);
  const before = { edge: car.currentStep().edgeId, s: car.s, cancelled: sim.stats.cancelled };

  const report = reconcileTrafficAfterEdit(sim, { removedEdgeIds: [] });

  assert.deepEqual(report.cancelled, [], 'nothing cancelled');
  assert.equal(report.rerouted, 0, 'nothing rerouted');
  assert.equal(car.currentStep().edgeId, before.edge, 'route untouched');
  assert.equal(car.s, before.s, 'position untouched');
  assert.equal(sim.stats.cancelled, before.cancelled);
});

// ------------------------------------------- demolished destination building ---

test('a car whose destination building was demolished is cancelled', () => {
  const { net, west, east } = loopWithChord();
  const eco = new Economy(net, mockTerrain, 1);
  eco.onToast = () => {};
  eco.batch = { house: 5, shop: 5, factory: 5 };

  const shop = eco.place('shop', 200, -60); // north of the chord
  assert.ok(shop, 'shop placed');
  const sim = new TrafficSim(net, { seed: 4 });

  const car = sim.spawn(west.id, shop.drivewayNode);
  assert.ok(car, 'car heading to the shop');
  car.destId = shop.id;
  car.homeId = null;

  eco.remove(shop.id);
  const report = reconcileTrafficAfterEdit(sim, { removedBuildingIds: [shop.id] });

  assert.equal(report.cancelled.length, 1, `expected one cancellation, got ${report.cancelled.length}`);
  assert.equal(report.cancelled[0].reason, 'endpointRemoved',
    'the reason names the demolished endpoint');
  assert.equal(sim.stats.cancelled, 1);
  assert.equal(sim.stats.trips, 0, 'not counted as completed');
});

test('a car whose origin building was demolished is cancelled', () => {
  const { net, west, east } = loopWithChord();
  const eco = new Economy(net, mockTerrain, 1);
  eco.onToast = () => {};
  eco.batch = { house: 5, shop: 5, factory: 5 };
  const home = eco.place('house', 200, -60);
  assert.ok(home);

  const sim = new TrafficSim(net, { seed: 4 });
  const car = sim.spawn(home.drivewayNode, east.id);
  assert.ok(car);
  car.homeId = home.id;

  eco.remove(home.id);
  const report = reconcileTrafficAfterEdit(sim, { removedBuildingIds: [home.id] });

  assert.equal(report.cancelled.length, 1);
  assert.equal(report.cancelled[0].reason, 'endpointRemoved');
});

// -------------------------------------------------- honesty of the counters ---

test('cancelled and completed trips are tracked separately', () => {
  const { net, west, east } = loneRoad();
  const sim = new TrafficSim(net, { seed: 4 });

  // One car completes the trip.
  const finisher = sim.spawn(west.id, east.id);
  assert.ok(finisher);
  runUntil(sim, () => !!finisher.arrived);
  assert.equal(sim.stats.trips, 1, 'one completed');
  assert.equal(sim.stats.cancelled, 0, 'none cancelled yet');

  // A second car loses its road mid-trip.
  const victim = sim.spawn(west.id, east.id);
  assert.ok(victim, 'second car spawned');
  const edge = net.edges.get(victim.currentStep().edgeId);
  if (edge) {
    net.removeEdge(edge.id);
    reconcileTrafficAfterEdit(sim, { removedEdgeIds: [edge.id] });
  }

  assert.equal(sim.stats.trips, 1, 'the completed count is unchanged');
  assert.ok(sim.stats.cancelled >= 1, 'the cancellation is counted separately');
});

test('every cancellation carries a non-empty reason', () => {
  const { net, west, east } = loneRoad();
  const sim = new TrafficSim(net, { seed: 4 });
  const car = sim.spawn(west.id, east.id);
  assert.ok(car);
  const only = net.edges.get(car.currentStep().edgeId);
  net.removeEdge(only.id);

  const report = reconcileTrafficAfterEdit(sim, { removedEdgeIds: [only.id] });
  for (const entry of report.cancelled) {
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0,
      'a cancellation without a reason is not actionable');
  }
  assert.equal(car.cancelReason, 'routeRemoved', 'the car itself records why');
  assert.equal(car.cancelled, true, 'and is flagged as cancelled, not completed');
});

test('a car is never teleported onto an unrelated road', () => {
  const { net, west, east } = loopWithChord();
  const sim = new TrafficSim(net, { seed: 4 });
  const car = sim.spawn(west.id, east.id);
  assert.ok(car);
  for (let t = 0; t < 60; t++) sim.update(1 / 60);

  const chord = net.edges.get(car.currentStep().edgeId);
  const positionBefore = { x: car.x, y: car.y };
  net.removeEdge(chord.id);
  reconcileTrafficAfterEdit(sim, { removedEdgeIds: [chord.id] });

  if (sim.cars.has(car.id)) {
    // A reroute restarts at the node the car was standing on, so it must still
    // be near where it was, not somewhere across the map.
    const moved = Math.hypot(car.x - positionBefore.x, car.y - positionBefore.y);
    assert.ok(moved < 60,
      `a reroute must not teleport the car (moved ${moved.toFixed(1)} wu)`);
  }
});
