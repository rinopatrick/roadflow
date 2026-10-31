// S07.6: walking paths, crossings, multimodal access. Sidewalks on
// local/arterial only (no motorway; bridge only if enabled; tunnels never).
// Crosswalks only at marked compatible junctions. Speed 1.4wu/s.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WALK, sidewalkFor, crosswalkAllowed, planWalk, WALK_LIMITS,
} from '../src/walking.js';

const edge = (access, grade = 'ground', bridgeWalk = false) => ({ access, grade: { kind: grade }, bridgeWalk });

describe('S07.6 walking', () => {
  it('sidewalks on local/arterial; none on motorway/ring/tunnel', () => {
    assert.equal(sidewalkFor(edge('local')), true);
    assert.equal(sidewalkFor(edge('arterial')), true);
    assert.equal(sidewalkFor(edge('motorway')), false);
    assert.equal(sidewalkFor(edge('local', 'tunnel')), false);
    assert.equal(sidewalkFor(edge('local', 'bridge', false)), false);
    assert.equal(sidewalkFor(edge('local', 'bridge', true)), true);
  });

  it('speed is 1.4wu/s; limits documented', () => {
    assert.equal(WALK.speed, 1.4);
    assert.equal(WALK_LIMITS.walkOnly, 800);
    assert.equal(WALK_LIMITS.transitAccess, 400);
  });

  it('crosswalks only at marked compatible junctions', () => {
    assert.equal(crosswalkAllowed({ marked: true, signal: 'walk' }).ok, true);
    assert.equal(crosswalkAllowed({ marked: false, signal: 'walk' }).ok, false);
    assert.equal(crosswalkAllowed({ marked: true, signal: 'dontwalk' }).ok, false);
  });

  it('walk-only within 800wu; transit access within 400wu; else reason', () => {
    const near = planWalk({ dist: 500, transitDist: 900, crossing: true });
    assert.equal(near.mode, 'walk');
    const bus = planWalk({ dist: 1200, transitDist: 200, crossing: true });
    assert.equal(bus.mode, 'walk-transit-walk');
    const far = planWalk({ dist: 1200, transitDist: 900, crossing: true });
    assert.equal(far.mode, 'car');
    assert.match(far.reason, /too-far/i);
    const blocked = planWalk({ dist: 100, transitDist: 100, crossing: false });
    assert.equal(blocked.mode, 'car');
    assert.match(blocked.reason, /no-crossing/i);
  });

  it('pedestrians cannot cross water/rock/buildings/motorways', () => {
    const bad = planWalk({ dist: 100, transitDist: 100, crossing: true, barrier: 'water' });
    assert.equal(bad.mode, 'car');
    assert.match(bad.reason, /barrier/i);
  });
});
