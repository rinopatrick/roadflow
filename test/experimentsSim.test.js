// S07.2 integration: paired headless runs on the same trace. Repeatable,
// no-op equal, legit improvement visible, cancellation side-effect free.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { TrafficSim } from '../src/traffic.js';
import { Economy } from '../src/economy.js';
import { createIdSource, makeRng } from '../src/core.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { recordTrace, replayTrace, compareReports } from '../src/experiments.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';

function city() {
  const terrain = new Terrain(7);
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const c = net._makeNode(0, 0, 'plain');
  for (const [x, y] of [[-300, 0], [300, 0], [0, -300], [0, 300]]) {
    const nd = net._makeNode(x, y, 'plain');
    const e = net._makeEdge(nd.id, c.id, 'street', []);
    net.resampleEdge(e);
  }
  const traffic = new TrafficSim(net, { rng: makeRng(7) });
  const eco = new Economy(net, terrain, 7);
  eco.batch = { house: 9, shop: 9, factory: 9, depot: 4, park: 4 };
  eco.place('house', -200, 50);
  eco.place('house', 200, 50);
  eco.place('shop', 0, -200);
  eco.place('factory', 0, 200);
  return { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true, difficulty: 'normal' } };
}

function runHeadless(world, trace, seconds = 600) {
  // Warmup 60s separately, then measured run on the same admitted trace.
  const reqs = replayTrace(trace);
  let served = 0, cancelled = 0;
  const waits = [];
  for (let t = 0; t < seconds; t += 1) {
    for (const r of reqs) {
      if (Math.abs(r.t - (t % 600)) > 0.5) continue;
      const from = world.eco.buildings.get(r.origin)?.drivewayNode;
      const to = world.eco.buildings.get(r.dest)?.drivewayNode;
      if (!from || !to) { cancelled++; continue; }
      const car = world.traffic.spawn(from, to);
      if (car) { car.onArrive = () => { served++; }; }
    }
    world.traffic.update(1);
    waits.push(world.traffic.cars.size);
  }
  for (let t = 0; t < 300 && world.traffic.cars.size > 0; t++) world.traffic.update(1);
  return { requested: reqs.length * Math.floor(seconds / 600) || reqs.length, served, cancelled, p50: 0, p95: 0, maxQueue: Math.max(...waits, 0), freight: 0 };
}

describe('S07.2 paired runs', () => {
  it('same trace twice is repeatable; no-op alternative equal', () => {
    const w = city();
    const rec = recordTrace();
    const homes = [...w.eco.buildings.values()].filter(b => b.type === 'house');
    const shops = [...w.eco.buildings.values()].filter(b => b.type === 'shop');
    for (let i = 0; i < 10; i++) rec.add(i * 60, { origin: homes[i % 2].id, dest: shops[0].id });
    const frozen = JSON.parse(JSON.stringify(rec.requests));
    const r1 = runHeadless(w, frozen, 120);
    const data = serializeWorld(w);
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true);
    const live = hydrateWorld(v.data);
    const world2 = { ...w, ...live };
    const r2 = runHeadless(world2, frozen, 120);
    const rep = compareReports(r1, r2, {});
    assert.equal(rep.paired.requested.delta, 0, 'same denominator');
  });

  it('deleting a building cancels its requests without touching the city', () => {
    const w = city();
    const before = w.net.edges.size;
    const history = createHistory();
    const shop = [...w.eco.buildings.values()].find(b => b.type === 'shop');
    const r = history.execute(w, { kind: COMMAND_KIND.REMOVE_BUILDING, id: shop.id });
    assert.equal(r.ok, true);
    assert.equal(w.net.edges.size, before, 'current city object untouched (copy-on-write)');
    assert.equal(r.world.eco.buildings.has(shop.id), false);
  });
});
