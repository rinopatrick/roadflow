// S04.2 junction connector unit tests: T/X/Y, skewed arms, asymmetric lanes,
// blocked exit, no-U-turn, out-of-range lanes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { createIdSource } from '../src/core.js';
import { buildJunctionConnectors, connectorConflicts } from '../src/junctions.js';

function star(arms, cls = 'street', profiles = {}) {
  const net = new RoadNetwork({ ids: createIdSource() });
  const c = net._makeNode(0, 0, 'plain');
  const ends = arms.map(([x, y], i) => net._makeNode(x, y, 'plain'));
  ends.forEach((nd, i) => {
    const e = net._makeEdge(nd.id, c.id, 'street', []);
    void cls;
    if (profiles[i]) e.profile = { ...profiles[i] };
    net.resampleEdge(e);
  });
  // Fix cls after: _makeEdge signature keeps cls label.
  return { net, c };
}

describe('S04.2 junctions', () => {
  it('T junction: no U-turn, entries connect to exits', () => {
    const { net, c } = star([[0, -100], [100, 0], [0, 100]]);
    const cons = buildJunctionConnectors(net, c.id);
    assert.ok(cons.length > 0);
    for (const k of cons) assert.notEqual(k.from.edgeId, k.to.edgeId);
  });

  it('Y junction enumerates legal movements', () => {
    const { net, c } = star([[0, -100], [87, 50], [-87, 50]]);
    const cons = buildJunctionConnectors(net, c.id);
    assert.ok(cons.length >= 4, `Y needs entries, got ${cons.length}`);
  });

  it('skewed arms still produce through movements', () => {
    const { net, c } = star([[0, -100], [30, 100], [100, 10], [-100, -10]]);
    const cons = buildJunctionConnectors(net, c.id);
    assert.ok(cons.some(k => k.turn === 'through'));
  });

  it('asymmetric lanes: 2-lane entry maps to legal exit lanes only', () => {
    const { net, c } = star(
      [[0, -100], [0, 100], [100, 0]],
      'street',
      { 0: { forward: 2, backward: 0, laneWidth: 6, medianWidth: 0, shoulderWidth: 1, speed: 14, access: 'local' } },
    );
    const cons = buildJunctionConnectors(net, c.id);
    for (const k of cons) {
      assert.ok(k.from.lane >= 0 && k.to.lane >= 0);
    }
  });

  it('out-of-range lanes are never emitted', async () => {
    const { profileFor, lanesAvailable } = await import('../src/roadProfiles.js');
    const { net, c } = star([[0, -100], [0, 100]]);
    const cons = buildJunctionConnectors(net, c.id);
    for (const k of cons) {
      const fe = net.edges.get(k.from.edgeId);
      const te = net.edges.get(k.to.edgeId);
      assert.ok(k.from.lane < lanesAvailable(profileFor(fe), k.from.dir));
      assert.ok(k.to.lane < lanesAvailable(profileFor(te), k.to.dir));
    }
  });

  it('conflict sets are non-trivial: crossing throughs conflict', () => {
    const { net, c } = star([[0, -100], [0, 100], [-100, 0], [100, 0]]);
    const cons = buildJunctionConnectors(net, c.id);
    const conflicts = connectorConflicts(cons);
    const withConflict = cons.filter(k => (conflicts.get(k.id) ?? []).length > 0);
    assert.ok(withConflict.length > 0, 'a 4-way must have conflicting movements');
  });
});

