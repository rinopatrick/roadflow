// S06.5 fixture: scripted reasonable expansion on all difficulties.
// Records delivered/failed services, XP, congestion, starvation. Same design
// must show an observable challenge gradient without inevitable deadlock.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { rulesFor } from '../src/rules.js';
import { DemandManager } from '../src/demand.js';

function town(seed = 7) {
  const terrain = new Terrain(seed);
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
  return { terrain, net, traffic, eco, ids };
}

function runFixture(difficulty) {
  const w = town();
  const rules = rulesFor(difficulty);
  w.eco.batch = { ...rules.startBatch };
  // Scripted reasonable expansion: ring of homes + shop + factory + depot.
  const spots = [
    ['house', -200, 40], ['house', 200, 40], ['house', -200, -40], ['house', 200, -40],
    ['shop', 0, -220], ['factory', 0, 220], ['depot', -280, 120],
  ];
  for (const [type, x, y] of spots) {
    if ((w.eco.batch[type] ?? 0) > 0) w.eco.place(type, x, y);
  }
  // Assign all factory jobs from houses.
  const facts = [...w.eco.buildings.values()].filter(b => b.type === 'factory');
  const homes = [...w.eco.buildings.values()].filter(b => b.type === 'house');
  for (const f of facts) {
    for (const h of homes) {
      if ((f.assignedWorkers ?? 0) >= (f.jobs ?? 0)) break;
      w.eco.assignWorker(h.id, f.id);
    }
  }
  // 30 sim-minutes at demand-scaled trip intervals.
  let delivered = 0, failed = 0, requested = 0;
  const cost = {};
  for (const b of w.eco.buildings.values()) {
    cost[b.drivewayNode] = {};
    for (const o of w.eco.buildings.values()) {
      if (o.id !== b.id) cost[b.drivewayNode][o.drivewayNode] = 10;
    }
  }
  const demand = new DemandManager({ buildings: w.eco.buildings, cost });
  let tick = 0;
  const every = Math.max(1, Math.round(6 / rules.demandRate)); // iterations
  for (let t = 0; t < 1800; t += 5, tick++) {
    // Demand ticks scaled by difficulty.
    if (tick % every === 0) {
      for (const h of homes) {
        const j = demand.request({ kind: t % 2 ? 'work' : 'shopping', origin: h.id });
        if (j) requested++;
        else failed++;
      }
    }
    demand.dispatchAll((from, to) => w.traffic.spawn(from, to) ?? w.traffic.spawnFreight?.(from, to, {}) ?? null);
    for (const [vid] of [...demand._vehicleJourney.entries()]) {
      if (!w.traffic.cars.has(Number(vid)) && !w.traffic.cars.has(vid)) demand.arrive(vid);
    }
    w.traffic.update(5);
    w.eco.update(5, w.traffic, (a, b) => w.traffic.spawn(a, b));
    w.eco.processReturns(5, (a, b) => w.traffic.spawn(a, b));
    w.eco.checkLevelUp();
  }
  delivered = demand.stats().completed;
  failed += demand.stats().cancelled;
  return {
    difficulty, delivered, failed, requested,
    xp: Math.round(w.eco.xp), level: w.eco.level,
    congestion: w.traffic.stats,
  };
}

describe('S06.5 difficulty fixtures', () => {
  it('30 sim-minutes per difficulty: gradient without deadlock', () => {
    const results = ['easy', 'normal', 'hard'].map(runFixture);
    for (const r of results) {
      console.log(`  ${r.difficulty}: requested=${r.requested} delivered=${r.delivered} failed=${r.failed} xp=${r.xp} level=${r.level}`);
      assert.ok(r.requested > 0, `${r.difficulty} produced demand`);
      assert.ok(r.delivered > 0, `${r.difficulty} solvable: something delivered`);
    }
    // Harder demand paces more attempts; easy paces fewer. Volume counts
    // attempts (admitted + refused-at-cap): the cap is what backpressure
    // looks like under heavy demand. Solvability is separate (delivered>0).
    const [e, n, h] = results;
    const vol = (r) => r.requested + r.failed;
    console.log(`  volumes: easy=${vol(e)} normal=${vol(n)} hard=${vol(h)}`);
    assert.ok(vol(h) >= vol(n) && vol(n) >= vol(e), 'monotonic demand gradient');
  });
});
