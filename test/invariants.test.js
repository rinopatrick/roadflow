// Fixture and invariant tests.
//
// Two jobs:
//  1. Prove the fixture builders and the invariant helpers work.
//  2. Prove the helpers actually FAIL on broken input. A validator that never
//     fails is worse than none, so each helper gets an explicit negative
//     control that deliberately corrupts a copy and asserts the throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  straightWorld, crossWorld, eightCrossingsWorld, ringWorld, serviceWorld,
  loadLegacyV1, routeBetween, mockTerrain,
} from './fixtures/worlds.js';
import {
  assertGraphConsistent, assertVehiclesFinite, assertEconomyConsistent,
} from './helpers/invariants.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { LEVEL_XP, MILESTONES } from '../src/economy.js';

// ---------------------------------------------------------------- fixtures ---

test('straightWorld builds a 600 wu two-way street', () => {
  const { net, eco, traffic, terrain, anchors } = straightWorld();
  assertGraphConsistent(net, 'straightWorld');
  assertEconomyConsistent(eco, net, 'straightWorld');
  assertVehiclesFinite(traffic, 'straightWorld');
  assert.equal(terrain, mockTerrain, 'default terrain is the buildable stub');
  assert.equal(net.edges.size, 1, 'one road segment');
  assert.ok(Math.abs(anchors.length - 600) < 1e-6, `length was ${anchors.length}`);
  assert.ok(anchors.start && anchors.end, 'endpoint anchors resolve');
});

test('crossWorld builds one 4-way junction with four arm anchors', () => {
  const { net, anchors } = crossWorld();
  assertGraphConsistent(net, 'crossWorld');
  assert.ok(anchors.center, 'a 4-way junction exists');
  assert.equal(anchors.center.edges.size, 4, 'centre has four connections');
  assert.equal(anchors.arms.length, 4, 'four arm anchors');
  assert.equal(net.nodes.size, 5, 'four outer nodes plus the centre');
});

test('crossWorld supports rotated variants', () => {
  for (const deg of [0, 30, 45]) {
    const { net, anchors } = crossWorld({ rotationDeg: deg });
    assertGraphConsistent(net, `crossWorld(${deg}deg)`);
    assert.ok(anchors.center, `${deg}deg variant produced a junction`);
    assert.equal(anchors.arms.length, 4, `${deg}deg variant kept four arms`);
    for (const arm of anchors.arms) {
      assert.ok(Math.abs(Math.hypot(arm.outer.x, arm.outer.y) - 300) < 0.5,
        `${deg}deg arm length drifted: ${Math.hypot(arm.outer.x, arm.outer.y)}`);
    }
  }
});

test('ringWorld converts a four-arm junction into a one-way ring', () => {
  const { net, anchors } = ringWorld();
  assertGraphConsistent(net, 'ringWorld');
  assert.ok(anchors.converted, 'roundabout conversion succeeded');
  assert.ok(anchors.ringNodeIds.length >= 4, `ring nodes: ${anchors.ringNodeIds.length}`);
  assert.equal(anchors.ringEdgeIds.length, anchors.ringNodeIds.length, 'ring is closed');

  for (const e of anchors.ringEdges) {
    assert.equal(e.oneway, true, `ring edge ${e.id} must be one-way`);
    assert.equal(e.ring, true, `ring edge ${e.id} must be flagged as ring`);
  }

  const ringNodes = anchors.ringNodeIds.map(id => net.nodes.get(id));
  assert.ok(ringNodes.every(n => n && n.isRing), 'every ring node is flagged');

  // A ring node carries exactly two ring edges (its ring neighbours) plus
  // exactly one arm edge connecting it back to the rest of the network.
  for (const n of ringNodes) {
    const ringDeg = [...n.edges].filter(eid => net.edges.get(eid)?.ring).length;
    const armDeg = [...n.edges].filter(eid => !net.edges.get(eid)?.ring).length;
    assert.equal(ringDeg, 2, `ring node ${n.id} should touch two ring edges, got ${ringDeg}`);
    assert.equal(armDeg, 1, `ring node ${n.id} should touch one arm edge, got ${armDeg}`);
  }

  const outerNodes = [...net.nodes.values()].filter(n => !n.isRing);
  assert.ok(outerNodes.every(n => n.edges.size === 1),
    'each arm outer end is a degree-1 stub after ring conversion');
});

