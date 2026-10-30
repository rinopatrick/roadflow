// Analytic overlay model (S02.2b).
//
// Every value these functions return is read from something the simulation
// actually computes:
//   - edge._congestion  the per-edge stopped-vehicle EMA (traffic.js)
//   - edge._carCount    vehicles present on the edge (traffic.js)
//   - graph reachability between building access nodes (pathfinding.js)
//
// There is deliberately no pollution or noise layer. No such field exists in
// the simulation, and DESIGN section 5 forbids showing a value the core does not
// compute. S06.3 owns environment/noise and will add its layer with its own
// data. test/layers.test.js asserts that no layer without a data source can be
// added here by accident.
import { clamp01 } from './metrics.js';
import { findPath } from './pathfinding.js';

/** Reachability states a building can be in, as stable strings. */
export const ACCESS_STATE = {
  REACHABLE: 'reachable',
  UNREACHABLE: 'unreachable',
};

/**
 * Traffic severity bands.
 *
 * DESIGN section 1: the traffic overlay is "colour + line thickness + numbers,
 * not red/green alone". Each band therefore carries a tone (for colour and
 * thickness) AND a label (for the number and the legend), so the information
 * survives greyscale and colour blindness.
 */
export const TRAFFIC_BANDS = [
  { level: 0, min: 0.00, label: 'free flowing', tone: 'calm' },
  { level: 1, min: 0.25, label: 'busy', tone: 'busy' },
  { level: 2, min: 0.55, label: 'queueing', tone: 'heavy' },
  { level: 3, min: 0.80, label: 'jammed', tone: 'jammed' },
];

/** The band a congestion share falls into. Non-numeric input is treated as 0. */
export function trafficBand(congestion) {
  const c = clamp01(congestion);
  let band = TRAFFIC_BANDS[0];
  for (const b of TRAFFIC_BANDS) if (c >= b.min) band = b;
  return band;
}

/**
 * The analytic overlays this build can actually show.
 *
 * `dataSource` names the simulated field each one reads. It is asserted by
 * test/layers.test.js, so adding a layer without a real source fails the suite
 * rather than quietly shipping invented values.
 */
export const LAYERS = [
  {
    id: 'traffic',
    label: 'Traffic',
    icon: 'traffic',
    dataSource: 'edge._congestion, edge._carCount',
    legend: TRAFFIC_BANDS.map(b => ({ key: `band-${b.level}`, label: b.label, tone: b.tone })),
  },
  {
    id: 'access',
    label: 'Access',
    icon: 'access',
    dataSource: 'graph reachability between building driveway nodes',
    legend: [
      { key: ACCESS_STATE.REACHABLE, label: 'can reach the road network', tone: 'reachable' },
      { key: ACCESS_STATE.UNREACHABLE, label: 'no route to anything', tone: 'unreachable' },
    ],
  },
  {
    // S05.3: underground alignment. Data source is real grade state:
    // edge.grade.kind + node z. Surface stays normal; tunnels draw muted
    // dashed only in this layer (or when a tunnel edge is selected).
    id: 'underground',
    label: 'Underground',
    icon: 'tunnel',
    dataSource: 'edge.grade.kind, node z',
    legend: [
      { key: 'tunnel', label: 'tunnel bore (-12wu)', tone: 'tunnel' },
      { key: 'ramp', label: 'portal ramp', tone: 'ramp' },
    ],
  },
];

export const LAYER_IDS = LAYERS.map(l => l.id);

/**
 * One analytic overlay at a time (DESIGN section 1). Asking for the overlay
 * that is already showing turns it off, so the control is a real toggle rather
 * than a radio group with no way back to the plain map.
 */
export function nextOverlay(current, id) {
  // `null` is the explicit "no overlay" request; anything else must be a real
  // layer id. A misspelled or future id leaves the current layer alone rather
  // than storing a value no renderer can draw.
  if (id === null) return null;
  if (!LAYER_IDS.includes(id)) return current;
  return current === id ? null : id;
}

/**
 * Per-edge traffic for the overlay, from real simulation state.
 *
 * Edges with no vehicles and no accumulated congestion are omitted rather than
 * drawn as "free flowing", so the overlay highlights where traffic actually is
 * instead of tinting the whole map.
 *
 * @param {import('./roadNetwork.js').RoadNetwork} net
 * @returns {{edgeId:string, congestion:number, cars:number, level:number,
 *            label:string, tone:string}[]}
 */
export function trafficOverlay(net) {
  const out = [];
  if (!net) return out;
  for (const edge of net.edges.values()) {
    const cars = Number.isFinite(edge._carCount) ? edge._carCount : 0;
    const congestion = clamp01(edge._congestion);
    if (cars <= 0 && congestion < TRAFFIC_BANDS[1].min) continue;
    const band = trafficBand(congestion);
    out.push({
      edgeId: edge.id,
      congestion,
      cars,
      level: band.level,
      label: band.label,
      tone: band.tone,
    });
  }
  return out;
}

/**
 * Reachability of every building, from the existing graph.
 *
 * A building is reachable when a road path exists from its driveway node to any
 * other building's driveway node. Two buildings sharing one access point are
 * reachable to each other by definition, which matters because the access node
 * is shared by design (EVIDENCE E15).
 *
 * @param {{net:object, eco:object}} world
 * @returns {Map<string, {state:string, reachableTo:string|null}>}
 */
export function accessOverlay(world) {
  const out = new Map();
  const { net, eco } = world ?? {};
  if (!net || !eco?.buildings) return out;

  const list = [...eco.buildings.values()];
  for (const b of list) {
    let via = null;
    for (const other of list) {
      if (other.id === b.id) continue;
      if (other.drivewayNode === b.drivewayNode
        || findPath(net, b.drivewayNode, other.drivewayNode)) { via = other.id; break; }
    }
    out.set(b.id, {
      state: via ? ACCESS_STATE.REACHABLE : ACCESS_STATE.UNREACHABLE,
      reachableTo: via,
    });
  }
  return out;
}

/** Counts for the legend, so the panel can report real totals. */
export function accessSummary(states) {
  let reachable = 0;
  let unreachable = 0;
  for (const v of states.values()) {
    if (v.state === ACCESS_STATE.REACHABLE) reachable++;
    else unreachable++;
  }
  return { reachable, unreachable, total: reachable + unreachable };
}
