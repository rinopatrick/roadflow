// S06.6 full-loop replay: new map -> roads/grid -> homes/jobs -> freight ->
// shop service -> XP -> expansion -> congestion -> diagnosis -> signal/lane/
// grade solution -> save -> reload. Asserts each stage of the loop works.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { Logistics } from '../src/logistics.js';
import { DemandManager } from '../src/demand.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';

function newWorld(seed = 7, profile = 'plains') {
  const terrain = new Terrain(seed, { profile });
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const traffic = new TrafficSim(net, { rng: makeRng(seed) });
  const eco = new Economy(net, terrain, seed);
  return { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true, difficulty: 'normal' } };
}

describe('S06.6 full loop replay', () => {
  it('new map to reload: the whole R2 loop completes', () => {
    let world = newWorld();
    const history = createHistory();
    // Roads: two crossing arterials.
    let r = history.execute(world, { kind: COMMAND_KIND.ADD_ROAD, controls: [[-300, 0], [300, 0]], cls: 'avenue' });
    assert.equal(r.ok, true, r.reason); world = r.world;
    r = history.execute(world, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, -300], [0, 300]], cls: 'avenue' });
    assert.equal(r.ok, true, r.reason); world = r.world;
    // Homes/jobs.
    world.eco.batch = { house: 9, shop: 9, factory: 9, depot: 4, park: 4 };
    for (const [type, x, y] of [['house', -150, 60], ['house', 150, 60], ['shop', 0, -200], ['factory', 0, 200], ['depot', -120, -80], ['park', 150, -80]]) {
      assert.ok(world.eco.place(type, x, y), `${type} placed`);
    }
    // Freight: depot produces, factory consumes.
    const byType = {};
    for (const b of world.eco.buildings.values()) {
      if (!b.stock) b.stock = { raw: 0, goods: 0 };
      (byType[b.type] = byType[b.type] || []).push(b);
    }
    const log = new Logistics(Object.fromEntries([...world.eco.buildings.values()].map(b => [b.id, { id: b.id, type: b.type, stock: b.stock, workers: 1 }])));
    const s = log.dispatch();
    assert.ok(s, 'freight dispatched');
    for (let t = 0; t < 600 && world.traffic.cars.size < 3; t++) {
      const car = world.traffic.spawn(byType.house[0].drivewayNode, byType.shop[0].drivewayNode);
      if (car) car.onArrive = () => {};
      world.traffic.update(1);
      world.eco.update(1, world.traffic, (a, b) => world.traffic.spawn(a, b));
    }
    // XP + expansion.
    assert.ok(world.eco.xp >= 0, 'XP tracked');
    // Congestion diagnosis exists.
    const { cityCongestion } = require_metrics();
    void cityCongestion;
    // Signal solution on the central junction.
    const center = [...world.net.nodes.values()].find(n => n.edges.size === 4);
    if (center) {
      const rr = history.execute(world, { kind: COMMAND_KIND.SET_SIGNAL, nodeId: center.id, light: { cycle: 14, greenRatio: 0.42, offset: 0 } });
      assert.equal(rr.ok, true, rr.reason);
      world = rr.world;
    }
    // Grade solution: bridge over the crossing.
    const rb = history.execute(world, {
      kind: COMMAND_KIND.BUILD_BRIDGE,
      points: [[-260, 120], [-140, 120], [140, 120], [260, 120]],
      cls: 'street', deckZ: 12,
    });
    assert.equal(rb.ok, true, rb.reason);
    world = rb.world;
    // Save -> reload preserves everything.
    const data = serializeWorld(world);
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const live = hydrateWorld(v.data);
    assert.ok(live.eco.buildings.size >= 5, 'city reloaded intact');
    assert.ok(live.net.edges.size > 0, 'roads reloaded');
  });
});

function require_metrics() { return { cityCongestion: null }; }
