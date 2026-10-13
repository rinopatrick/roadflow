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
import { readFileSync } from 'node:fs';
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

// ------------------------------------------- legacy save ID interaction ---

/** Loads the frozen v1 fixture the way main.js does, then plays on. */
function loadLegacyAndPlay() {
  const raw = JSON.parse(
    readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url), 'utf8'));
  const net = RoadNetwork.fromJSON(raw.net);
  const eco = Economy.fromJSON(net, mockTerrain, raw.eco);

  // main.js attaches a fresh source AFTER deserializing, then reserves.
  const ids = createIdSource();
  for (const id of net.nodes.keys()) ids.reserve(id);
  for (const id of net.edges.keys()) ids.reserve(id);
  for (const id of eco.buildings.keys()) ids.reserve(id);
  net.ids = ids;
  return { raw, net, eco, ids };
}

test('legacy v1 save keeps its original random IDs unchanged', () => {
  const { raw, net, eco } = loadLegacyAndPlay();

  // v1 IDs came from uid() (Math.random). They are preserved verbatim rather
  // than rewritten: rewriting would break every reference inside the save.
  assert.deepEqual([...eco.buildings.keys()].sort(),
    raw.eco.buildings.map(b => b.id).sort(),
    'loaded building IDs must equal the saved ones');
  assert.deepEqual([...net.nodes.keys()].sort(),
    raw.net.nodes.map(n => n.id).sort(),
    'loaded node IDs must equal the saved ones');

  // And they are NOT sequential, which is expected and correct.
  assert.ok(!raw.eco.buildings.every(b => /^b\d+$/.test(b.id)),
    'the fixture should still carry its original random IDs');
});

test('new buildings on a legacy save get sequential IDs without colliding', () => {
  const { raw, net, eco } = loadLegacyAndPlay();

  eco.batch.house = 5;
  const added = eco.place('house', 200, 60);
  assert.ok(added, 'placement on a legacy save succeeds');

  // A played-on legacy save is therefore a MIX of random and sequential IDs.
  // That is safe because IDs are opaque strings, but it means "IDs look
  // sequential" is NOT a valid assertion for migrated saves - only for a
  // freshly created world. This test pins that expectation.
  assert.ok(/^b\d+$/.test(added.id), `new ID should be sequential, got ${added.id}`);

  const legacyIds = new Set(raw.eco.buildings.map(b => b.id));
  assert.ok(!legacyIds.has(added.id), 'new ID must not reuse a legacy ID');

  const all = [...net.nodes.keys(), ...net.edges.keys(), ...eco.buildings.keys()];
  assert.equal(new Set(all).size, all.length, 'no duplicate IDs anywhere in the world');
});

test('a reloaded save whose IDs are already sequential cannot be reused', () => {
  // Adversarial case for the counter resetting to 1 on every load: the only
  // thing preventing reuse is reserve(). Build a save that already contains
  // sequential IDs, then reload it into a fresh counter.
  const ids0 = createIdSource();
  const net0 = new RoadNetwork({ ids: ids0 });
  net0.addRoad([[-600, 0], [600, 0]], 'street');
  const eco0 = new Economy(net0, mockTerrain, 1);
  eco0.onToast = () => {};
  eco0.batch.house = 5;
  for (const x of [-350, -100, 150]) eco0.place('house', x, 60);

  const save = { net: net0.toJSON(), eco: eco0.toJSON() };
  const savedIds = new Set(save.eco.buildings.map(b => b.id));
  assert.ok([...savedIds].every(id => /^b\d+$/.test(id)), 'save has sequential IDs');

  const ids = createIdSource();            // counter restarts at 1
  const net = RoadNetwork.fromJSON(save.net, { ids });
  const eco = Economy.fromJSON(net, mockTerrain, save.eco);
  for (const id of net.nodes.keys()) ids.reserve(id);
  for (const id of net.edges.keys()) ids.reserve(id);
  for (const id of eco.buildings.keys()) ids.reserve(id);

  eco.batch.house = 10;
  const added = [];
  for (const x of [300, 400, 500]) {
    const b = eco.place('house', x, 60);
    if (b) added.push(b.id);
  }

  assert.ok(added.length > 0, 'placements succeeded');
  for (const id of added) {
    assert.ok(!savedIds.has(id), `new ID ${id} reused a loaded ID`);
  }
  const all = [...net.nodes.keys(), ...net.edges.keys(), ...eco.buildings.keys()];
  assert.equal(new Set(all).size, all.length, 'no duplicates after reload and build');
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
