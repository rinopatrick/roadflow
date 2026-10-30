// Traffic signal phase authority.
//
// Why this module exists
// ----------------------
// Two defects are fixed here (EVIDENCE E04):
//
//  1. `greenRatio` did not describe a real schedule. After `greenLen` elapsed
//     but before the end of the half-cycle, the selected axis returned "free"
//     (go). A 42% ratio therefore still gave that axis almost the entire
//     half-cycle, and there was no enforced clearance interval at all.
//
//  2. The renderer computed its own phase from a bare `cyclePos < half`
//     comparison, ignoring `greenRatio` and yellow entirely. The dot drawn on
//     the map could disagree with the phase the simulator actually obeyed.
//
// Both the simulator and the renderer now call `getLegacyPhase`, so the map
// cannot show green while the simulation is holding traffic.
//
// Phase layout for one half-cycle (half = cycle / 2):
//
//   |<--- green --->|<-- yellow -->|<---- allRed ---->|
//   0            greenEnd      greenEnd+yellow       half
//
//   green   = half * greenRatio
//   yellow  = min(MAX_YELLOW_SECONDS, (half - green) / 2)
//   allRed  = half - green - yellow
//
// `cycle` is the FULL cycle (both halves). Axis A is green in the first half,
// axis B in the second. The second half repeats the same layout.
//
// With cycle 14 and ratio 0.42: half 7, green 2.94, yellow 2, allRed 2.06.
//
// S04.4 replaces this axis-based model with movement-based signal programs
// (`getSignalState`). This module deliberately keeps the legacy two-axis shape
// so the S01.4 fix is a focused correctness change; the migration in S04.4
// converts these values conservatively rather than discarding them.

/** Shortest green fraction accepted, so a clearance interval always survives. */
export const MIN_GREEN_RATIO = 0.05;

/** Longest green fraction accepted, leaving room for yellow plus all-red. */
export const MAX_GREEN_RATIO = 0.90;

/** Upper bound on the yellow interval, in seconds. */
export const MAX_YELLOW_SECONDS = 2;

/**
 * Bounds for movement-based signal programs (CONTRACTS section 6, S04.4).
 * green >= 3, yellow >= 1, allRed >= 1, complete cycle <= 180 seconds.
 */
export const PROGRAM_LIMITS = {
  green: { min: 3 },
  yellow: { min: 1 },
  allRed: { min: 1 },
  cycle: { max: 180 },
};

/** Ratio used when a light has none configured or it is not a number. */
export const DEFAULT_GREEN_RATIO = 0.42;

/** Normalises an arbitrary time value into `[0, cycle)`. */
function wrap(value, cycle) {
  const m = value % cycle;
  return m < 0 ? m + cycle : m;
}

/**
 * Current phase of a legacy two-axis traffic light.
 *
 * @param {{cycle:number, greenRatio?:number, offset?:number, axis?:'x'|'y'}} light
 * @param {number} simTime simulation seconds
 * @returns {{axis:'x'|'y', state:'green'|'yellow'|'allRed', remaining:number,
 *            cycle:number, half:number, greenDuration:number,
 *            yellowDuration:number, allRedDuration:number}}
 * @throws {RangeError} when `cycle` is missing, non-finite or not positive, or
 *         when `simTime` is not finite. Invalid values are rejected rather than
 *         silently producing a nonsense phase.
 */