test('serviceWorld places home, shop and factory on a connected street', () => {
  const { net, eco, anchors } = serviceWorld();
  assertGraphConsistent(net, 'serviceWorld');
  assertEconomyConsistent(eco, net, 'serviceWorld');
  assert.ok(anchors.home && anchors.shop && anchors.factory, 'all three buildings placed');
  assert.equal(anchors.home.type, 'house');
  assert.equal(anchors.home.residents, 4, 'house holds four residents');
  assert.equal(eco.population(), 4, 'population counts residents');
  assert.ok(routeBetween(net, anchors.home, anchors.shop), 'home can reach the shop');
  assert.ok(routeBetween(net, anchors.home, anchors.factory), 'home can reach the factory');
  assert.ok(routeBetween(net, anchors.shop, anchors.home), 'shop can reach the home');
});

test('serviceWorld options omit buildings on request', () => {
  const { eco, anchors } = serviceWorld({ factory: false });
  assert.ok(anchors.home && anchors.shop, 'home and shop still placed');
  assert.equal(anchors.factory, null, 'factory skipped');
  assert.equal(eco.buildings.size, 2, 'only two buildings exist');
});

// ----------------------------------------------------- negative controls -----

test('assertGraphConsistent rejects an edge with a missing endpoint', () => {
  const { net } = straightWorld();
  const edge = [...net.edges.values()][0];
  net.nodes.delete(edge.b); // corrupt: endpoint no longer exists
  assert.throws(() => assertGraphConsistent(net, 'corrupt'), /missing endpoint|not listed on node/);
});

test('assertGraphConsistent rejects non-reciprocal membership', () => {
  const { net } = straightWorld();
  const edge = [...net.edges.values()][0];
  net.nodes.get(edge.a).edges.delete(edge.id); // corrupt: node forgot the edge
  assert.throws(() => assertGraphConsistent(net, 'corrupt'), /not listed on node/);
});

test('assertGraphConsistent rejects a zero-length edge', () => {
  const { net } = straightWorld();
  const edge = [...net.edges.values()][0];
  edge.total = 0; // corrupt
  assert.throws(() => assertGraphConsistent(net, 'corrupt'), /positive finite length/);
});

test('assertGraphConsistent rejects non-finite geometry', () => {
  const { net } = straightWorld();
  const edge = [...net.edges.values()][0];
  edge.pts[1] = [NaN, 0]; // corrupt
  assert.throws(() => assertGraphConsistent(net, 'corrupt'), /non-finite/);
});

test('assertVehiclesFinite rejects a non-finite car position', () => {
  const { net, traffic, anchors } = straightWorld();
  const car = traffic.spawn(anchors.start.id, anchors.end.id);
  assert.ok(car, 'fixture spawns a car');
  assertVehiclesFinite(traffic, 'intact');

  car.x = NaN; // corrupt
  assert.throws(() => assertVehiclesFinite(traffic, 'corrupt'), /non-finite x/);
});

test('assertVehiclesFinite rejects negative speed', () => {
  const { traffic, anchors } = straightWorld();
  const car = traffic.spawn(anchors.start.id, anchors.end.id);
  assert.ok(car);
  car.speed = -3; // corrupt
  assert.throws(() => assertVehiclesFinite(traffic, 'corrupt'), /negative speed/);
});

test('assertVehiclesFinite rejects a car driving a deleted edge', () => {
  const { net, traffic, anchors } = straightWorld();
  const car = traffic.spawn(anchors.start.id, anchors.end.id);
  assert.ok(car);
  net.edges.delete(car.currentStep().edgeId); // corrupt
  assert.throws(() => assertVehiclesFinite(traffic, 'corrupt'), /drives missing edge/);
});

