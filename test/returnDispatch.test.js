// Return-trip dispatch and lifecycle accounting (S01.2).
//
// Defect being fixed (EVIDENCE E01): `_completeTrip` scheduled a return with
// BUILDING ids (`from: destId, to: homeId`), but `TrafficSim.spawn` expects
// NODE ids. Returns therefore failed silently — the pending entry was removed
// whether or not a car was ever created.
//
// Rules established here:
//  - building ids are resolved to CURRENT access nodes at DISPATCH time, not
//    when the return is scheduled, because a building may be deleted, moved or
//    re-attached to a different road during the dwell period
//  - a deleted endpoint cancels the return exactly once, with a reason
//  - a blocked spawn retains the request and retries later
//  - the return leg grants no second service reward
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIdSource } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';

const mockTerrain = { isBuildable: () => true };

/** Straight road with a home and a shop attached; no factory (no pollution). */
function serviceWorld() {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  net.addRoad([[-600, 0], [600, 0]], 'street');
  const eco = new Economy(net, mockTerrain, 7);
  eco.onToast = () => {};
  eco.batch.house = 5;
  eco.batch.shop = 5;
  const home = eco.place('house', -350, 60);
  const shop = eco.place('shop', 0, 80);
  assert.ok(home && shop, 'fixture places both buildings');
  return { ids, net, eco, home, shop };
}

/** Records every spawnCar call and returns a fake car, or null if told to. */
function recorder({ block = false } = {}) {
  const calls = [];
  return {
    calls,
    spawnCar: (from, to) => {
      calls.push([from, to]);
      return block ? null : { id: `car-${calls.length}` };
    },
  };
}

// --------------------------------------------------- R1: node ids, not ---

test('pending return dispatch resolves access-node IDs, not building IDs', () => {
  const { net, eco, home, shop } = serviceWorld();
  eco._completeTrip({ id: 'outbound' }, shop.id, home.id);

  const { calls, spawnCar } = recorder();
  eco.processReturns(100, spawnCar);

  assert.equal(calls.length, 1, 'exactly one return was dispatched');
  assert.deepEqual(calls[0], [shop.drivewayNode, home.drivewayNode],
    'dispatch must pass driveway node IDs, not building IDs');
  for (const id of calls[0]) {
    assert.ok(net.nodes.has(id), `dispatched ID ${id} must exist in the graph`);
  }
  assert.ok(!calls[0].includes(shop.id), 'must not pass the shop building ID');
  assert.ok(!calls[0].includes(home.id), 'must not pass the home building ID');
});

test('the scheduled return stores building ids, so re-attachment is respected', () => {
  const { net, eco, home, shop } = serviceWorld();
  eco._completeTrip({ id: 'outbound' }, shop.id, home.id);

  // Re-attach the shop to a different point on the road during the dwell.
  const oldNode = shop.drivewayNode;
  net.detachDriveway(oldNode);
  const moved = net.attachDriveway(shop.id, 200, 80);
  assert.ok(moved, 'shop re-attached');
  shop.drivewayNode = moved.id;
  assert.notEqual(shop.drivewayNode, oldNode, 'access node actually changed');

  const { calls, spawnCar } = recorder();
  eco.processReturns(100, spawnCar);

  assert.deepEqual(calls[0], [shop.drivewayNode, home.drivewayNode],
    'dispatch must use the CURRENT access node after re-attachment');
});

// ------------------------------------------------------ lifecycle rules ---

test('a blocked spawn retains the request and retries later', () => {
  const { eco, home, shop } = serviceWorld();
  eco._completeTrip({ id: 'outbound' }, shop.id, home.id);

  const blocked = recorder({ block: true });
  eco.processReturns(100, blocked.spawnCar);
  assert.equal(blocked.calls.length, 1, 'first attempt happened');
  assert.equal(eco.pendingReturnCount, 1, 'request must be retained when spawn is blocked');
  assert.equal(eco.cancelledReturns, 0, 'a blocked spawn is not a cancellation');

  // Not enough time has passed for a retry yet.
  const tooSoon = recorder();
  eco.processReturns(1, tooSoon.spawnCar);
  assert.equal(tooSoon.calls.length, 0, 'must not retry before the retry interval');

  // After the retry interval it tries again, and succeeds.
  const retry = recorder();
  eco.processReturns(eco.RETURN_RETRY_SECONDS, retry.spawnCar);
  assert.equal(retry.calls.length, 1, 'retried after the interval');
  assert.equal(eco.pendingReturnCount, 0, 'request cleared after a successful spawn');
});

