import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork, ROAD_CLASS } from '../src/roadNetwork.js';

test('addRoad creates nodes and one edge', () => {
  const net = new RoadNetwork();
  const r = net.addRoad([[0, 0], [100, 0]], 'street');
  assert.equal(r.nodeIds.length, 2);
  assert.equal(r.edgeIds.length, 1);
  const e = net.edges.get(r.edgeIds[0]);
  assert.equal(e.cls, 'street');
  assert.ok(e.total > 99 && e.total < 101, 'length ~100');
});

test('shared endpoint creates a junction (2 edges at node)', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [100, 0]]);
  net.addRoad([[100, 0], [100, 100]]); // endpoint snaps to node (100,0)
  const junctions = [...net.nodes.values()].filter(n => n.edges.size === 2);
  assert.equal(junctions.length, 1, 'one junction with two edges');
  assert.equal(net.edges.size, 2);
});

test('mid-edge snap splits edge into two', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [100, 0]]);
  // start a new road from a point on the existing edge
  net.addRoad([[50, 0], [50, 80]]);
  const node50 = [...net.nodes.values()].find(n => Math.abs(n.x - 50) < 1 && Math.abs(n.y) < 1);
  assert.ok(node50, 'split node exists at (50,0)');
  assert.equal(node50.edges.size, 3, 'T junction with 3 edges');
  assert.equal(net.edges.size, 3);
});

test('duplicate road between same nodes is rejected', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [100, 0]]);
  const before = net.edges.size;
  net.addRoad([[100, 0], [0, 0]]);
  assert.equal(net.edges.size, before, 'no new edge for A->B when B->A exists');
});

test('removeEdge cleans up dangling nodes', () => {
  const net = new RoadNetwork();
  const r = net.addRoad([[0, 0], [100, 0]]);
  net.removeEdge(r.edgeIds[0]);
  assert.equal(net.edges.size, 0);
  assert.equal(net.nodes.size, 0);
});

test('driveway attach splits edge and tags node', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [200, 0]]);
  const node = net.attachDriveway('b1', 80, 30);
  assert.ok(node, 'driveway node created');
  assert.equal(node.type, 'driveway');
  assert.equal(node.drivewayFor, 'b1');
  const nEdges = [...net.edges.values()].filter(e => e.a === node.id || e.b === node.id);
  assert.ok(nEdges.length >= 2);
});

test('lanePoint offsets right of travel direction', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [100, 0]]);
  const e = [...net.edges.values()][0];
  // travelling a->b (east), lane 0 should be south of centerline (right-hand)
  const p = net.lanePoint(e, 1, 0, 50);
  assert.ok(p.y > 0, 'lane 0 eastbound is right of centerline');
  assert.ok(Math.abs(p.x - 50) < 1);
  // opposite direction is north
  const q = net.lanePoint(e, -1, 0, 50);
  assert.ok(q.y < 0);
});

test('lane widths per road class', () => {
  assert.ok(ROAD_CLASS.highway.width > ROAD_CLASS.avenue.width);
  assert.ok(ROAD_CLASS.avenue.width > ROAD_CLASS.street.width);
  assert.ok(ROAD_CLASS.highway.speed > ROAD_CLASS.street.speed);
});

test('legacy roundabout node converts to ring on load', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [100, 0]]);
  net.addRoad([[100, 0], [100, 100]]);
  const n = [...net.nodes.values()].find(n => n.edges.size === 2);
  n.type = 'roundabout';
  const data = net.toJSON();
  const net2 = RoadNetwork.fromJSON(data);
  const rb = [...net2.nodes.values()].find(n => n.type === 'roundabout');
  assert.ok(!rb, 'legacy point roundabout upgraded');
  const ringEdges = [...net2.edges.values()].filter(e => e.ring);
  assert.ok(ringEdges.length >= 3, 'ring edges created on load');
  for (const e of net2.edges.values()) {
    assert.ok(e.pts && e.total > 0, 'edges resampled on load');
  }
});

