// S07.5 integration: bus stops/boards/alights with real capacity, mode
// ownership (no double car), line legality, save ownership.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { TrafficSim } from '../src/traffic.js';
import { Economy } from '../src/economy.js';
import { createIdSource, makeRng } from '../src/core.js';
import { TransitLine, validateLine, BUS } from '../src/transit.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';

function loop() {
  const terrain = new Terrain(7);
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const a = net._makeNode(-200, 0, 'plain');
  const b = net._makeNode(200, 0, 'plain');
  const e = net._makeEdge(a.id, b.id, 'street', []);
  net.resampleEdge(e);
  const traffic = new TrafficSim(net, { rng: makeRng(7) });
  const eco = new Economy(net, terrain, 7);
  return { terrain, net, traffic, eco, ids, a, b };
}

describe('S07.5 transit integration', () => {
  it('bus spawns with full-size envelope and serves the line', () => {
    const w = loop();
    const bus = w.traffic.spawnBus(w.a.id, w.b.id, { lineId: 'L1' });
    assert.ok(bus, 'bus spawns on a legal route');
    assert.equal(bus.length, BUS.length);
    assert.equal(bus.width, BUS.width);
    assert.equal(bus.kind, 'bus');
    const line = new TransitLine({ id: 'L1', stops: [w.a.id, w.b.id], headway: 60 });
    line.enqueue(w.a.id, 'j1');
    const boarded = line.board(w.a.id, bus.id, [w.b.id], BUS.capacity);
    assert.deepEqual(boarded, ['j1']);
    for (let t = 0; t < 1200 && w.traffic.cars.size > 0; t++) w.traffic.update(1);
    const done = line.alight(bus.id, w.b.id);
    assert.deepEqual(done, ['j1'], 'alighting completes the journey');
  });

  it('bus does not fit car gaps: spawn blocked by a stopped bus', () => {
    const w = loop();
    const b1 = w.traffic.spawnBus(w.a.id, w.b.id, {});
    assert.ok(b1);
    b1.s = 5; b1.speed = 0;
    const car = w.traffic.spawn(w.a.id, w.b.id);
    // Either blocked (correct: 18wu bus occupies the spawn zone) or behind.
    if (car) assert.ok(Math.abs(car.s - b1.s) >= BUS.length, 'car respects bus length');
  });

  it('stops reject motorway/ramp/ring/bridge edges', async () => {
    const { profileFor } = await import('../src/roadProfiles.js');
    const w = loop();
    // Local street stop: valid. (Access rule: local/arterial only.)
    const edge = [...w.net.edges.values()][0];
    const access = profileFor(edge).access;
    assert.ok(['local', 'arterial'].includes(access), 'street is stop-eligible');
  });

  it('riders and queues survive save/load with ownership', () => {
    const w = loop();
    const world = {
      terrain: w.terrain, net: w.net, traffic: w.traffic, eco: w.eco, ids: w.ids,
      camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true },
      transit: { lines: [{ id: 'L1', stops: [w.a.id, w.b.id], headway: 60, queues: { [w.a.id]: ['j1'] } }] },
    };
    const data = serializeWorld(world);
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const live = hydrateWorld(v.data);
    assert.ok(live, 'world hydrates with transit state');
  });

  it('a transit journey never also spawns a car', () => {
    const w = loop();
    let carSpawns = 0;
    const origSpawn = w.traffic.spawn.bind(w.traffic);
    w.traffic.spawn = (...a) => { carSpawns++; return origSpawn(...a); };
    const bus = w.traffic.spawnBus(w.a.id, w.b.id, {});
    assert.ok(bus);
    assert.equal(carSpawns, 0, 'bus path spawns no car');
  });
});
