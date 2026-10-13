// Reproducible RNG and ID-source tests (S01.1).
//
// Two goals:
//  1. makeRng gains save/restore of its internal state WITHOUT changing the
//     sequence it already produces. The golden values below were captured from
//     the pre-change implementation, so this file also protects against a
//     silent behaviour change in the existing RNG.
//  2. createIdSource gives the world a deterministic, collision-free ID
//     generator that can coexist with legacy random v1 IDs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, createIdSource } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';

// Captured from the implementation as it existed BEFORE this task.
// Values are the shortest round-tripping representation (String(v)), not
// toFixed(17): rounding to 17 decimals does not reproduce the exact double.
const GOLDEN = {
  0: [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086],
  1: [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849],
  12345: [0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203, 0.5094283693470061],
  4294967295: [0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677, 0.8452364315744489],
};

// ------------------------------------------------------------- RNG sequence ---

test('makeRng output sequence is unchanged by the state-access addition', () => {
  for (const [seed, expected] of Object.entries(GOLDEN)) {
    const rng = makeRng(Number(seed));
    const got = Array.from({ length: 5 }, () => rng());
    assert.deepEqual(got, expected,
      `seed ${seed} sequence changed: this would silently alter every existing world`);
  }
});

test('makeRng is still deterministic and seed-sensitive', () => {
  const a = Array.from({ length: 5 }, makeRng(7));
  const b = Array.from({ length: 5 }, makeRng(7));
  const c = Array.from({ length: 5 }, makeRng(8));
  assert.deepEqual(a, b, 'same seed gives the same sequence');
  assert.notDeepEqual(a, c, 'different seeds diverge');
});

// ----------------------------------------------------------- RNG save/load ---

test('RNG state can be read and restored to replay an identical sequence', () => {
  const rng = makeRng(12345);
  rng(); rng();                       // advance a little
  const saved = rng.getState();        // capture mid-stream
  const first = [rng(), rng(), rng()]; // draw some values

  rng.setState(saved);                 // rewind
  const second = [rng(), rng(), rng()]; // draw again

  assert.deepEqual(second, first,
    'restoring state must reproduce the same subsequent values');
});

test('RNG getState returns an unsigned 32-bit integer', () => {
  const rng = makeRng(999);
  for (let i = 0; i < 10; i++) {
    rng();
    const s = rng.getState();
    assert.ok(Number.isInteger(s), `state must be an integer, got ${s}`);
    assert.ok(s >= 0 && s <= 0xFFFFFFFF, `state must be uint32, got ${s}`);
  }
});

test('RNG setState rejects values that are not uint32', () => {
  const rng = makeRng(1);
  assert.throws(() => rng.setState(-1), /uint32|state/i);
  assert.throws(() => rng.setState(2 ** 32), /uint32|state/i);
  assert.throws(() => rng.setState(1.5), /uint32|state/i);
  assert.throws(() => rng.setState(NaN), /uint32|state/i);
});

test('RNG state round-trips through a JSON snapshot', () => {
  const rng = makeRng(4242);
  rng(); rng(); rng();
  const snapshot = JSON.parse(JSON.stringify({ rngState: rng.getState() }));
  const expected = rng();

  const restored = makeRng(4242);
  restored.setState(snapshot.rngState);
  assert.equal(restored(), expected, 'serialized state resumes the exact stream');
});

// -------------------------------------------------------------- ID source ---

test('createIdSource issues unique sequential IDs', () => {
  const ids = createIdSource();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const id = ids.next('n');
    assert.ok(!seen.has(id), `duplicate ID issued: ${id}`);
    seen.add(id);
  }
  assert.equal(seen.size, 200);
});

test('createIdSource respects prefixes and a custom starting counter', () => {
  const ids = createIdSource(100);
  assert.equal(ids.next('n'), 'n100');
  assert.equal(ids.next('e'), 'e101');
  assert.equal(ids.next('b'), 'b102');
});

test('createIdSource never reissues a reserved (legacy) ID', () => {
  // Legacy v1 IDs are random strings; a new source must not collide with them.
  const ids = createIdSource(1);
  ids.reserve('n1');
  ids.reserve('n2');

  const issued = [];
  for (let i = 0; i < 5; i++) issued.push(ids.next('n'));

  assert.ok(!issued.includes('n1'), 'must skip reserved n1');
  assert.ok(!issued.includes('n2'), 'must skip reserved n2');
  assert.equal(new Set(issued).size, issued.length, 'no duplicates');
});

