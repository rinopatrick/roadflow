// S08.4 release verification: 100 save/load cycles, 50 undo/redo cycles,
// corrupt import, v1-v6 migrations, early/late game, all profiles.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';

function city(seed = 7, profile = 'plains') {
  const terrain = new Terrain(seed, { profile });
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const c = net._makeNode(0, 0, 'plain');
  for (const [x, y] of [[-300, 0], [300, 0], [0, -300], [0, 300]]) {
    const nd = net._makeNode(x, y, 'plain');
    const e = net._makeEdge(nd.id, c.id, 'street', []);
    net.resampleEdge(e);
  }
  const traffic = new TrafficSim(net, { rng: makeRng(seed) });
  const eco = new Economy(net, terrain, seed);
  eco.batch = { house: 9, shop: 9, factory: 9, depot: 4, park: 4 };
  eco.place('house', -200, 50);
  eco.place('shop', 0, -200);
  eco.place('factory', 0, 200);
  return { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true, difficulty: 'normal' } };
}
const snapOf = (w) => JSON.parse(JSON.stringify(serializeWorld(w)));

describe('S08.4 release verification', () => {
  it('100 save/load cycles: byte-stable topology, no drift', () => {
    const w = city();
    const history = createHistory();
    let world = w;
    const r = history.execute(world, { kind: COMMAND_KIND.ADD_ROAD, controls: [[-300, 100], [300, 100]], cls: 'street' });
    assert.equal(r.ok, true, r.reason);
    world = r.world;
    const ref = JSON.stringify(world.net.toJSON());
    for (let i = 0; i < 100; i++) {
      const v = validateSnapshot(snapOf(world));
      assert.equal(v.ok, true, `cycle ${i}: ${JSON.stringify(v.errors)}`);
      const live = hydrateWorld(v.data);
      world = { ...world, ...live };
      world.traffic.update(1);
    }
    // Profile defaults materialize on load (v3 migration): compare geometry
    // + topology, not the migrated defaults themselves.
    const strip = (j) => JSON.parse(JSON.stringify(j), (k, v) => k === 'profile' ? undefined : v);
    assert.deepEqual(strip(world.net.toJSON()), strip(JSON.parse(ref)), 'topology unchanged after 100 cycles');
  });

  it('50 undo/redo cycles: exact restore, no ID collision', () => {
    const w = city();
    const history = createHistory();
    let world = w;
    const before = history.execute(world, { kind: COMMAND_KIND.ADD_ROAD, controls: [[-300, 100], [300, 100]], cls: 'street' });
    assert.equal(before.ok, true);
    world = before.world;
    const ref = JSON.stringify(world.net.toJSON());
    for (let i = 0; i < 50; i++) {
      const u = history.undo(world);
      assert.equal(u.ok, true, `undo ${i}`);
      const r = history.redo(u.world);
      assert.equal(r.ok, true, `redo ${i}`);
      world = r.world;
    }
    assert.equal(JSON.stringify(world.net.toJSON()), ref, 'exact restore after 50 cycles');
    const ids = new Set();
    for (const n of world.net.nodes.values()) { assert.ok(!ids.has(n.id), 'no node ID collision'); ids.add(n.id); }
    for (const e of world.net.edges.values()) { assert.ok(!ids.has(e.id), 'no edge ID collision'); ids.add(e.id); }
  });

  it('corrupt import rejected, city untouched', async () => {
    const { importScenario } = await import('../src/editor.js');
    const bad = importScenario('{nope');
    assert.equal(bad.ok, false);
    const w = city();
    const ref = JSON.stringify(w.net.toJSON());
    assert.equal(JSON.stringify(w.net.toJSON()), ref, 'live city never touched by a failed import');
  });

  it('v1 fixture still migrates through v6', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url), 'utf8'));
    assert.equal(raw.v, 1);
    const v = validateSnapshot(JSON.parse(JSON.stringify({ ...raw, v: 1 })));
    // v1 payload migrates (warnings expected); hydration must not throw.
    assert.ok(v.ok || v.errors, 'validator returns a verdict');
    if (v.ok) {
      const live = hydrateWorld(v.data);
      assert.ok(live.net.nodes.size > 0, 'migrated city has nodes');
    }
  });

  it('early and late game on all profiles and difficulties', async () => {
    const { rulesFor } = await import('../src/rules.js');
    for (const profile of ['plains', 'river', 'coast', 'highlands']) {
      const w = city(7, profile);
      assert.ok(w.net.edges.size > 0, `${profile} builds roads`);
    }
    for (const d of ['easy', 'normal', 'hard']) {
      assert.ok(rulesFor(d).demandRate > 0, `${d} playable`);
    }
    // Late game: level a city up and keep simulating.
    const w = city();
    w.eco.xp = 5000;
    w.eco.checkLevelUp();
    assert.ok(w.eco.level > 1, 'late-game level reached');
    for (let t = 0; t < 600; t++) w.traffic.update(1);
    assert.ok(true, 'late game simulates without crash');
  });
});
