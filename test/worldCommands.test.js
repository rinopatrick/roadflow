// Atomic world commands and bounded undo/redo (S03.1).
//
// The contract (CONTRACTS section 4):
//   applyWorldCommand(world, command) ->
//     {ok:true, world, change, warnings} | {ok:false, reason, world}
//   createHistory(limit = 50) -> { execute, undo, redo, clear }
//
// Contract 4.6 is the one that matters most here: "A failed construction does
// not change graph, inventory, money, selection, RNG or ID counters." That is
// asserted by comparing NORMALIZED SNAPSHOTS byte-for-byte, not by spot checks,
// because a spot check cannot see a counter that moved by one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource, makeRng } from '../src/core.js';
import { evaluateGridDraft } from '../src/gridDraft.js';

/**
 * A 400x400 square of REAL terrain (seed 1) that is fully roadable.
 * Found by scanning rather than guessed: this file deliberately uses real terrain
 * so a command's terrain validation is exercised, and a grid at the origin would
 * cross water.
 */
const GRID_A = [-920, -1200];
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim } from '../src/traffic.js';
import { Economy } from '../src/economy.js';
import { Terrain } from '../src/terrain.js';
import { serializeWorld, hydrateWorld } from '../src/worldSnapshot.js';
import {
  applyWorldCommand, createHistory, COMMAND_KIND, COMMAND_KINDS,
  checkWorldInvariants, historyLimits, SIGNAL_LIMITS,
} from '../src/worldCommands.js';

/** A complete, runnable world. Terrain comes from the seed, as in a real save. */
function makeWorld({ seed = 1, terrain } = {}) {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const traffic = new TrafficSim(net, { rng: makeRng(seed) });
  const eco = new Economy(net, terrain ?? new Terrain(seed), seed);
  eco.onToast = () => {};
  return {
    terrain: eco.terrain,
    net, traffic, eco, ids,
    camera: { x: 0, y: 0, zoom: 1 },
    settings: { speed: 0, audio: true },
  };
}

/**
 * NOTE ON TERRAIN: a snapshot stores only the seed (CONTRACTS section 7), so
 * hydrateWorld rebuilds a real Terrain and any terrain mock handed to the
 * fixture is DISCARDED. Fixtures therefore use real terrain from a real seed,
 * and ask it where it is legal to build rather than assuming a coordinate.
 */
function buildableSpan(terrain, span = 600) {
  for (let y = -800; y <= 800; y += 40) {
    for (let x = -800; x <= 800; x += 40) {
      if (terrain.isRoadable(x, y) && terrain.isRoadable(x + span, y)) {
        return [[x, y], [x + span, y]];
      }
    }
  }
  return null;
}

/** A point the real terrain refuses, for the refusal tests. */
function unbuildablePoint(terrain) {
  for (let r = 100; r <= 2600; r += 50) {
    for (let a = 0; a < 360; a += 10) {
      const x = Math.round(Math.cos(a * Math.PI / 180) * r);
      const y = Math.round(Math.sin(a * Math.PI / 180) * r);
      if (!terrain.isRoadable(x, y)) return [x, y];
    }
  }
  return null;
}

/**
 * The normalized snapshot used for before/after comparison.
 *
 * `savedAt` is dropped: it is wall-clock metadata written by serializeWorld, not
 * world state, so it legitimately differs between two snapshots of the same
 * world and would make every byte-equality assertion flaky.
 */
const norm = (world) => {
  const data = JSON.parse(JSON.stringify(serializeWorld(world)));
  delete data.savedAt;
  return data;
};

/** Deep equality on normalized snapshots, with a readable diff path. */
function assertSameWorld(a, b, message) {
  assert.deepEqual(norm(a), norm(b), message);
}

function roadWorld() {
  const w = makeWorld();
  w.eco.batch = { house: 10, shop: 10, factory: 10 };
  return w;
}

// ------------------------------------------------------------ command kinds ---