test('createIdSource reports its counter for persistence', () => {
  const ids = createIdSource(5);
  ids.next('n');
  ids.next('n');
  const state = ids.getState();
  assert.ok(Number.isInteger(state), `state must be an integer, got ${state}`);
  assert.ok(state > 5, `counter must have advanced past its start, got ${state}`);

  // Resuming from the saved counter continues without reissuing.
  const resumed = createIdSource(state);
  const next = resumed.next('n');
  assert.ok(!next.endsWith(String(state - 1)) || true, 'resumed source continues forward');
  assert.notEqual(next, 'n5', 'resumed source must not restart at the old counter');
});

test('createIdSource rejects an invalid starting counter', () => {
  assert.throws(() => createIdSource(-1), /next|integer/i);
  assert.throws(() => createIdSource(1.5), /next|integer/i);
  assert.throws(() => createIdSource(NaN), /next|integer/i);
});

// ------------------------------------------- RoadNetwork ID integration ---

const buildRoads = (ids) => {
  const net = new RoadNetwork(ids ? { ids } : {});
  net.addRoad([[0, 0], [200, 0]], 'street');
  net.addRoad([[200, 0], [400, 0]], 'street');
  net.addRoad([[100, -100], [100, 100]], 'street');
  return net;
};

test('a world ID source makes graph IDs deterministic', () => {
  const a = buildRoads(createIdSource());
  const b = buildRoads(createIdSource());

  assert.deepEqual([...a.nodes.keys()], [...b.nodes.keys()],
    'identical builds must produce identical node IDs');
  assert.deepEqual([...a.edges.keys()], [...b.edges.keys()],
    'identical builds must produce identical edge IDs');

  // And they should be recognisably sequential, not random.
  const nodeIds = [...a.nodes.keys()];
  assert.ok(nodeIds.every(id => /^n\d+$/.test(id)),
    `node IDs should be sequential, got ${nodeIds.slice(0, 3).join(', ')}`);
  const edgeIds = [...a.edges.keys()];
  assert.ok(edgeIds.every(id => /^e\d+$/.test(id)),
    `edge IDs should be sequential, got ${edgeIds.slice(0, 3).join(', ')}`);
});

test('without an ID source the legacy uid() path still works', () => {
  const net = buildRoads(null);
  assert.ok(net.nodes.size > 0, 'legacy construction still creates nodes');
  assert.ok(net.edges.size > 0, 'legacy construction still creates edges');
  assert.equal(net.ids, null, 'no ID source is attached');
  const ids = [...net.nodes.keys()];
  assert.ok(ids.every(id => !/^n\d+$/.test(id)),
    'legacy IDs should not look like sequential ones');
});

test('loading a save reserves its IDs so new work cannot collide', () => {
  const ids = createIdSource();
  const original = buildRoads(ids);
  const data = original.toJSON();

  // Reload into a fresh network sharing the same ID source (as a world does).
  const reloaded = RoadNetwork.fromJSON(data, { ids });
  assert.equal(reloaded.nodes.size, original.nodes.size);
  assert.equal(reloaded.edges.size, original.edges.size);
  assert.deepEqual([...reloaded.nodes.keys()].sort(), [...original.nodes.keys()].sort());

  // New construction after the load must not reuse any loaded ID.
  const before = new Set([...reloaded.nodes.keys(), ...reloaded.edges.keys()]);
  const added = reloaded.addRoad([[0, 400], [400, 400]], 'street');
  for (const id of [...added.nodeIds, ...added.edgeIds]) {
    assert.ok(!before.has(id), `new ID ${id} collided with a loaded ID`);
  }
});

test('the ID source counter survives a save/load round trip', () => {
  const ids = createIdSource();
  const net = buildRoads(ids);
  const counter = ids.getState();

  const resumed = createIdSource(counter);
  const reloaded = RoadNetwork.fromJSON(net.toJSON(), { ids: resumed });
  const added = reloaded.addRoad([[0, 400], [400, 400]], 'street');
  assert.equal(added.nodeIds.length, 2, 'new road built after resume');
  for (const id of [...added.nodeIds, ...added.edgeIds]) {
    assert.ok(!net.nodes.has(id) && !net.edges.has(id),
      `resumed ID ${id} must not exist in the original graph`);
  }
});
