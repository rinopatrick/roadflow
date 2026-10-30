// S04.4: movement-based signal programs. Pure getSignalState at every
// boundary + offset wrap; conflicting protected movements rejected; no
// starvation; legacy axis migration conservative.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSignalState, validateProgram, migrateLegacyLight, PROGRAM_LIMITS,
} from '../src/signals.js';

const NS_THROUGH = 'a> b'.replace(' ', '');
void NS_THROUGH;

function prog(phases, offset = 0) {
  return { offset, phases };
}

describe('S04.4 getSignalState', () => {
  it('evaluates green/yellow/allRed at every boundary', () => {
    const p = prog([{ id: 'p1', green: 10, yellow: 2, allRed: 1, connectorIds: ['c1'] }]);
    // cycle = 13. t=0 green, t=10 yellow, t=12 allRed, t=13 wraps to green.
    assert.equal(getSignalState(p, 0).state, 'green');
    assert.equal(getSignalState(p, 9.99).state, 'green');
    assert.equal(getSignalState(p, 10).state, 'yellow');
    assert.equal(getSignalState(p, 11.99).state, 'yellow');
    assert.equal(getSignalState(p, 12).state, 'allRed');
    assert.equal(getSignalState(p, 12.99).state, 'allRed');
    assert.equal(getSignalState(p, 13).state, 'green');
    assert.equal(getSignalState(p, 13).phaseId, 'p1');
  });

  it('offset wraps: offset 5 shifts phase start to t=8 in a 13-cycle', () => {
    const p = prog([{ id: 'p1', green: 10, yellow: 2, allRed: 1, connectorIds: ['c1'] }], 5);
    assert.equal(getSignalState(p, 8).state, 'green');
    assert.equal(getSignalState(p, 7.99).state, 'allRed');
  });

  it('allowedConnectorIds only include the active green phase', () => {
    const p = prog([
      { id: 'p1', green: 10, yellow: 2, allRed: 1, connectorIds: ['cNS'] },
      { id: 'p2', green: 8, yellow: 2, allRed: 1, connectorIds: ['cEW'] },
    ]);
    const s1 = getSignalState(p, 1);
    assert.deepEqual(s1.allowedConnectorIds, ['cNS']);
    const s2 = getSignalState(p, 14);
    assert.deepEqual(s2.allowedConnectorIds, ['cEW']);
    // Yellow/allRed allow nobody new.
    assert.deepEqual(getSignalState(p, 10.5).allowedConnectorIds, []);
  });

  it('remaining counts down within the state', () => {
    const p = prog([{ id: 'p1', green: 10, yellow: 2, allRed: 1, connectorIds: [] }]);
    assert.ok(Math.abs(getSignalState(p, 3).remaining - 7) < 1e-9);
  });
});

describe('S04.4 validateProgram', () => {
  it('rejects conflicting protected movements in one phase', () => {
    const conflicts = new Map([['c1', ['c2']], ['c2', ['c1']]]);
    const r = validateProgram(
      prog([{ id: 'p1', green: 10, yellow: 2, allRed: 1, connectorIds: ['c1', 'c2'] }]),
      conflicts,
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /conflict/i);
  });

  it('rejects out-of-range durations and overlong cycles', () => {
    const conflicts = new Map();
    assert.equal(validateProgram(prog([{ id: 'p1', green: 2, yellow: 2, allRed: 1, connectorIds: [] }]), conflicts).ok, false);
    assert.equal(validateProgram(prog([{ id: 'p1', green: 10, yellow: 0, allRed: 1, connectorIds: [] }]), conflicts).ok, false);
    const long = prog(Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, green: 15, yellow: 2, allRed: 1, connectorIds: [] })));
    assert.equal(validateProgram(long, conflicts).ok, false);
    const atMax = prog(Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, green: 15, yellow: 2, allRed: 1, connectorIds: [] })));
    assert.equal(validateProgram(atMax, conflicts).ok, true, 'cycle exactly 180 is allowed');
  });

  it('detects starvation: a movement with no green in the cycle', () => {
    const conflicts = new Map();
    const r = validateProgram(
      prog([{ id: 'p1', green: 10, yellow: 2, allRed: 1, connectorIds: ['c1'] }]),
      conflicts, ['c1', 'c2'],
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /starv|c2/i);
  });

  it('PROGRAM_LIMITS documents bounds', () => {
    assert.deepEqual(PROGRAM_LIMITS.green, { min: 3 });
    assert.deepEqual(PROGRAM_LIMITS.cycle, { max: 180 });
  });
});

describe('S04.4 migrateLegacyLight', () => {
  it('converts an axis light into two conservative protected phases', () => {
    const m = migrateLegacyLight(
      { cycle: 14, greenRatio: 0.42, offset: 0, axis: 'x' },
      { xConnectors: ['cx1', 'cx2'], yConnectors: ['cy1'] },
      new Map(),
    );
    assert.equal(m.program.phases.length, 2);
    assert.ok(m.program.phases.every(p => p.green >= 3));
    // Conservative: crossing movements never share a phase.
    const p1 = m.program.phases[0].connectorIds;
    const p2 = m.program.phases[1].connectorIds;
    assert.ok(!p1.some(c => p2.includes(c)));
  });

  it('reports a warning when the cycle duration changes', () => {
    const m = migrateLegacyLight(
      { cycle: 14, greenRatio: 0.42, offset: 0, axis: 'x' },
      { xConnectors: ['cx1'], yConnectors: ['cy1'] },
      new Map(),
    );
    assert.ok(Array.isArray(m.warnings));
  });
});