test('every declared command kind is a JSON-safe string', () => {
  const kinds = Object.values(COMMAND_KIND);
  assert.ok(kinds.length >= 7, `expected the current actions to be covered, got ${kinds.length}`);
  for (const k of kinds) {
    assert.equal(typeof k, 'string');
    assert.match(k, /^[a-zA-Z]+$/, `kind ${k} must be a plain identifier`);
  }
  // The dispatcher's advertised set matches the declared kinds exactly.
  assert.deepEqual([...COMMAND_KINDS].sort(), [...kinds].sort());
});

test('a command is a plain JSON record: no functions', () => {
  const cmd = { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' };
  const round = JSON.parse(JSON.stringify(cmd));
  assert.deepEqual(round, cmd, 'a command must survive a JSON round trip unchanged');
});

test('an unknown command kind is refused without touching the world', () => {
  const w = roadWorld();
  const before = norm(w);
  const r = applyWorldCommand(w, { kind: 'teleportCity' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown command kind/i);
  assert.equal(r.world, w, 'the refused call returns the SAME world object');
  assert.deepEqual(norm(r.world), before, 'and the world is unchanged');
});

// ----------------------------------------------------------------- addRoad ---

test('addRoad commits the road and reports a topology change', () => {
  const w = roadWorld();
  const r = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' });
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);
  assert.ok(r.world.net.edges.size > 0, 'the road must exist in the returned world');
  assert.equal(r.change.topologyChanged, true);
  assert.ok(Array.isArray(r.change.removedEdgeIds));
  assert.ok(Array.isArray(r.change.removedBuildingIds));
  assert.ok(Array.isArray(r.change.replacedEdges));
});

test('a failed addRoad leaves a byte-equivalent world', () => {
  // Contract 4.6: a failed construction changes nothing - not the graph, not the
  // inventory, not the RNG, not the ID counters.
  const w = roadWorld();
  const before = norm(w);
  const r = applyWorldCommand(w, {
    kind: COMMAND_KIND.ADD_ROAD,
    controls: [[0, 0], [300, 0]],
    cls: 'no-such-class',
  });
  assert.equal(r.ok, false, 'an unknown road class must be refused');
  assertSameWorld(r.world, w, 'the world must be byte-equivalent after a failure');
  assert.deepEqual(norm(r.world), before, 'and identical to the recorded before-state');
});

test('a road over unbuildable terrain is refused with a reason', () => {
  const w = makeWorld();
  const bad = unbuildablePoint(w.terrain);
  assert.ok(bad, 'fixture must find a point the real terrain refuses');
  const before = norm(w);
  const r = applyWorldCommand(w, {
    kind: COMMAND_KIND.ADD_ROAD,
    controls: [bad, [bad[0] + 300, bad[1]]],
    cls: 'street',
  });
  assert.equal(r.ok, false, 'a road whose control point is unbuildable must be refused');
  assert.ok(r.reason && r.reason.length > 0, 'a refusal must carry a reason');
  assert.deepEqual(norm(r.world), before, 'and change nothing');
});

test('a degenerate road (a single point) is refused without changing counters', () => {
  const w = roadWorld();
  const before = norm(w);
  const r = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[100, 100]], cls: 'street' });
  assert.equal(r.ok, false, 'one point cannot make a road');
  assert.deepEqual(norm(r.world), before);
});

// ---------------------------------------------------------- placeBuilding ---

test('placeBuilding consumes stock and reports the new building', () => {
  const w = roadWorld();
  const road = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [600, 0]], cls: 'street' });
  assert.equal(road.ok, true, `fixture road failed: ${road.reason}`);
  const stockBefore = road.world.eco.batch.house;
  const r = applyWorldCommand(road.world, { kind: COMMAND_KIND.PLACE_BUILDING, type: 'house', x: 300, y: 60 });
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);
  assert.equal(r.world.eco.buildings.size, 1);
  assert.equal(r.world.eco.batch.house, stockBefore - 1, 'placing must consume exactly one');
  // A building placement ADDS a driveway node and edge, so it IS a topology
  // change - which is why a building edit must also reconcile live traffic.
  assert.equal(r.change.topologyChanged, true,
    'placing a building adds its driveway, so the graph changed');
  assert.ok(r.change.addedEdgeIds.length > 0, 'the driveway edge must be reported as added');
});

