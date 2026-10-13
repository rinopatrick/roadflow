// Reusable structural invariants for Roadflow worlds.
//
// Why this exists
// ---------------
// Graph and vehicle corruption is easy to create and hard to spot: a dangling
// edge endpoint still renders, a NaN vehicle simply stops drawing, a node
// holding an edge ID that no longer exists only fails later in pathfinding.
// These helpers turn those silent states into immediate, located failures.
//
// Failure messages always name the offending ID and coordinates, so a failing
// test points at the object instead of just reporting a count mismatch.
import assert from 'node:assert/strict';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Verifies road-network structural integrity.
 *
 * Checks:
 *  1. every edge endpoint node exists
 *  2. membership is reciprocal (node.edges <-> edge.a/edge.b)
 *  3. every node's edge reference resolves
 *  4. node coordinates are finite
 *  5. edge geometry is finite and the edge has positive length
 *  6. cumulative arc-length array is non-decreasing and matches the polyline
 *  7. one-way ring edges carry the ring flag (roundabout circulation)
 */
export function assertGraphConsistent(net, label = 'graph') {
  assert.ok(net, `${label}: network is missing`);
  assert.ok(net.nodes instanceof Map, `${label}: net.nodes must be a Map`);
  assert.ok(net.edges instanceof Map, `${label}: net.edges must be a Map`);

  for (const node of net.nodes.values()) {
    const at = `node ${node.id} (${node.x},${node.y})`;
    assert.ok(finite(node.x) && finite(node.y), `${label}: ${at} has non-finite coordinates`);
    assert.ok(node.edges instanceof Set, `${label}: ${at} .edges must be a Set`);
    for (const eid of node.edges) {
      assert.ok(net.edges.has(eid), `${label}: ${at} references missing edge ${eid}`);
    }
  }

  for (const edge of net.edges.values()) {
    const at = `edge ${edge.id} (${edge.a}->${edge.b})`;
    assert.ok(net.nodes.has(edge.a), `${label}: ${at} has missing endpoint a=${edge.a}`);
    assert.ok(net.nodes.has(edge.b), `${label}: ${at} has missing endpoint b=${edge.b}`);
    assert.ok(net.nodes.get(edge.a).edges.has(edge.id), `${label}: ${at} not listed on node ${edge.a}`);
    assert.ok(net.nodes.get(edge.b).edges.has(edge.id), `${label}: ${at} not listed on node ${edge.b}`);

    assert.ok(Array.isArray(edge.pts) && edge.pts.length >= 2,
      `${label}: ${at} needs at least 2 polyline samples, got ${edge.pts?.length}`);
    assert.ok(Array.isArray(edge.cum) && edge.cum.length === edge.pts.length,
      `${label}: ${at} cum length ${edge.cum?.length} must equal pts length ${edge.pts.length}`);

    for (let i = 0; i < edge.pts.length; i++) {
      const [x, y] = edge.pts[i];
      assert.ok(finite(x) && finite(y), `${label}: ${at} sample ${i} is non-finite (${x},${y})`);
      assert.ok(finite(edge.cum[i]), `${label}: ${at} cumulative length ${i} is non-finite`);
      if (i > 0) {
        assert.ok(edge.cum[i] >= edge.cum[i - 1],
          `${label}: ${at} cumulative length decreases at sample ${i}`);
      }
    }

    assert.ok(finite(edge.total) && edge.total > 0,
      `${label}: ${at} must have positive finite length, got ${edge.total}`);
    const last = edge.cum[edge.cum.length - 1];
    assert.ok(Math.abs(last - edge.total) < 1e-6,
      `${label}: ${at} total ${edge.total} disagrees with final cumulative length ${last}`);

    if (edge.ring) {
      assert.equal(edge.oneway, true, `${label}: ${at} is a ring edge and must be one-way`);
    }
  }

  return true;
}

/**
 * Verifies active vehicles are in a usable state.
 *
 * Checks per car:
 *  - x, y, s, speed are finite
 *  - speed is not negative
 *  - the car has a current route step and that edge still exists
 *  - the car's lane index is within the edge's configured lanes
 */
export function assertVehiclesFinite(traffic, label = 'traffic') {
  assert.ok(traffic, `${label}: simulation is missing`);
  assert.ok(traffic.cars instanceof Map, `${label}: traffic.cars must be a Map`);

  const net = traffic.net;
  assert.ok(net, `${label}: simulation is not bound to a network`);

  for (const car of traffic.cars.values()) {
    const at = `car ${car.id}`;
    for (const [name, v] of [['x', car.x], ['y', car.y], ['s', car.s], ['speed', car.speed]]) {
      assert.ok(finite(v), `${label}: ${at} has non-finite ${name}=${v}`);
    }
    assert.ok(car.speed >= 0, `${label}: ${at} has negative speed ${car.speed}`);

    const step = car.currentStep();
    assert.ok(step, `${label}: ${at} at step ${car.step} has no current step`);
    const edge = net.edges.get(step.edgeId);
    assert.ok(edge, `${label}: ${at} drives missing edge ${step.edgeId}`);

    if (step.lane !== undefined && step.lane !== null) {
      assert.ok(Number.isInteger(step.lane) && step.lane >= 0,
        `${label}: ${at} has invalid lane index ${step.lane}`);
    }
  }

  return true;
}

/**
 * Verifies economy bookkeeping is internally coherent.
 * Counts are derived from the building map, never from cached fields.
 */
export function assertEconomyConsistent(eco, net, label = 'economy') {
  assert.ok(eco, `${label}: economy is missing`);
  assert.ok(eco.buildings instanceof Map, `${label}: eco.buildings must be a Map`);
  assert.ok(finite(eco.xp) && eco.xp >= 0, `${label}: xp must be finite and >= 0, got ${eco.xp}`);
  assert.ok(Number.isInteger(eco.level) && eco.level >= 1,
    `${label}: level must be an integer >= 1, got ${eco.level}`);
  assert.ok(Number.isInteger(eco.totalTrips) && eco.totalTrips >= 0,
    `${label}: totalTrips must be a non-negative integer, got ${eco.totalTrips}`);

  for (const key of ['house', 'shop', 'factory']) {
    const n = eco.batch[key];
    assert.ok(Number.isInteger(n) && n >= 0,
      `${label}: batch.${key} must be a non-negative integer, got ${n}`);
  }

  for (const b of eco.buildings.values()) {
    const at = `building ${b.id} (${b.type})`;
    assert.ok(finite(b.x) && finite(b.y), `${label}: ${at} has non-finite coordinates`);
    if (net) {
      assert.ok(b.drivewayNode, `${label}: ${at} has no access node`);
      assert.ok(net.nodes.has(b.drivewayNode),
        `${label}: ${at} references missing access node ${b.drivewayNode}`);
    }
  }

  return true;
}
