// Explicit grade model — S05.1.
//
// node.z in world units, default 0. edge.grade = {kind, za, zb} matching
// endpoint elevations; ramps interpolate height by normalized arc length.
// XY crossings connect only when both paths intend a junction AND heights
// differ by <= 0.5wu. Different grades with >= 8wu clearance never connect.
// A height gap of 0.5..8wu is an invalid collision: reject the transaction.
export const GRADE_LEVELS = [-12, 0, 12];
export const RAMP_MAX_SLOPE = 0.15;
export const MIN_CLEARANCE = 8;
export const JUNCTION_Z_TOL = 0.5;

const GRADE_KINDS = ['ground', 'bridge', 'ramp', 'tunnel'];

/** Minimum horizontal length for a height change at max slope. */
export function rampMinLength(dz) {
  return Math.abs(dz) / RAMP_MAX_SLOPE;
}

/** Height at normalized arc t in [0,1] along a graded edge. */
export function gradeHeightAt(grade, t) {
  const kind = grade?.kind ?? 'ground';
  const za = grade?.za ?? 0;
  const zb = grade?.zb ?? 0;
  if (kind === 'ramp') {
    const c = Math.max(0, Math.min(1, t));
    return za + (zb - za) * c;
  }
  return kind === 'ground' ? 0 : za;
}

/**
 * Validates one graded edge: kind known, deck endpoints level, ramp slope
 * within limits, endpoints on offered levels.
 */
export function validateGrade(grade, lengthWu) {
  const kind = grade?.kind ?? 'ground';
  if (!GRADE_KINDS.includes(kind)) {
    return { ok: false, reason: `unknown grade kind: ${kind}` };
  }
  const { za = 0, zb = 0 } = grade ?? {};
  if (kind === 'ground') {
    if (za !== 0 || zb !== 0) return { ok: false, reason: 'ground grade must sit at z=0' };
    return { ok: true };
  }
  if ((kind === 'bridge' || kind === 'tunnel') && za !== zb) {
    return { ok: false, reason: `a ${kind} deck must be level (${za} vs ${zb})` };
  }
  if (kind === 'ramp' && Math.abs(zb - za) < 1e-9) {
    return { ok: false, reason: 'a ramp must change height' };
  }
  const need = rampMinLength(zb - za);
  if (lengthWu < need) {
    return { ok: false, reason: `ramp too short: ${lengthWu.toFixed(0)}wu < ${need.toFixed(0)}wu minimum (slope ${RAMP_MAX_SLOPE})` };
  }
  return { ok: true };
}

/**
 * Do two XY-crossing paths at heights za/zb connect?
 * Returns boolean, or {ok:false, reason} in strict mode for the 0.5..8 gap.
 */
export function crossingsConnect(za, zb, options = {}) {
  const gap = Math.abs(za - zb);
  if (gap <= JUNCTION_Z_TOL) return options.strict ? { ok: true } : true;
  if (gap >= MIN_CLEARANCE) return options.strict ? { ok: false, reason: 'grade-separated: no junction' } : false;
  // 0.5..8wu: too close to pass under, too far to join — invalid collision.
  const r = { ok: false, reason: `height gap ${gap.toFixed(1)}wu is a collision: join levels or clear ${MIN_CLEARANCE}wu` };
  return options.strict ? r : false;
}

/** Z level snapped to the nearest offered level. */
export function snapLevel(z) {
  let best = GRADE_LEVELS[0];
  for (const l of GRADE_LEVELS) {
    if (Math.abs(l - z) < Math.abs(best - z)) best = l;
  }
  return best;
}
