// Save, validation, migration and restore-fidelity tests (S01.7).
//
// Defects being fixed (EVIDENCE E13, E18):
//
//  - the v1 save stored no active vehicles, pending return trips, clocks, RNG
//    state or ID counters, so a reload silently lost trips and could reissue IDs
//  - a corrupt payload produced a half-built world or fell back to a new city
//  - a failed load destroyed the current city behind a "City loaded." toast
//
// The central guarantee is the ROUND-TRIP EQUALITY test: a world saved and
// restored must behave identically to one that was never interrupted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createIdSource, makeRng } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { Terrain } from '../src/terrain.js';
import {
  serializeWorld, validateSnapshot, hydrateWorld, SNAPSHOT_VERSION,
} from '../src/worldSnapshot.js';
import {
  saveGame, loadGame, hasSave, hasRecoverableBackup, recoverFromBackup,
  clearSaves, autosave, importGame, exportGame, SAVE_KEY, AUTOSAVE_KEY, BACKUP_KEY,
} from '../src/save.js';
import { assertGraphConsistent, assertEconomyConsistent, assertVehiclesFinite } from './helpers/invariants.js';

const mockTerrain = { seed: 1, isBuildable: () => true, isRoadable: () => true, sample: () => 0 };

/** A small live city with buildings and traffic. */
function liveCity({ seed = 1, withTraffic = true } = {}) {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  net.addRoad([[-600, 0], [600, 0]], 'street');
  const terrain = { ...mockTerrain, seed };
  const eco = new Economy(net, terrain, seed);
  eco.onToast = () => {};
  eco.batch = { house: 5, shop: 5, factory: 5 };
  const home = eco.place('house', -350, 60);
  const shop = eco.place('shop', 0, 80);
  const factory = eco.place('factory', 350, 100);

  const traffic = new TrafficSim(net, { rng: makeRng(seed) });
  if (withTraffic) {
    const car = traffic.spawn(home.drivewayNode, shop.drivewayNode);
    if (car) {
      car.purpose = 'outbound';
      car.homeId = home.id;
      car.destId = shop.id;
      for (let i = 0; i < 60; i++) traffic.update(1 / 60);
    }
  }
  return {
    terrain, net, traffic, eco, ids,
    camera: { x: 12, y: -34, zoom: 1.5 },
    settings: { speed: 3, audio: false },
    home, shop, factory,
  };
}

