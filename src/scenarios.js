// Reproducible scenarios and objectives — S07.1.
//
// Data-only: {id,version,title,initialSnapshot,objectives,events,seed}.
// Objectives {metric,op,target,windowSeconds} use an allowlist of metrics
// and comparisons; no evaluated code. Events {at,kind,payload} use sim time;
// a Set ledger makes application idempotent. Completion rewards are cosmetic
// (stars) and persist once.
export const SCENARIO_VERSION = 1;

export const ALLOWED_METRICS = [
  'served',         // completed journeys
  'unmetFreight',   // pending freight shipments
  'trips',          // completed vehicle trips
  'level',          // city level
  'satisfaction',   // mean home satisfaction
  'cancelled',      // cancelled journeys
];

export const ALLOWED_OPS = ['>=', '<=', '==', '>', '<'];

export const ALLOWED_EVENT_KINDS = [
  'demand-surge',   // {origin, count}
  'road-closure',   // {edgeId}
  'notice',         // {text}
];

const fail = (reason) => { throw new Error(reason); };

export function checkObjective(objective, state) {
  const { metric, op, target, windowSeconds = 0 } = objective ?? {};
  if (!ALLOWED_METRICS.includes(metric)) fail(`unknown metric: ${metric}`);
  if (!ALLOWED_OPS.includes(op)) fail(`unknown op: ${op}`);
  if (!Number.isFinite(target)) fail(`target must be finite, got ${target}`);
  const value = state[metric];
  if (!Number.isFinite(value)) return { ok: false, value, reason: `no reading for ${metric}` };
  let pass = false;
  switch (op) {
    case '>=': pass = value >= target; break;
    case '<=': pass = value <= target; break;
    case '==': pass = value === target; break;
    case '>': pass = value > target; break;
    case '<': pass = value < target; break;
  }
  if (!pass) return { ok: false, value, reason: `${metric} ${value} does not satisfy ${op} ${target}` };
  // Sustained window: state.since marks when the condition first held.
  if (windowSeconds > 0) {
    const held = (state.time ?? 0) - (state.since ?? state.time ?? 0);
    if (held < windowSeconds) return { ok: false, value, reason: `held ${held}s of ${windowSeconds}s` };
  }
  return { ok: true, value };
}

/** Applies one event if due and not already in the ledger. Pure except ledger. */
export function applyEvent(event, simState, ledger) {
  const { at, kind, payload = {} } = event ?? {};
  if (!Number.isFinite(at)) fail('event needs a finite at time');
  if (!ALLOWED_EVENT_KINDS.includes(kind)) fail(`unknown event kind: ${kind}`);
  const key = `${at}:${kind}:${JSON.stringify(payload)}`;
  if (ledger.has(key)) return { applied: false, key };
  if ((simState.time ?? 0) < at) return { applied: false, key, reason: 'not due' };
  ledger.add(key);
  return { applied: true, key, effect: { kind, payload } };
}

/** Cosmetic completion rewards, granted once per scenario id. */
export function grantRewards(scenario, grantedIds) {
  const key = scenario?.id ?? 'unknown';
  if (grantedIds.has(key)) return { granted: false, rewards: {} };
  grantedIds.add(key);
  return { granted: true, rewards: { ...(scenario?.rewards ?? {}) } };
}

// solution: deterministic reference command list (played by tests/browser).
// maxSimSeconds: sim budget the reference solution is tuned against.
const SCENARIO_FIELDS = new Set(['id', 'version', 'title', 'seed', 'initialSnapshot', 'restrictions', 'objectives', 'events', 'rewards', 'hints', 'solution', 'maxSimSeconds']);

export function validateScenario(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'scenario must be an object' };
  for (const k of Object.keys(raw)) {
    if (!SCENARIO_FIELDS.has(k)) return { ok: false, reason: `unknown field: ${k}` };
  }
  if (typeof raw.id !== 'string' || !raw.id) return { ok: false, reason: 'scenario needs an id' };
  if (raw.version !== SCENARIO_VERSION) return { ok: false, reason: `unsupported version ${raw.version}` };
  if (typeof raw.title !== 'string' || !raw.title) return { ok: false, reason: 'scenario needs a title' };
  if (!Number.isInteger(raw.seed)) return { ok: false, reason: 'scenario needs an integer seed' };
  if (!raw.initialSnapshot || typeof raw.initialSnapshot !== 'object') return { ok: false, reason: 'scenario needs an initialSnapshot' };
  if (!Array.isArray(raw.objectives) || !raw.objectives.length) return { ok: false, reason: 'scenario needs objectives' };
  try {
    for (const o of raw.objectives) checkObjective(o, { served: 0, unmetFreight: 0, trips: 0, level: 1, satisfaction: 1, cancelled: 0, time: 0 });
  } catch (e) {
    return { ok: false, reason: `bad objective: ${e.message}` };
  }
  if (raw.solution !== undefined && !Array.isArray(raw.solution)) return { ok: false, reason: 'solution must be an array' };
  if (raw.maxSimSeconds !== undefined && !Number.isFinite(raw.maxSimSeconds)) return { ok: false, reason: 'maxSimSeconds must be finite' };
  if (!Array.isArray(raw.events)) return { ok: false, reason: 'events must be an array' };
  for (const e of raw.events) {
    if (!ALLOWED_EVENT_KINDS.includes(e?.kind)) return { ok: false, reason: `bad event kind: ${e?.kind}` };
    if (!Number.isFinite(e?.at)) return { ok: false, reason: 'event needs finite at' };
  }
  return { ok: true };
}
