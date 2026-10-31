// S05.1 integration: grade-aware crossings, split height preservation,
// no route jumps between levels, save round-trip.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { createIdSource } from '../src/core.js';
import { findVehicleRoute } from '../src/pathfinding.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { makeRng } from '../src/core.js';

function groundCross() {
  const net = new RoadNetwork({ ids: createIdSource() });
  const a = net._makeNode(-200, 0, 'plain');
  const b = net._makeNode(200, 0, 'plain');
  const c = net._makeNode(0, -200, 'plain');
  const d = net._makeNode(0, 200, 'plain');
  const e1 = net._makeEdge(a.id, b.id, 'street', []);
  net.resampleEdge(e1);
  const e2 = net._makeEdge(c.id, d.id, 'street', []);
  net.resampleEdge(e2);
  net.resolveCrossings([e1.id, e2.id]);
  return { net, a, b, c, d };
}

describe('S05.1 integration', () => {
  it('XY cross at the same grade creates a junction and routes', () => {
    const { net, a, b } = groundCross();
    const mid = [...net.nodes.values()].find(n => n.edges.size === 4);
    assert.ok(mid, 'four-way junction formed');
    const r = findVehicleRoute(net, a.id, b.id);
    assert.ok(r, 'through route exists');
  });

  it('a bridge over a ground road never creates a junction or route', () => {
    const net = new RoadNetwork({ ids: createIdSource() });
    const a = net._makeNode(-200, 0, 'plain');
    const b = net._makeNode(200, 0, 'plain');
    const e1 = net._makeEdge(a.id, b.id, 'street', []);
    net.resampleEdge(e1);
    // Elevated crossing: nodes at z=12, deck grade bridge.
    const c = net._makeNode(0, -200, 'plain', 12);
    const d = net._makeNode(0, 200, 'plain', 12);
    const e2 = net._makeEdge(c.id, d.id, 'street', []);
    e2.grade = { kind: 'bridge', za: 12, zb: 12 };
    net.resampleEdge(e2);
    const before = net.nodes.size;
    assert.equal(net.resolveCrossings([e2.id]), true);
    assert.equal(net.nodes.size, before, 'no junction created across grades');
    assert.equal(findVehicleRoute(net, c.id, a.id), null, 'no route from deck to ground');
    assert.ok(findVehicleRoute(net, a.id, b.id), 'ground through route intact');
    assert.ok(findVehicleRoute(net, c.id, d.id), 'bridge through route intact');
  });

  it('a 0.5..8wu gap rejects the whole transaction', () => {
    const net = new RoadNetwork({ ids: createIdSource() });
    const a = net._makeNode(-200, 0, 'plain');
    const b = net._makeNode(200, 0, 'plain');
    net._makeEdge(a.id, b.id, 'street', []);
    for (const e of net.edges.values()) net.resampleEdge(e);
    // Draft a crossing at z=4 (invalid gap): addRoad with elevated endpoints.
    const c = net._makeNode(0, -200, 'plain', 4);
    const d = net._makeNode(0, 200, 'plain', 4);
    const before = JSON.stringify(net.toJSON());
    net._makeEdge(c.id, d.id, 'street', []);
    for (const e of net.edges.values()) if (!e.pts) net.resampleEdge(e);
    const fresh = [...net.edges.values()].find(e => e.a === c.id);
    fresh.grade = { kind: 'bridge', za: 4, zb: 4 };
    assert.equal(net.resolveCrossings([fresh.id]), false, 'collision gap rejected');
  });

  it('split ramp preserves height at the split point', () => {
    const net = new RoadNetwork({ ids: createIdSource() });
    const a = net._makeNode(0, 0, 'plain', 0);
    const b = net._makeNode(200, 0, 'plain', 12);
    const e = net._makeEdge(a.id, b.id, 'street', []);
    e.grade = { kind: 'ramp', za: 0, zb: 12 };
    net.resampleEdge(e);
    const total = e.total;
    const node = net.splitEdge(e.id, total / 2);
    assert.ok(node, 'split works');
    assert.ok(Math.abs(node.z - 6) < 1, `split height ~6, got ${node.z}`);
    const kids = [...net.edges.values()];
    assert.equal(kids.length, 2);
    const heights = kids.map(k => [k.grade.za, k.grade.zb]);
    assert.ok(heights.some(([za, zb]) => za === 0 && Math.abs(zb - 6) < 1));
    assert.ok(heights.some(([za, zb]) => Math.abs(za - 6) < 1 && zb === 12));
  });

  it('grades survive save/load with identical routing', () => {
    const net = new RoadNetwork({ ids: createIdSource() });
    const terrain = new Terrain(1);
    const a = net._makeNode(-200, 0, 'plain');
    const b = net._makeNode(200, 0, 'plain');
    const c = net._makeNode(0, -200, 'plain', 12);
    const d = net._makeNode(0, 200, 'plain', 12);
    const e1 = net._makeEdge(a.id, b.id, 'street', []);
    net.resampleEdge(e1);
    const e2 = net._makeEdge(c.id, d.id, 'street', []);
    e2.grade = { kind: 'bridge', za: 12, zb: 12 };
    net.resampleEdge(e2);
    const eco = new Economy(net, terrain, 1);
    const traffic = new TrafficSim(net, { rng: makeRng(1) });
    const world = { terrain, net, traffic, eco, ids: createIdSource(1), camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true } };
    const data = serializeWorld(world);
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal(v.data.v, 6);
    const live = hydrateWorld(v.data);
    const le2 = live.net.edges.get(e2.id);
    assert.deepEqual(le2.grade, { kind: 'bridge', za: 12, zb: 12 });
    assert.equal(findVehicleRoute(live.net, c.id, a.id), null);
    assert.ok(findVehicleRoute(live.net, c.id, d.id));
  });
});
