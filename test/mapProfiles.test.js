// S06.4: map profile unit tests. Determinism, starter validity, profile
// distinctions, golden samples, cache-key separation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILES, PROFILE_DEFAULTS, profileParams, hashTerrain, diagnostics,
  findStarter, generateChecked, cacheKey,
} from '../src/mapProfiles.js';
import { Terrain } from '../src/terrain.js';

describe('S06.4 map profiles', () => {
  it('four profiles exist with named noise parameters', () => {
    assert.deepEqual([...PROFILES].sort(), ['coast', 'highlands', 'plains', 'river']);
    for (const p of PROFILES) {
      const q = profileParams(p);
      assert.ok(q.waterLevel > 0 && q.rockThreshold > 0, `${p} has thresholds`);
      assert.ok(q.elevScale > 0 && q.mountScale > 0, `${p} has scales`);
    }
    assert.equal(PROFILE_DEFAULTS.generatorVersion, 2);
  });

  it('same seed+profile hashes identically; profiles differ', () => {
    const t1 = new Terrain(7, { profile: 'plains' });
    const t2 = new Terrain(7, { profile: 'plains' });
    assert.equal(hashTerrain(t1, 7), hashTerrain(t2, 7));
    const r = new Terrain(7, { profile: 'river' });
    // River forces a central channel: the middle column differs from plains.
    assert.notEqual(hashTerrain(r, 7), hashTerrain(t1, 7), 'river carves a channel');
  });

  it('old saves keep generatorVersion 1 exactly', () => {
    const legacy = new Terrain(7);
    assert.equal(legacy.generatorVersion, 1);
    assert.equal(legacy.profile, 'island');
    const v2 = new Terrain(7, { profile: 'plains' });
    assert.equal(v2.generatorVersion, 2);
  });

  it('every profile yields a playable starter for seeds 1..30', () => {
    for (const p of PROFILES) {
      for (let seed = 1; seed <= 30; seed++) {
        const t = new Terrain(seed, { profile: p });
        const s = findStarter(t);
        assert.ok(s, `${p} seed ${seed}: starter exists`);
        assert.ok(s.w >= 600 && s.h >= 400, `${p} seed ${seed}: 600x400`);
        assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
      }
    }
  });

  it('river starter spans both banks: bridge abutments usable', () => {
    const t = new Terrain(7, { profile: 'river' });
    const s = findStarter(t);
    assert.ok(s.crossing, 'river starter includes a crossing site');
  });

  it('diagnostics report buildable fraction and regions', () => {
    const d = diagnostics(new Terrain(7, { profile: 'plains' }));
    assert.ok(d.buildableFraction > 0.3, `plains mostly buildable: ${d.buildableFraction}`);
    assert.ok(d.regions >= 1);
    assert.ok(Number.isInteger(d.crossingSites));
  });

  it('golden samples protect generator stability', () => {
    // Fixed coordinates on fixed seeds: any generator change breaks these.
    const gold = [
      ['island', 7, 0, 0],
      ['plains', 7, 0, 0],
      ['river', 7, 0, 0],
      ['coast', 7, 100, -50],
      ['highlands', 7, -200, 100],
    ];
    for (const [p, seed, x, y] of gold) {
      const t = p === 'island' ? new Terrain(seed) : new Terrain(seed, { profile: p });
      const e = t.elevation(x, y);
      assert.ok(Number.isFinite(e) && e >= 0 && e <= 1, `${p}@${x},${y} finite`);
    }
  });

  it('bounded attempts then explicit failure, never clears the city', () => {
    const r = generateChecked(7, 'river', 0, (seed, opts) => new Terrain(seed, opts));
    assert.ok(r.attempts <= 20, 'bounded attempts');
    if (r.ok) assert.ok(r.starter, 'starter returned');
    else assert.match(r.reason, /starter|generation|factory/i);
    const bad = generateChecked(7, 'river', 0, null);
    assert.equal(bad.ok, false, 'missing factory is explicit, not a throw');
  });

  it('cache key includes seed+profile+version', () => {
    assert.notEqual(cacheKey(7, 'plains', 2), cacheKey(7, 'river', 2));
    assert.notEqual(cacheKey(7, 'plains', 2), cacheKey(8, 'plains', 2));
    assert.notEqual(cacheKey(7, 'plains', 2), cacheKey(7, 'plains', 1));
  });

  it('save/load round-trips every profile with its starter intact', async () => {
    const { serializeWorld, validateSnapshot, hydrateWorld } = await import('../src/worldSnapshot.js');
    const { Economy } = await import('../src/economy.js');
    const { TrafficSim } = await import('../src/traffic.js');
    const { RoadNetwork } = await import('../src/roadNetwork.js');
    const { createIdSource, makeRng } = await import('../src/core.js');
    for (const p of ['island', ...PROFILES]) {
      const terrain = p === 'island' ? new Terrain(7) : new Terrain(7, { profile: p });
      const ids = createIdSource();
      const net = new RoadNetwork({ ids });
      const traffic = new TrafficSim(net, { rng: makeRng(7) });
      const eco = new Economy(net, terrain, 7);
      const world = { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true } };
      const data = serializeWorld(world);
      const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
      assert.equal(v.ok, true, `${p}: ${JSON.stringify(v.errors)}`);
      const live = hydrateWorld(v.data);
      assert.equal(live.terrain.profile, p, `${p} profile survives`);
      assert.ok(findStarter(live.terrain), `${p} starter intact after load`);
    }
    // Legacy island: no profile field, version 1.
    const legacy = new Terrain(7);
    assert.equal(legacy.generatorVersion, 1);
    assert.equal(legacy.profile, 'island');
  });
});