/** In-memory storage adapter that can be made to fail. */
function memoryStorage({ failWrites = false, failReads = false } = {}) {
  const map = new Map();
  return {
    getItem(k) {
      if (failReads) throw new Error('storage disabled');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (failWrites) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}

/** Normalized comparable view of a world. */
function normalize(world) {
  return {
    nodes: [...world.net.nodes.keys()].sort(),
    edges: [...world.net.edges.keys()].sort(),
    edgeTotals: [...world.net.edges.values()]
      .map(e => [e.id, Number(e.total.toFixed(6))]).sort(),
    buildings: [...world.eco.buildings.values()]
      .map(b => [b.id, b.type, b.x, b.y, b.drivewayNode]).sort(),
    xp: Number(world.eco.xp.toFixed(6)),
    level: world.eco.level,
    batch: { ...world.eco.batch },
    totalTrips: world.eco.totalTrips,
    pendingReturns: world.eco.pendingReturnCount,
    cancelledReturns: world.eco.cancelledReturns,
    trafficTime: Number(world.traffic.time.toFixed(6)),
    stats: { ...world.traffic.stats },
    cars: [...world.traffic.cars.values()]
      .map(c => [c.id, c.step, Number(c.s.toFixed(6)), Number(c.speed.toFixed(6)), c.purpose ?? null])
      .sort(),
  };
}

// ---------------------------------------------------- round-trip equality ---

test('a saved and restored world behaves identically to an uninterrupted one', () => {
  const original = liveCity();

  // Serialize mid-flight, then hydrate a copy.
  const snapshot = serializeWorld(original);
  const verdict = validateSnapshot(snapshot);
  assert.equal(verdict.ok, true, `snapshot must validate: ${verdict.errors?.join('; ')}`);
  const restored = hydrateWorld(verdict.data);

  // Both worlds receive the SAME future: identical ticks and demand.
  const step = (world) => {
    world.traffic.update(1 / 60);
    world.eco.update(1 / 60, world.traffic, (f, t) => world.traffic.spawn(f, t));
    world.eco.processReturns(1 / 60, (f, t) => world.traffic.spawn(f, t));
    world.eco.checkLevelUp();
  };
  for (let i = 0; i < 600; i++) { step(original); step(restored); }

  assert.deepEqual(normalize(restored), normalize(original),
    'a restored world must evolve exactly like the original');
});

test('restoring preserves the exact vehicle position and progress', () => {
  const original = liveCity();
  const car = [...original.traffic.cars.values()][0];
  assert.ok(car, 'fixture has a car mid-trip');

  const snapshot = serializeWorld(original);
  const restored = hydrateWorld(validateSnapshot(snapshot).data);
  const restoredCar = [...restored.traffic.cars.values()][0];

  assert.ok(restoredCar, 'the car survived the round trip');
  assert.equal(restoredCar.id, car.id, 'same vehicle id');
  assert.equal(restoredCar.step, car.step, 'same route step');
  assert.ok(Math.abs(restoredCar.s - car.s) < 1e-9, `same arc position (${restoredCar.s} vs ${car.s})`);
  assert.ok(Math.abs(restoredCar.x - car.x) < 1e-6, 'same x');
  assert.ok(Math.abs(restoredCar.y - car.y) < 1e-6, 'same y');
});

test('the RNG streams resume rather than restarting', () => {
  const original = liveCity();
  // Advance the economy RNG so its state is not the initial one.
  original.eco.rng(); original.eco.rng();

  const restored = hydrateWorld(validateSnapshot(serializeWorld(original)).data);

  // The next draws must match, which only holds if the state was preserved.
  assert.equal(restored.eco.rng(), original.eco.rng(), 'economy RNG stream resumes');
  assert.equal(restored.eco.cosmeticRng(), original.eco.cosmeticRng(), 'cosmetic stream resumes');
  assert.equal(restored.traffic.rng(), original.traffic.rng(), 'traffic RNG stream resumes');
});

test('the ID counter is preserved so new IDs never collide', () => {
  const original = liveCity();
  const snapshot = serializeWorld(original);
  const restored = hydrateWorld(validateSnapshot(snapshot).data);

  const existing = new Set([
    ...restored.net.nodes.keys(), ...restored.net.edges.keys(),
    ...restored.eco.buildings.keys(),
  ]);

  restored.eco.batch.house = 5;
  const added = restored.eco.place('house', 400, 60);
  assert.ok(added, 'placement after restore succeeds');
  assert.ok(!existing.has(added.id), `new building id ${added.id} collided`);

  const road = restored.net.addRoad([[0, -400], [0, -200]], 'street');
  for (const id of [...road.nodeIds, ...road.edgeIds]) {
    assert.ok(!existing.has(id), `new road id ${id} collided`);
  }
});

test('pending return trips survive a save', () => {
  const original = liveCity({ withTraffic: false });
  original.eco._completeTrip({ id: 'probe' }, original.shop.id, original.home.id);
  assert.equal(original.eco.pendingReturnCount, 1, 'a return is queued');

  const restored = hydrateWorld(validateSnapshot(serializeWorld(original)).data);
  assert.equal(restored.eco.pendingReturnCount, 1,
    'the queued return must survive (this is what GAP-pending-returns-not-saved was about)');
  assert.equal(restored.eco._pendingReturns[0].from, original.shop.id);
  assert.equal(restored.eco._pendingReturns[0].to, original.home.id);
});

test('a restored pending return still dispatches to a real access node', () => {
  const original = liveCity({ withTraffic: false });
  original.eco._completeTrip({ id: 'probe' }, original.shop.id, original.home.id);
  const restored = hydrateWorld(validateSnapshot(serializeWorld(original)).data);

  const calls = [];
  restored.eco.processReturns(1000, (from, to) => {
    calls.push([from, to]);
    return { id: 'return' };
  });

  assert.equal(calls.length, 1, 'the restored return dispatched');
  for (const id of calls[0]) {
    assert.ok(restored.net.nodes.has(id), `dispatched id ${id} must exist`);
  }
});

test('cancellation counters survive a save', () => {
  const original = liveCity({ withTraffic: false });
  original.eco._completeTrip({ id: 'probe' }, original.shop.id, original.home.id);
  original.eco.remove(original.shop.id);
  original.eco.processReturns(1000, () => null);
  assert.equal(original.eco.cancelledReturns, 1);

  const restored = hydrateWorld(validateSnapshot(serializeWorld(original)).data);
  assert.equal(restored.eco.cancelledReturns, 1, 'cancellation count preserved');
  assert.equal(restored.eco.cancellationReasons.deletedOrigin, 1, 'reason preserved');
});

test('a car arriving just before a save is rewarded exactly once', () => {
  const original = liveCity({ withTraffic: false });
  const car = original.traffic.spawn(original.home.drivewayNode, original.shop.drivewayNode);
  assert.ok(car);
  let rewards = 0;
  car.onArrive = () => { rewards++; };

  // Advance to within a few ticks of arrival, then save.
  for (let i = 0; i < 60 * 60 && !car.arrived; i++) {
    const edge = original.net.edges.get(car.currentStep()?.edgeId);
    if (edge && edge.total - car.s < 1) break;
    original.traffic.update(1 / 60);
  }

  const restored = hydrateWorld(validateSnapshot(serializeWorld(original)).data, {
    onArrival: () => { rewards++; },
  });
  const restoredCar = [...restored.traffic.cars.values()][0];
  assert.ok(restoredCar, 'the near-arrival car was preserved');

  for (let i = 0; i < 600; i++) restored.traffic.update(1 / 60);
  assert.ok(rewards <= 1, `the trip must be rewarded at most once, got ${rewards}`);
});

test('the serialized payload contains no functions, Maps or Sets', () => {
  const text = JSON.stringify(serializeWorld(liveCity()));
  assert.ok(!/=>|function\s*\(/.test(text), 'no serialized functions');
  assert.ok(!text.includes('"__proto__"'), 'no prototype pollution payload');

  const parsed = JSON.parse(text);
  const walk = (v, path) => {
    if (v === null) return;
    assert.notEqual(typeof v, 'function', `function at ${path}`);
    if (v instanceof Map || v instanceof Set) assert.fail(`Map/Set at ${path}`);
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${path}[${i}]`));
    else if (typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) walk(item, `${path}.${k}`);
    }
  };
  walk(parsed, '$');
});

// ------------------------------------------------------------- validation ---

test('a valid snapshot reports its version and any warnings', () => {
  const verdict = validateSnapshot(serializeWorld(liveCity()));
  assert.equal(verdict.ok, true);
  assert.ok(Array.isArray(verdict.warnings));
  assert.equal(verdict.data.v, SNAPSHOT_VERSION);
});

test('a future version is refused rather than misinterpreted', () => {
  const data = serializeWorld(liveCity());
  data.v = SNAPSHOT_VERSION + 5;
  const verdict = validateSnapshot(data);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(' '), /newer version/i);
});

test('truncated JSON is refused', () => {
  const text = JSON.stringify(serializeWorld(liveCity()));
  const verdict = validateSnapshot(text.slice(0, Math.floor(text.length / 2)));
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(' '), /valid JSON/i);
});

test('duplicate node ids are refused', () => {
  const data = serializeWorld(liveCity());
  data.net.nodes.push({ ...data.net.nodes[0] });
  const verdict = validateSnapshot(data);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(' '), /duplicate node/i);
});

test('an edge referencing a missing node is refused', () => {
  const data = serializeWorld(liveCity());
  data.net.edges[0].a = 'does-not-exist';
  const verdict = validateSnapshot(data);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(' '), /missing node/i);
});

test('non-finite coordinates are refused', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const data = serializeWorld(liveCity());
    data.net.nodes[0].x = bad;
    const verdict = validateSnapshot(data);
    assert.equal(verdict.ok, false, `${bad} must be refused`);
  }
});

test('an oversize payload is refused before parsing', () => {
  const huge = 'x'.repeat(11 * 1024 * 1024);
  const verdict = validateSnapshot(huge);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(' '), /too large/i);
});

test('too many buildings are refused', () => {
  const data = serializeWorld(liveCity());
  data.eco.buildings = Array.from({ length: 10001 }, (_, i) => ({
    id: `b${i}`, type: 'house', x: 0, y: 0, drivewayNode: data.net.nodes[0].id,
  }));
  const verdict = validateSnapshot(data);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(' '), /too many buildings/i);
});

test('a building that lost its access node warns but does not fail the save', () => {
  const data = serializeWorld(liveCity());
  data.eco.buildings[0].drivewayNode = 'vanished';
  const verdict = validateSnapshot(data);
  assert.equal(verdict.ok, true, 'the rest of the city is still usable');
  assert.ok(verdict.warnings.some(w => /road access/i.test(w)), 'the problem is reported');
});

test('an out-of-range camera zoom is refused', () => {
  const data = serializeWorld(liveCity());
  data.camera.zoom = 999;
  const verdict = validateSnapshot(data);
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join(' '), /zoom/i);
});

// ------------------------------------------------------- v1 migration ---

test('the frozen v1 fixture migrates to v2 with its city intact', () => {
  const raw = JSON.parse(
    readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url), 'utf8'));
  assert.equal(raw.v, 1, 'the fixture really is v1');

  const verdict = validateSnapshot(raw);
  assert.equal(verdict.ok, true, `v1 must migrate: ${verdict.errors?.join('; ')}`);
  assert.ok(verdict.warnings.some(w => /migrated from v1/i), 'the migration is reported');

  const world = hydrateWorld(verdict.data);
  assertGraphConsistent(world.net, 'migrated v1');
  assertEconomyConsistent(world.eco, world.net, 'migrated v1');

  assert.equal(world.eco.buildings.size, raw.eco.buildings.length,
    'every building survived migration');
  assert.equal(world.eco.xp, raw.eco.xp, 'XP preserved');
  assert.equal(world.net.nodes.size, raw.net.nodes.length, 'every node survived');
});

test('a v1 save loads without traffic state, defaulting cleanly', () => {
  const raw = JSON.parse(
    readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url), 'utf8'));
  const world = hydrateWorld(validateSnapshot(raw).data);
  assert.equal(world.traffic.cars.size, 0, 'no vehicles invented');
  assert.equal(world.eco.pendingReturnCount, 0, 'no phantom return trips');
  assertVehiclesFinite(world.traffic, 'migrated v1');

  // v1 stored the clock as `simTime`; migration must carry it across rather than
  // silently restarting the city's clock at zero.
  assert.equal(raw.simTime, 42, 'the fixture records a non-zero clock');
  assert.equal(world.traffic.time, 42, 'the v1 clock is preserved as traffic.time');
});

test('a v1 save with no clock at all defaults to zero', () => {
  const raw = JSON.parse(
    readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url), 'utf8'));
  delete raw.simTime;
  const world = hydrateWorld(validateSnapshot(raw).data);
  assert.equal(world.traffic.time, 0, 'an absent clock defaults to zero');
});

// -------------------------------------------------------------- storage ---

test('save then load through storage returns the same world', () => {
  const storage = memoryStorage();
  const original = liveCity();

  const saved = saveGame(original, { storage });
  assert.equal(saved.ok, true, `save failed: ${saved.error}`);

  const loaded = loadGame({ storage });
  assert.equal(loaded.ok, true, `load failed: ${loaded.error}`);
  assert.deepEqual(normalize(loaded.world), normalize(original));
});

test('hasSave is false on an empty slot and never throws', () => {
  const storage = memoryStorage();
  assert.equal(hasSave({ storage }), false);

  const broken = memoryStorage({ failReads: true });
  assert.doesNotThrow(() => hasSave({ storage: broken }));
  assert.equal(hasSave({ storage: broken }), false, 'a throwing read reports false');
});

test('a failed write is reported, not swallowed', () => {
  const storage = memoryStorage({ failWrites: true });
  const res = saveGame(liveCity(), { storage });
  assert.equal(res.ok, false);
  assert.match(res.error, /storage is full|write failed/i, `unhelpful error: ${res.error}`);
});

test('a full storage gives actionable advice', () => {
  const storage = memoryStorage({ failWrites: true });
  const res = saveGame(liveCity(), { storage });
  assert.match(res.error, /export|remove old saves/i, 'the message says what to do');
});

test('loading a corrupt slot reports the problem and returns no world', () => {
  const storage = memoryStorage();
  storage.setItem(SAVE_KEY, '{ this is not json');
  const res = loadGame({ storage });
  assert.equal(res.ok, false);
  assert.equal(res.world, undefined, 'no world is produced from a corrupt save');
  assert.match(res.error, /not usable/i);
});

test('an empty slot is distinguishable from a corrupt one', () => {
  const storage = memoryStorage();
  const empty = loadGame({ storage });
  assert.equal(empty.ok, false);
  assert.equal(empty.empty, true, 'an empty slot is flagged as empty');

  storage.setItem(SAVE_KEY, 'garbage');
  const corrupt = loadGame({ storage });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.empty, undefined, 'a corrupt slot is NOT flagged as empty');
});

test('the previous save is preserved as a backup before being overwritten', () => {
  const storage = memoryStorage();
  saveGame(liveCity(), { storage });
  const first = storage.getItem(SAVE_KEY);
  assert.ok(first, 'first save written');

  const bigger = liveCity();
  bigger.eco.batch.house = 99;
  saveGame(bigger, { storage });

  assert.equal(storage.getItem(BACKUP_KEY), first,
    'the backup holds the previous save, not the new one');
});

test('a valid backup is reported as recoverable', () => {
  const storage = memoryStorage();
  assert.equal(hasRecoverableBackup({ storage }), false, 'nothing to recover initially');
  saveGame(liveCity(), { storage });
  saveGame(liveCity(), { storage });
  assert.equal(hasRecoverableBackup({ storage }), true, 'a backup exists after two saves');
});

test('recovery restores a city after the manual save is corrupted', () => {
  const storage = memoryStorage();
  const original = liveCity();
  saveGame(original, { storage });
  saveGame(liveCity(), { storage });          // creates the backup

  storage.setItem(SAVE_KEY, 'corrupted!');
  assert.equal(hasSave({ storage }), false, 'the manual save is unusable');

  const recovered = recoverFromBackup({ storage });
  assert.equal(recovered.ok, true, `recovery failed: ${recovered.error}`);
  assert.ok(recovered.world.net.edges.size > 0, 'the recovered city has roads');
  assert.equal(hasSave({ storage }), true, 'the manual slot is usable again');
});

test('recovery fails cleanly when there is no backup', () => {
  const storage = memoryStorage();
  const res = recoverFromBackup({ storage });
  assert.equal(res.ok, false);
  assert.match(res.error, /no backup/i);
});

test('autosave uses a separate slot and never overwrites the manual save', () => {
  const storage = memoryStorage();
  const manual = liveCity();
  saveGame(manual, { storage });
  const manualText = storage.getItem(SAVE_KEY);

  const auto = autosave(liveCity());
  assert.equal(auto.ok, false, 'no storage was injected, so this reports unavailability');

  const res = autosave(liveCity(), { storage });
  assert.equal(res.ok, true, `autosave failed: ${res.error}`);
  assert.ok(storage.getItem(AUTOSAVE_KEY), 'the autosave slot was written');
  assert.equal(storage.getItem(SAVE_KEY), manualText, 'the manual save is untouched');
});

test('a missing storage backend is reported rather than throwing', () => {
  const res = saveGame(liveCity(), { storage: null });
  // `null` means "resolve the real backend"; in Node that is unavailable.
  assert.equal(res.ok, false);
  assert.match(res.error, /unavailable/i);
});

test('clearSaves removes every slot', () => {
  const storage = memoryStorage();
  saveGame(liveCity(), { storage });
  saveGame(liveCity(), { storage });
  autosave(liveCity(), { storage });

  const res = clearSaves({ storage });
  assert.equal(res.ok, true);
  assert.equal(storage.getItem(SAVE_KEY), null);
  assert.equal(storage.getItem(AUTOSAVE_KEY), null);
  assert.equal(storage.getItem(BACKUP_KEY), null);
});

// ------------------------------------------------------- import / export ---

test('an exported city can be imported back', () => {
  const original = liveCity();
  const text = exportGame(original);

  const res = importGame(text);
  assert.equal(res.ok, true, `import failed: ${res.error}`);
  assert.deepEqual(normalize(res.world), normalize(original));
});

test('a corrupt import is refused and produces no world', () => {
  const res = importGame('{"v":2,"net":{"nodes":[]}}');
  assert.equal(res.ok, false);
  assert.equal(res.world, undefined);
  assert.match(res.error, /not usable/i);
});

test('importing does not touch the current world', () => {
  const storage = memoryStorage();
  const current = liveCity();
  saveGame(current, { storage });
  const before = storage.getItem(SAVE_KEY);

  importGame('garbage');
  importGame(exportGame(liveCity()));

  assert.equal(storage.getItem(SAVE_KEY), before,
    'import must not write to storage at all');
});

test('importing a v1 file works', () => {
  const raw = readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url), 'utf8');
  const res = importGame(raw);
  assert.equal(res.ok, true, `v1 import failed: ${res.error}`);
  assert.ok(res.warnings.some(w => /migrated/i), 'the migration is reported to the player');
});

// ------------------------------------------------------- graph integrity ---

test('a restored world passes the structural invariants', () => {
  const original = liveCity();
  const restored = hydrateWorld(validateSnapshot(serializeWorld(original)).data);
  assertGraphConsistent(restored.net, 'restored');
  assertEconomyConsistent(restored.eco, restored.net, 'restored');
  assertVehiclesFinite(restored.traffic, 'restored');
});

test('every restored building keeps a real access node', () => {
  const original = liveCity();
  const restored = hydrateWorld(validateSnapshot(serializeWorld(original)).data);
  for (const b of restored.eco.buildings.values()) {
    assert.ok(restored.net.nodes.has(b.drivewayNode),
      `building ${b.id} lost its access node`);
  }
});

test('terrain is rebuilt from the seed, not stored', () => {
  const original = liveCity({ seed: 4242 });
  const data = serializeWorld(original);
  assert.equal(data.map.seed, 4242, 'the seed is recorded');
  assert.equal(data.terrain, undefined, 'terrain data is NOT stored');

  const restored = hydrateWorld(validateSnapshot(data).data);
  assert.equal(restored.terrain.seed, 4242, 'terrain rebuilt from the seed');
});