test('deleting the return ORIGIN (the shop) cancels with reason deletedOrigin', () => {
  // The return trip departs from the shop and ends at the home, so the shop is
  // the return's origin.
  const { eco, home, shop } = serviceWorld();
  eco._completeTrip({ id: 'outbound' }, shop.id, home.id);

  eco.remove(shop.id);
  assert.ok(!eco.buildings.has(shop.id), 'shop removed');

  const { calls, spawnCar } = recorder();
  eco.processReturns(100, spawnCar);

  assert.equal(calls.length, 0, 'no car may be spawned toward a deleted building');
  assert.equal(eco.cancelledReturns, 1, 'cancellation counted once');
  assert.equal(eco.cancellationReasons.deletedOrigin, 1, 'reason recorded');
  assert.equal(eco.pendingReturnCount, 0, 'cancelled request is not retained');

  // A further tick must not cancel the same request again.
  eco.processReturns(100, spawnCar);
  assert.equal(eco.cancelledReturns, 1, 'cancellation must not be counted twice');
});

test('deleting the return DESTINATION (the home) cancels with reason deletedDestination', () => {
  // The return trip ends at the home, so the home is its destination.
  const { eco, home, shop } = serviceWorld();
  eco._completeTrip({ id: 'outbound' }, shop.id, home.id);

  eco.remove(home.id);

  const { calls, spawnCar } = recorder();
  eco.processReturns(100, spawnCar);

  assert.equal(calls.length, 0, 'no car spawned');
  assert.equal(eco.cancelledReturns, 1, 'counted once');
  assert.equal(eco.cancellationReasons.deletedDestination, 1, 'reason recorded');
  assert.equal(eco.pendingReturnCount, 0, 'not retained');
});

test('a return whose access node vanished is cancelled as noAccessNode', () => {
  const { net, eco, home, shop } = serviceWorld();
  eco._completeTrip({ id: 'outbound' }, shop.id, home.id);

  // Building still exists, but its access node was removed from the graph
  // (e.g. the road under it was bulldozed).
  const node = shop.drivewayNode;
  net.detachDriveway(node);
  net.nodes.delete(node);

  const { calls, spawnCar } = recorder();
  eco.processReturns(100, spawnCar);

  assert.equal(calls.length, 0, 'no car spawned from a missing access node');
  assert.equal(eco.cancellationReasons.noAccessNode, 1, 'reason recorded');
});

test('return dispatch grants no second service reward', () => {
  const { eco, home, shop } = serviceWorld();
  const xpBefore = eco.xp;

  eco._completeTrip({ id: 'outbound' }, shop.id, home.id);
  const xpAfterOutbound = eco.xp;
  assert.ok(xpAfterOutbound > xpBefore, 'the outward service grants XP');
  assert.equal(eco.totalTrips, 1, 'one trip counted');

  const { spawnCar } = recorder();
  eco.processReturns(100, spawnCar);

  assert.equal(eco.xp, xpAfterOutbound, 'dispatching a return must not grant XP');
  assert.equal(eco.totalTrips, 1, 'dispatching a return must not count another trip');
});

