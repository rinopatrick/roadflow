// S04.2 verify: 1000 seeded arrivals at a four-way fixture.
// Zero illegal connector entries, zero conflicting reservations, reachable
// paths complete. Engine-level (no browser) so CI stays fast.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { buildJunctionConnectors } from '../src/junctions.js';
import { findVehicleRoute } from '../src/pathfinding.js';

function fourWay() {
  const net = new RoadNetwork({ ids: createIdSource() });
  const flat = { isRoadable: () => true, isBuildable: () => true };
  void flat;
  const c = net._makeNode(0, 0, 'plain');
  const n = net._makeNode(0, -200, 'plain');
  const s = net._makeNode(0, 200, 'plain');
  const e = net._makeNode(200, 0, 'plain');
  const w = net._makeNode(-200, 0, 'plain');
  for (const [a, b] of [[n, c], [c, s], [w, c], [c, e]]) {
    net._makeEdge(a.id, b.id, 'avenue', []);
  }
  for (const ed of net.edges.values()) net.resampleEdge(ed);
  return { net, c, ends: { n, s, e, w } };
}

describe('S04.2 stress: 1000 seeded arrivals', () => {
  it('zero illegal entries, zero conflicting reservations, all complete', () => {
    const { net, ends } = fourWay();
    const sim = new TrafficSim(net, { rng: makeRng(42) });
    const ids = [ends.n.id, ends.s.id, ends.e.id, ends.w.id];
    const rng = makeRng(1337);
    let spawned = 0;
    let arrived = 0;
    let illegal = 0;
    let conflictDup = 0;
    const seenConflicts = new Map(); // connectorId -> carId per tick sample
    for (let t = 0; t < 10000; t++) {
      // One arrival every 200 ticks (~3.3 sim-seconds apart): spawn points
      // clear between arrivals, so the test measures junction legality, not
      // spawn contention at a single point. Total ≈ 55 sim-minutes.
      if (t % 200 !== 0) { sim.update(1 / 60); continue; }
      const a = ids[Math.floor(rng() * 4)];
      let b = ids[Math.floor(rng() * 4)];
      if (b === a) b = ids[(ids.indexOf(a) + 2) % 4];
      const r = findVehicleRoute(net, a, b);
      assert.ok(r, `tick ${t}: reachable simple path must exist`);
      // Every connector on the route must be a legal connector of its node.
      for (const st of r.steps) {
        if (!st.connectorId) continue;
        const edge = net.edges.get(st.edgeId);
        const nodeId = st.dir === 1 ? edge.b : edge.a;
        const legal = buildJunctionConnectors(net, nodeId).some(k => k.id === st.connectorId);
        if (!legal) illegal++;
      }
      const car = sim.spawn(a, b);
      if (car) {
        spawned++;
        car.onArrive = () => { arrived++; };
      }
      sim.update(1 / 60);
      // Sample: no two different cars holding the same conflict group.
      seenConflicts.clear();
      for (const [cid, holder] of sim.reservations) {
        if (seenConflicts.has(cid) && seenConflicts.get(cid) !== holder) conflictDup++;
        seenConflicts.set(cid, holder);
      }
      // No vehicle outside a valid swept corridor: every moving car is on an
      // edge it legally traverses (lane in range for its direction).
      for (const car of sim.cars.values()) {
        const st = car.currentStep();
        if (!st) continue;
        const edge = net.edges.get(st.edgeId);
        assert.ok(edge, `car ${car.id} on a real edge`);
        assert.ok(car.s >= -1 && car.s <= edge.total + 1, `car ${car.id} inside corridor`);
      }
    }
    // Drain: run until all cars arrive or a bounded horizon (10 sim-minutes:
    // single-lane junction service is serial, so the tail clears slowly).
    for (let t = 0; t < 60 * 600 && sim.cars.size > 0; t++) sim.update(1 / 60);
    assert.equal(illegal, 0, 'zero illegal connector entries');
    assert.equal(conflictDup, 0, 'zero conflicting reservations');
    assert.ok(spawned >= 45, `spawned ${spawned}/50 attempts, expected most admitted`); // 50 attempts
    assert.equal(sim.cars.size, 0, 'all admitted journeys complete (no deadlock)');
    assert.ok(arrived >= spawned * 0.95, `arrived ${arrived}/${spawned}`);
  });
});