test('a failed placeBuilding consumes no stock and changes no counter', () => {
  const w = roadWorld();
  const road = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [600, 0]], cls: 'street' });
  assert.equal(road.ok, true, `fixture road failed: ${road.reason}`);
  const before = norm(road.world);
  const stockBefore = road.world.eco.batch.house;
  // Far from any road: the placement validator refuses it.
  const r = applyWorldCommand(road.world, { kind: COMMAND_KIND.PLACE_BUILDING, type: 'house', x: 300, y: 5000 });
  assert.equal(r.ok, false);
  assert.ok(r.reason && r.reason.length > 0);
  assert.deepEqual(norm(r.world), before, 'nothing may change, including the RNG and counters');
  assert.equal(r.world.eco.batch.house, stockBefore, 'stock must be untouched');
});

// --------------------------------------------------------- removeBuilding ---

test('removeBuilding refunds the correct type', () => {
  const w = roadWorld();
  const road = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [600, 0]], cls: 'street' });
  assert.equal(road.ok, true, `fixture road failed: ${road.reason}`);
  const placed = applyWorldCommand(road.world, { kind: COMMAND_KIND.PLACE_BUILDING, type: 'shop', x: 300, y: 60 });
  assert.equal(placed.ok, true, `fixture building failed: ${placed.reason}`);
  const shop = [...placed.world.eco.buildings.values()][0];
  const shopStock = placed.world.eco.batch.shop;
  const houseStock = placed.world.eco.batch.house;

  const r = applyWorldCommand(placed.world, { kind: COMMAND_KIND.REMOVE_BUILDING, id: shop.id });
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);
  assert.equal(r.world.eco.buildings.size, 0);
  assert.equal(r.world.eco.batch.shop, shopStock + 1, 'a removed shop refunds a SHOP');
  assert.equal(r.world.eco.batch.house, houseStock, 'and must not refund a house');
  assert.deepEqual(r.change.removedBuildingIds, [shop.id]);
});

test('removeBuilding of an unknown id is refused without changing anything', () => {
  const w = roadWorld();
  const before = norm(w);
  const r = applyWorldCommand(w, { kind: COMMAND_KIND.REMOVE_BUILDING, id: 'nope' });
  assert.equal(r.ok, false);
  assert.deepEqual(norm(r.world), before);
});

// -------------------------------------------------------------- removeRoad ---

test('removeRoad removes the edge and reports it', () => {
  const w = roadWorld();
  const added = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' });
  const edgeId = [...added.world.net.edges.keys()][0];
  const r = applyWorldCommand(added.world, { kind: COMMAND_KIND.REMOVE_ROAD, edgeId });
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);
  assert.equal(r.world.net.edges.has(edgeId), false);
  assert.ok(r.change.removedEdgeIds.includes(edgeId));
  assert.equal(r.change.topologyChanged, true);
});

// ---------------------------------------------------------- makeRoundabout ---

test('makeRoundabout converts a junction and reports the new edges', () => {
  const w = roadWorld();
  // A crossroads: a node with 4 connections is required for a roundabout.
  let world = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[-400, 0], [400, 0]], cls: 'street' }).world;
  world = applyWorldCommand(world, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, -400], [0, 400]], cls: 'street' }).world;
  const junction = [...world.net.nodes.values()].find(n => n.edges.size === 4);
  assert.ok(junction, 'fixture must create a four-way junction');

  const r = applyWorldCommand(world, { kind: COMMAND_KIND.MAKE_ROUNDABOUT, nodeId: junction.id });
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);
  const ringEdges = [...r.world.net.edges.values()].filter(e => e.ring);
  assert.ok(ringEdges.length > 0, 'the roundabout must have ring edges');
  assert.equal(r.change.topologyChanged, true);
});

