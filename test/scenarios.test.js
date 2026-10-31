// S07.1: reproducible scenarios and objectives. Data-only schema:
// {id,version,title,initialSnapshot,objectives,events,seed}. Objective
// records {metric,op,target,windowSeconds} use an allowlist; no eval.
// Events {at,kind,payload} use sim time with an idempotent applied ledger.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateScenario, checkObjective, applyEvent, SCENARIO_VERSION,
  ALLOWED_METRICS, ALLOWED_OPS,
} from '../src/scenarios.js';

const state = () => ({ served: 0, unmetFreight: 3, time: 0 });

describe('S07.1 scenarios engine', () => {
  it('rejects unknown metrics and ops, accepts the allowlist', () => {
    assert.throws(() => checkObjective({ metric: 'fun', op: '>=', target: 1 }, state()), /metric/);
    assert.throws(() => checkObjective({ metric: 'served', op: '≈', target: 1 }, state()), /op/);
    for (const m of ALLOWED_METRICS) {
      assert.doesNotThrow(() => checkObjective({ metric: m, op: '>=', target: 0 }, state()));
    }
    for (const op of ALLOWED_OPS) {
      assert.doesNotThrow(() => checkObjective({ metric: 'served', op, target: 0 }, state()));
    }
  });

  it('objective passes only after the sustained window', () => {
    const o = { metric: 'served', op: '>=', target: 20, windowSeconds: 10 };
    assert.equal(checkObjective(o, { served: 25, time: 100, since: 95 }).ok, false, '5s not enough');
    assert.equal(checkObjective(o, { served: 25, time: 100, since: 85 }).ok, true, '15s sustains');
  });

  it('events apply idempotently via the ledger', () => {
    const ledger = new Set();
    const r1 = applyEvent({ at: 60, kind: 'demand-surge', payload: { origin: 'h1' } }, { time: 60 }, ledger);
    assert.equal(r1.applied, true);
    const r2 = applyEvent({ at: 60, kind: 'demand-surge', payload: { origin: 'h1' } }, { time: 120 }, ledger);
    assert.equal(r2.applied, false, 'replay does not duplicate');
  });

  it('unknown event kinds are rejected, not executed', () => {
    assert.throws(() => applyEvent({ at: 1, kind: 'rm -rf', payload: {} }, {}, new Set()), /kind/);
  });

  it('validateScenario enforces the data-only schema', () => {
    const bad = { id: 'x', version: SCENARIO_VERSION };
    assert.equal(validateScenario(bad).ok, false);
    const good = {
      id: 'first-connection', version: SCENARIO_VERSION, title: 'First Connection',
      seed: 7, initialSnapshot: { v: 6 }, restrictions: {},
      objectives: [{ metric: 'served', op: '>=', target: 1, windowSeconds: 0 }],
      events: [],
    };
    assert.equal(validateScenario(good).ok, true);
  });

  it('completion rewards are idempotent and cosmetic-only', async () => {
    const { grantRewards } = await import('../src/scenarios.js');
    const seen = new Set();
    const r1 = grantRewards({ rewards: { stars: 2 } }, seen);
    assert.equal(r1.granted, true);
    assert.deepEqual(r1.rewards, { stars: 2 });
    const r2 = grantRewards({ rewards: { stars: 2 } }, seen);
    assert.equal(r2.granted, false, 'no duplicate injection on reopen');
    const r3 = grantRewards({}, seen);
    assert.deepEqual(r3.rewards, {}, 'missing rewards default empty');
  });
});
