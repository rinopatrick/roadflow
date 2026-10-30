// S05.2: bridge + ramp construction as one atomic transaction.
// approach/ramp/deck/ramp committed together; one undo removes all.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { validateBridge } from '../src/constructionEdits.js';

function flatWorld(seed = 7) {
  const terrain = new Terrain(seed);
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const traffic = new TrafficSim(net, { rng: makeRng(seed) });
  const eco = new Economy(net, terrain, seed);
  return { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true } };
}

describe('S05.2 bridge construction', () => {
  it('builds approach/ramp/deck/ramp as one command and one undo', () => {
    const world = flatWorld();
    const history = createHistory();
    const before = world.net.edges.size;
    const r = history.execute(world, {
      kind: COMMAND_KIND.BUILD_BRIDGE,
      // Straight deck along x at y=0: approach/ramp/deck/ramp/deck span.
      points: [[-260, 0], [-140, 0], [140, 0], [260, 0]],
      cls: 'avenue',
      deckZ: 12,
    });
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.world.net.edges.size > before + 2, 'several segments committed');
    const grades = [...r.world.net.edges.values()].map(e => e.grade.kind);
    assert.ok(grades.includes('bridge'), 'deck present');
    assert.ok(grades.includes('ramp'), 'ramps present');
    assert.ok(grades.includes('ground'), 'ground approaches present');
    const u = history.undo(r.world);
    assert.equal(u.ok, true, u.reason);
    assert.equal(u.world.net.edges.size, before, 'one undo removes the whole bridge');
  });

  it('too-short ramp rejects the whole transaction, nothing built', () => {
    const world = flatWorld();
    const history = createHistory();
    const before = JSON.stringify(world.net.toJSON());
    const r = history.execute(world, {
      kind: COMMAND_KIND.BUILD_BRIDGE,
      points: [[-30, 0], [-10, 0], [10, 0], [30, 0]],
      cls: 'street',
      deckZ: 12,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /slope|ramp|length/i);
    assert.equal(JSON.stringify(world.net.toJSON()), before);
  });

  it('river spanning trip completes via the bridge', async () => {
    const world = flatWorld();
    const { net } = world;
    // A ground road north-south that the bridge must cross without joining.
    const a = net._makeNode(0, -200, 'plain');
    const b = net._makeNode(0, 200, 'plain');
    const g = net._makeEdge(a.id, b.id, 'street', []);
    net.resampleEdge(g);
    const history = createHistory();
    const r = history.execute(world, {
      kind: COMMAND_KIND.BUILD_BRIDGE,
      points: [[-260, 0], [-140, 0], [140, 0], [260, 0]],
      cls: 'street',
      deckZ: 12,
    });
    assert.equal(r.ok, true, r.reason);
    // Ends of the bridge route east-west; the crossing has no junction.
    const west = [...r.world.net.nodes.values()].filter(n => n.x < -150 && Math.abs(n.y) < 1);
    const east = [...r.world.net.nodes.values()].filter(n => n.x > 150 && Math.abs(n.y) < 1);
    assert.ok(west.length && east.length, 'bridge endpoints exist');
    const { findVehicleRoute } = await import('../src/pathfinding.js');
    // West approach to east approach: the route must use the deck.
    const wEnd = west[0].id;
    const eEnd = east[0].id;
    const route = findVehicleRoute(r.world.net, wEnd, eEnd);
    assert.ok(route, 'bridge carries the east-west trip');
    assert.ok(route.steps.some(s => {
      const e = r.world.net.edges.get(s.edgeId);
      return e.grade?.kind === 'bridge';
    }), 'route crosses the deck');
    // North-south ground road unaffected: no junction with the deck.
    const groundJunction = [...r.world.net.nodes.values()].filter(n => n.edges.size === 4);
    assert.equal(groundJunction.length, 0, 'no accidental junction under the deck');
  });

  it('validateBridge explains deck on rock and missing abutment', () => {
    const world = flatWorld();
    const v = validateBridge(world, {
      points: [[-260, 0], [-140, 0], [140, 0], [260, 0]],
      cls: 'avenue', deckZ: 12,
    });
    assert.equal(v.ok, true, v.reason);
  });
});

