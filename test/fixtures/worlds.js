// Shared deterministic fixtures for Roadflow tests.
//
// Purpose
// -------
// Tests across stages need the same small, named worlds instead of each file
// inventing its own coordinates. Fixtures expose *semantic anchors* (a junction
// node, a house building, an edge) so assertions never depend on generated IDs,
// which are random in v1 and become counter-based later.
//
// Determinism
// -----------
// Terrain is mocked by default so geometry fixtures do not depend on noise
// output. The legacy save fixture uses a real Terrain because a save stores a
// seed, not terrain data. Economies use a fixed RNG seed.
//
// These builders create worlds only. They assert nothing; assertions live in
// test/invariants.test.js and in the per-stage suites.
import { readFileSync } from 'node:fs';
import { RoadNetwork } from '../../src/roadNetwork.js';
import { Economy } from '../../src/economy.js';
import { TrafficSim } from '../../src/traffic.js';
import { Terrain } from '../../src/terrain.js';
import { findPath } from '../../src/pathfinding.js';

/** Terrain stub: every point is buildable. Keeps geometry tests noise-free. */
export const mockTerrain = {
  seed: 0,
  isBuildable: () => true,
  isRoadable: () => true,
  sample: () => 0,
  elevation: () => 0.5,
};

const FIXTURE_ECO_SEED = 12345;

/** Assemble the canonical world shape used throughout the plan. */
function buildWorld(net, { terrain = mockTerrain, ecoSeed = FIXTURE_ECO_SEED, silent = true } = {}) {
  const eco = new Economy(net, terrain, ecoSeed);
  if (silent) eco.onToast = () => {};
  return { net, eco, traffic: new TrafficSim(net), terrain };
}

/** All nodes with exactly `degree` connected edges, sorted by x then y. */
function junctionsOfDegree(net, degree) {
  return [...net.nodes.values()]
    .filter(n => n.edges.size === degree)
    .sort((a, b) => (a.x - b.x) || (a.y - b.y));
}

/**
 * straightWorld — one 600 wu street, both directions, no junctions.
 * anchors: { start, end, edge, length }
 */
export function straightWorld({ cls = 'street', length = 600 } = {}) {
  const net = new RoadNetwork();
  const res = net.addRoad([[0, 0], [length, 0]], cls);
  const edge = net.edges.get(res.edgeIds[0]);
  return {
    ...buildWorld(net),
    anchors: {
      start: net.nodes.get(edge.a),
      end: net.nodes.get(edge.b),
      edge,
      length: edge.total,
    },
  };
}

/**
 * crossWorld — four arms crossing at the origin, producing one 4-way junction.
 * `rotationDeg` lets later stage suites reuse the same shape at an angle.
 * anchors: { center, east, west, north, south, arms }
 */
export function crossWorld({ armLength = 300, rotationDeg = 0 } = {}) {
  const net = new RoadNetwork();
  const t = rotationDeg * Math.PI / 180;
  const rot = (x, y) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
  const L = armLength;

  net.addRoad([rot(-L, 0), rot(L, 0)], 'street');
  net.addRoad([rot(0, -L), rot(0, L)], 'street');

  const center = junctionsOfDegree(net, 4)[0] ?? null;
  const anchors = { center, arms: [] };
  if (center) {
    for (const eid of center.edges) {
      const e = net.edges.get(eid);
      const otherId = e.a === center.id ? e.b : e.a;
      anchors.arms.push({ edge: e, outer: net.nodes.get(otherId) });
    }
    anchors.arms.sort((p, q) => Math.atan2(p.outer.y, p.outer.x) - Math.atan2(q.outer.y, q.outer.x));
  }
  return { ...buildWorld(net), anchors };
}

/**
 * eightCrossingsWorld — eight parallel verticals crossed by one horizontal road.
 * This is the fixture that exposes the crossing-resolution truncation (E05):
 * the target is 8 junctions, but the current resolver stops early.
 * anchors: { verticalXs, junctions, expectedJunctionCount, horizontal }
 */
export function eightCrossingsWorld() {
  const net = new RoadNetwork();
  const verticalXs = [0, 100, 200, 300, 400, 500, 600, 700];
  for (const x of verticalXs) net.addRoad([[x, -150], [x, 150]], 'street');
  net.addRoad([[-100, 0], [800, 0]], 'street');

  return {
    ...buildWorld(net),
    anchors: {
      verticalXs,
      expectedJunctionCount: verticalXs.length,
      junctions: junctionsOfDegree(net, 4),
    },
  };
}

/**
 * ringWorld — one junction with four asymmetric arms converted to a roundabout.
 * Arms differ in length and angle so the ring is not a symmetric special case.
 * anchors: { center (pre-conversion coords), ringNodeIds, ringEdgeIds, arms, converted }
 */
export function ringWorld() {
  const net = new RoadNetwork();
  const arms = [
    [300, 0],      // long east
    [-200, 80],    // medium west, off-axis
    [50, -260],    // north
    [-150, -180],  // south-west
  ];
  for (const [x, y] of arms) net.addRoad([[0, 0], [x, y]], 'street');

  const junction = junctionsOfDegree(net, 4)[0] ?? null;
  const converted = junction ? net.makeRoundabout(junction.id) : null;
  const ringNodeIds = converted ? converted.ringNodeIds : [];
  const ringEdgeIds = converted ? converted.ringEdgeIds : [];

  return {
    ...buildWorld(net),
    anchors: {
      center: junction ? { x: junction.x, y: junction.y } : null,
      ringNodeIds,
      ringEdgeIds,
      ringEdges: ringEdgeIds.map(id => net.edges.get(id)),
      armOuterIds: [...net.nodes.values()].filter(n => !n.isRing).map(n => n.id),
      converted,
    },
  };
}

/**
 * serviceWorld — one long street with a house, a shop and a factory attached.
 * This is the standard economy/routing fixture.
 * anchors: { road, home, shop, factory }
 */
export function serviceWorld({ house = true, shop = true, factory = true } = {}) {
  const net = new RoadNetwork();
  const res = net.addRoad([[-600, 0], [600, 0]], 'street');
  const world = buildWorld(net);

  const anchors = { road: net.edges.get(res.edgeIds[0]), home: null, shop: null, factory: null };
  if (house) anchors.home = world.eco.place('house', -350, 60);
  if (shop) anchors.shop = world.eco.place('shop', 0, 80);
  if (factory) anchors.factory = world.eco.place('factory', 350, 100);

  return { ...world, anchors };
}

/**
 * Loads the frozen v1 save fixture through the real deserializers.
 * Returns { data, terrain, net, eco } where `data` is the raw v1 payload.
 * Throws if the fixture is missing so a broken checkout fails loudly.
 */
export function loadLegacyV1() {
  const file = new URL('../fixtures/legacy-v1.json', import.meta.url);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const terrain = new Terrain(data.seed);
  const net = RoadNetwork.fromJSON(data.net);
  const eco = Economy.fromJSON(net, terrain, data.eco);
  return { data, terrain, net, eco };
}

/**
 * Convenience: does a route exist between two buildings' access nodes?
 * Used by fixtures tests and later by demand tests.
 */
export function routeBetween(net, fromBuilding, toBuilding) {
  return findPath(net, fromBuilding.drivewayNode, toBuilding.drivewayNode);
}
