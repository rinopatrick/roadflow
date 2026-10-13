import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy, BUILDING_DEFS, LEVEL_XP } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';

const mockTerrain = { isBuildable: () => true };

function netWithRoad() {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [600, 0]]);
  return net;
}

function setupEco() {
  const net = netWithRoad();
  const eco = new Economy(net, mockTerrain, 7);
  eco.onToast = () => {};
  return { net, eco };
}

test('placing buildings consumes batch', () => {
  const { eco } = setupEco();
  const before = eco.batch.house;
  const b = eco.place('house', 100, 60);
  assert.ok(b, 'house placed');
  assert.equal(eco.batch.house, before - 1);
  assert.equal(BUILDING_DEFS.house.residents, b.residents);
});

test('buildings need a road within reach', () => {
  const net = new RoadNetwork(); // no roads at all
  const eco = new Economy(net, mockTerrain, 7);
  assert.equal(eco.place('house', 0, 0), null, 'no road -> cannot place');
});

test('buildings cannot overlap', () => {
  const { eco } = setupEco();
  assert.ok(eco.place('house', 100, 60));
  assert.equal(eco.place('shop', 105, 65), null, 'overlaps first building');
  assert.ok(eco.place('shop', 400, 60), 'far away is fine');
});

test('factory pollution decays with distance', () => {
  const { eco } = setupEco();
  eco.batch.factory = 10; // test grant
  eco.place('factory', 100, 60);
  const near = eco.pollutionAt(110, 60);
  const far = eco.pollutionAt(800, 60);
  assert.ok(near > 0.3);
  assert.ok(far < near);
});

test('completed trips grant XP and level up grants batch', () => {
  const { eco } = setupEco();
  eco.batch.house = 10;
  eco.batch.shop = 10;
  const house = eco.place('house', 100, 60);
  const shop = eco.place('shop', 300, 60);
  assert.ok(house && shop, 'both placed');
  // simulate a completed trip
  eco._completeTrip({ id: 1 }, shop.id, house.id);
  assert.ok(eco.xp > 0, 'XP granted');
  assert.equal(eco.totalTrips, 1);
  // force level up
  eco.xp = LEVEL_XP(1) + 1;
  const bHouse = eco.batch.house, bShop = eco.batch.shop;
  eco.checkLevelUp();
  assert.equal(eco.level, 2);
  assert.ok(eco.batch.house > bHouse, 'houses granted');
  assert.ok(eco.batch.shop > bShop, 'shops granted');
});

test('end-to-end: house trips to a reachable shop spawn cars that arrive', () => {
  const { net, eco } = setupEco();
  eco.batch.house = 10;
  eco.batch.shop = 10;
  eco.place('house', 100, 50);
  eco.place('shop', 500, 50);
  const sim = new TrafficSim(net);
  // run the sim: houses will trip; cars drive; arrive -> XP
  let spawnedCount = 0;
  for (let t = 0; t < 60 * 180 && eco.totalTrips < 1; t++) {
    const dt = 1 / 60;
    eco.update(dt, sim, (from, to) => { const c = sim.spawn(from, to); if (c) spawnedCount++; return c; });
    eco.processReturns(dt, (from, to) => sim.spawn(from, to));
    sim.update(dt);
  }
  assert.ok(eco.totalTrips >= 1, `trip completed (spawned=${spawnedCount})`);
  assert.ok(eco.xp > 0);
});

test('unreachable destination produces a toast, no crash', () => {
  const { net, eco } = setupEco();
  eco.batch.house = 5;
  const house = eco.place('house', 100, 50);
  // no shop exists
  let toasts = 0;
  eco.onToast = () => toasts++;
  eco._failTimer = 10; // simulate accumulated unmet demand
  house.tripTimer = 0.01;
  eco.update(0.02, null, () => null);
  assert.ok(toasts >= 1, 'warning toast emitted');
});

test('population counts residents', () => {
  const { eco } = setupEco();
  eco.batch.house = 10;
  eco.place('house', 100, 50);
  eco.place('house', 200, 50);
  assert.equal(eco.population(), 8);
});

test('economy save roundtrip', () => {
  const { net, eco } = setupEco();
  eco.batch.house = 10;
  eco.place('house', 100, 50);
  eco.xp = 555;
  const data = eco.toJSON();
  const eco2 = Economy.fromJSON(net, mockTerrain, data);
  assert.equal(eco2.xp, 555);
  assert.equal(eco2.buildings.size, 1);
  assert.equal(eco2.population(), 4);
});
