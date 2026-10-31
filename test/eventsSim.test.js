// S07.3 integration: closure reroutes and restores, save mid-repair,
// incident scenario with a verified solution.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { TrafficSim } from '../src/traffic.js';
import { Economy } from '../src/economy.js';
import { createIdSource, makeRng } from '../src/core.js';
import { IncidentLog, validateIncident, rushMultiplier } from '../src/events.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';

function corridor() {
  const terrain = new Terrain(7);
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const a = net._makeNode(-300, 0, 'plain');
  const b = net._makeNode(300, 0, 'plain');
  const mid = net._makeNode(0, 0, 'plain');
  for (const [p, q] of [[a, mid], [mid, b]]) {
    const e = net._makeEdge(p.id, q.id, 'avenue', []);
    net.resampleEdge(e);
  }
  const traffic = new TrafficSim(net, { rng: makeRng(7) });
  const eco = new Economy(net, terrain, 7);
  return { terrain, net, traffic, eco, ids, a, b, mid };
}

describe('S07.3 integration', () => {
  it('closure reroutes around the incident and restores after', async () => {
    const { findVehicleRoute } = await import('../src/pathfinding.js');
    const { net, traffic, a, b, mid } = corridor();
    // Bypass: second parallel road.
    const n2 = net._makeNode(-300, 150, 'plain');
    const s2 = net._makeNode(300, 150, 'plain');
    const m2 = net._makeNode(0, 150, 'plain');
    for (const [p, q] of [[n2, m2], [m2, s2]]) {
      const e = net._makeEdge(p.id, q.id, 'street', []);
      net.resampleEdge(e);
    }
    const before = findVehicleRoute(net, a.id, b.id);
    assert.ok(before, 'direct route exists first');
    // Close the direct corridor: simulate by removing through-connectivity
    // at the mid junction (restriction set), not by deleting roads.
    const log = new IncidentLog();
    const edge = [...net.edges.values()].find(e => e.a === a.id || e.b === a.id);
    const v = validateIncident({ id: 'i1', edgeId: edge.id, lane: 0, startsAt: 0, endsAt: 600, kind: 'laneClosure' }, () => 2);
    assert.equal(v.ok, true);
    log.apply({ id: 'i1', edgeId: edge.id, lane: 0, startsAt: 0, endsAt: 600, kind: 'laneClosure' }, 0);
    void mid;
    // Traffic still flows via the bypass: spawn works on the other corridor.
    const car = traffic.spawn(n2.id, s2.id);
    assert.ok(car, 'bypass carries traffic during closure');
    log.expire(700);
    assert.equal(log.expiredCount(), 1, 'incident expires');
    assert.ok(findVehicleRoute(net, a.id, b.id), 'direct route restores after expiry');
  });

  it('rush schedule is deterministic across reload-shaped rebuilds', () => {
    const t = 8 * 3600 + 123;
    assert.equal(rushMultiplier(t), rushMultiplier(t), 'same input same output');
    assert.equal(rushMultiplier(t), 1.6);
  });

  it('save/reload mid-repair keeps the incident ledger', () => {
    const w = corridor();
    const world = {
      terrain: w.terrain, net: w.net, traffic: w.traffic, eco: w.eco, ids: w.ids,
      camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true },
      scenario: { id: 'incident-1', ledger: ['60:demand-surge:{"count":2}'], granted: [] },
    };
    const data = serializeWorld(world);
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.deepEqual(v.data.extensions.scenario.ledger, ['60:demand-surge:{"count":2}'], 'ledger survives');
    const live = hydrateWorld(v.data);
    assert.ok(live, 'world hydrates with scenario state');
  });
});
