// Optional construction budgets and maintenance — S07.4.
//
// Opt-in per city/scenario; default sandbox is unlimited. Integer credits
// only. Costs from committed geometry (per 10wu rounded up); preview cost
// must equal transaction debit. Failed validation debits zero. Demolition
// refunds 50% of the RECORDED principal. Undo restores exact money state
// (snapshots carry credits, so no second refund). Income per unique served
// request; maintenance per minute boundary. Never deletes the city: bankruptcy
// pauses the challenge, it does not sell roads.
export const BUDGET_COSTS = {
  per10wu: { street: 2, avenue: 4, highway: 7 },
  gradeMultiplier: { ground: 1, ramp: 1, bridge: 3, tunnel: 4 },
  flats: { signal: 50, roundabout: 80, depot: 100 },
};

export const BUDGET_LIMITS = {
  refundRate: 0.5,
  margin: 0.10,
};

export function roadCost(cls, lengthWu, gradeKind = 'ground') {
  const per = BUDGET_COSTS.per10wu[cls];
  if (!Number.isFinite(per)) throw new Error(`unknown road class: ${cls}`);
  const mult = BUDGET_COSTS.gradeMultiplier[gradeKind] ?? 1;
  return Math.ceil(lengthWu / 10) * per * mult;
}

export function flatCost(what) {
  const c = BUDGET_COSTS.flats[what];
  if (!Number.isFinite(c)) throw new Error(`unknown flat cost: ${what}`);
  return c;
}

/** Integer-credit transaction. Negative amount = refund/income. */
export function applyTransaction(budget, amount, label) {
  if (!Number.isInteger(amount)) throw new Error('credits are integers');
  if (budget.unlimited) return { ok: true, credits: budget.credits, label };
  if (amount > 0 && budget.credits < amount) {
    return { ok: false, reason: `insufficient funds for ${label}: shortfall ${amount - budget.credits}`, credits: budget.credits };
  }
  return { ok: true, credits: budget.credits - amount, label };
}

/** Income per unique served request kind. */
export function incomeFor(kind) {
  return { work: 2, shopping: 1, freight: 3, return: 0 }[kind] ?? 0;
}

/**
 * Maintenance due when crossing a minute boundary (once per boundary).
 * laneWu = total lane world-units; serviceVehicles = active response fleet.
 */
export function maintenanceDue(state, lastTick, nowTick) {
  if (Math.floor(nowTick / 60) <= Math.floor(lastTick / 60)) return 0;
  return Math.ceil((state.laneWu ?? 0) / 100) + (state.serviceVehicles ?? 0) * 2;
}

/** Reference solution cost + 10% margin must fit the scenario budget. */
export function validateScenarioBudget(budget, referenceCost) {
  const need = Math.ceil(referenceCost * (1 + BUDGET_LIMITS.margin));
  if (budget < need) {
    return { ok: false, reason: `budget ${budget} cannot cover reference ${referenceCost} + 10% (needs ${need})` };
  }
  return { ok: true, need };
}
