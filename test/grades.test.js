// S05.1: explicit grade model. node.z in wu (default 0); edge.grade
// {kind, za, zb}; ramps interpolate by normalized arc; crossings connect
// only at equal height; insufficient clearance rejects.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRADE_LEVELS, RAMP_MAX_SLOPE, MIN_CLEARANCE, JUNCTION_Z_TOL,
  gradeHeightAt, validateGrade, crossingsConnect, rampMinLength,
} from '../src/grades.js';

describe('S05.1 grade model', () => {
  it('levels are -12, 0, +12', () => {
    assert.deepEqual(GRADE_LEVELS, [-12, 0, 12]);
  });

  it('ramp of 12wu needs at least 80wu length (slope 0.15)', () => {
    assert.equal(rampMinLength(12), 80);
    assert.equal(RAMP_MAX_SLOPE, 0.15);
  });

  it('ground height is 0, bridge deck flat at +12', () => {
    assert.equal(gradeHeightAt({ kind: 'ground', za: 0, zb: 0 }, 0.5), 0);
    assert.equal(gradeHeightAt({ kind: 'bridge', za: 12, zb: 12 }, 0.3), 12);
    assert.equal(gradeHeightAt({ kind: 'tunnel', za: -12, zb: -12 }, 0.7), -12);
  });

  it('ramp interpolates by normalized arc, both orientations', () => {
    assert.equal(gradeHeightAt({ kind: 'ramp', za: 0, zb: 12 }, 0.5), 6);
    assert.equal(gradeHeightAt({ kind: 'ramp', za: 12, zb: 0 }, 0.25), 9);
    assert.equal(gradeHeightAt({ kind: 'ramp', za: 0, zb: 12 }, 0), 0);
    assert.equal(gradeHeightAt({ kind: 'ramp', za: 0, zb: 12 }, 1), 12);
  });

  it('validateGrade: ground-ground ok, bridge needs abutment levels', () => {
    assert.equal(validateGrade({ kind: 'ground', za: 0, zb: 0 }, 100).ok, true);
    assert.equal(validateGrade({ kind: 'bridge', za: 12, zb: 12 }, 100).ok, true);
    assert.equal(validateGrade({ kind: 'bridge', za: 12, zb: 0 }, 100).ok, false);
    assert.equal(validateGrade({ kind: 'ramp', za: 0, zb: 12 }, 100).ok, true);
    const short = validateGrade({ kind: 'ramp', za: 0, zb: 12 }, 50);
    assert.equal(short.ok, false);
    assert.match(short.reason, /slope|length/i);
  });

  it('crossingsConnect: same grade joins, 12wu apart never, gap 0.5-8 invalid', () => {
    assert.equal(crossingsConnect(0, 0), true);
    assert.equal(crossingsConnect(0, 0.4), true);
    assert.equal(crossingsConnect(0, 12), false);
    assert.equal(crossingsConnect(0, -12), false);
    const mid = crossingsConnect(0, 4, { strict: true });
    assert.equal(mid.ok, false);
    assert.match(mid.reason, /clearance|collision/i);
  });

  it('clearance minimum is 8wu, junction tolerance 0.5wu', () => {
    assert.equal(MIN_CLEARANCE, 8);
    assert.equal(JUNCTION_Z_TOL, 0.5);
  });
});
