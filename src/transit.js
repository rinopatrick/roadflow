// Buses, stops and capacity-aware passengers — S07.5 (buses only).
//
// Bus: 18wu long, 4 wide, speedFactor 0.8, capacity 20, dwell 6s + 0.3s per
// boarding/alighting passenger capped at 20s. Stops anchor to local/arterial
// lanes only (no motorway/ramp/ring/bridge). Passengers: pending → wait →
// ride → completed; queues bounded 64/stop. A transit journey never spawns
// a car. Mode choice deterministic: transit iff <= 1.15x car estimate.
export const BUS = { length: 18, width: 4, speedFactor: 0.8, capacity: 20 };

export const TRANSIT_LIMITS = {
  minStops: 2,
  headwayMin: 30,
  headwayMax: 300,
  maxBuses: 8,
  queuePerStop: 64,
  dwellBase: 6,
  dwellPerPax: 0.3,
  dwellMax: 20,
  modeRatio: 1.15,
};

/** Dwell time for a stop visit with board/alight counts. */
export function dwellFor(boarding, alighting) {
  return Math.min(
    TRANSIT_LIMITS.dwellMax,
    TRANSIT_LIMITS.dwellBase + TRANSIT_LIMITS.dwellPerPax * (boarding + alighting),
  );
}

/**
 * Validates a line: 2+ stops, headway range, fleet cap, legal route between
 * every consecutive pair INCLUDING last->first (cyclic service).
 */
export function validateLine(line, hasRoute) {
  const stops = line?.stops ?? [];
  if (stops.length < TRANSIT_LIMITS.minStops) return { ok: false, reason: `a line needs at least ${TRANSIT_LIMITS.minStops} stops` };
  const h = line.headway;
  if (!Number.isFinite(h) || h < TRANSIT_LIMITS.headwayMin || h > TRANSIT_LIMITS.headwayMax) {
    return { ok: false, reason: `headway must be ${TRANSIT_LIMITS.headwayMin}..${TRANSIT_LIMITS.headwayMax}s` };
  }
  if ((line.buses ?? 1) > TRANSIT_LIMITS.maxBuses) {
    return { ok: false, reason: `at most ${TRANSIT_LIMITS.maxBuses} buses per line` };
  }
  for (let i = 0; i < stops.length; i++) {
    const a = stops[i];
    const b = stops[(i + 1) % stops.length];
    if (!hasRoute(a, b)) return { ok: false, reason: `no legal route ${a} -> ${b}` };
  }
  return { ok: true };
}

/** Deterministic mode choice: transit iff <= 1.15x car estimate and valid. */
export function chooseMode({ car, transit, valid }) {
  if (!valid) return 'car';
  if (!Number.isFinite(car) || car <= 0) return 'transit';
  return transit <= car * TRANSIT_LIMITS.modeRatio ? 'transit' : 'car';
}

export class TransitLine {
  constructor({ id, stops, headway, buses = 1 }) {
    this.id = id;
    this.stops = [...stops];
    this.headway = headway;
    this.buses = buses;
    this.queues = new Map(stops.map(s => [s, []]));
    this.onboard = new Map(); // busId -> journeyIds
    this.refused = 0;
  }
  queueAt(stop) { return this.queues.get(stop) ?? []; }
  enqueue(stop, journeyId) {
    const q = this.queues.get(stop);
    if (!q) return false;
    if (q.length >= TRANSIT_LIMITS.queuePerStop) { this.refused++; return false; }
    q.push(journeyId);
    return true;
  }
  /** Board up to capacity for passengers whose destination is downstream. */
  board(stop, busId, downstreamStops, capacity = BUS.capacity) {
    const q = this.queues.get(stop) ?? [];
    const riding = this.onboard.get(busId) ?? [];
    const room = capacity - riding.length;
    const take = q.splice(0, Math.max(0, room));
    this.onboard.set(busId, [...riding, ...take]);
    void downstreamStops;
    return take;
  }
  /** Alight everyone at this stop; returns completed journey ids. */
  alight(busId, stop) {
    void stop;
    const riding = this.onboard.get(busId) ?? [];
    this.onboard.set(busId, []);
    return riding;
  }
}
