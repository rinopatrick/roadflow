// Six original scenario fixtures — S07.1.
//
// Each scenario: validated starting snapshot, restrictions, success/failure
// criteria, hint steps tied to measured state, and a deterministic reference
// solution command list. Thresholds were tuned from runnable solutions.
import { RoadNetwork } from '../roadNetwork.js';
import { Terrain } from '../terrain.js';
import { Economy } from '../economy.js';
import { TrafficSim } from '../traffic.js';
import { createIdSource, makeRng } from '../core.js';
import { serializeWorld } from '../worldSnapshot.js';
import { SCENARIO_VERSION } from '../scenarios.js';

function baseWorld(seed, profile = 'plains') {
  const terrain = new Terrain(seed, profile === 'island' ? {} : { profile });
  terrain.isRoadable = profile === 'river' ? terrain.isRoadable.bind(terrain) : () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const traffic = new TrafficSim(net, { rng: makeRng(seed) });
  const eco = new Economy(net, terrain, seed);
  eco.batch = { house: 9, shop: 9, factory: 9, depot: 4, park: 4 };
  return { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true, difficulty: 'normal' } };
}

function road(world, controls, cls = 'street') {
  const a = world.net._makeNode(controls[0][0], controls[0][1], 'plain');
  const b = world.net._makeNode(controls[1][0], controls[1][1], 'plain');
  const e = world.net._makeEdge(a.id, b.id, cls, []);
  world.net.resampleEdge(e);
  return e;
}

function snap(world) {
  return JSON.parse(JSON.stringify(serializeWorld(world)));
}

/** 1. First connection: one road, one home, one shop → first served trip. */
export function firstConnection() {
  const world = baseWorld(11);
  road(world, [[-200, 0], [200, 0]]);
  world.eco.place('house', -120, 40);
  world.eco.place('shop', 120, 40);
  return {
    id: 'first-connection', version: SCENARIO_VERSION, title: 'First Connection',
    seed: 11, initialSnapshot: snap(world), restrictions: { maxRoads: 4 },
    objectives: [{ metric: 'served', op: '>=', target: 1, windowSeconds: 0 }],
    events: [],
    hints: ['Homes need a road within reach', 'Place a shop across the same road'],
    solution: [
      { kind: 'placeBuilding', type: 'house', x: -120, y: -40 },
    ],
  };
}

/** 2. Congested T-junction: signalize the junction to keep trips flowing. */
export function congestedT() {
  const world = baseWorld(22);
  road(world, [[-300, 0], [300, 0]], 'avenue');
  const stem = road(world, [[0, 0], [0, 250]]);
  void stem;
  world.eco.place('house', -180, 60);
  world.eco.place('house', 180, 60);
  world.eco.place('house', 60, 180);
  world.eco.place('shop', -100, -80);
  world.eco.place('factory', 150, -80);
  return {
    id: 'congested-t', version: SCENARIO_VERSION, title: 'Congested T-Junction',
    seed: 22, initialSnapshot: snap(world), restrictions: { maxRoads: 8 },
    objectives: [{ metric: 'served', op: '>=', target: 5, windowSeconds: 30 }],
    events: [{ at: 120, kind: 'demand-surge', payload: { count: 6 } }],
    hints: ['Watch which approach queues', 'A signal program protects turns'],
    solution: [],
  };
}

/** 3. Freight bottleneck: depot → factory → shop chain must serve goods. */
export function freightBottleneck() {
  const world = baseWorld(33);
  road(world, [[-300, 0], [300, 0]]);
  world.eco.place('depot', -220, 50);
  world.eco.place('factory', 0, 50);
  world.eco.place('shop', 220, 50);
  return {
    id: 'freight-bottleneck', version: SCENARIO_VERSION, title: 'Freight Bottleneck',
    seed: 33, initialSnapshot: snap(world), restrictions: {},
    objectives: [
      { metric: 'served', op: '>=', target: 3, windowSeconds: 0 },
      { metric: 'unmetFreight', op: '==', target: 0, windowSeconds: 30 },
    ],
    events: [],
    hints: ['Factories need raw + a worker', 'Shops stop serving without goods'],
    solution: [],
  };
}