// ---------- real roundabout rings ----------

function fourWayNet() {
  const net = new RoadNetwork();
  net.addRoad([[-400, 0], [400, 0]]);
  net.addRoad([[0, -400], [0, 400]]);
  return net;
}

function centerOf(net) {
  return [...net.nodes.values()].find(n => n.edges.size === 4);
}

test('makeRoundabout builds a one-way ring and reconnects arms', () => {
  const net = fourWayNet();
  const center = centerOf(net);
  const armOuter = [...center.edges].map(eid => {
    const e = net.edges.get(eid);
    return net.nodes.get(e.a === center.id ? e.b : e.a);
  });
  const res = net.makeRoundabout(center.id);
  assert.ok(res, 'conversion returns result');
  // center node gone, no plain node left at that point
  assert.ok(!net.nodes.has(center.id), 'center node removed');
  const ringEdges = [...net.edges.values()].filter(e => e.ring);
  assert.ok(ringEdges.length >= 3, 'ring edges exist');
  for (const e of ringEdges) {
    assert.ok(e.oneway, 'ring edges are one-way');
    assert.ok(net.nodes.get(e.a).isRing && net.nodes.get(e.b).isRing, 'ring edges join ring nodes');
  }
  // every arm still connects to a ring node
  for (const outer of armOuter) {
    const conn = [...outer.edges].map(id => net.edges.get(id));
    const reaches = conn.some(e => net.nodes.get(e.a).isRing || net.nodes.get(e.b).isRing);
    assert.ok(reaches, 'arm still reaches the ring');
  }
  // ring nodes only have ring edges + at most one arm
  for (const n of net.nodes.values()) {
    if (!n.isRing) continue;
    const ringCount = [...n.edges].filter(id => net.edges.get(id).ring).length;
    assert.ok(ringCount === 2, 'ring node has 2 ring edges');
    assert.ok(n.edges.size === 2 || n.edges.size === 3, 'ring node has 2-3 edges');
  }
});

test('makeRoundabout survives short arms (arm shorter than radius)', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [400, 0]]);
  net.addRoad([[0, 0], [0, 400]]);
  net.addRoad([[0, 60], [-60, 60]]); // 60-long stub arm at the corner
  const corner = [...net.nodes.values()].find(n => n.edges.size === 3);
  assert.ok(corner, '3-way corner exists');
  const res = net.makeRoundabout(corner.id);
  assert.ok(res, 'conversion succeeded');
  for (const nid of res.ringNodeIds) {
    assert.ok(net.nodes.has(nid), 'ring node alive after conversion');
  }
  for (const e of net.edges.values()) {
    assert.ok(net.nodes.has(e.a) && net.nodes.has(e.b), 'no dangling edge endpoints');
  }
  const ringEdges = [...net.edges.values()].filter(e => e.ring);
  assert.ok(ringEdges.length >= 3, 'ring closed');
});

test('removeRoundabout restores a plain junction', () => {
  const net = fourWayNet();
  const center = centerOf(net);
  net.makeRoundabout(center.id);
  // find any ring node and bulldoze the roundabout
  const ringNode = [...net.nodes.values()].find(n => n.isRing);
  net.removeRoundabout(ringNode.id);
  const c2 = centerOf(net);
  assert.ok(c2, 'plain 4-way junction restored');
  const ringLeft = [...net.edges.values()].filter(e => e.ring);
  assert.equal(ringLeft.length, 0, 'ring edges gone');
});

test('roundabout survives save/load roundtrip', () => {
  const net = fourWayNet();
  const center = centerOf(net);
  net.makeRoundabout(center.id);
  const net2 = RoadNetwork.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
  const ringEdges = [...net2.edges.values()].filter(e => e.ring);
  assert.ok(ringEdges.length >= 3, 'ring edges persisted');
  assert.ok(ringEdges.every(e => e.oneway), 'oneway persisted');
  assert.ok([...net2.nodes.values()].some(n => n.isRing), 'ring nodes persisted');
});
