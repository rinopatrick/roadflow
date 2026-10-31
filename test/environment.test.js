// S06.3: environment. Distance decay, production-rate emissions, truck noise,
// relocation, parked decay, satisfaction bounds, XP separation, park caps.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Environment, noiseFalloff, ENV_LIMITS } from '../src/environment.js';

function env(over = {}) {
  return new Environment(() => ({
    factories: [{ x: 0, y: 0, rate: 1 }],
    vehicles: [],
    parks: [],
    homes: [],
    ...over,
  }));
}

describe('S06.3 environment', () => {
  it('air decays with distance and scales with production rate', () => {
    const e = env();
    const near = e.airAt(10, 0);
    const far = e.airAt(200, 0);
    assert.ok(near > far, `near ${near} > far ${far}`);
    assert.ok(far > 0, 'still nonzero inside 260wu radius');
    assert.equal(e.airAt(500, 0), 0, 'zero beyond radius');
    const idle = env({ factories: [{ x: 0, y: 0, rate: 0 }] });
    assert.equal(idle.airAt(10, 0), 0, 'stopped factory emits nothing');
  });

  it('noise: trucks louder than cars, parked silent, decays', () => {
    const car = env({ factories: [], vehicles: [{ x: 0, y: 0, speed: 18, kind: 'car' }] });
    const truck = env({ factories: [], vehicles: [{ x: 0, y: 0, speed: 18, kind: 'truck' }] });
    car.update(2); truck.update(2);
    assert.ok(truck.noiseAt(0, 0) > car.noiseAt(0, 0), 'truck flow noisier');
    const parked = env({ factories: [], vehicles: [{ x: 0, y: 0, speed: 0, kind: 'truck' }] });
    parked.update(2);
    assert.equal(parked.noiseAt(0, 0), 0, 'parked traffic silent');
    assert.ok(noiseFalloff(0) === 1 && noiseFalloff(120) < 0.37, 'exp falloff');
  });

  it('relocation reduces exposure', () => {
    const e = env();
    const before = e.evaluate({ id: 'h', x: 20, y: 0, work: 1, shop: 1 });
    const after = e.evaluate({ id: 'h', x: 400, y: 0, work: 1, shop: 1 });
    assert.ok(after.value > before.value, 'moving away helps');
  });

  it('satisfaction bounds and component weights', () => {
    const e = env({ factories: [] });
    const perfect = e.evaluate({ id: 'h', x: 500, y: 500, work: 1, shop: 1 });
    assert.ok(perfect.value <= 1 && perfect.value >= 0);
    assert.ok(Math.abs(perfect.value - (0.45 + 0.35 + 0.20)) < 1e-9, 'perfect access = 1.0');
    const destitute = e.evaluate({ id: 'h', x: 500, y: 500, work: 0, shop: 0 });
    assert.ok(Math.abs(destitute.value - 0.20) < 1e-9, 'no access still gets clean-env 0.2');
  });

  it('parks cap at 0.1 and cannot fix missing jobs', () => {
    const e = env({ factories: [], parks: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }] });
    const v = e.evaluate({ id: 'h', x: 5, y: 5, work: 0, shop: 0 });
    assert.ok(v.park <= ENV_LIMITS.parkMaxBonus + 1e-9, 'capped at 0.1');
    assert.ok(v.value < 0.5, 'park cannot replace jobs/goods');
  });

  it('EMA smooths with tau 30s; no XP coupling', () => {
    const e = env({ factories: [] });
    const h = { id: 'h', x: 0, y: 0, work: 1, shop: 1 };
    const v1 = e.satisfaction(h, 30);
    // Instant drop in access moves EMA only partway.
    const v2 = e.satisfaction({ ...h, work: 0, shop: 0 }, 30);
    assert.ok(v2.value > 0.20 && v2.value < v1.value, 'EMA lags the step');
    // Environment exposes no XP: satisfaction and XP are separate systems.
    assert.ok(!('xp' in v2), 'no XP field leaks into satisfaction');
  });
});