test('assertEconomyConsistent rejects negative XP and batch', () => {
  const { net, eco } = serviceWorld();
  assertEconomyConsistent(eco, net, 'intact');

  eco.xp = -1; // corrupt
  assert.throws(() => assertEconomyConsistent(eco, net, 'corrupt'), /xp must be finite and >= 0/);
  eco.xp = 0;

  eco.batch.house = -1; // corrupt
  assert.throws(() => assertEconomyConsistent(eco, net, 'corrupt'), /batch\.house/);
});

test('assertEconomyConsistent rejects a building with a missing access node', () => {
  const { net, eco } = serviceWorld();
  const home = [...eco.buildings.values()].find(b => b.type === 'house');
  net.nodes.delete(home.drivewayNode); // corrupt
  assert.throws(() => assertEconomyConsistent(eco, net, 'corrupt'), /missing access node/);
});

// ------------------------------------------------------- legacy v1 fixture ---

test('legacy v1 fixture loads through the real deserializers and stays coherent', () => {
  const { data, terrain, net, eco } = loadLegacyV1();

  assert.equal(data.v, 1, 'fixture is a v1 payload');
  assert.equal(data.seed, 1, 'fixture records the original map seed');
  assert.equal(terrain.seed, 1, 'terrain rebuilt from the saved seed');

  assertGraphConsistent(net, 'legacy-v1');
  assertEconomyConsistent(eco, net, 'legacy-v1');

  const types = [...eco.buildings.values()].map(b => b.type).sort();
  assert.deepEqual(types, ['factory', 'house', 'shop'], 'house, shop and factory preserved');
  assert.equal(eco.xp, 120, 'XP preserved');
  assert.equal(eco.totalTrips, 3, 'trip count preserved');
});

test('legacy v1 fixture preserves a traffic light and a roundabout', () => {
  const { net } = loadLegacyV1();

  const lights = [...net.nodes.values()].filter(n => n.type === 'light');
  assert.equal(lights.length, 1, `expected one signal, found ${lights.length}`);
  const light = lights[0];
  assert.ok(light.light, 'signal carries a light program');
  assert.equal(light.light.cycle, 14, 'signal cycle preserved');
  assert.equal(light.light.greenRatio, 0.42, 'signal green ratio preserved');

  const ringNodes = [...net.nodes.values()].filter(n => n.isRing);
  const ringEdges = [...net.edges.values()].filter(e => e.ring);
  assert.ok(ringNodes.length >= 4, `roundabout ring nodes: ${ringNodes.length}`);
  assert.equal(ringEdges.length, ringNodes.length, 'ring is closed');
  assert.ok(ringEdges.every(e => e.oneway), 'every ring edge is one-way');
});

test('legacy v1 fixture still routes a house to a shop', () => {
  const { net, eco } = loadLegacyV1();
  const home = [...eco.buildings.values()].find(b => b.type === 'house');
  const shop = [...eco.buildings.values()].find(b => b.type === 'shop');
  const path = routeBetween(net, home, shop);
  assert.ok(path, 'loaded city must remain navigable');
  assert.ok(path.nodes.length >= 2, 'route has at least one edge');
  assert.ok(path.time > 0, `route has positive travel time, got ${path.time}`);
});

// ------------------------------------------------ gap closed by S01.5 ---

test('eightCrossingsWorld resolves all 8 junctions', () => {
  const { net, anchors } = eightCrossingsWorld();
  assertGraphConsistent(net, 'eightCrossingsWorld');
  assert.equal(anchors.verticalXs.length, 8, 'fixture declares eight vertical roads');

  // S00.3 pinned today's value as a CHARACTERIZATION test because the crossing
  // resolver stopped after six iterations. S01.5 replaced that bounded loop with
  // a frontier walk that continues until no crossing remains, so this now
  // asserts the TARGET. GAP-E05-crossings is closed.
  assert.equal(anchors.junctions.length, anchors.expectedJunctionCount,
    `expected ${anchors.expectedJunctionCount} junctions, got ${anchors.junctions.length}`);

  const xs = anchors.junctions.map(n => Math.round(n.x)).sort((a, b) => a - b);
  assert.deepEqual(xs, [0, 100, 200, 300, 400, 500, 600, 700],
    `junctions must sit at each crossing, got ${xs.join(',')}`);
});

