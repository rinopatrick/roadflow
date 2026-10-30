// S05.3: tunnels. z=-12 beneath rock and surface roads; portals need
// buildable approach + compliant ramps; water tunnelling explicitly rejected.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { validateTunnel } from '../src/constructionEdits.js';
import { findVehicleRoute } from '../src/pathfinding.js';

function flatWorld(seed = 7) {
  const terrain = new Terrain(seed);
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const traffic = new TrafficSim(net, { rng: makeRng(seed) });
  const eco = new Economy(net, terrain, seed);
  return { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true } };
}

describe('S05.3 tunnels', () => {
  it('builds portal/ramp/bore/ramp/portal as one command and one undo', () => {
    const world = flatWorld();
    const history = createHistory();
    const before = world.net.edges.size;
    const r = history.execute(world, {
      kind: COMMAND_KIND.BUILD_TUNNEL,
      points: [[-260, 100], [-140, 100], [140, 100], [260, 100]],
      cls: 'street', depthZ: -12,
    });
    assert.equal(r.ok, true, r.reason);
    const grades = [...r.world.net.edges.values()].map(e => e.grade.kind);
    assert.ok(grades.includes('tunnel'), 'bore present');
    assert.ok(grades.includes('ramp'), 'portal ramps present');
    const u = history.undo(r.world);
    assert.equal(u.ok, true, u.reason);
    assert.equal(u.world.net.edges.size, before);
  });

  it('water tunnelling is explicitly rejected as a game rule', () => {
    const world = flatWorld();
    // Points crossing water: seed-7 map water is at the edges; force by mock.
    world.terrain.isRoadable = () => true;
    world.terrain.sample = () => 2; // WATER everywhere
    const v = validateTunnel(world, {
      points: [[-260, 100], [-140, 100], [140, 100], [260, 100]],
      cls: 'street', depthZ: -12,
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /water/i);
  });

  it('tunnel under a surface road creates no junction and still routes', async () => {
    const world = flatWorld();
    const { net } = world;
    const a = net._makeNode(0, -200, 'plain');
    const b = net._makeNode(0, 200, 'plain');
    const g = net._makeEdge(a.id, b.id, 'street', []);
    net.resampleEdge(g);
    const history = createHistory();
    const r = history.execute(world, {
      kind: COMMAND_KIND.BUILD_TUNNEL,
      points: [[-260, 0], [-140, 0], [140, 0], [260, 0]],
      cls: 'street', depthZ: -12,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal([...r.world.net.nodes.values()].filter(n => n.edges.size === 4).length, 0,
      'no junction where the bore passes under');
    // Surface road still routes; tunnel carries its own trip end to end.
    assert.ok(findVehicleRoute(r.world.net, a.id, b.id), 'surface intact');
    const ends = [...r.world.net.nodes.values()].filter(n => n.edges.size === 1).map(n => n.id);
    const tw = ends.find(id => r.world.net.nodes.get(id).x < -200);
    const te = ends.find(id => r.world.net.nodes.get(id).x > 200);
    assert.ok(tw && te, 'tunnel portals exist');
    const route = findVehicleRoute(r.world.net, tw, te);
    assert.ok(route, 'tunnel trip routes portal to portal');
    assert.ok(route.steps.some(s => r.world.net.edges.get(s.edgeId).grade?.kind === 'tunnel'));
  });

  it('too-short portal ramp rejects the whole transaction', () => {
    const world = flatWorld();
    const history = createHistory();
    const before = JSON.stringify(world.net.toJSON());
    const r = history.execute(world, {
      kind: COMMAND_KIND.BUILD_TUNNEL,
      points: [[-30, 100], [-10, 100], [10, 100], [30, 100]],
      cls: 'street', depthZ: -12,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /ramp|slope|length/i);
    assert.equal(JSON.stringify(world.net.toJSON()), before);
  });
});
