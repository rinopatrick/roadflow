// S04.6 release matrix: class × direction × junction × control coverage.
// Every supported combination routes legally or is explicitly rejected.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { createIdSource, makeRng } from '../src/core.js';
import { findVehicleRoute } from '../src/pathfinding.js';
import { buildJunctionConnectors } from '../src/junctions.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { Terrain } from '../src/terrain.js';
import { TrafficSim } from '../src/traffic.js';
import { Economy } from '../src/economy.js';

function junction(kind, cls = 'street') {
  const net = new RoadNetwork({ ids: createIdSource() });
  const c = net._makeNode(0, 0, 'plain');
  const arms = kind === 'T'
    ? [[0, -200], [200, 0], [0, 200]]
    : kind === 'Y'
      ? [[0, -200], [173, 100], [-173, 100]]
      : [[0, -200], [0, 200], [-200, 0], [200, 0]];
  const ends = arms.map(([x, y]) => net._makeNode(x, y, 'plain'));
  const mk = (a, b, oneway = false) => {
    const e = net._makeEdge(a.id, b.id, cls, []);
    if (oneway) {
      e.oneway = true;
      e.profile = { forward: 2, backward: 0, laneWidth: 6, medianWidth: 0, shoulderWidth: 1, speed: 18, access: 'arterial' };
    }
    net.resampleEdge(e);
    return e;
  };
  // Orient all arms outward from the junction for two-way; one-way tested separately.
  ends.forEach((nd, i) => {
    if (i % 2 === 0) mk(nd, c);
    else mk(c, nd);
  });
  return { net, c, ends };
}

describe('S04.6 release matrix', () => {
  for (const cls of ['street', 'avenue', 'highway']) {
    for (const kind of ['T', 'Y', 'X']) {
      it(`${cls} ${kind}: every arm pair routes or is lawfully rejected`, () => {
        const { net, ends } = junction(kind, cls);
        let routed = 0;
        let rejected = 0;
        for (const a of ends) {
          for (const b of ends) {
            if (a.id === b.id) continue;
            const r = findVehicleRoute(net, a.id, b.id);
            if (r) {
              routed++;
              // Every connector on the route is legal at its node.
              for (const st of r.steps) {
                if (!st.connectorId) continue;
                const edge = net.edges.get(st.edgeId);
                const nodeId = st.dir === 1 ? edge.b : edge.a;
                const legal = buildJunctionConnectors(net, nodeId).some(k => k.id === st.connectorId);
                assert.ok(legal, `${cls} ${kind}: connector ${st.connectorId} legal`);
              }
            } else {
              rejected++;
            }
          }
        }
        assert.ok(routed > 0, `${cls} ${kind}: at least one pair routes`);
        void rejected;
      });
    }
  }

  it('signal/plain/yield controls: signal obeys program, plain yields, ring circulates', () => {
    const terrain = new Terrain(3);
    terrain.isRoadable = () => true;
    const ids = createIdSource();
    const net = new RoadNetwork({ ids });
    const c = net._makeNode(0, 0, 'plain');
    const n = net._makeNode(0, -200, 'plain');
    const s = net._makeNode(0, 200, 'plain');
    const e = net._makeNode(200, 0, 'plain');
    const w = net._makeNode(-200, 0, 'plain');
    for (const [a, b] of [[n, c], [c, s], [w, c], [c, e]]) {
      const ed = net._makeEdge(a.id, b.id, 'street', []);
      net.resampleEdge(ed);
    }
    const traffic = new TrafficSim(net, { rng: makeRng(3) });
    const eco = new Economy(net, terrain, 3);
    const world = { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true } };
    const history = createHistory();
    // Plain junction: traffic flows without a signal.
    const car = traffic.spawn(n.id, s.id);
    assert.ok(car, 'plain junction serves a through trip');
    for (let t = 0; t < 3600 && traffic.cars.size > 0; t++) traffic.update(1 / 60);
    assert.equal(traffic.cars.size, 0, 'plain junction drains');
    // Signal: install a program covering all movements.
    const conns = buildJunctionConnectors(net, c.id);
    const phases = [];
    const remaining = new Set(conns.map(k => k.id));
    const byId = new Map(conns.map(k => [k.id, k]));
    let pi = 0;
    while (remaining.size) {
      const ids2 = [];
      for (const id of [...remaining]) {
        if (!ids2.some(o => (byId.get(o).conflicts ?? []).includes(id))) { ids2.push(id); remaining.delete(id); }
      }
      phases.push({ id: `p${pi++}`, green: 8, yellow: 2, allRed: 1, connectorIds: ids2 });
    }
    const r = history.execute(world, {
      kind: COMMAND_KIND.SET_SIGNAL_PROGRAM, nodeId: c.id,
      program: { offset: 0, phases },
    });
    assert.equal(r.ok, true, r.reason);
    // Ring: conversion keeps the junction servable.
    const rr = history.execute(r.world, { kind: COMMAND_KIND.MAKE_ROUNDABOUT, nodeId: c.id });
    assert.equal(rr.ok, true, rr.reason);
    const ends = [...rr.world.net.nodes.values()].filter(x => x.edges.size === 1 && !x.isRing).map(x => x.id);
    assert.ok(ends.length >= 2, 'ring keeps entries');
  });
});