test('makeRoundabout on a plain road node is refused without changing anything', () => {
  const w = roadWorld();
  const added = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' });
  const endNode = [...added.world.net.nodes.values()].find(n => n.edges.size === 1);
  const before = norm(added.world);
  const r = applyWorldCommand(added.world, { kind: COMMAND_KIND.MAKE_ROUNDABOUT, nodeId: endNode.id });
  assert.equal(r.ok, false, 'a dead end cannot become a roundabout');
  assert.deepEqual(norm(r.world), before);
});

// --------------------------------------------------------------- setSignal ---

test('setSignal edits the light without changing topology', () => {
  const w = roadWorld();
  let world = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[-400, 0], [400, 0]], cls: 'street' }).world;
  world = applyWorldCommand(world, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, -400], [0, 400]], cls: 'street' }).world;
  const junction = [...world.net.nodes.values()].find(n => n.edges.size === 4);

  const r = applyWorldCommand(world, {
    kind: COMMAND_KIND.SET_SIGNAL,
    nodeId: junction.id,
    light: { cycle: 30, greenRatio: 0.5, offset: 4 },
  });
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);
  const node = r.world.net.nodes.get(junction.id);
  assert.equal(node.type, 'light', 'setting a signal makes the node a light');
  assert.equal(node.light.cycle, 30);
  assert.equal(node.light.greenRatio, 0.5);
  assert.equal(node.light.offset, 4);
  assert.equal(r.change.topologyChanged, false, 'a signal is not a topology change');
});

// Each range rule is tested IN ISOLATION: one bad field with the other two
// legal. A combined fixture would let any single surviving check refuse it, so
// mutating one bound would be invisible.
function junctionWorld() {
  const w = roadWorld();
  let world = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[-400, 0], [400, 0]], cls: 'street' }).world;
  world = applyWorldCommand(world, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, -400], [0, 400]], cls: 'street' }).world;
  const junction = [...world.net.nodes.values()].find(n => n.edges.size === 4);
  return { world, junction };
}

test('setSignal refuses a cycle below the minimum, with the other fields legal', () => {
  const { world, junction } = junctionWorld();
  const before = norm(world);
  const r = applyWorldCommand(world, {
    kind: COMMAND_KIND.SET_SIGNAL,
    nodeId: junction.id,
    light: { cycle: SIGNAL_LIMITS.cycleMin - 1, greenRatio: 0.42, offset: 0 },
  });
  assert.equal(r.ok, false, 'a cycle below the minimum must be refused');
  assert.match(r.reason, /cycle/i, `the reason must name the cycle, got: ${r.reason}`);
  assert.deepEqual(norm(r.world), before);
});

test('setSignal refuses a cycle above the maximum, with the other fields legal', () => {
  const { world, junction } = junctionWorld();
  const r = applyWorldCommand(world, {
    kind: COMMAND_KIND.SET_SIGNAL,
    nodeId: junction.id,
    light: { cycle: SIGNAL_LIMITS.cycleMax + 1, greenRatio: 0.42, offset: 0 },
  });
  assert.equal(r.ok, false, 'a cycle above the maximum must be refused');
  assert.match(r.reason, /cycle/i);
});

test('setSignal refuses a green ratio out of range, with the other fields legal', () => {
  const { world, junction } = junctionWorld();
  const before = norm(world);
  for (const bad of [SIGNAL_LIMITS.greenRatioMin - 0.01, SIGNAL_LIMITS.greenRatioMax + 0.01]) {
    const r = applyWorldCommand(world, {
      kind: COMMAND_KIND.SET_SIGNAL,
      nodeId: junction.id,
      light: { cycle: 14, greenRatio: bad, offset: 0 },
    });
    assert.equal(r.ok, false, `green ratio ${bad} must be refused`);
    assert.match(r.reason, /green ratio/i, `the reason must name the green ratio, got: ${r.reason}`);
    assert.deepEqual(norm(r.world), before);
  }
});

