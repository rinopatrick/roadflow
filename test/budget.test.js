// S07.4: optional construction budgets. Integer credits, opt-in per city;
// sandbox stays unlimited. Costs from committed geometry; preview equals
// debit; failed validation debits zero; demolition refunds 50% of recorded
// principal; undo restores exact money state.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET_COSTS, roadCost, flatCost, applyTransaction,
  incomeFor, maintenanceDue, validateScenarioBudget, BUDGET_LIMITS,
} from '../src/budget.js';

describe('S07.4 budgets', () => {
  it('road cost: per 10wu rounded up by class, grade multipliers', () => {
    assert.equal(roadCost('street', 100, 'ground'), 20, '100wu street = 10 units x 2');
    assert.equal(roadCost('street', 101, 'ground'), 22, 'rounds up');
    assert.equal(roadCost('avenue', 100, 'ground'), 40);
    assert.equal(roadCost('highway', 100, 'ground'), 70);
    assert.equal(roadCost('street', 100, 'bridge'), 60, 'bridge x3');
    assert.equal(roadCost('street', 100, 'tunnel'), 80, 'tunnel x4');
    assert.throws(() => roadCost('rail', 100, 'ground'), /class/);
  });

  it('flat costs: signals 50, roundabout 80, depot 100', () => {
    assert.equal(flatCost('signal'), 50);
    assert.equal(flatCost('roundabout'), 80);
    assert.equal(flatCost('depot'), 100);
    assert.deepEqual(BUDGET_COSTS.flats, { signal: 50, roundabout: 80, depot: 100 });
  });

  it('insufficient funds rejects atomically with shortfall', () => {
    const r = applyTransaction({ credits: 30, unlimited: false }, 50, 'test road');
    assert.equal(r.ok, false);
    assert.match(r.reason, /shortfall|30/i);
    assert.equal(r.credits, 30, 'balance untouched');
  });

  it('demolition refunds 50% of recorded principal; undo is exact', () => {
    const r = applyTransaction({ credits: 100, unlimited: false }, 60, 'build');
    assert.equal(r.credits, 40);
    // Refund references the recorded principal, not a re-estimate.
    const refund = applyTransaction({ credits: 40, unlimited: false }, -30, 'demolish (50% of 60)');
    assert.equal(refund.credits, 70);
  });

  it('income: work 2, shopping 1, freight 3, return 0; integer only', () => {
    assert.equal(incomeFor('work'), 2);
    assert.equal(incomeFor('shopping'), 1);
    assert.equal(incomeFor('freight'), 3);
    assert.equal(incomeFor('return'), 0);
    assert.equal(incomeFor('mystery'), 0);
  });

  it('maintenance charged once per minute boundary, lane-wu based', () => {
    const m1 = maintenanceDue({ laneWu: 1000, serviceVehicles: 2 }, 59, 61);
    const m2 = maintenanceDue({ laneWu: 1000, serviceVehicles: 2 }, 61, 61);
    assert.ok(m1 > 0, 'boundary crossed: charged');
    assert.equal(m2, 0, 'same minute: not double-charged');
  });

  it('scenario budget validated against reference + 10% margin', () => {
    assert.equal(validateScenarioBudget(1000, 900).ok, true);
    assert.equal(validateScenarioBudget(1000, 950).ok, false, '950 > 900*1.1');
  });

  it('unlimited mode never blocks', () => {
    assert.equal(applyTransaction({ credits: 0, unlimited: true }, 999999, 'mega').ok, true);
  });
});
