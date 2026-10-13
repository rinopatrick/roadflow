// Building identity and appearance determinism (S01.1 follow-up).
//
// S01.1 made node and edge IDs deterministic by giving RoadNetwork a world ID
// source, but `Economy.place` still called `uid()` directly, so building IDs
// stayed random. Anything keyed by building ID was therefore not reproducible:
// save/load identity, pending-return targets (S01.2), reachability caches,
// selection state, and fixture assertions.
//
// `rot` was also drawn from Math.random in main.js, which made rendered output
// differ between runs of the same seed and would make golden-image visual
// regression tests flaky.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource, makeRng } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';

const mockTerrain = { isBuildable: () => true };

/** Builds the same small world twice, each with a fresh deterministic ID source. */
function buildTwice() {
  const build = () => {
    const ids = createIdSource();
    const net = new RoadNetwork({ ids });
    net.addRoad([[-600, 0], [600, 0]], 'street');
    const eco = new Economy(net, mockTerrain, 12345);
    eco.onToast = () => {};
    const house = eco.place('house', -350, 60);
    const shop = eco.place('shop', 0, 80);
    return { ids, net, eco, house, shop };
  };
  return [build(), build()];
}

test('building IDs are deterministic when the world has an ID source', () => {
  const [a, b] = buildTwice();

  assert.deepEqual([...a.eco.buildings.keys()].sort(), [...b.eco.buildings.keys()].sort(),
    'identical builds must produce identical building IDs');
  assert.equal(a.house.id, b.house.id, 'house ID must match across runs');
  assert.equal(a.shop.id, b.shop.id, 'shop ID must match across runs');
});

test('building IDs are recognisably sequential, not random', () => {
  const [a] = buildTwice();
  const ids = [...a.eco.buildings.keys()];
  assert.ok(ids.every(id => /^b\d+$/.test(id)),
    `building IDs should be sequential, got ${ids.join(', ')}`);
});

test('building IDs do not collide with node or edge IDs', () => {
  const [a] = buildTwice();
  const graphIds = new Set([...a.net.nodes.keys(), ...a.net.edges.keys()]);
  for (const id of a.eco.buildings.keys()) {
    assert.ok(!graphIds.has(id), `building ID ${id} collides with a graph ID`);
  }
});

test('building rot is deterministic and stays in its documented range', () => {
  const [a, b] = buildTwice();

  assert.equal(typeof a.house.rot, 'number', 'place() must assign a rotation');
  assert.equal(a.house.rot, b.house.rot, 'rotation must be reproducible for the same seed');

  for (const building of [a.house, a.shop]) {
    assert.ok(building.rot >= -0.25 && building.rot <= 0.25,
      `rot must stay within +/-0.25 rad, got ${building.rot}`);
  }
  // Two buildings in the same world should not be forced to the same angle;
  // a fixed constant would defeat the purpose of the variation.
  assert.notEqual(a.house.rot, a.shop.rot,
    'rotation should vary between buildings rather than being constant');
});

test('rot survives a save/load round trip unchanged', () => {
  const [a] = buildTwice();
  const data = a.eco.toJSON();
  const reloaded = Economy.fromJSON(a.net, mockTerrain, data);

  for (const [id, building] of a.eco.buildings) {
    const restored = reloaded.buildings.get(id);
    assert.ok(restored, `building ${id} missing after reload`);
    assert.equal(restored.rot, building.rot, `rot changed for ${id} across save/load`);
  }
});

test('loading a save reserves building IDs so new placements cannot collide', () => {
  const [a] = buildTwice();
  const data = a.eco.toJSON();

  const reloaded = Economy.fromJSON(a.net, mockTerrain, data);
  const loaded = new Set(reloaded.buildings.keys());

  reloaded.batch.house = 5;
  const added = reloaded.place('house', 300, 60);
  assert.ok(added, 'placement after reload succeeds');
  assert.ok(!loaded.has(added.id),
    `new building ID ${added.id} collided with a loaded one`);
});

test('without an ID source, building creation still works (legacy path)', () => {
  const net = new RoadNetwork(); // bare: no ID source attached
  net.addRoad([[-600, 0], [600, 0]], 'street');
  const eco = new Economy(net, mockTerrain, 1);
  eco.onToast = () => {};

  const house = eco.place('house', -350, 60);
  assert.ok(house, 'legacy placement still succeeds');
  assert.ok(house.id, 'a building ID is still assigned');
  assert.ok(Number.isFinite(house.rot), 'rotation is still assigned on the legacy path');
});

test('cosmetic rotation does not perturb the simulation RNG stream', () => {
  // rot must come from a separate stream. If it were drawn from this.rng, every
  // later tripTimer draw would shift and demand pacing would silently change.
  // This asserts the exact tripTimer values a seed produced before the rot
  // feature existed, so any future re-coupling is caught immediately.
  const drawTimers = () => {
    const ids = createIdSource();
    const net = new RoadNetwork({ ids });
    net.addRoad([[-600, 0], [600, 0]], 'street');
    const eco = new Economy(net, mockTerrain, 12345);
    eco.onToast = () => {};
    const timers = [];
    for (const [type, x] of [['house', -350], ['shop', 0], ['factory', 350]]) {
      const b = eco.place(type, x, 60);
      if (b) timers.push(b.tripTimer);
    }
    return timers;
  };

  const first = drawTimers();
  assert.equal(first.length, 3, 'three buildings placed');
  assert.deepEqual(drawTimers(), first, 'tripTimer sequence must be reproducible');

  // Golden values captured with seed 12345 from the simulation stream alone.
  // These come from makeRng(12345) draws 1..3, proving rot consumed none of them.
  const rng = makeRng(12345);
  const expected = [0, 1, 2].map(() => 8 + rng() * 30);
  assert.deepEqual(first, expected,
    'tripTimer values must match the simulation stream exactly, unaffected by rot');
});