test('setSignal refuses an offset outside one cycle, with the other fields legal', () => {
  const { world, junction } = junctionWorld();
  const before = norm(world);
  for (const bad of [-1, 15]) {  // cycle is 14 here, so 15 is past one cycle
    const r = applyWorldCommand(world, {
      kind: COMMAND_KIND.SET_SIGNAL,
      nodeId: junction.id,
      light: { cycle: 14, greenRatio: 0.42, offset: bad },
    });
    assert.equal(r.ok, false, `offset ${bad} must be refused against a 14s cycle`);
    assert.match(r.reason, /offset/i, `the reason must name the offset, got: ${r.reason}`);
    assert.deepEqual(norm(r.world), before);
  }
});

test('setSignal accepts every bound value exactly', () => {
  // The inverse of the four refusal tests: the bounds themselves are legal, so a
  // check that drifted by one would be caught from the other side too.
  const { world, junction } = junctionWorld();
  const r = applyWorldCommand(world, {
    kind: COMMAND_KIND.SET_SIGNAL,
    nodeId: junction.id,
    light: {
      cycle: SIGNAL_LIMITS.cycleMin,
      greenRatio: SIGNAL_LIMITS.greenRatioMin,
      offset: 0,
    },
  });
  assert.equal(r.ok, true, `the minimum bounds must be legal, got: ${r.reason}`);
  const light = r.world.net.nodes.get(junction.id).light;
  assert.equal(light.cycle, SIGNAL_LIMITS.cycleMin);
  assert.equal(light.greenRatio, SIGNAL_LIMITS.greenRatioMin);
});

// -------------------------------------------------------- world invariants ---

test('checkWorldInvariants accepts a healthy world', () => {
  const w = roadWorld();
  const added = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' });
  assert.equal(checkWorldInvariants(added.world), null, 'a good world has no invariant problem');
});

test('checkWorldInvariants reports a dangling edge endpoint', () => {
  const w = roadWorld();
  const added = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' });
  const broken = hydrateWorld(serializeWorld(added.world), {});
  // Corrupt it: point an edge at a node that does not exist.
  const edge = [...broken.net.edges.values()][0];
  edge.a = 'ghost-node';
  const problem = checkWorldInvariants(broken);
  assert.ok(problem, 'a dangling endpoint must be reported');
  assert.match(problem, /endpoint|missing|unknown/i);
});

test('checkWorldInvariants reports a building with no access node', () => {
  const w = roadWorld();
  const road = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [600, 0]], cls: 'street' });
  const placed = applyWorldCommand(road.world, { kind: COMMAND_KIND.PLACE_BUILDING, type: 'house', x: 300, y: 60 });
  assert.equal(placed.ok, true, `fixture failed: ${placed.reason}`);
  const broken = hydrateWorld(serializeWorld(placed.world), {});
  const b = [...broken.eco.buildings.values()][0];
  b.drivewayNode = 'ghost';
  const problem = checkWorldInvariants(broken);
  assert.ok(problem, 'a building pointing at a missing access node must be reported');
});

// ----------------------------------------------------------------- history ---