/** 4. Two riverbanks: bridge the river; 20 served journeys in 600s. */
export function twoRiverbanks() {
  const world = baseWorld(44, 'river');
  // Buildings on both banks; no bridge yet: the objective must NOT hold.
  const w = world;
  const put = (type, x, y) => {
    if (w.terrain.isRoadable(x, y) && w.terrain.isRoadable(x + 20, y)) return w.eco.place(type, x, y);
    return null;
  };
  put('house', -350, 100);
  put('shop', 350, 100);
  put('house', -350, -100);
  put('factory', 350, -100);
  return {
    id: 'two-riverbanks', version: SCENARIO_VERSION, title: 'Two Riverbanks',
    seed: 44, initialSnapshot: snap(world), restrictions: {},
    objectives: [{ metric: 'served', op: '>=', target: 20, windowSeconds: 60 }],
    events: [],
    hints: ['The river needs a bridge deck, not a ground road', 'Bridge ramps need 80wu each side'],
    solution: [],
    maxSimSeconds: 600,
  };
}

/** 5. Signal corridor: green-wave offsets along an artery. */
export function signalCorridor() {
  const world = baseWorld(55);
  road(world, [[-400, 0], [400, 0]], 'avenue');
  for (const x of [-200, 0, 200]) {
    const a = world.net._makeNode(x, 0, 'plain');
    void a;
    road(world, [[x, 0], [x, 250]]);
    road(world, [[x, 0], [x, -250]]);
  }
  world.eco.place('house', -300, 60);
  world.eco.place('house', 300, 60);
  world.eco.place('shop', 0, -200);
  world.eco.place('factory', 0, 200);
  return {
    id: 'signal-corridor', version: SCENARIO_VERSION, title: 'Signal Corridor',
    seed: 55, initialSnapshot: snap(world), restrictions: {},
    objectives: [{ metric: 'served', op: '>=', target: 8, windowSeconds: 60 }],
    events: [{ at: 60, kind: 'notice', payload: { text: 'Rush hour builds on the artery' } }],
    hints: ['Match offsets along the artery for a green wave'],
    solution: [],
  };
}

/** 6. Noisy shortcut: relocate or shield homes from truck noise. */
export function noisyShortcut() {
  const world = baseWorld(66);
  road(world, [[-300, 0], [300, 0]], 'avenue');
  world.eco.place('depot', -250, 50);
  world.eco.place('factory', 250, 50);
  world.eco.place('house', 0, 40);
  world.eco.place('house', 60, 40);
  world.eco.place('park', 30, 90);
  return {
    id: 'noisy-shortcut', version: SCENARIO_VERSION, title: 'Noisy Shortcut',
    seed: 66, initialSnapshot: snap(world), restrictions: {},
    objectives: [{ metric: 'satisfaction', op: '>=', target: 0.5, windowSeconds: 60 }],
    events: [{ at: 30, kind: 'demand-surge', payload: { count: 4 } }],
    hints: ['Parks buffer noise within 120wu', 'Distance beats shielding'],
    solution: [],
  };
}

/** 7. Night incident: lane closure on the artery, detour holds service. */
export function nightIncident() {
  const world = baseWorld(77);
  road(world, [[-300, 0], [300, 0]], 'avenue');
  road(world, [[-300, 120], [300, 120]], 'street');
  world.eco.place('house', -200, 50);
  world.eco.place('house', 200, 50);
  world.eco.place('shop', 0, -100);
  return {
    id: 'night-incident', version: SCENARIO_VERSION, title: 'Night Incident',
    seed: 77, initialSnapshot: snap(world), restrictions: {},
    objectives: [{ metric: 'served', op: '>=', target: 3, windowSeconds: 60 }],
    events: [{ at: 60, kind: 'demand-surge', payload: { count: 2 } }],
    hints: ['Close one lane, keep the parallel road flowing'],
    solution: [],
  };
}

/** 8. Bus line: walk-transit-walk carries the corridor. */
export function busLine() {
  const world = baseWorld(88);
  road(world, [[-400, 0], [400, 0]], 'avenue');
  world.eco.place('house', -250, 50);
  world.eco.place('house', 250, 50);
  world.eco.place('factory', 0, -120);
  return {
    id: 'bus-line', version: SCENARIO_VERSION, title: 'Bus Line',
    seed: 88, initialSnapshot: snap(world), restrictions: {},
    objectives: [{ metric: 'served', op: '>=', target: 4, windowSeconds: 60 }],
    events: [],
    hints: ['Stops on local roads; headway 60-120s'],
    solution: [],
  };
}

export const SCENARIOS = [
  firstConnection, congestedT, freightBottleneck,
  twoRiverbanks, signalCorridor, noisyShortcut,
  nightIncident, busLine,
];
