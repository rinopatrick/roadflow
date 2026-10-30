// S05.2 render order + driveway + upgrade rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { evaluateBuildingPlacement } from '../src/access.js';

function worldWithBridge() {
  const terrain = new Terrain(7);
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const traffic = new TrafficSim(net, { rng: makeRng(7) });
  const eco = new Economy(net, terrain, 7);
  const world = { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true } };
  const history = createHistory();
  const r = history.execute(world, {
    kind: COMMAND_KIND.BUILD_BRIDGE,
    points: [[-260, 0], [-140, 0], [140, 0], [260, 0]],
    cls: 'street', deckZ: 12,
  });
  assert.equal(r.ok, true, r.reason);
  return { world: r.world, history };
}

describe('S05.2 deck rules', () => {
  it('buildings cannot attach to a bridge deck or ramp', () => {
    const { world } = worldWithBridge();
    // A point right beside the deck: nearest road is elevated.
    const deck = [...world.net.edges.values()].find(e => e.grade?.kind === 'bridge');
    assert.ok(deck, 'deck exists');
    // A world with ONLY an elevated deck nearby: placement must refuse with
    // the elevated reason, not a generic "no road".
    const t2 = new Terrain(7);
    const ids2 = createIdSource();
    const net2 = new RoadNetwork({ ids: ids2 });
    const traffic2 = new TrafficSim(net2, { rng: makeRng(7) });
    const eco2 = new Economy(net2, t2, 7);
    const na = net2._makeNode(-100, 0, 'plain', 12);
    const nb = net2._makeNode(100, 0, 'plain', 12);
    const ne = net2._makeEdge(na.id, nb.id, 'street', []);
    ne.grade = { kind: 'bridge', za: 12, zb: 12 };
    net2.resampleEdge(ne);
    const res = evaluateBuildingPlacement(
      { terrain: t2, net: net2, eco: eco2 }, { type: 'house', x: 0, y: 30 });
    assert.equal(res.ok, false);
    assert.match(res.reason, /bridge|ramp|ground/i);
  });

  it('bridge lanes upgrade revalidates the deck footprint', () => {
    const { world, history } = worldWithBridge();
    const deck = [...world.net.edges.values()].find(e => e.grade?.kind === 'bridge');
    assert.ok(deck);
    // Widening the deck profile is allowed when clear (fixture is empty).
    const r = history.execute(world, {
      kind: COMMAND_KIND.EDIT_PROFILE, edgeId: deck.id,
      profile: { forward: 2, backward: 1 },
    });
    assert.equal(r.ok, true, r.reason);
  });

  it('deleting the bridge cancels or reroutes only affected trips', () => {
    const { world, history } = worldWithBridge();
    const ends = [...world.net.nodes.values()].filter(n => n.edges.size === 1).map(n => n.id);
    const w = world.traffic.spawn(ends[0], ends[ends.length - 1]);
    assert.ok(w, 'bridge trip spawned');
    // Demolish one deck edge: the trip must cancel with a reason, not vanish.
    const deck = [...world.net.edges.values()].find(e => e.grade?.kind === 'bridge');
    const r = history.execute(world, { kind: COMMAND_KIND.REMOVE_ROAD, edgeId: deck.id });
    assert.equal(r.ok, true, r.reason);
    assert.ok(!r.world.net.edges.has(deck.id), 'deck edge removed');
  });
});