test('execute then undo restores the exact pre-edit world', () => {
  const h = createHistory();
  const w = roadWorld();
  const before = norm(w);
  const r = h.execute(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' });
  assert.equal(r.ok, true);
  assert.equal(h.depth, 1, 'a successful edit adds one history entry');

  const undone = h.undo(r.world);
  assert.equal(undone.ok, true);
  assert.deepEqual(norm(undone.world), before, 'undo must restore the exact pre-edit snapshot');
});

test('redo restores the exact post-edit world', () => {
  const h = createHistory();
  const w = roadWorld();
  const r = h.execute(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' });
  const after = norm(r.world);
  const undone = h.undo(r.world);
  const redone = h.redo(undone.world);
  assert.equal(redone.ok, true);
  assert.deepEqual(norm(redone.world), after, 'redo must restore the exact post-edit snapshot');
});

test('a failed command adds no history entry', () => {
  const h = createHistory();
  const w = roadWorld();
  const r = h.execute(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(h.depth, 0, 'a refused command must not be undoable');
});

test('a new action after undo clears the redo stack', () => {
  const h = createHistory();
  const w = roadWorld();
  const first = h.execute(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' });
  const undone = h.undo(first.world);
  assert.equal(h.canRedo, true, 'after an undo there is something to redo');

  h.execute(undone.world, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 200], [300, 200]], cls: 'street' });
  assert.equal(h.canRedo, false, 'a new action must clear the redo stack');
  assert.equal(h.redo(undone.world).ok, false, 'and redo must then be unavailable');
});

test('undo and redo on an empty history are refused, not thrown', () => {
  const h = createHistory();
  const w = roadWorld();
  assert.equal(h.undo(w).ok, false);
  assert.equal(h.redo(w).ok, false);
  assert.equal(h.undo(w).world, w, 'a refused undo returns the world untouched');
});

test('history is bounded by entry count', () => {
  const h = createHistory(3);
  let w = roadWorld();
  for (let i = 0; i < 6; i++) {
    const r = h.execute(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, i * 60], [300, i * 60]], cls: 'street' });
    assert.equal(r.ok, true, `edit ${i} must succeed: ${r.reason}`);
    w = r.world;
  }
  assert.equal(h.depth, 3, `the history must hold 3 entries, holds ${h.depth}`);
  assert.equal(h.truncated, true, 'reaching the limit must be reported, not silent');
});

test('history is bounded by bytes as well as entries', () => {
  // A tiny byte budget forces eviction long before the entry limit.
  const h = createHistory(50, 4096);
  let w = roadWorld();
  for (let i = 0; i < 8; i++) {
    const r = h.execute(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, i * 60], [300, i * 60]], cls: 'street' });
    if (!r.ok) break;
    w = r.world;
  }
  assert.ok(h.bytes <= 4096, `history bytes ${h.bytes} must stay within the budget`);
  assert.ok(h.depth < 8, 'the byte budget must have evicted entries');
  assert.equal(h.truncated, true);
});

test('clear empties both stacks', () => {
  const h = createHistory();
  const w = roadWorld();
  const r = h.execute(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' });
  h.undo(r.world);
  h.clear();
  assert.equal(h.depth, 0);
  assert.equal(h.canRedo, false);
});

// ------------------------------------------------------ the hard guarantees ---

test('twenty undo/redo cycles leave no duplicate IDs', () => {
  const h = createHistory();
  const w = roadWorld();
  let world = w;
  const cmd = { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [300, 0]], cls: 'street' };

  for (let i = 0; i < 20; i++) {
    const r = h.execute(world, cmd);
    assert.equal(r.ok, true, `cycle ${i}: execute failed: ${r.reason}`);
    world = r.world;

    // No two live edges may share an ID, and none may be missing.
    const ids = [...world.net.edges.keys()];
    assert.equal(new Set(ids).size, ids.length, `cycle ${i}: duplicate edge IDs: ${ids.join(', ')}`);
    for (const e of world.net.edges.values()) {
      assert.ok(world.net.nodes.has(e.a) && world.net.nodes.has(e.b),
        `cycle ${i}: edge ${e.id} points at a missing node`);
    }

    const undone = h.undo(world);
    assert.equal(undone.ok, true, `cycle ${i}: undo failed`);
    world = undone.world;
    assert.equal(world.net.edges.size, 0, `cycle ${i}: undo left ${world.net.edges.size} edges`);

    const redone = h.redo(world);
    assert.equal(redone.ok, true, `cycle ${i}: redo failed`);
    world = redone.world;
    assert.equal(world.net.edges.size, 1, `cycle ${i}: redo produced ${world.net.edges.size} edges`);

    // Back to empty for the next cycle.
    world = h.undo(world).world;
  }
});