// ------------------------------------------------------ level-up threshold ---

test('exactly one level-up is granted at the XP threshold and never twice', () => {
  // No factory: factory pollution would reduce the trip reward below 10 and
  // make the "exactly one trip below threshold" setup inexact.
  const { net, eco, traffic } = serviceWorld({ factory: false });
  assertGraphConsistent(net, 'levelup');
  assert.equal(eco.level, 1, 'starts at level 1');

  // Position XP exactly one served trip below the level-2 threshold.
  // S06.5 milestones: first threshold is 100 cumulative XP.
  const tripReward = 10;
  eco.xp = MILESTONES[0] - tripReward;
  assert.ok(eco.xp < MILESTONES[0], 'starts below the threshold');

  // Run the REAL loop until a journey completes. Not a direct _completeTrip call.
  let ticks = 0;
  const maxTicks = 60 * 300;
  while (eco.totalTrips < 1 && ticks < maxTicks) {
    const dt = 1 / 60;
    eco.update(dt, traffic, (from, to) => traffic.spawn(from, to));
    eco.processReturns(dt, (from, to) => traffic.spawn(from, to));
    traffic.update(dt);
    ticks++;
  }
  assert.equal(eco.totalTrips, 1, `one journey should complete within ${maxTicks} ticks (ran ${ticks})`);
  assert.ok(eco.xp >= MILESTONES[0], `one reward must reach the threshold: xp=${eco.xp}`);

  // First check grants exactly one level.
  const before = { ...eco.batch };
  eco.checkLevelUp();
  assert.equal(eco.level, 2, 'reached level 2');

  // Level 2 grant from economy.js: house +min(2+floor(2/2),8)=+3, shop +1, factory +0.
  assert.equal(eco.batch.house, before.house + 3, 'level 2 grants 3 houses');
  assert.equal(eco.batch.shop, before.shop + 1, 'level 2 grants 1 shop');
  assert.equal(eco.batch.factory, before.factory, 'level 2 grants no factory');

  // Idempotent: repeating the check, and ticking further, must not re-award.
  const awarded = { ...eco.batch };
  eco.checkLevelUp();
  assert.equal(eco.level, 2, 'level did not advance twice from one threshold');
  assert.deepEqual(eco.batch, awarded, 'no second batch award on repeat check');

  for (let i = 0; i < 120; i++) {
    const dt = 1 / 60;
    eco.update(dt, traffic, (from, to) => traffic.spawn(from, to));
    traffic.update(dt);
  }
  eco.checkLevelUp();
  assert.equal(eco.level, 2, 'level stable while XP stays below the next threshold');
  assert.deepEqual(eco.batch, awarded, 'no batch award without a further level-up');
});

// -------------------------------------------------------- world shape -------

test('every fixture exposes the canonical world shape', () => {
  const worlds = {
    straight: straightWorld(),
    cross: crossWorld(),
    eight: eightCrossingsWorld(),
    ring: ringWorld(),
    service: serviceWorld(),
  };
  for (const [name, w] of Object.entries(worlds)) {
    assert.ok(w.net instanceof RoadNetwork, `${name}: net`);
    assert.ok(w.eco && w.traffic && w.terrain, `${name}: eco/traffic/terrain present`);
    assert.equal(w.traffic.net, w.net, `${name}: traffic bound to the same net`);
    assert.equal(w.eco.net, w.net, `${name}: economy bound to the same net`);
    assertGraphConsistent(w.net, name);
    assertEconomyConsistent(w.eco, w.net, name);
    assertVehiclesFinite(w.traffic, name);
  }
});
