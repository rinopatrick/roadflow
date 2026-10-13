// Diagnoses junction deadlock in a small city.
//
// Usage: node scripts/diagnose-gridlock.mjs [simSeconds]
//
// Why this exists
// ---------------
// The 90-second soak in soak.js builds a four-building city on a closed loop and
// ends with every vehicle stopped and a maximum wait near 70 seconds. Before
// S01.4 the congestion metric was broken (it settled at 0.05 with every vehicle
// stopped), so the HUD reported about 2% and the gridlock was invisible
// (EVIDENCE E03). Once the metric was corrected the same scenario honestly
// reported about 92%.
//
// This script reproduces that scenario headlessly and reports enough detail to
// act on: per-edge congestion, per-vehicle position and wait, and a breakdown of
// why each vehicle is being held.
//
// It also runs the same scenario twice - once with congestion-aware routing and
// once with congestion ignored - to prove whether the deadlock is caused by
// routing decisions or by junction yielding. Both variants currently deadlock
// identically, so the cause is junction yielding, not routing.
//
// Owner of the fix: S04.2 (connector reservations) with the acceptance gate in
// S04.6. Tracked as GAP-loop-gridlock in docs/roadmap/status.json.
import { createIdSource, makeRng } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { cityCongestion } from '../src/metrics.js';

const SIM_SECONDS = Number(process.argv[2] ?? 270);

/** The soak fixture, expressed in world coordinates. */
function buildSoakCity({ ignoreCongestion = false } = {}) {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  // Closed loop: the soak draws this by clicking four corners plus the start.
  net.addRoad([[-250, 30], [150, 30], [150, 210], [-250, 210], [-250, 30]], 'street');

  const eco = new Economy(net, { isBuildable: () => true }, 1);
  eco.onToast = () => {};
  eco.batch = { house: 4, shop: 2, factory: 1 };
  eco.place('house', -150, -30);
  eco.place('house', 50, -30);
  eco.place('shop', 250, 120);
  eco.place('factory', -150, 270);

  const traffic = new TrafficSim(net, { rng: makeRng(1) });

  if (ignoreCongestion) {
    // Reproduce pre-S01.4 routing, where congestion never influenced cost.
    for (const e of net.edges.values()) {
      Object.defineProperty(e, '_congestion', { get: () => 0, set: () => {}, configurable: true });
    }
  }
  return { net, eco, traffic };
}

/** Runs the city and returns a summary plus per-object detail. */
function simulate({ ignoreCongestion = false } = {}) {
  const { net, eco, traffic } = buildSoakCity({ ignoreCongestion });
  const dt = 1 / 60;
  for (let i = 0; i < 60 * SIM_SECONDS; i++) {
    traffic.update(dt);
    eco.update(dt, traffic, (f, t) => traffic.spawn(f, t));
    eco.processReturns(dt, (f, t) => traffic.spawn(f, t));
    eco.checkLevelUp();
  }

  const edges = [...net.edges.values()]
    .filter(e => (e._carCount || 0) > 0 || (e._congestion || 0) > 0.01)
    .map(e => ({
      id: e.id,
      cars: e._carCount || 0,
      congestion: e._congestion || 0,
      length: e.total,
    }));

  const cars = [...traffic.cars.values()].map(c => {
    const st = c.currentStep();
    const edge = st && net.edges.get(st.edgeId);
    const node = st && net.nodes.get(st.to);
    return {
      id: c.id,
      purpose: c.purpose || 'outbound',
      speed: c.speed,
      waiting: c.waiting,
      step: `${c.step}/${c.route.steps.length}`,
      distToEnd: edge ? edge.total - c.s : null,
      nextNodeDegree: node ? node.edges.size : null,
    };
  });

  return {
    net, eco, traffic, edges, cars,
    stopped: cars.filter(c => c.speed < 0.5).length,
    maxWait: cars.length ? Math.max(...cars.map(c => c.waiting)) : 0,
    congestion: cityCongestion(net),
  };
}

function report(label, result) {
  console.log(`\n=== ${label} ===`);
  console.log(`vehicles ${result.cars.length}, stopped ${result.stopped}, `
    + `trips ${result.eco.totalTrips}, city congestion ${(result.congestion * 100).toFixed(1)}%, `
    + `max wait ${result.maxWait.toFixed(1)}s`);
  for (const e of result.edges) {
    console.log(`  edge ${e.id}: cars=${e.cars} congestion=${(e.congestion * 100).toFixed(0)}% len=${e.length.toFixed(0)}`);
  }
  for (const c of result.cars) {
    console.log(`  car ${c.id} ${c.purpose.padEnd(8)} speed=${c.speed.toFixed(2)} `
      + `step=${c.step} distToEnd=${c.distToEnd?.toFixed(1)} nextNodeDegree=${c.nextNodeDegree} `
      + `waiting=${c.waiting.toFixed(1)}s`);
  }
}

const aware = simulate({ ignoreCongestion: false });
const ignoring = simulate({ ignoreCongestion: true });

report('congestion-aware routing (current)', aware);
report('congestion ignored (pre-S01.4 routing)', ignoring);

const verdict = aware.stopped > 0 && ignoring.stopped > 0
  ? 'DEADLOCK IS INDEPENDENT OF ROUTING -> caused by junction yielding, not congestion cost'
  : 'deadlock differs between variants -> routing participates in the cause';
console.log(`\n${verdict}`);

if (aware.stopped > 0) {
  console.error('\nGRIDLOCK PRESENT. See GAP-loop-gridlock in docs/roadmap/status.json.');
  process.exitCode = 1;
}