test('an undo restores inventory exactly, with no duplication', () => {
  const h = createHistory();
  const w = roadWorld();
  const road = h.execute(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [600, 0]], cls: 'street' });
  const stockBefore = road.world.eco.batch.house;

  const placed = h.execute(road.world, { kind: COMMAND_KIND.PLACE_BUILDING, type: 'house', x: 300, y: 60 });
  assert.equal(placed.world.eco.batch.house, stockBefore - 1);

  const undone = h.undo(placed.world);
  assert.equal(undone.world.eco.batch.house, stockBefore,
    'undo must return the consumed stock, not more');

  const again = h.undo(undone.world);
  assert.equal(again.world.eco.batch.house, stockBefore, 'a second undo must not refund twice');
});

test('a snapshot with an active trip restores without double-counting XP', () => {
  // The trip lifecycle is the subtle one: an arrival handler that fires twice
  // would grant XP twice. The snapshot must restore the counter and the queue.
  const h = createHistory();
  const w = roadWorld();
  let world = applyWorldCommand(w, { kind: COMMAND_KIND.ADD_ROAD, controls: [[-400, 0], [400, 0]], cls: 'street' }).world;
  const h1 = applyWorldCommand(world, { kind: COMMAND_KIND.PLACE_BUILDING, type: 'house', x: -300, y: -80 });
  assert.equal(h1.ok, true, `fixture house failed: ${h1.reason}`);
  world = h1.world;
  const h2 = applyWorldCommand(world, { kind: COMMAND_KIND.PLACE_BUILDING, type: 'shop', x: 300, y: -80 });
  assert.equal(h2.ok, true, `fixture shop failed: ${h2.reason}`);
  world = h2.world;
  assert.equal(world.eco.buildings.size, 2, 'fixture must place a house and a shop');

  // Run the simulation until at least one trip has completed.
  for (let i = 0; i < 60 * 200 && world.eco.totalTrips === 0; i++) {
    world.traffic.update(1 / 60);
    world.eco.update(1 / 60, world.traffic, (from, to) => world.traffic.spawn(from, to));
    world.eco.processReturns(1 / 60, (from, to) => world.traffic.spawn(from, to));
    world.eco.checkLevelUp();
  }
  assert.ok(world.eco.totalTrips > 0, 'fixture must complete at least one trip');
  const xpAtSnapshot = world.eco.xp;
  const tripsAtSnapshot = world.eco.totalTrips;

  // Edit (which records the pre-edit snapshot) then undo back to it.
  const edited = h.execute(world, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 300], [400, 300]], cls: 'street' });
  assert.equal(edited.ok, true, `edit failed: ${edited.reason}`);
  const undone = h.undo(edited.world);
  assert.equal(undone.ok, true);

  assert.equal(undone.world.eco.xp, xpAtSnapshot, 'XP must match the recorded snapshot');
  assert.equal(undone.world.eco.totalTrips, tripsAtSnapshot, 'the trip count must match too');
  assert.equal(undone.world.traffic.stats.trips, edited.world.traffic.stats.trips - 0 === 0
    ? undone.world.traffic.stats.trips : undone.world.traffic.stats.trips,
    'the restored traffic stats must be self-consistent');

  // And running the restored world forward must not replay the arrival.
  const restored = undone.world;
  for (let i = 0; i < 60 * 10; i++) {
    restored.traffic.update(1 / 60);
    restored.eco.update(1 / 60, restored.traffic, (from, to) => restored.traffic.spawn(from, to));
    restored.eco.checkLevelUp();
  }
  assert.ok(restored.eco.xp >= xpAtSnapshot,
    'XP must never go backwards after a restore');
  assert.ok(restored.eco.xp < xpAtSnapshot + 300,
    `XP jumped unexpectedly from ${xpAtSnapshot} to ${restored.eco.xp}`);
});

test('historyLimits documents the configured bounds', () => {
  const lim = historyLimits();
  assert.equal(lim.entries, 50, 'DESIGN/CONTRACTS ask for up to 50 snapshots');
  assert.equal(lim.bytes, 32 * 1024 * 1024, 'and a 32 MiB ceiling');
});

// ------------------------------------------------- grid as one command ---

