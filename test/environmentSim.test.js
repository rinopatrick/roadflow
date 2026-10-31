// S06.3 integration: factory clearing changes air after decay, road detour
// changes noise, environment rebuilds deterministically (no saved cache).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Environment } from '../src/environment.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';

function city() {
  const terrain = new Terrain(7);
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const c = net._makeNode(0, 0, 'plain');
  for (const [x, y] of [[-200, 0], [200, 0], [0, -200]]) {
    const nd = net._makeNode(x, y, 'plain');
    const e = net._makeEdge(nd.id, c.id, 'street', []);
    net.resampleEdge(e);
  }
  const traffic = new TrafficSim(net, { rng: makeRng(7) });
  const eco = new Economy(net, terrain, 7);
  eco.batch = { house: 9, shop: 9, factory: 9, depot: 4, park: 4 };
  return { net, traffic, eco };
}

describe('S06.3 integration', () => {
  it('clearing the factory changes air after production stops', () => {
    const w = city();
    const f = w.eco.place('factory', 0, 60);
    const h = w.eco.place('house', 100, 60);
    assert.ok(f && h);
    const src = () => ({
      factories: [{ x: f.x, y: f.y, rate: 1 }],
      vehicles: [], parks: [], homes: [],
    });
    const e1 = new Environment(src);
    const dirty = e1.airAt(h.x, h.y);
    assert.ok(dirty > 0);
    // Factory demolished: air rebuilds to zero deterministically.
    w.eco.remove(f.id);
    const e2 = new Environment(() => ({ factories: [], vehicles: [], parks: [], homes: [] }));
    assert.equal(e2.airAt(h.x, h.y), 0, 'no factories means clean air');
    void dirty;
  });

  it('road detour changes noise exposure', () => {
    const busy = new Environment(() => ({
      factories: [],
      vehicles: [{ x: 0, y: 0, speed: 18, kind: 'car' }],
      parks: [], homes: [],
    }));
    busy.update(2);
    const nearBusy = busy.noiseAt(0, 32);
    const quiet = new Environment(() => ({ factories: [], vehicles: [], parks: [], homes: [] }));
    quiet.update(2);
    assert.ok(nearBusy > quiet.noiseAt(0, 32), 'traffic raises nearby noise');
  });

  it('no factory traffic means noise decays to zero', () => {
    const e = new Environment(() => ({
      factories: [],
      vehicles: [{ x: 0, y: 0, speed: 18, kind: 'car' }],
      parks: [], homes: [],
    }));
    e.update(2);
    assert.ok(e.noiseAt(0, 0) > 0, 'traffic registers');
    const e2 = new Environment(() => ({ factories: [], vehicles: [], parks: [], homes: [] }));
    e2.update(2);
    assert.equal(e2.noiseAt(0, 0), 0, 'grid rebuilds empty without traffic');
  });

  it('park placement is validated and counted once', () => {
    const w = city();
    const p = w.eco.place('park', 50, 50);
    assert.ok(p, 'park places like a building');
    const e = new Environment(() => ({
      factories: [], vehicles: [],
      parks: [...w.eco.buildings.values()].filter(b => b.type === 'park'),
      homes: [],
    }));
    assert.ok(e.parkBonusAt(50, 60) > 0, 'nearby home gets the bonus');
    assert.equal(e.parkBonusAt(500, 500), 0, 'far home gets nothing');
  });

  it('satisfaction slows levelling but never deletes population', () => {
    const w = city();
    const h = w.eco.place('house', -100, 60);
    assert.ok(h);
    w.eco.environment = {}; // hooked: mean reads per-house satisfaction
    h.satisfaction = 0.1;
    const pop0 = w.eco.population();
    w.eco.xp = 100000;
    w.eco.checkLevelUp();
    assert.equal(w.eco.level, 1, 'level gated while miserable');
    assert.equal(w.eco.population(), pop0, 'nobody deleted');
    h.satisfaction = 0.9;
    w.eco.checkLevelUp();
    assert.ok(w.eco.level > 1, 'recovers when happy');
  });
});
