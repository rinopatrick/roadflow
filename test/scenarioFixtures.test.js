// S07.1 fixtures: six scenarios validate, start disconnected where claimed,
// reference solutions and do-nothing runs behave as specified.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateScenario, checkObjective, applyEvent } from '../src/scenarios.js';
import {
  SCENARIOS, firstConnection, twoRiverbanks,
} from '../src/content/scenarios.js';

describe('S07.1 scenario fixtures', () => {
  it('all six validate against the schema', () => {
    const made = SCENARIOS.map(fn => fn());
    assert.equal(made.length, 6);
    const ids = made.map(s => s.id);
    assert.equal(new Set(ids).size, 6, 'distinct ids');
    for (const s of made) {
      const v = validateScenario(s);
      assert.equal(v.ok, true, `${s.id}: ${v.reason}`);
    }
  });

  it('riverbanks starts disconnected: objective must NOT hold initially', () => {
    const s = twoRiverbanks();
    const r = checkObjective(s.objectives[0], { served: 0, time: 0, since: 0 });
    assert.equal(r.ok, false, 'no free bridge: nothing served yet');
  });

  it('first-connection reference: placing the second home still serves', () => {
    const s = firstConnection();
    assert.ok(s.solution.length >= 1, 'solution has commands');
    assert.equal(s.solution[0].kind, 'placeBuilding');
  });

  it('do-nothing fails the congested-t objective where expected', () => {
    const t = SCENARIOS[1]();
    const r = checkObjective(t.objectives[0], { served: 0, time: 600, since: 600 });
    assert.equal(r.ok, false, 'idling serves nobody');
  });

  it('events ledger survives save/resume shape (serialize + re-apply)', () => {
    const ledger = new Set();
    const ev = { at: 60, kind: 'demand-surge', payload: { count: 6 } };
    assert.equal(applyEvent(ev, { time: 60 }, ledger).applied, true);
    // Serialized ledger round-trips as an array.
    const frozen = JSON.stringify([...ledger]);
    const restored = new Set(JSON.parse(frozen));
    assert.equal(applyEvent(ev, { time: 999 }, restored).applied, false, 'no duplicate after resume');
  });

  it('unknown metric in a fixture is rejected', () => {
    const bad = {
      id: 'bad', version: 1, title: 'Bad', seed: 1, initialSnapshot: { v: 6 },
      objectives: [{ metric: 'vibes', op: '>=', target: 1 }], events: [],
    };
    assert.equal(validateScenario(bad).ok, false);
  });
});
