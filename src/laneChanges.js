// Safe lane changes — S04.3.
//
// Pure decision logic; TrafficSim owns the per-tick application. A lane change
// record `{fromLane,toLane,startS,duration,elapsed}` occupies BOTH lanes for
// collision checks during the transition. No voluntary change within 25wu of a
// stop line or on a connector/ring. Required exit lane planning starts at
// max(60wu, speed*5s) before the junction; if missed, the car continues legally
// and reroutes instead of cutting across at the last instant.
export const LANE_CHANGE = {
  duration: 1.5,       // seconds for the lateral transition
  cooldown: 3,         // seconds before the next voluntary change
  noChangeNearJunction: 25, // wu before a stop line: no voluntary changes
  minGap: 2.2,         // wu base gap plus vehicle length
  headway: 1.2,        // seconds of time headway
  maxBraking: 7,       // wu/s²: target rear vehicle must not brake harder
  planAheadBase: 60,   // wu minimum planning distance
  planAheadTime: 5,    // seconds of travel for planning distance
};

export const VEHICLE_LENGTH = 7;

/**
 * Pure: can `vehicle` move to `targetLane` right now?
 *
 * @param {{s:number, speed:number, lane:number}} vehicle
 * @param {number} targetLane
 * @param {{cars:Array<{lane:number,s:number,speed:number}>}} index cars on the
 *   same edge+direction (both lanes, for dual occupancy checks)
 * @param {{edgeTotal:number, voluntary?:boolean}} ctx
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function canChangeLane(vehicle, targetLane, index, ctx) {
  if (!Number.isInteger(targetLane) || targetLane < 0) {
    return { ok: false, reason: 'target lane is not a valid lane' };
  }
  if (targetLane === vehicle.lane) {
    return { ok: false, reason: 'already in the target lane' };
  }
  const edgeTotal = ctx?.edgeTotal ?? Infinity;
  const remaining = edgeTotal - vehicle.s;
  // The transition needs room: duration * speed plus a stop margin.
  const needLength = vehicle.speed * LANE_CHANGE.duration + 10;
  if (remaining < needLength) {
    return { ok: false, reason: `not enough remaining length (${remaining.toFixed(1)}wu < ${needLength.toFixed(1)}wu)` };
  }
  if (ctx?.voluntary && remaining < LANE_CHANGE.noChangeNearJunction + needLength) {
    return { ok: false, reason: `no voluntary change within ${LANE_CHANGE.noChangeNearJunction}wu of the stop line` };
  }
  const cars = index?.cars ?? [];
  const minFront = VEHICLE_LENGTH + LANE_CHANGE.minGap;
  // Opposing swaps first: names the real cause before gap coincidences.
  for (const o of cars) {
    if (o.lane !== targetLane) continue;
    if (o._changing && o._changing.toLane === vehicle.lane
      && Math.abs(o.s - vehicle.s) < VEHICLE_LENGTH + LANE_CHANGE.minGap) {
      return { ok: false, reason: 'opposing lane change in progress' };
    }
  }
  for (const o of cars) {
    if (o.lane !== targetLane) continue;
    if (o.s >= vehicle.s) {
      const gapAhead = o.s - vehicle.s - VEHICLE_LENGTH;
      if (gapAhead < minFront) {
        return { ok: false, reason: `front gap too small (${gapAhead.toFixed(1)}wu)` };
      }
      continue;
    }
    if (true) { // o.s < vehicle.s: the follower behind us.
      const gapBehind = vehicle.s - o.s - VEHICLE_LENGTH;
      // A faster rear vehicle closes the gap: reject unless far enough that
      // no hard braking is needed. needHeadway scales with OUR speed (time
      // for us to clear) plus a margin for a faster follower.
      const needHeadway = vehicle.speed * LANE_CHANGE.headway + VEHICLE_LENGTH
        + Math.max(0, o.speed - vehicle.speed) * LANE_CHANGE.headway;
      if (gapBehind < needHeadway) {
        const closing = o.speed - vehicle.speed;
        const needBraking = closing > 0 ? (closing * closing) / (2 * Math.max(gapBehind, 0.1)) : 0;
        if (closing > 0 || needBraking > LANE_CHANGE.maxBraking) {
          return { ok: false, reason: `rear gap forces ${Math.max(needBraking, closing).toFixed(1)}wu/s² braking` };
        }
      }
    }
  }
  return { ok: true };
}

/**
 * Pure: where must the lane change start so the car holds `toLane` at the
 * junction? Returns `{targetLane, startS, missed}`.
 */
export function planExitLane(vehicle, need) {
  const planDist = Math.max(LANE_CHANGE.planAheadBase, need.speed * LANE_CHANGE.planAheadTime);
  const startS = need.edgeTotal - planDist;
  if (vehicle.s > startS) {
    return { targetLane: need.toLane, startS, missed: true };
  }
  return { targetLane: need.toLane, startS, missed: false };
}

/**
 * Lateral position (0..1) through a transition for rendering.
 * Smoothstep so the visual transition eases in and out.
 */
export function changeProgress(elapsed) {
  const t = Math.max(0, Math.min(1, elapsed / LANE_CHANGE.duration));
  return t * t * (3 - 2 * t);
}
