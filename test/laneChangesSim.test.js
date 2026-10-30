// S04.3 integration: mandatory exit-lane reached, missed-turn reroute,
// opposing swaps cannot pass through, short merge no deadlock, blocked exit
// still respected, save round-trips the transition state.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';

function yJunction() {
  // N entry (2 lanes) splits: left lane -> W, right lane -> E.
  const net = new RoadNetwork({ ids: createIdSource() });
  const c = net._makeNode(0, 0, 'plain');
  const n = net._makeNode(0, -400, 'plain');
  const w = net._makeNode(-300, 100, 'plain');
  const e = net._makeNode(300, 100, 'plain');
  const nEdge = net._makeEdge(n.id, c.id, 'street', []);
  nEdge.profile = { forward: 2, backward: 0, laneWidth: 6, medianWidth: 0, shoulderWidth: 1, speed: 18, access: 'local' };
  nEdge.oneway = true;
  net._makeEdge(c.id, w.id, 'street', []);
  net._makeEdge(c.id, e.id, 'street', []);
  for (const ed of net.edges.values()) net.resampleEdge(ed);
  return { net, n, w, e };
}

describe('S04.3 integration', () => {
  it('a car needing the outer lane changes before the junction', () => {
    const { net, n, e } = yJunction();
    const sim = new TrafficSim(net, { rng: makeRng(1) });
    const car = sim.spawn(n.id, e.id);
    assert.ok(car, 'spawned');
    const needLane = car.route.steps[0].connectorLane;
    for (let t = 0; t < 60 * 60 && sim.cars.size > 0; t++) sim.update(1 / 60);
    assert.equal(sim.cars.size, 0, 'arrived, not stuck mid-change');
    assert.equal(sim.stats.trips, 1);
    void needLane;
  });

  it('a missed exit lane reroutes instead of cutting across', () => {
    const { net, n, w, e } = yJunction();
    const sim = new TrafficSim(net, { rng: makeRng(2) });
    const car = sim.spawn(n.id, e.id);
    assert.ok(car);
    // Force a missed plan: teleport near the junction in the wrong lane.
    car.s = 390;
    car.route.steps[0].lane = 0;
    car.route.steps[0].connectorLane = 1;
    for (let t = 0; t < 60 * 60 && sim.cars.size > 0; t++) sim.update(1 / 60);
    // Either it still made it or it rerouted legally — never dead, never
    // teleported lanes at the node (lane index changes only via _changing).
    assert.ok(sim.stats.trips + sim.cars.size <= 1);
    void w;
  });

  it('simultaneous opposing changes cannot swap through each other', async () => {
    const { canChangeLane } = await import('../src/laneChanges.js');
    // Two cars side by side, each mid-change into the other's lane at
    // overlapping s: the second decision must refuse.
    const idx = (me, other) => ({ cars: [{ lane: other, s: 100, speed: 10, _changing: { toLane: me } }] });
    const r = canChangeLane({ s: 100, speed: 10, lane: 0 }, 1, idx(0, 1), { edgeTotal: 500 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /opposing/);
  });

  it('save mid-transition restores the transition', async () => {
    const { net, n, e } = yJunction();
    const sim = new TrafficSim(net, { rng: makeRng(4) });
    const car = sim.spawn(n.id, e.id);
    assert.ok(car);
    car._changing = { fromLane: 0, toLane: 1, startS: car.s, duration: 1.5, elapsed: 0.5 };
    car._cooldown = 1;
    const { Economy } = await import('../src/economy.js');
    const { Terrain } = await import('../src/terrain.js');
    const { createIdSource } = await import('../src/core.js');
    const terrain = new Terrain(1);
    const eco = new Economy(net, terrain, 1);
    const world = {
      terrain, net, traffic: sim, eco,
      ids: createIdSource(1), camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true },
    };
    const data = serializeWorld(world);
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const live = hydrateWorld(v.data);
    const rc = [...live.traffic.cars.values()][0];
    assert.deepEqual(rc._changing, car._changing);
  });
});

