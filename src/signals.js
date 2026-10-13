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
