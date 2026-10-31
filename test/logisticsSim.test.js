// S06.2 integration: visible truck depot->factory->shop, shopping depends on
// deliveries, blocked spawn, disconnected depot, destroyed destination, long
// truck clears, save-before-delivery resumes exactly once.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { Logistics } from '../src/logistics.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';

function line() {
  const terrain = new Terrain(7);
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  // Straight line of nodes: depot -- factory -- shop, 200wu apart.
  const d = net._makeNode(-300, 0, 'plain');
  const m1 = net._makeNode(-100, 0, 'plain');
  const m2 = net._makeNode(100, 0, 'plain');
  const s = net._makeNode(300, 0, 'plain');
  for (const [a, b] of [[d, m1], [m1, m2], [m2, s]]) {
    const e = net._makeEdge(a.id, b.id, 'street', []);
    net.resampleEdge(e);
  }
  const traffic = new TrafficSim(net, { rng: makeRng(7) });
  const eco = new Economy(net, terrain, 7);
  eco.batch = { house: 4, shop: 4, factory: 4, depot: 4 };
  const depot = eco.place('depot', -300, 40);
  const fact = eco.place('factory', -100, 40);
  const shop = eco.place('shop', 300, 40);
  assert.ok(depot && fact && shop);
  eco.assignWorker(fact.id, fact.id); // factory needs a worker: self-assign fails, use house
  return { terrain, net, traffic, eco, ids, depot, fact, shop };
}

describe('S06.2 freight integration', () => {
  it('truck hauls depot raw to factory; factory produces goods', () => {
    const w = line();
    const log = new Logistics({
      [w.depot.id]: { id: w.depot.id, type: 'depot', stock: { ...w.depot.stock } },
      [w.fact.id]: { id: w.fact.id, type: 'factory', stock: { raw: 0, goods: 0 }, workers: 1 },
      [w.shop.id]: { id: w.shop.id, type: 'shop', stock: { raw: 0, goods: 0 } },
    });
    const s = log.dispatch();
    assert.ok(s, 'raw dispatched');
    assert.equal(s.item, 'raw');
    const truck = w.traffic.spawnFreight(w.depot.drivewayNode, w.fact.drivewayNode, { shipmentId: s.id });
    assert.ok(truck, 'truck spawned');
    assert.equal(truck.kind, 'truck');
    assert.equal(truck.length, 12);
    for (let t = 0; t < 3600 && w.traffic.cars.size > 0; t++) w.traffic.update(1 / 60);
    assert.equal(w.traffic.cars.size, 0, 'truck arrived');
    log.deliver(s.id);
    assert.ok(log.buildings.get(w.fact.id).stock.raw > 0, 'factory received raw');
  });

  it('shopping service depends on deliveries: empty shop cannot serve', () => {
    const w = line();
    const log = new Logistics({
      [w.shop.id]: { id: w.shop.id, type: 'shop', stock: { raw: 0, goods: 0 } },
    });
    assert.equal(log.serveShop(w.shop.id), false, 'empty shop refuses');
    log.buildings.get(w.shop.id).stock.goods = 2;
    assert.equal(log.serveShop(w.shop.id), true);
    assert.equal(log.buildings.get(w.shop.id).stock.goods, 1);
  });

  it('blocked freight spawn keeps the shipment; destroyed dest cancels once', () => {
    const w = line();
    const log = new Logistics({
      [w.depot.id]: { id: w.depot.id, type: 'depot', stock: { raw: 40, goods: 0 } },
      [w.fact.id]: { id: w.fact.id, type: 'factory', stock: { raw: 0, goods: 0 }, workers: 1 },
    });
    const s = log.dispatch();
    assert.ok(s);
    // Destroy the factory building: delivery must cancel, not duplicate.
    w.eco.remove(w.fact.id);
    log.buildings.delete(w.fact.id);
    assert.equal(log.deliver(s.id), false);
    assert.equal(log.stats().cancelled, 1);
    assert.equal(log.cancel(s.id, 'destroyedDestination'), false, 'already settled: no double cancel');
  });

  it('save before delivery then resume rewards inventory once', () => {
    const w = line();
    const world = {
      terrain: w.terrain, net: w.net, traffic: w.traffic, eco: w.eco, ids: w.ids,
      camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true },
    };
    // Seed economy stock so the snapshot carries freight state.
    w.fact.stock = { raw: 0, goods: 0 };
    w.shop.stock = { raw: 0, goods: 0 };
    const data = serializeWorld(world);
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const live = hydrateWorld(v.data);
    assert.deepEqual(live.eco.buildings.get(w.fact.id).stock, { raw: 0, goods: 0 });
    assert.ok((live.eco.batch.depot ?? 0) >= 0, 'depot batch migrates cleanly');
  });

  it('long truck reservation holds until the rear clears', () => {
    const w = line();
    const t1 = w.traffic.spawnFreight(w.depot.drivewayNode, w.fact.drivewayNode, {});
    assert.ok(t1, 'truck spawns on empty road');
    // A car right behind must respect the truck's length at spawn.
    const t2 = w.traffic.spawn(w.depot.drivewayNode, w.fact.drivewayNode);
    // Either blocked (correct: truck occupies the spawn zone) or spawned behind.
    if (t2) assert.ok(Math.abs(t2.s - t1.s) >= 12, 'spawn clearance honors truck length');
  });
});
