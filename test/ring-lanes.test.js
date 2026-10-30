// S04.6: two-lane ring policy. Outer lane serves near exits, inner lane only
// via designated legal connectors; no voluntary lane changes inside a ring;
// impossible patterns rejected.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { createIdSource } from '../src/core.js';
import { profileFor } from '../src/roadProfiles.js';
import { buildJunctionConnectors } from '../src/junctions.js';

function ring4({ lanes = 1 } = {}) {
  const net = new RoadNetwork({ ids: createIdSource() });
  const c = net._makeNode(0, 0, 'plain');
  const n = net._makeNode(0, -200, 'plain');
  const s = net._makeNode(0, 200, 'plain');
  const e = net._makeNode(200, 0, 'plain');
  const w = net._makeNode(-200, 0, 'plain');
  for (const [a, b] of [[n, c], [c, s], [w, c], [c, e]]) {
    const ed = net._makeEdge(a.id, b.id, 'street', []);
    net.resampleEdge(ed);
  }
  const made = net.makeRoundabout(c.id, 40);
  assert.ok(made, 'ring builds');
  if (lanes === 2) {
    const ok = net.setRingLanes([...net.edges.values()].find(e => e.ring).a, 2);
    assert.equal(ok, true, 'two-lane ring accepted');
  }
  return net;
}

describe('S04.6 two-lane ring', () => {
  it('single-lane ring is the default: forward 1 / backward 0', () => {
    const net = ring4();
    for (const e of net.edges.values()) {
      if (!e.ring) continue;
      const p = profileFor(e);
      assert.equal(p.forward, 1);
      assert.equal(p.backward, 0);
    }
  });

  it('two-lane ring: ring edges carry forward 2', () => {
    const net = ring4({ lanes: 2 });
    const rings = [...net.edges.values()].filter(e => e.ring);
    assert.ok(rings.length > 0);
    for (const e of rings) assert.equal(profileFor(e).forward, 2);
  });

  it('three lanes rejected: only 1 or 2 ring lanes supported', () => {
    const net = ring4();
    const anchor = [...net.edges.values()].find(e => e.ring).a;
    assert.equal(net.setRingLanes(anchor, 3), false);
    assert.equal(net.setRingLanes(anchor, 0), false);
  });

  it('ring connectors exist at every arm entry in both policies', () => {
    for (const lanes of [1, 2]) {
      const net = ring4({ lanes });
      const ringNodes = [...net.nodes.values()].filter(n => n.isRing);
      assert.ok(ringNodes.length >= 4);
      let total = 0;
      for (const n of ringNodes) total += buildJunctionConnectors(net, n.id).length;
      assert.ok(total > 0, `lanes=${lanes}: ring entries have connectors`);
    }
  });

  it('release matrix: every class × direction combo routes legally', async () => {
    const { findVehicleRoute } = await import('../src/pathfinding.js');
    for (const cls of ['street', 'avenue', 'highway']) {
      for (const oneway of [false, true]) {
        const net = new RoadNetwork({ ids: createIdSource() });
        const a = net._makeNode(0, 0, 'plain');
        const b = net._makeNode(300, 0, 'plain');
        const ed = net._makeEdge(a.id, b.id, cls, []);
        if (oneway) { ed.oneway = true; ed.profile = { ...profileFor(ed), backward: 0, medianWidth: 0 }; }
        net.resampleEdge(ed);
        const fwd = findVehicleRoute(net, a.id, b.id);
        assert.ok(fwd, `${cls} oneway=${oneway}: forward routes`);
        const back = findVehicleRoute(net, b.id, a.id);
        assert.equal(!!back, !oneway, `${cls} oneway=${oneway}: reverse ${oneway ? 'blocked' : 'routes'}`);
      }
    }
  });
});