test('the no-op setTimeout was removed from _completeTrip', () => {
  // The old code contained `setTimeout(() => {}, 0)` with a comment saying
  // returns were handled elsewhere. It did nothing and confused the reader.
  const source = readFileSync(new URL('../src/economy.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('setTimeout'),
    '_completeTrip must not contain a no-op setTimeout');
});

// ------------------------------------------------------- full lifecycle ---

test('outbound arrival, dwell and return spawn complete end to end', () => {
  const { net, eco, home, shop } = serviceWorld();
  const sim = new TrafficSim(net, { seed: 3 });

  // Dispatch a real outward car and let it arrive, driving the real loop.
  const outbound = sim.spawn(home.drivewayNode, shop.drivewayNode);
  assert.ok(outbound, 'outbound car spawned');
  outbound.onArrive = (c) => eco._completeTrip(c, shop.id, home.id);
  outbound.homeId = home.id;
  outbound.destId = shop.id;

  let ticks = 0;
  while (!outbound.arrived && ticks < 60 * 200) {
    sim.update(1 / 60);
    ticks++;
  }
  assert.ok(outbound.arrived, `outbound car should arrive (ran ${ticks} ticks)`);
  assert.equal(eco.totalTrips, 1, 'outbound service counted');
  assert.equal(eco.pendingReturnCount, 1, 'a return is now pending');

  // Drive the real return path.
  let returnCar = null;
  const spawnReturn = (from, to) => {
    returnCar = sim.spawn(from, to);
    return returnCar;
  };
  for (let t = 0; t < 60 * 400 && !returnCar; t++) {
    eco.processReturns(1 / 60, spawnReturn);
    sim.update(1 / 60);
  }
  assert.ok(returnCar, 'return car was spawned through the real loop');
  assert.equal(eco.pendingReturnCount, 0, 'pending queue drained');

  const xpAfterReturnSpawn = eco.xp;
  let rTicks = 0;
  while (!returnCar.arrived && rTicks < 60 * 200) {
    sim.update(1 / 60);
    rTicks++;
  }
  assert.ok(returnCar.arrived, 'return car arrives home');
  assert.equal(eco.xp, xpAfterReturnSpawn, 'return arrival grants no extra XP');
  assert.equal(eco.totalTrips, 1, 'still exactly one served trip');
});

test('processReturns is safe with no pending work', () => {
  const { eco } = serviceWorld();
  const { calls, spawnCar } = recorder();
  assert.doesNotThrow(() => eco.processReturns(1, spawnCar));
  assert.equal(calls.length, 0);
  assert.equal(eco.pendingReturnCount, 0);
});

test('CHARACTERIZATION: pending returns are not yet persisted across save/load', () => {
  // Current, documented limitation - NOT desired behaviour.
  //
  // Economy.toJSON() does not serialize _pendingReturns, cancelledReturns or
  // cancellationReasons, and Economy.fromJSON() builds a fresh instance (which
  // initializes an empty queue). Saving during the dwell therefore drops the
  // queued return trip. No crash, no corruption - the trip is simply lost.
  //
  // The full snapshot (which includes pending returns, clocks and RNG state)
  // is owned by S01.7. This test pins today's behaviour so that S01.7 shows up
  // as a deliberate diff, and so the gap cannot be mistaken for a regression.
  // Tracked as GAP-pending-returns-not-saved in docs/roadmap/status.json.
  const { net, eco, home, shop } = serviceWorld();
  eco._completeTrip({ id: 'outbound' }, shop.id, home.id);
  assert.equal(eco.pendingReturnCount, 1, 'a return is queued before saving');

  const data = eco.toJSON();
  assert.equal(data.pendingReturns, undefined,
    'toJSON currently omits pending returns; S01.7 must add this field');

  const reloaded = Economy.fromJSON(net, mockTerrain, data);
  assert.equal(reloaded.pendingReturnCount, 0,
    'after S01.7 this must be 1 - the queued return should survive a save');
});

test('cancellation counters are also absent from the current serializer', () => {
  // Same ownership as above (S01.7). Documented so the counters are not
  // assumed to survive a reload.
  const { eco, home, shop } = serviceWorld();
  eco._completeTrip({ id: 'outbound' }, shop.id, home.id);
  eco.remove(shop.id);
  const { spawnCar } = recorder();
  eco.processReturns(100, spawnCar);
  assert.equal(eco.cancelledReturns, 1, 'cancellation happened');

  const data = eco.toJSON();
  assert.equal(data.cancelledReturns, undefined,
    'cancellation counters are not serialized yet (S01.7)');
});