export function getLegacyPhase(light, simTime) {
  const cycle = light?.cycle;
  if (!Number.isFinite(cycle) || cycle <= 0) {
    throw new RangeError(`light cycle must be a positive finite number, got ${cycle}`);
  }
  if (!Number.isFinite(simTime)) {
    throw new RangeError(`simTime must be a finite number, got ${simTime}`);
  }

  // A missing or non-numeric ratio falls back to the default; a numeric one is
  // clamped so the clearance interval can never be squeezed out.
  const rawRatio = light.greenRatio;
  const ratio = Number.isFinite(rawRatio)
    ? Math.min(MAX_GREEN_RATIO, Math.max(MIN_GREEN_RATIO, rawRatio))
    : DEFAULT_GREEN_RATIO;

  const half = cycle / 2;
  const greenDuration = half * ratio;
  const yellowDuration = Math.min(MAX_YELLOW_SECONDS, Math.max(0, (half - greenDuration) / 2));
  const allRedDuration = half - greenDuration - yellowDuration;

  const offset = Number.isFinite(light.offset) ? light.offset : 0;
  const pos = wrap(simTime + offset, cycle);
  const firstHalf = pos < half;

  const axisA = light.axis === 'y' ? 'y' : 'x';
  const axis = firstHalf ? axisA : (axisA === 'x' ? 'y' : 'x');
  const inHalf = firstHalf ? pos : pos - half;

  let state;
  let remaining;
  if (inHalf < greenDuration) {
    state = 'green';
    remaining = greenDuration - inHalf;
  } else if (inHalf < greenDuration + yellowDuration) {
    state = 'yellow';
    remaining = greenDuration + yellowDuration - inHalf;
  } else {
    state = 'allRed';
    remaining = half - inHalf;
  }

  return {
    axis,
    state,
    remaining: Math.max(0, remaining),
    cycle,
    half,
    greenDuration,
    yellowDuration,
    allRedDuration,
  };
}

/**
 * Phase evaluated for one specific approach axis.
 *
 * `go` is true only on green. Yellow is reported separately so a vehicle that
 * cannot stop safely may still clear the junction, while a vehicle that can stop
 * must hold.
 *
 * @param {object} light
 * @param {number} simTime
 * @param {'x'|'y'} edgeAxis axis of the road the vehicle is travelling on
 */
export function phaseForAxis(light, simTime, edgeAxis) {
  const phase = getLegacyPhase(light, simTime);
  const isGreen = phase.state === 'green' && phase.axis === edgeAxis;
  const isYellow = phase.state === 'yellow' && phase.axis === edgeAxis;
  return {
    ...phase,
    edgeAxis,
    go: isGreen,
    yellow: isYellow,
    stop: !isGreen,
  };
}

// ------------------------------------------------------- signal programs --
// S04.4 movement-based programs. A program is data:
//   { offset, phases: [{ id, green, yellow, allRed, connectorIds }] }
// Both the renderer and the sim call getSignalState, so the map cannot show
// a green the simulation does not obey (same rule as S01.4 axes).

/** Total cycle length of a program (sum of all phases). */
export function programCycle(program) {
  return (program?.phases ?? []).reduce(
    (n, p) => n + p.green + p.yellow + p.allRed, 0);
}

/**
 * Current phase of a movement-based signal program.
 *
 * @param {{offset:number, phases:Array}} program
 * @param {number} simTime simulation seconds
 * @returns {{phaseId:string, state:'green'|'yellow'|'allRed', remaining:number,
 *            allowedConnectorIds:string[], cycle:number}}
 */
export function getSignalState(program, simTime) {
  if (!program || !Array.isArray(program.phases) || !program.phases.length) {
    throw new RangeError('signal program needs at least one phase');
  }
  if (!Number.isFinite(simTime)) {
    throw new RangeError(`simTime must be a finite number, got ${simTime}`);
  }
  const cycle = programCycle(program);
  if (!(cycle > 0)) throw new RangeError('signal program has zero cycle');
  const offset = Number.isFinite(program.offset) ? program.offset : 0;
  const pos = wrap(simTime + offset, cycle);
  let at = 0;
  for (const p of program.phases) {
    const total = p.green + p.yellow + p.allRed;
    if (pos < at + total) {
      const inPhase = pos - at;
      if (inPhase < p.green) {
        return { phaseId: p.id, state: 'green', remaining: p.green - inPhase, allowedConnectorIds: [...p.connectorIds], cycle };
      }
      if (inPhase < p.green + p.yellow) {
        return { phaseId: p.id, state: 'yellow', remaining: p.green + p.yellow - inPhase, allowedConnectorIds: [], cycle };
      }
      return { phaseId: p.id, state: 'allRed', remaining: total - inPhase, allowedConnectorIds: [], cycle };
    }
    at += total;
  }
  // Floating-point edge: pos == cycle wraps to the first phase.
  const p = program.phases[0];
  return { phaseId: p.id, state: 'green', remaining: p.green, allowedConnectorIds: [...p.connectorIds], cycle };
}

