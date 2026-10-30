// S04.1: explicit directional road profiles.
// Per CONTRACTS section 3: edge.profile {forward, backward, laneWidth,
// medianWidth, shoulderWidth, speed, access}. Presets convert to equivalent
// profiles; ring = forward 1 / backward 0; reverse with zero lanes unroutable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROAD_PRESETS, PROFILE_LIMITS,
  profileFor, normaliseProfile, isOneWayProfile,
  lanesAvailable,
} from '../src/roadProfiles.js';

describe('S04.1 lane profiles', () => {
  it('every preset converts to an equivalent profile', () => {
    for (const cls of ['street', 'avenue', 'highway']) {
      const p = profileFor({ cls });
      const preset = ROAD_PRESETS[cls];
      assert.equal(p.forward, preset.forward);
      assert.equal(p.backward, preset.backward);
      assert.equal(p.speed, preset.speed);
      assert.equal(p.access, preset.access);
    }
  });

  it('profile overrides win over the preset, cls stays a label', () => {
    const p = profileFor({ cls: 'street', profile: { forward: 2 } });
    assert.equal(p.forward, 2);
    assert.equal(p.backward, 1); // preset remainder
    assert.equal(p.speed, 14);
  });

  it('a ring edge is forward 1 / backward 0 with no median', () => {
    const p = profileFor({ cls: 'street', ring: true });
    assert.equal(p.forward, 1);
    assert.equal(p.backward, 0);
    assert.equal(p.medianWidth, 0);
  });

  it('explicit oneway flag is honoured', () => {
    assert.equal(isOneWayProfile(profileFor({ cls: 'street' })), false);
    assert.equal(isOneWayProfile(profileFor({ cls: 'street', oneway: true })), true);
    assert.equal(isOneWayProfile(profileFor({ cls: 'street', ring: true })), true);
    const p = profileFor({ cls: 'avenue', oneway: true });
    assert.equal(p.backward, 0);
    assert.equal(p.medianWidth, 0);
  });

  it('lane bounds: 0..4 per direction, total 1..8, no zero-both', () => {
    assert.throws(() => normaliseProfile({ forward: 5, backward: 1 }), /lane/);
    assert.throws(() => normaliseProfile({ forward: 0, backward: 0 }), /lane/);
    assert.throws(() => normaliseProfile({ forward: 4, backward: 5 }), /lane/);
    assert.doesNotThrow(() => normaliseProfile({ forward: 4, backward: 4 }));
    assert.doesNotThrow(() => normaliseProfile({ forward: 1, backward: 0 }));
  });

  it('speed bounds: 1..40', () => {
    assert.throws(() => normaliseProfile({ speed: 0 }), /speed/);
    assert.throws(() => normaliseProfile({ speed: 41 }), /speed/);
    assert.doesNotThrow(() => normaliseProfile({ speed: 1 }));
    assert.doesNotThrow(() => normaliseProfile({ speed: 40 }));
  });

  it('access is local | arterial | motorway', () => {
    assert.throws(() => normaliseProfile({ access: 'hyperloop' }), /access/);
  });

  it('lanesAvailable reports zero-lane directions as unavailable', () => {
    assert.equal(lanesAvailable(profileFor({ cls: 'street', oneway: true }), 1), 1);
    assert.equal(lanesAvailable(profileFor({ cls: 'street', oneway: true }), -1), 0);
    assert.equal(lanesAvailable(profileFor({ cls: 'street' }), -1), 1);
  });

  it('PROFILE_LIMITS documents the bounds', () => {
    assert.deepEqual(PROFILE_LIMITS.lanes, { min: 0, max: 4 });
    assert.deepEqual(PROFILE_LIMITS.total, { min: 1, max: 8 });
    assert.deepEqual(PROFILE_LIMITS.speed, { min: 1, max: 40 });
  });
});
