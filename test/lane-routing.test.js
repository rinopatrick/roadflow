// S04.2: junction connectors + legal lane route graph.
// CONTRACTS 5: buildJunctionConnectors(net,nodeId), findVehicleRoute.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { createIdSource } from '../src/core.js';
import { buildJunctionConnectors, connectorId } from '../src/junctions.js';
import { findVehicleRoute } from '../src/pathfinding.js';

function xCross() {
  const net = new RoadNetwork({ ids: createIdSource() });
  const c = net._makeNode(0, 0, 'plain');
  const n = net._makeNode(0, -100, 'plain');
  const s = net._makeNode(0, 100, 'plain');
  const e = net._makeNode(100, 0, 'plain');
  const w = net._makeNode(-100, 0, 'plain');
  net._makeEdge(n.id, c.id, 'street', []);
  net._makeEdge(c.id, s.id, 'street', []);
  net._makeEdge(w.id, c.id, 'street', []);
  net._makeEdge(c.id, e.id, 'street', []);
  for (const ed of net.edges.values()) net.resampleEdge(ed);
  return { net, c };
}

describe('S04.2 buildJunctionConnectors', () => {
  it('enumerates through + left + right, no same-edge U-turn', () => {
    const { net, c } = xCross();
    const cons = buildJunctionConnectors(net, c.id);
    assert.ok(cons.length > 0);
    for (const k of cons) {
      assert.notEqual(k.from.edgeId, k.to.edgeId, 'same-edge U-turn forbidden');
      assert.equal(k.id, connectorId(k.from, k.to));
    }
    const turns = new Set(cons.map(k => k.turn));
    assert.ok(turns.has('through'));
    // Sorted by stable tuple ID.
    const ids = cons.map(k => k.id);
    assert.deepEqual([...ids].sort(), ids);
  });

  it('same input generates same geometry', () => {
    const { net, c } = xCross();
    const a = buildJunctionConnectors(net, c.id);
    const b = buildJunctionConnectors(net, c.id);
    assert.deepEqual(a, b);
  });

  it('conflicts are symmetric', () => {
    const { net, c } = xCross();
    const cons = buildJunctionConnectors(net, c.id);
    const byId = new Map(cons.map(k => [k.id, k]));
    for (const k of cons) {
      for (const o of k.conflicts) {
        assert.ok(byId.get(o)?.conflicts.includes(k.id), `${k.id} vs ${o} asymmetric`);
      }
    }
  });
});

describe('S04.2 findVehicleRoute', () => {
  it('returns lane-level steps with connectorId on all but last', () => {
    const { net, c } = xCross();
    const nodes = [...net.nodes.values()];
    const from = nodes.find(n => n.y === -100).id;
    const to = nodes.find(n => n.y === 100).id;
    void c;
    const r = findVehicleRoute(net, from, to);
    assert.ok(r, 'route exists');
    assert.ok(r.steps.length >= 1);
    assert.ok(r.steps.every(s => Number.isInteger(s.lane) && s.lane >= 0));
    for (let i = 0; i < r.steps.length - 1; i++) {
      assert.ok(r.steps[i].connectorId, `step ${i} needs connectorId`);
    }
    assert.equal(r.steps[r.steps.length - 1].connectorId, null);
    assert.ok(r.version !== undefined);
  });

  it('rejects a lane path no legal connector can serve', () => {
    const { net, c } = xCross();
    const nodes = [...net.nodes.values()];
    const from = nodes.find(n => n.x === -100).id;
    const to = nodes.find(n => n.x === 100).id;
    // Block the specific straight connector at the centre: W→E must fail.
    const plain = findVehicleRoute(net, from, to);
    assert.ok(plain, 'unrestricted W→E exists');
    const straight = plain.steps.find(s => s.connectorId);
    assert.ok(straight, 'W→E uses a connector');
    const blocked = findVehicleRoute(net, from, to, {
      restrictions: new Set([straight.connectorId]),
    });
    assert.equal(blocked, null, 'blocked straight connector means no route');
    void c;
  });
});
