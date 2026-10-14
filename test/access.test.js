// Shared building access and placement evaluation (S01.6).
//
// Defects being fixed:
//
//  1. `attachDriveway` stored ONE owner in `node.drivewayFor`, so two buildings
//     sharing an access node overwrote each other. Worse, removing the first
//     building called `detachDriveway`, which cleared the flag and let
//     `_maybeRemoveDrivewayNode` merge the two road halves and DELETE the node
//     while the second building still referenced it. The second building was
//     then permanently disconnected, silently.
//
//     Reachable in normal play: two buildings on OPPOSITE sides of the same road
//     point are 120 wu apart, so the overlap check passes, but both project onto
//     the same spot on the road.
//
//  2. Placement validation was scattered inside `Economy.place`, so the UI could
//     not ask "would this work?" without mutating the world, and could not show
//     the player WHY a placement failed.
//
// Established here:
//  - access-node ownership is a LIST (`node.buildingIds`), not a single field
//  - access-node lifetime is separate from building lifetime
//  - `evaluateBuildingPlacement` is pure and returns `{ok, reason, drivewayTarget}`
//  - `Economy.place` keeps its building-or-null signature for existing callers
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy, BUILDING_DEFS } from '../src/economy.js';
import {
  evaluateBuildingPlacement, ACCESS_MAX_DISTANCE,
} from '../src/access.js';
import { assertGraphConsistent, assertEconomyConsistent } from './helpers/invariants.js';

const mockTerrain = { isBuildable: () => true };

/** 600 wu road with a generous batch, ready for placement. */
function world({ road = [[0, 0], [600, 0]], cls = 'street' } = {}) {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  net.addRoad(road, cls);
  const eco = new Economy(net, mockTerrain, 1);
  eco.onToast = () => {};
  eco.batch = { house: 10, shop: 10, factory: 10 };
  return { ids, net, eco, terrain: mockTerrain };
}

/** Buildings on opposite sides of the same road point. */
function oppositePair(w) {
  const north = w.eco.place('house', 300, 60);
  const south = w.eco.place('shop', 300, -60);
  assert.ok(north && south, 'both buildings placed');
  return { north, south };
}

// ------------------------------------------- shared access node (bug 1) ---

test('two buildings opposite each other can share one access node', () => {
  const w = world();
  const { north, south } = oppositePair(w);

  // Both project onto the same road point, so sharing is expected and fine.
  assert.equal(north.drivewayNode, south.drivewayNode,
    'the fixture must actually share an access node for this test to mean anything');

  const node = w.net.nodes.get(north.drivewayNode);
  assert.ok(node, 'the shared access node exists');
  assert.ok(Array.isArray(node.buildingIds),
    'ownership must be a list, not a single field that can be overwritten');
  assert.deepEqual([...node.buildingIds].sort(), [north.id, south.id].sort(),
    'both buildings must be recorded as owners');
});

test('removing one building leaves the other connected', () => {
  const w = world();
  const { north, south } = oppositePair(w);
  const shared = north.drivewayNode;

  w.eco.remove(north.id);

  assert.ok(w.net.nodes.has(shared),
    'the shared access node must survive while another building still uses it');
  const shop = w.eco.buildings.get(south.id);
  assert.ok(shop, 'the shop still exists');
  assert.ok(w.net.nodes.has(shop.drivewayNode),
    'the shop must still reference a real node (this was the silent corruption)');
  assertGraphConsistent(w.net, 'after removing one of two owners');
  assertEconomyConsistent(w.eco, w.net, 'after removing one of two owners');
});

test('removing both owners releases the access node', () => {
  const w = world();
  const { north, south } = oppositePair(w);
  const shared = north.drivewayNode;

  w.eco.remove(north.id);
  w.eco.remove(south.id);

  // With no owners left, the driveway node should be merged away again.
  assert.ok(!w.net.nodes.has(shared),
    'an unowned driveway node should be cleaned up');
  assertGraphConsistent(w.net, 'after removing both owners');
  assert.equal(w.net.nodes.size, 2, 'back to the two road endpoints');
});

test('a shared access node reports every owner that still exists', () => {
  const w = world();
  const { north, south } = oppositePair(w);
  const shared = north.drivewayNode;

  w.eco.remove(north.id);

  const node = w.net.nodes.get(shared);
  assert.ok(node.buildingIds.includes(south.id), 'the surviving owner is still listed');
  assert.ok(!node.buildingIds.includes(north.id), 'the removed owner is not listed');
});

