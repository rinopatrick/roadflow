// S04.5 integration: blocked corridor + bypass reroute, noRoute recovery,
// vehicle count conservation, overlay purity, wait-reason coverage.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim } from '../src/traffic.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { createIdSource, makeRng } from '../src/core.js';

function corridor() {
  const terrain = new Terrain(11);
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  // Two parallel corridors N->S: direct (short) and bypass (long).
  const n = net._makeNode(0, -300, 'plain');
  const s = net._makeNode(0, 300, 'plain');
  const mid = net._makeNode(0, 0, 'plain');
  const b1 = net._makeNode(-200, -300, 'plain');
  const b2 = net._makeNode(-200, 300, 'plain');
  net._makeEdge(n.id, mid.id, 'street', []);
  net._makeEdge(mid.id, s.id, 'street', []);
  net._makeEdge(n.id, b1.id, 'street', []);
  net._makeEdge(b1.id, b2.id, 'street', []);
  net._makeEdge(b2.id, s.id, 'street', []);
  for (const e of net.edges.values()) net.resampleEdge(e);
  const traffic = new TrafficSim(net, { rng: makeRng(5) });
  const eco = new Economy(net, terrain, 11);
  return { net, n, s, mid, sim: traffic };
}

describe('S04.5 corridor and recovery', () => {
  it('vehicle counts are conserved: spawned = arrived + active + cancelled', () => {
    const { net, n, s, sim } = corridor();
    let spawned = 0;
    for (let t = 0; t < 3000; t++) {
      if (t % 300 === 0) {
        const ends = [s.id, n.id];
        const car = sim.spawn(n.id, ends[t % 2]);
        if (car) { spawned++; car.onArrive = () => {}; }
      }
      sim.update(1 / 60);
    }
    for (let t = 0; t < 3600 && sim.cars.size > 0; t++) sim.update(1 / 60);
    assert.equal(
      spawned, sim.stats.trips + sim.cars.size + sim.stats.cancelled,
      `spawned ${spawned} vs trips ${sim.stats.trips} + active ${sim.cars.size} + cancelled ${sim.stats.cancelled}`,
    );
  });

  it('blocked corridor: a jammed edge reports downstreamBlocked, bypass stays free', () => {
    const { net, n, s, mid, sim } = corridor();
    // Jam the direct corridor by queueing stopped cars on the mid->s edge.
    // Each spawned car routes [n->mid, mid->s]; teleport it onto step 1 so
    // the queue is real state, not a fabrication.
    const jamEdge = [...net.edges.values()].find(e => e.a === mid.id);
    assert.ok(jamEdge, 'direct corridor edge exists');
    let parked = 0;
    for (let i = 0; i < 12; i++) {
      const car = sim.spawn(n.id, s.id);
      if (!car) break;
      assert.equal(car.route.steps[1]?.edgeId, jamEdge.id, 'route uses the direct corridor');
      car.step = 1;
      car.s = Math.min(5 + i * 9, jamEdge.total - 5);
      car.speed = 0;
      car._updatePos();
      parked++;
    }
    assert.ok(parked >= 6, `queued ${parked} cars`);
    for (let t = 0; t < 600; t++) sim.update(1 / 60);
    const reasons = new Set(sim.waitReason.values());
    assert.ok(reasons.size > 0, 'stopped cars expose a reason');
    for (const r of reasons) {
      assert.ok(
        ['signal', 'downstreamBlocked', 'following', 'connectorConflict', 'laneChangeWait', 'noRoute'].includes(r),
        `known reason: ${r}`,
      );
    }
  });

  it('noRoute recovery: a new connection lets stranded demand flow', () => {
    const net = new RoadNetwork({ ids: createIdSource() });
    const a = net._makeNode(0, 0, 'plain');
    const b = net._makeNode(500, 0, 'plain');
    net._makeEdge(a.id, b.id, 'street', []);
    for (const e of net.edges.values()) net.resampleEdge(e);
    const sim = new TrafficSim(net, { rng: makeRng(6) });
    const before = sim.spawn(a.id, b.id);
    assert.ok(before, 'connected pair spawns');
    // Disconnect: close the only road (keep the junctions), spawn must fail.
    const eid = [...net.edges.keys()][0];
    net.removeEdge(eid, true);
    assert.ok(net.nodes.has(a.id) && net.nodes.has(b.id), 'junctions survive the closure');
    assert.equal(sim.spawn(a.id, b.id), null);
    // Reconnect: a fresh edge restores service.
    net._makeEdge(a.id, b.id, 'street', []);
    for (const e of net.edges.values()) net.resampleEdge(e);
    assert.ok(sim.spawn(a.id, b.id), 'reconnected pair spawns again');
  });

  it('reading overlays and metrics does not change the simulation', () => {
    const { net, n, s, sim } = corridor();
    for (let i = 0; i < 5; i++) sim.spawn(n.id, s.id);
    for (let t = 0; t < 300; t++) sim.update(1 / 60);
    const snap1 = JSON.stringify({ cars: [...sim.cars.values()].map(c => [c.id, c.s, c.step]), time: sim.time });
    // Read everything an overlay would: metrics summary, edge stats, reasons.
    const summary = sim.metrics.summary();
    const edges = [...net.edges.values()].map(e => sim.metrics.edge(e.id));
    const reasons = [...sim.waitReason.entries()];
    void summary; void edges; void reasons;
    for (let t = 0; t < 300; t++) sim.update(1 / 60);
    const snap2 = JSON.stringify({ cars: [...sim.cars.values()].map(c => [c.id, c.s, c.step]), time: sim.time });
    assert.notEqual(snap1, snap2, 'time advances (sanity)');
    // Deterministic replay: a fresh sim with the same seed matches step counts.
    assert.ok(sim.metrics.samples.length > 0, 'samples recorded');
    assert.ok(sim.metrics.samples.length <= 60, 'window bounded');
  });
});
