// Capacity-aware demand — S06.1.
//
// A journey is a data record, independent of the vehicle that serves it:
// {id, kind, origin, destination, state, vehicleId, retries, createdAt,
//  cancelReason}. States: pending → active → completed|cancelled. Dwell/return
// legs are separate journeys so the lifecycle is uniform.
//
// Bounded: at most 16 pending per origin, retry every 2 sim-seconds, expire
// at 300s with a counted reason. Capacity is reserved on admit and released
// on cancel/delete. Unmet demand appears in stats with a reason.
export const DEMAND_LIMITS = {
  maxPendingPerOrigin: 16,
  retrySeconds: 2,
  expireSeconds: 300,
};

const CUSTOMER_CAPACITY = 4; // concurrent shoppers a shop serves

let journeySeq = 1;
export function resetJourneySeq() { journeySeq = 1; }

export class DemandManager {
  /**
   * @param {{buildings:Map, cost:Object}} world cost[fromNode][toNode] or null
   * @param {function} [rng] deterministic tie-breaks
   */
  constructor(world, rng = Math.random) {
    this.world = world;
    this.rng = rng;
    this.journeys = new Map();
    // destinationId -> count of reserved slots (workers or customers)
    this.reservations = new Map();
    this.lastRefusal = null;
    this.cancelled = 0;
    this.reasons = {};
    this.completed = 0;
    this._arriveHandlers = new Map(); // vehicleId -> fn
    this._vehicleJourney = new Map(); // vehicleId -> journeyId
    this._settled = new Set(); // journeyIds already completed
  }

  get(id) { return this.journeys.get(id); }
  reservedAt(destId) { return this.reservations.get(destId) ?? 0; }

  _capacityOf(b) {
    if (!b) return 0;
    if (b.type === 'shop') return CUSTOMER_CAPACITY;
    if (b.type === 'factory') return b.jobs ?? 6;
    return 0;
  }

  _pendingFor(origin) {
    let n = 0;
    for (const j of this.journeys.values()) {
      if (j.origin === origin && j.state === 'pending') n++;
    }
    return n;
  }

  /** Cheapest reachable destination with free capacity, stable ID ties. */
  _choose(kind, originId) {
    const { buildings, cost } = this.world;
    const origin = buildings.get(originId);
    if (!origin) { this.lastRefusal = 'unknown origin'; return null; }
    const wantType = kind === 'shopping' ? 'shop' : 'factory';
    const from = origin.drivewayNode;
    let best = null;
    for (const b of buildings.values()) {
      if (b.type !== wantType || b.id === originId) continue;
      const c = cost[from]?.[b.drivewayNode];
      if (c === undefined || c === null) continue; // no path
      if (this.reservedAt(b.id) >= this._capacityOf(b)) continue; // full
      if (!best || c < best.cost || (c === best.cost && b.id < best.b.id)) {
        best = { b, cost: c };
      }
    }
    return best?.b ?? null;
  }

  request({ kind, origin }) {
    if (this._pendingFor(origin) >= DEMAND_LIMITS.maxPendingPerOrigin) {
      this.lastRefusal = `pending queue at cap (${DEMAND_LIMITS.maxPendingPerOrigin})`;
      return null;
    }
    const dest = this._choose(kind, origin);
    if (!dest) {
      this.lastRefusal = 'no reachable destination with capacity';
      return null;
    }
    const id = `j${journeySeq++}`;
    const j = {
      id, kind, origin, destination: dest.id,
      state: 'pending', vehicleId: null, retries: 0,
      createdAt: 0, cancelReason: null,
    };
    this.journeys.set(id, j);
    this.reservations.set(dest.id, this.reservedAt(dest.id) + 1);
    return j;
  }

  /** Admit pending journeys to vehicles. spawn(fromNode,toNode)->vehicle|null */
  dispatchAll(spawn) {
    const { buildings } = this.world;
    for (const j of this.journeys.values()) {
      if (j.state !== 'pending') continue;
      const o = buildings.get(j.origin);
      const d = buildings.get(j.destination);
      if (!o || !d) { this.cancel(j.id, !o ? 'deletedOrigin' : 'deletedDestination'); continue; }
      const v = this.dispatch ? this.dispatch(j) : spawn(o.drivewayNode, d.drivewayNode);
      if (!v) { j.retries++; continue; }
      j.state = 'active';
      j.vehicleId = v.id;
      this._vehicleJourney.set(v.id, j.id);
    }
  }

  onArrive(vehicleId, fn) { this._arriveHandlers.set(vehicleId, fn); }

  arrive(vehicleId) {
    const jid = this._vehicleJourney.get(vehicleId);
    if (!jid || this._settled.has(jid)) return; // idempotent: no double XP
    const j = this.journeys.get(jid);
    if (!j || j.state !== 'active') return;
    j.state = 'completed';
    this._settled.add(jid);
    this.completed++;
    this.reservations.set(j.destination, Math.max(0, this.reservedAt(j.destination) - 1));
    this._arriveHandlers.get(vehicleId)?.();
  }

  cancel(jid, reason = 'cancelled') {
    const j = this.journeys.get(jid);
    if (!j || j.state === 'completed' || j.state === 'cancelled') return false;
    j.state = 'cancelled';
    j.cancelReason = reason;
    this.cancelled++;
    this.reasons[reason] = (this.reasons[reason] || 0) + 1;
    this.reservations.set(j.destination, Math.max(0, this.reservedAt(j.destination) - 1));
    return true;
  }

  /** Expire journeys older than the limit. Returns expired count. */
  expire(now) {
    let n = 0;
    for (const j of this.journeys.values()) {
      if ((j.state === 'pending' || j.state === 'active')
        && now - j.createdAt > DEMAND_LIMITS.expireSeconds) {
        this.cancel(j.id, 'expired');
        n++;
      }
    }
    return n;
  }

  stats() {
    let pending = 0, active = 0;
    for (const j of this.journeys.values()) {
      if (j.state === 'pending') pending++;
      else if (j.state === 'active') active++;
    }
    return { pending, active, completed: this.completed, cancelled: this.cancelled, reasons: { ...this.reasons } };
  }
}