// ------------------------------------------- placement evaluation (bug 2) ---

test('evaluateBuildingPlacement accepts a valid spot and names the access target', () => {
  const w = world();
  const res = evaluateBuildingPlacement(w, { type: 'house', x: 300, y: 60 });
  assert.equal(res.ok, true, `expected ok, got reason: ${res.reason}`);
  assert.equal(res.reason, null);
  assert.ok(res.drivewayTarget, 'a valid placement reports where the driveway will attach');
  assert.ok(Number.isFinite(res.drivewayTarget.x));
  assert.ok(Number.isFinite(res.drivewayTarget.y));
});

test('evaluation is pure: it does not mutate the world', () => {
  const w = world();
  const before = {
    nodes: w.net.nodes.size,
    edges: w.net.edges.size,
    buildings: w.eco.buildings.size,
    batch: { ...w.eco.batch },
    version: w.net.version,
  };

  evaluateBuildingPlacement(w, { type: 'house', x: 300, y: 60 });
  evaluateBuildingPlacement(w, { type: 'shop', x: 100, y: 60 });
  evaluateBuildingPlacement(w, { type: 'factory', x: 500, y: 200 });

  assert.equal(w.net.nodes.size, before.nodes, 'nodes unchanged');
  assert.equal(w.net.edges.size, before.edges, 'edges unchanged');
  assert.equal(w.eco.buildings.size, before.buildings, 'no building created');
  assert.deepEqual(w.eco.batch, before.batch, 'batch unchanged');
  assert.equal(w.net.version, before.version, 'topology version unchanged');
});

