// Rush hours, incidents and service vehicles — S07.3.
//
// Rush profile: deterministic multiplier by sim-time phase (1 outside, 1.6 in
// work peaks). Incidents {id,edgeId,lane,startsAt,endsAt,kind}: laneClosure,
// stalledVehicle, demandSurge. Closures block new admission; existing vehicles
// clear or stop at a known point. Service depot + response vehicle: routes to
// the incident access point, clears only on arrival after a 10s service timer.
// Preemption may REQUEST clearance but never violates conflict/all-red safety.
export const RUSH_DEFAULTS = {
  peak: 1.6,
  offPeak: 1.0,
  morning: [7 * 3600, 9 * 3600],
  evening: [16.5 * 3600, 18.5 * 3600],
  dayLength: 24 * 3600,
};

export function rushMultiplier(simTime) {
  const t = ((simTime % RUSH_DEFAULTS.dayLength) + RUSH_DEFAULTS.dayLength) % RUSH_DEFAULTS.dayLength;
  const inWindow = t >= RUSH_DEFAULTS.morning[0] && t < RUSH_DEFAULTS.morning[1]
    || t >= RUSH_DEFAULTS.evening[0] && t < RUSH_DEFAULTS.evening[1];
  return inWindow ? RUSH_DEFAULTS.peak : RUSH_DEFAULTS.offPeak;
}

export const INCIDENT_KINDS = ['laneClosure', 'stalledVehicle', 'demandSurge'];

/**
 * Validates an incident: kind known, finite window, edge+lane exist.
 * laneCount(edgeId) -> number of lanes in the incident direction.
 */
export function validateIncident(inc, laneCount) {
  if (!inc || typeof inc !== 'object') return { ok: false, reason: 'incident must be an object' };
  if (!INCIDENT_KINDS.includes(inc.kind)) return { ok: false, reason: `unknown kind: ${inc.kind}` };
  if (!Number.isFinite(inc.startsAt) || !Number.isFinite(inc.endsAt)) {
    return { ok: false, reason: 'incident needs a finite window' };
  }
  if (inc.endsAt <= inc.startsAt) return { ok: false, reason: 'endsAt must exceed startsAt' };
  const lanes = laneCount(inc.edgeId);
  if (!Number.isInteger(lanes) || lanes <= 0) return { ok: false, reason: `unknown edge: ${inc.edgeId}` };
  if (!Number.isInteger(inc.lane) || inc.lane < 0 || inc.lane >= lanes) {
    return { ok: false, reason: `lane ${inc.lane} does not exist on ${inc.edgeId}` };
  }
  return { ok: true };
}

export class IncidentLog {
  constructor() {
    this.applied = new Map(); // id -> incident
    this.expired = new Set();
    this.cancelled = new Map(); // id -> reason
  }
  apply(inc, now) {
    if (this.applied.has(inc.id) || this.expired.has(inc.id) || this.cancelled.has(inc.id)) return false;
    if (now < inc.startsAt || now > inc.endsAt) return false;
    this.applied.set(inc.id, inc);
    return true;
  }
  expire(now) {
    let n = 0;
    for (const [id, inc] of this.applied) {
      if (now > inc.endsAt) {
        this.applied.delete(id);
        this.expired.add(id);
        n++;
      }
    }
    return n;
  }
  cancel(id, reason) {
    if (!this.applied.has(id)) return false;
    this.applied.delete(id);
    this.cancelled.set(id, reason);
    return true;
  }
  appliedCount() { return this.applied.size; }
  expiredCount() { return this.expired.size; }
  cancelledCount() { return this.cancelled.size; }
  active() { return [...this.applied.values()]; }
}

/**
 * Service dispatch: response vehicle from depot to incident access point.
 * Returns {ok, serviceSeconds:10} only when reachable; the 10s timer runs on
 * arrival, and only then does the incident clear.
 */
export function serviceDispatch(unit, incident, net) {
  const path = net.reachable?.(unit.depot, incident.access);
  if (!path) return { ok: false, reason: `no reachable service path to ${incident.access}` };
  return { ok: true, unitId: unit.id, incidentId: incident.id, serviceSeconds: 10 };
}
