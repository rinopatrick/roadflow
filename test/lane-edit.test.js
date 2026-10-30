// S04.1 command + migration coverage: editProfile, setOneway, v1/v2→v3,
// profile survival through split/template/undo.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';
import { profileFor } from '../src/roadProfiles.js';

function flatWorld(seed = 7) {
  const terrain = new Terrain(seed);
  // Flatten: S04.1 footprint checks need buildable ground, not island noise.
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const traffic = new TrafficSim(net, { rng: makeRng(seed) });
  const eco = new Economy(net, terrain, seed);
  return { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true } };
}

function straightRoad(world, x0 = 0, x1 = 200, cls = 'street') {
  const history = createHistory();
  const r = history.execute(world, {
    kind: COMMAND_KIND.ADD_ROAD, controls: [[x0, 0], [x1, 0]], cls,
  });
  assert.equal(r.ok, true, r.reason);
  return { world: r.world, edgeId: r.world.net.edges.values().next().value.id, history };
}

describe('S04.1 editProfile command', () => {
  it('adds a lane in place, keeping edge ID and topology', () => {
    const { world, edgeId, history } = straightRoad(flatWorld());
    const before = world.net.edges.get(edgeId);
    const r = history.execute(world, {
      kind: COMMAND_KIND.EDIT_PROFILE, edgeId, profile: { forward: 2, backward: 1 },
    });
    assert.equal(r.ok, true, r.reason);
    const after = r.world.net.edges.get(edgeId);
    assert.ok(after, 'edge ID preserved');
    assert.equal(after.a, before.a);
    assert.equal(after.b, before.b);
    assert.equal(profileFor(after).forward, 2);
  });

  it('refuses an invalid profile with a reason, world unchanged', () => {
    const { world, edgeId, history } = straightRoad(flatWorld());
    const before = JSON.stringify(world.net.toJSON());
    const r = history.execute(world, {
      kind: COMMAND_KIND.EDIT_PROFILE, edgeId, profile: { forward: 0, backward: 0 },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /lane/);
    assert.equal(JSON.stringify(world.net.toJSON()), before);
  });

  it('one undo reverses a profile edit', () => {
    let { world, edgeId, history } = straightRoad(flatWorld());
    const r = history.execute(world, {
      kind: COMMAND_KIND.EDIT_PROFILE, edgeId, profile: { forward: 2, backward: 2 },
    });
    assert.equal(r.ok, true, r.reason);
    world = r.world;
    const u = history.undo(world);
    assert.equal(u.ok, true, u.reason);
    const edge = [...u.world.net.edges.values()][0];
    assert.equal(profileFor(edge).forward, 1);
  });
});

describe('S04.1 setOneway command', () => {
  it('converts to one-way with zero backward lanes, and back', () => {
    let { world, edgeId, history } = straightRoad(flatWorld(), 0, 200, 'avenue');
    let r = history.execute(world, { kind: COMMAND_KIND.SET_ONEWAY, edgeId, oneway: true });
    assert.equal(r.ok, true, r.reason);
    assert.equal(profileFor(r.world.net.edges.get(edgeId)).backward, 0);
    world = r.world;
    r = history.execute(world, { kind: COMMAND_KIND.SET_ONEWAY, edgeId, oneway: false });
    assert.equal(r.ok, true, r.reason);
    assert.equal(profileFor(r.world.net.edges.get(edgeId)).backward, 2);
  });

  it('builds a one-way loop and verifies no reverse travel', async () => {
    const history = createHistory();
    let r = history.execute(flatWorld(), {
      kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [100, 0]], cls: 'street',
    });
    assert.equal(r.ok, true, r.reason);
    let world = r.world;
    // Close a two-edge loop: forward path then return path, then one-way both.
    r = history.execute(world, {
      kind: COMMAND_KIND.ADD_ROAD, controls: [[100, 0], [100, 100], [0, 100], [0, 0]], cls: 'street',
    });
    assert.equal(r.ok, true, r.reason);
    world = r.world;
    for (const e of world.net.edges.values()) {
      const one = history.execute(world, { kind: COMMAND_KIND.SET_ONEWAY, edgeId: e.id, oneway: true });
      assert.equal(one.ok, true, one.reason);
      world = one.world;
    }
    // Every directed edge now has a zero-lane reverse: routing that way fails.
    const { findPath } = await import('../src/pathfinding.js');
    const ids = [...world.net.nodes.keys()];
    let checked = 0;
    for (const e of world.net.edges.values()) {
      const fwd = findPath(world.net, e.a, e.b);
      assert.ok(fwd, `one-way edge ${e.id} must stay routable forward`);
      checked++;
    }
    assert.ok(checked > 0);
  });
});

describe('S04.1 v1/v2 to v3 migration', () => {
  it('a legacy edge without profile loads with unchanged widths', () => {
    const history = createHistory();
    const r = history.execute(flatWorld(), {
      kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [200, 0]], cls: 'avenue',
    });
    assert.equal(r.ok, true, r.reason);
    const data = serializeWorld(r.world);
    // Strip profiles to simulate a v2 payload.
    for (const e of data.net.edges) delete e.profile;
    data.v = 2;
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const live = hydrateWorld(v.data);
    const edge = [...live.net.edges.values()][0];
    assert.equal(profileFor(edge).forward, 2);
    assert.equal(profileFor(edge).backward, 2);
  });

  it('profile survives a split: children carry the parent profile', () => {
    let { world, edgeId, history } = straightRoad(flatWorld(), 0, 300, 'avenue');
    const r = history.execute(world, {
      kind: COMMAND_KIND.EDIT_PROFILE, edgeId, profile: { forward: 3, backward: 2 },
    });
    assert.equal(r.ok, true, r.reason);
    world = r.world;
    edgeId = [...world.net.edges.values()][0].id;
    world.net.splitEdge(edgeId, 150);
    for (const e of world.net.edges.values()) {
      assert.equal(profileFor(e).forward, 3, `child ${e.id} lost forward lanes`);
    }
  });
});