test('evaluation explains a missing stock', () => {
  const w = world();
  w.eco.batch.house = 0;
  const res = evaluateBuildingPlacement(w, { type: 'house', x: 300, y: 60 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /stock|available|left/i, `unhelpful reason: ${res.reason}`);
});

test('evaluation explains unbuildable terrain', () => {
  const w = world();
  const blocked = { isBuildable: () => false };
  const res = evaluateBuildingPlacement({ ...w, terrain: blocked }, { type: 'house', x: 300, y: 60 });
  assert.equal(res.ok, false);
  // The message names what is actually wrong, for a player: water or rock.
  assert.match(res.reason, /water|rock|terrain|buildable/i, `unhelpful reason: ${res.reason}`);
});

test('evaluation explains a building overlap', () => {
  const w = world();
  assert.ok(w.eco.place('house', 300, 60));
  const res = evaluateBuildingPlacement(w, { type: 'shop', x: 305, y: 65 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /overlap|too close|space/i, `unhelpful reason: ${res.reason}`);
});

test('evaluation explains no road within reach', () => {
  const w = world({ road: [[0, 0], [200, 0]] });
  // Far beyond ACCESS_MAX_DISTANCE from the road.
  const res = evaluateBuildingPlacement(w, { type: 'house', x: 900, y: 900 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /road|access|reach/i, `unhelpful reason: ${res.reason}`);
});

test('evaluation rejects non-finite coordinates', () => {
  const w = world();
  for (const [x, y] of [[NaN, 0], [0, NaN], [Infinity, 0]]) {
    const res = evaluateBuildingPlacement(w, { type: 'house', x, y });
    assert.equal(res.ok, false, `(${x},${y}) must be rejected`);
    assert.ok(res.reason, 'a reason is given');
  }
});

test('evaluation rejects an unknown building type', () => {
  const w = world();
  const res = evaluateBuildingPlacement(w, { type: 'stadium', x: 300, y: 60 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /unknown|type/i, `unhelpful reason: ${res.reason}`);
});

test('the access distance limit is documented and enforced', () => {
  assert.ok(Number.isFinite(ACCESS_MAX_DISTANCE) && ACCESS_MAX_DISTANCE > 0,
    `ACCESS_MAX_DISTANCE must be a positive number, got ${ACCESS_MAX_DISTANCE}`);

  const w = world({ road: [[0, 0], [600, 0]] });
  const justInside = evaluateBuildingPlacement(w, {
    type: 'house', x: 300, y: ACCESS_MAX_DISTANCE - 10,
  });
  assert.equal(justInside.ok, true,
    `a building inside the access limit should be allowed (${justInside.reason})`);
});

test('a successful evaluation matches what place actually builds', () => {
  const w = world();
  const res = evaluateBuildingPlacement(w, { type: 'house', x: 300, y: 60 });
  assert.equal(res.ok, true);

  const built = w.eco.place('house', 300, 60);
  assert.ok(built, 'place must succeed where evaluation said it would');
  assert.ok(w.net.nodes.has(built.drivewayNode), 'the access node exists');
});

test('a failed evaluation means place will also refuse', () => {
  const w = world();
  w.eco.batch.house = 0;
  const res = evaluateBuildingPlacement(w, { type: 'house', x: 300, y: 60 });
  assert.equal(res.ok, false);
  assert.equal(w.eco.place('house', 300, 60), null,
    'place must refuse exactly where evaluation said it would');
});

test('place keeps its building-or-null signature for existing callers', () => {
  const w = world();
  const b = w.eco.place('house', 300, 60);
  assert.ok(b && b.id, 'returns the building on success');
  assert.equal(w.eco.place('house', 300, 60), null, 'returns null on failure');
});

// --------------------------------------------- ownership migration (legacy) ---

test('loading a save derives ownership from building records', () => {
  // A v1 save has the singular `drivewayFor` field and no `buildingIds`. After
  // loading, ownership must be reconstructed from the buildings themselves,
  // because `drivewayFor` could already have been overwritten by the old bug.
  const w = world();
  const { north, south } = oppositePair(w);
  const shared = north.drivewayNode;

  const data = { net: w.net.toJSON(), eco: w.eco.toJSON() };
  // Simulate the legacy shape: no buildingIds, only a single drivewayFor.
  for (const n of data.net.nodes) {
    if (n.id === shared) {
      n.buildingIds = undefined;
      n.drivewayFor = south.id; // the overwritten value the old bug produced
    }
  }

  const reloaded = RoadNetwork.fromJSON(data.net);
  const eco2 = Economy.fromJSON(reloaded, mockTerrain, data.eco);

  const node = reloaded.nodes.get(shared);
  assert.ok(node, 'the shared node survives the round trip');
  assert.ok(Array.isArray(node.buildingIds), 'ownership is a list after loading');
  assert.ok(node.buildingIds.includes(north.id),
    'ownership must come from the building records, not the overwritten field');
  assert.ok(node.buildingIds.includes(south.id));
  assert.equal(eco2.buildings.size, 2, 'both buildings restored');
});

test('removing a building after a legacy load still leaves the other connected', () => {
  const w = world();
  const { north, south } = oppositePair(w);
  const shared = north.drivewayNode;

  const data = { net: w.net.toJSON(), eco: w.eco.toJSON() };
  const reloaded = RoadNetwork.fromJSON(data.net);
  const eco2 = Economy.fromJSON(reloaded, mockTerrain, data.eco);

  eco2.remove(north.id);
  assert.ok(reloaded.nodes.has(shared), 'the shared node survives');
  assert.ok(reloaded.nodes.has(eco2.buildings.get(south.id).drivewayNode),
    'the remaining building keeps a real access node');
  assertGraphConsistent(reloaded, 'legacy load then remove');
});

// --------------------------------------------------------- regression guard ---

test('the singular drivewayFor field is no longer authoritative', () => {
  const w = world();
  const { north, south } = oppositePair(w);
  const node = w.net.nodes.get(north.drivewayNode);

  // Whatever `drivewayFor` reports, it must not be the only source of truth.
  assert.ok(Array.isArray(node.buildingIds), 'buildingIds is the authority');
  assert.equal(node.buildingIds.length, 2, 'both owners recorded');
  assert.notEqual(node.drivewayFor, undefined,
    'drivewayFor may remain for legacy reads, but must not gate access');
});

test('building sizes still prevent genuine overlaps', () => {
  const w = world();
  assert.ok(w.eco.place('house', 300, 60));
  // Closer than the combined sizes: must be refused.
  const tooClose = evaluateBuildingPlacement(w, { type: 'house', x: 305, y: 62 });
  assert.equal(tooClose.ok, false, 'overlapping buildings are still rejected');
  assert.ok(BUILDING_DEFS.house.size > 0);
});