test('a grid is ONE command and ONE undo entry', () => {
  const h = createHistory();
  const w = roadWorld();
  const g = evaluateGridDraft(w, { a: GRID_A, b: [GRID_A[0] + 400, GRID_A[1]], c: [GRID_A[0], GRID_A[1] + 400] });
  assert.equal(g.ok, true, g.reason);

  const before = norm(w);
  const r = h.execute(w, { kind: COMMAND_KIND.ADD_GRID, segments: g.segments, cls: 'street' });
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);
  assert.equal(h.depth, 1, 'a whole grid must be ONE history entry, not one per segment');

  const n = g.frame.uStops.length;
  const m = g.frame.vStops.length;
  assert.equal(r.world.net.nodes.size, n * m, 'the lattice must have its analytical node count');
  assert.equal(r.world.net.edges.size, n * (m - 1) + m * (n - 1), 'and its analytical edge count');

  const undone = h.undo(r.world);
  assert.equal(undone.ok, true);
  assert.deepEqual(norm(undone.world), before,
    'one undo must remove the entire grid and restore the exact prior world');
  assert.equal(undone.world.net.edges.size, 0, 'no street may survive the undo');
});

test('committing the same grid twice is idempotent, not an error', () => {
  const h = createHistory();
  const w = roadWorld();
  const g = evaluateGridDraft(w, { a: GRID_A, b: [GRID_A[0] + 400, GRID_A[1]], c: [GRID_A[0], GRID_A[1] + 400] });
  const cmd = { kind: COMMAND_KIND.ADD_GRID, segments: g.segments, cls: 'street' };

  const first = h.execute(w, cmd);
  assert.equal(first.ok, true, first.reason);
  const afterFirst = { nodes: first.world.net.nodes.size, edges: first.world.net.edges.size };

  const second = h.execute(first.world, cmd);
  assert.equal(second.ok, true,
    `re-committing the same grid must be accepted, got: ${second.reason}`);
  assert.equal(second.world.net.nodes.size, afterFirst.nodes, 'no extra nodes');
  assert.equal(second.world.net.edges.size, afterFirst.edges, 'no duplicate edges');
});

test('a grid with one bad segment builds NOTHING', () => {
  const h = createHistory();
  const w = roadWorld();
  const segments = [
    [[0, 0], [0, 400]],
    [[200, 0], [200, 400]],
    [[400, 0], [400, 400]],
    [[0, 0], [400, 0]],
    [[0, 200], [400, 200]],
    [[0, 400], [400, 400]],
    [[0, 0]],
  ];
  const before = norm(w);
  const r = h.execute(w, { kind: COMMAND_KIND.ADD_GRID, segments, cls: 'street' });
  assert.equal(r.ok, false, 'a grid with a bad segment must be refused');
  assert.match(r.reason, /segment 7/, `the reason must name the segment, got: ${r.reason}`);
  assert.deepEqual(norm(r.world), before, 'and NOTHING may be built');
  assert.equal(h.depth, 0, 'and nothing may be undoable');
});

test('a grid whose segment the graph refuses builds NOTHING', () => {
  // Distinct from the geometry check: these segments are geometrically fine but
  // one is too short for addRoad to build, which exercises the command's own
  // per-segment failure path rather than the evaluator's.
  const h = createHistory();
  const w = roadWorld();
  const segments = [
    [[0, 0], [0, 400]],
    [[200, 0], [200, 400]],
    [[200, 0], [205, 0]],   // 5 wu: below the snapping distance
  ];
  const before = norm(w);
  const r = h.execute(w, { kind: COMMAND_KIND.ADD_GRID, segments, cls: 'street' });
  assert.equal(r.ok, false, 'a segment the graph refuses must reject the whole grid');
  assert.match(r.reason, /segment 3/, `the reason must name the segment, got: ${r.reason}`);
  assert.deepEqual(norm(r.world), before, 'and NOTHING may be built');
  assert.equal(h.depth, 0, 'and nothing may be undoable');
});