/**
 * Validates a program: durations in range, cycle <= 180, no conflicting
 * protected movements in one phase, no starved movement.
 *
 * @param {object} program
 * @param {Map<string,string[]>} conflicts connectorId -> conflicting ids
 * @param {string[]} [allMovements] every enabled movement; all need a green
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function validateProgram(program, conflicts = new Map(), allMovements = null) {
  const phases = program?.phases;
  if (!Array.isArray(phases) || !phases.length) {
    return { ok: false, reason: 'a program needs at least one phase' };
  }
  let cycle = 0;
  const greenCovered = new Set();
  for (const p of phases) {
    if (!(p.green >= PROGRAM_LIMITS.green.min)) {
      return { ok: false, reason: `phase ${p.id}: green must be >= ${PROGRAM_LIMITS.green.min}s` };
    }
    if (!(p.yellow >= PROGRAM_LIMITS.yellow.min)) {
      return { ok: false, reason: `phase ${p.id}: yellow must be >= ${PROGRAM_LIMITS.yellow.min}s` };
    }
    if (!(p.allRed >= PROGRAM_LIMITS.allRed.min)) {
      return { ok: false, reason: `phase ${p.id}: allRed must be >= ${PROGRAM_LIMITS.allRed.min}s` };
    }
    cycle += p.green + p.yellow + p.allRed;
    const ids = p.connectorIds ?? [];
    for (let i = 0; i < ids.length; i++) {
      greenCovered.add(ids[i]);
      for (let j = i + 1; j < ids.length; j++) {
        const c = conflicts.get(ids[i]) ?? [];
        if (c.includes(ids[j])) {
          return { ok: false, reason: `phase ${p.id}: ${ids[i]} conflicts with ${ids[j]}` };
        }
      }
    }
  }
  if (cycle > PROGRAM_LIMITS.cycle.max) {
    return { ok: false, reason: `cycle ${cycle}s exceeds ${PROGRAM_LIMITS.cycle.max}s` };
  }
  if (Array.isArray(allMovements)) {
    for (const m of allMovements) {
      if (!greenCovered.has(m)) {
        return { ok: false, reason: `movement ${m} starves: no green in the cycle` };
      }
    }
  }
  return { ok: true };
}

/**
 * Migrates a legacy two-axis light into two conservative protected phases:
 * incompatible connector sets are split, never granted simultaneous green.
 * Returns `{program, warnings}`; a cycle change is reported, never silent.
 */
export function migrateLegacyLight(light, movements, conflicts = new Map()) {
  const warnings = [];
  const cycle = Number.isFinite(light?.cycle) ? light.cycle : 14;
  const half = cycle / 2;
  // Conservative: each half keeps >= 3s green + 1s yellow + 1s allRed.
  const green = Math.max(PROGRAM_LIMITS.green.min, half - 2);
  const xConnectors = movements?.xConnectors ?? [];
  const yConnectors = movements?.yConnectors ?? [];
  const program = {
    offset: Number.isFinite(light?.offset) ? light.offset : 0,
    phases: [
      { id: 'legacy-x', green, yellow: 1, allRed: 1, connectorIds: [...xConnectors] },
      { id: 'legacy-y', green, yellow: 1, allRed: 1, connectorIds: [...yConnectors] },
    ],
  };
  const actual = programCycle(program);
  if (Math.abs(actual - cycle) > 1e-9) {
    warnings.push(`cycle adjusted from ${cycle}s to ${actual}s to fit protected phases`);
  }
  const check = validateProgram(program, conflicts);
  if (!check.ok) warnings.push(`migrated program needs review: ${check.reason}`);
  return { program, warnings };
}

/**
 * Green-wave offset assistant: cumulative free-flow travel time mod cycle.
 * Labelled an estimate, never optimal timing (S04.4.6).
 */
export function greenWaveOffset(travelTimes, cycle) {
  const total = travelTimes.reduce((n, t) => n + t, 0);
  return { offset: ((total % cycle) + cycle) % cycle, estimate: true };
}
