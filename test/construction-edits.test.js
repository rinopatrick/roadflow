// Safe construction edits (S03.4).
//
// The rule under test: a command "must not silently evict a building or
// invalidate data to succeed". So each of these edits is validated BEFORE it
// commits, and a refusal leaves the world untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource, dist } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { makeRng } from '../src/core.js';
import { serializeWorld } from '../src/worldSnapshot.js';
import { createHistory } from '../src/worldCommands.js';
import {
  ROUNDABOUT_RADIUS, UPGRADE_CLASSES, pavementHalfWidth,
  validateRoadUpgrade, validateRoundaboutRadius, validateBuildingMove,
  demolitionPreview, demolitionLabel,
} from '../src/constructionEdits.js';

const FLAT = { isBuildable: () => true, isRoadable: () => true, sample: () => 0, elevation: () => 0.5, seed: 1 };

function world({ terrain = FLAT } = {}) {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const eco = new Economy(net, terrain, 1);
  eco.onToast = () => {};
  eco.batch = { house: 10, shop: 10, factory: 10 };
  // A complete world: serializeWorld needs the traffic sim, and the purity test
  // compares whole snapshots.
  const traffic = new TrafficSim(net, { rng: makeRng(1) });
  return { net, terrain, eco, ids, traffic, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 0, audio: true } };
}

/** The single non-driveway edge of a one-road world. */
function mainEdge(w) {
  return [...w.net.edges.values()].find(e => e.cls !== 'driveway');
}

// ------------------------------------------------------------- upgrade ---

test('the upgrade classes are exactly street, avenue and highway', () => {
  assert.deepEqual(UPGRADE_CLASSES, ['street', 'avenue', 'highway']);
});

test('pavement half width grows with the class', () => {
  const s = pavementHalfWidth('street');
  const a = pavementHalfWidth('avenue');
  const h = pavementHalfWidth('highway');
  assert.ok(s > 0, 'a street has width');
  assert.ok(a > s, `avenue (${a}) must be wider than street (${s})`);
  assert.ok(h > a, `highway (${h}) must be wider than avenue (${a})`);
});

test('a clear road upgrades in place and keeps its edge ID', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const edge = mainEdge(w);
  const id = edge.id;

  const r = validateRoadUpgrade(w, id, 'avenue');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.edgeId, id, 'the edge ID must be preserved');
  assert.equal(r.from, 'street');
  assert.equal(r.to, 'avenue');
});

test('narrowing is always allowed, because it cannot swallow anything', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'highway');
  // A house right against the highway: narrowing is still fine.
  w.eco.place('house', 300, 40);
  const edge = mainEdge(w);
  const r = validateRoadUpgrade(w, edge.id, 'street');
  assert.equal(r.ok, true, `narrowing must be allowed, got: ${r.reason}`);
});

test('widening beside a house is REJECTED, naming the building', () => {
  // The headline case from the task: "widen road beside house (reject)".
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const house = w.eco.place('house', 300, 26);
  assert.ok(house, 'fixture must place a house near the road');
  const edge = mainEdge(w);

  // A house at y=26 sits inside the highway's pavement but clear of a street's.
  assert.ok(pavementHalfWidth('street') + 22 / 2 < 26,
    'fixture: the house must be clear of a street');
  const r = validateRoadUpgrade(w, edge.id, 'highway');
  assert.equal(r.ok, false, 'widening into a house must be refused');
  assert.match(r.reason, /cut through a house/i, `the reason must name it, got: ${r.reason}`);
  assert.deepEqual(r.at, [house.x, house.y], 'and point at the building');
});

test('widening over unbuildable ground is rejected with the point', () => {
  // A strip of water just outside the street's pavement but inside the highway's.
  const half = pavementHalfWidth('highway');
  // Everything above y=10 is unbuildable: a street (half ~8) fits, a highway
  // (half ~20) does not.
  const narrow = { ...FLAT, isRoadable: (x, y) => !(y > 10) };
  const w = world({ terrain: narrow });
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const edge = mainEdge(w);

  const r = validateRoadUpgrade(w, edge.id, 'highway');
  assert.equal(r.ok, false, 'widening onto unbuildable ground must be refused');
  assert.ok(r.at, 'and must name where');
  assert.ok(Math.abs(r.at[1]) > 10, `the failure point must be off the centreline, got ${r.at[1]}`);
});

test('an upgrade to the same class, an unknown class, a missing edge or a ring is refused', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const edge = mainEdge(w);
  assert.equal(validateRoadUpgrade(w, edge.id, 'street').ok, false, 'same class');
  assert.equal(validateRoadUpgrade(w, edge.id, 'motorway').ok, false, 'unknown class');
  assert.equal(validateRoadUpgrade(w, 'nope', 'avenue').ok, false, 'missing edge');
  assert.equal(validateRoadUpgrade(null, edge.id, 'avenue').ok, false, 'missing world');

  // A roundabout ring edge must not be upgraded in place.
  const w2 = world();
  w2.net.addRoad([[-400, 0], [400, 0]], 'street');
  w2.net.addRoad([[0, -400], [0, 400]], 'street');
  const junction = [...w2.net.nodes.values()].find(n => n.edges.size === 4);
  assert.ok(w2.net.makeRoundabout(junction.id), 'fixture must build a roundabout');
  const ring = [...w2.net.edges.values()].find(e => e.ring);
  const r = validateRoadUpgrade(w2, ring.id, 'avenue');
  assert.equal(r.ok, false, 'a ring edge must be refused');
  assert.match(r.reason, /roundabout/i);
});

// --------------------------------------------------------- roundabout ---

test('the radius bounds are 24 to 100 wu', () => {
  assert.equal(ROUNDABOUT_RADIUS.min, 24);
  assert.equal(ROUNDABOUT_RADIUS.max, 100);
  assert.ok(ROUNDABOUT_RADIUS.default >= ROUNDABOUT_RADIUS.min
    && ROUNDABOUT_RADIUS.default <= ROUNDABOUT_RADIUS.max, 'the default must be in range');
});

/** A crossroads with long arms, ready to become a roundabout. */
function crossroads() {
  const w = world();
  w.net.addRoad([[-600, 0], [600, 0]], 'street');
  w.net.addRoad([[0, -600], [0, 600]], 'street');
  const junction = [...w.net.nodes.values()].find(n => n.edges.size === 4);
  return { w, junction };
}

test('a radius inside the bounds is accepted', () => {
  const { w, junction } = crossroads();
  for (const radius of [ROUNDABOUT_RADIUS.min, 40, ROUNDABOUT_RADIUS.max]) {
    const r = validateRoundaboutRadius(w, junction.id, radius);
    assert.equal(r.ok, true, `radius ${radius}: ${r.reason}`);
    assert.equal(r.radius, radius);
  }
});

test('a radius outside the bounds is refused with the range', () => {
  const { w, junction } = crossroads();
  for (const radius of [ROUNDABOUT_RADIUS.min - 1, ROUNDABOUT_RADIUS.max + 1, 0, -20]) {
    const r = validateRoundaboutRadius(w, junction.id, radius);
    assert.equal(r.ok, false, `radius ${radius} must be refused`);
    assert.match(r.reason, /between 24 and 100/, `the reason must name the range, got: ${r.reason}`);
  }
});

test('a non-numeric radius is refused', () => {
  const { w, junction } = crossroads();
  for (const radius of [NaN, Infinity, undefined, 'big']) {
    assert.equal(validateRoundaboutRadius(w, junction.id, radius).ok, false,
      `radius ${radius} must be refused`);
  }
});

test('a radius larger than an arm is refused, because it would swallow it', () => {
  const w = world();
  // A short arm: 30 wu from the junction.
  w.net.addRoad([[-400, 0], [400, 0]], 'street');
  w.net.addRoad([[0, 0], [0, 30]], 'street');
  const junction = [...w.net.nodes.values()].find(n => n.edges.size === 3);
  assert.ok(junction, 'fixture must make a T junction');

  const big = validateRoundaboutRadius(w, junction.id, 100);
  assert.equal(big.ok, false, 'a 100 wu radius on a 30 wu arm must be refused');
  assert.match(big.reason, /shorter|swallow/i);

  const small = validateRoundaboutRadius(w, junction.id, 24);
  assert.equal(small.ok, true, `24 wu should fit a 30 wu arm, got: ${small.reason}`);
});

test('a junction with fewer than two roads cannot be a roundabout', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const end = [...w.net.nodes.values()].find(n => n.edges.size === 1);
  const r = validateRoundaboutRadius(w, end.id, 32);
  assert.equal(r.ok, false);
  assert.match(r.reason, /at least two roads/i);
});

test('a building driveway inside the ring is refused', () => {
  const { w, junction } = crossroads();
  // Attach a building to the junction node itself. `attachDriveway` snaps to the
  // nearest road point, so a building beside a junction can share the junction
  // node as its access - which is exactly the case where a big ring would
  // swallow a driveway without shortening any arm.
  // (5,5) snaps to the JUNCTION node itself without splitting any arm, because
  // the nearest road point is within NODE_SNAP of the node.
  const house = w.eco.place('house', 5, 5);
  assert.ok(house, 'fixture must place a house');
  assert.equal(house.drivewayNode, junction.id,
    'fixture: the driveway must snap to the junction node itself');
  const node = w.net.nodes.get(junction.id);
  assert.equal(dist(node.x, node.y, junction.x, junction.y), 0,
    'fixture: the access node is the junction itself');

  const r = validateRoundaboutRadius(w, junction.id, 100);
  assert.equal(r.ok, false, 'a driveway inside the ring must be refused');
  assert.match(r.reason, /driveway/i);
});

test('a missing junction is refused', () => {
  const { w } = crossroads();
  assert.equal(validateRoundaboutRadius(w, 'nope', 32).ok, false);
  assert.equal(validateRoundaboutRadius(null, 'nope', 32).ok, false);
});

// --------------------------------------------------------- relocation ---

test('a building moves to a legal position and keeps its identity', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const house = w.eco.place('house', 100, 40);
  assert.ok(house, 'fixture must place the house');

  const r = validateBuildingMove(w, house.id, 400, 40);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.buildingId, house.id, 'the ID must be preserved');
  assert.ok(r.drivewayTarget, 'and the new access point must be reported');
});

test('a move that would overlap ANOTHER building is refused', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const a = w.eco.place('house', 100, 40);
  const b = w.eco.place('shop', 400, 40);
  assert.ok(a && b, 'fixture must place both');

  const r = validateBuildingMove(w, a.id, b.x, b.y);
  assert.equal(r.ok, false, 'moving onto another building must be refused');
  assert.match(r.reason, /close|overlap/i);
});

test('a building is not blocked by ITSELF', () => {
  // The subtle one: the moved building must be excluded from the overlap test, or
  // every move would collide with the place it is leaving.
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const house = w.eco.place('house', 300, 40);
  assert.ok(house);
  const r = validateBuildingMove(w, house.id, house.x + 10, house.y);
  assert.equal(r.ok, true, `a small move must not collide with itself: ${r.reason}`);
});

test('a move off the road reach or onto water is refused', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const house = w.eco.place('house', 300, 40);
  assert.ok(house);

  assert.equal(validateBuildingMove(w, house.id, 300, 5000).ok, false,
    'far from any road must be refused');

  const water = { ...FLAT, isBuildable: () => false };
  const w2 = world({ terrain: water });
  w2.net.addRoad([[0, 0], [600, 0]], 'street');
  const h2 = w2.eco.place('house', 300, 40);
  if (h2) {
    assert.equal(validateBuildingMove(w2, h2.id, 320, 40).ok, false,
      'unbuildable ground must be refused');
  }
});

test('a move of an unknown building is refused', () => {
  const w = world();
  assert.equal(validateBuildingMove(w, 'nope', 0, 0).ok, false);
  assert.equal(validateBuildingMove(null, 'nope', 0, 0).ok, false);
});

test('a move does not consume or refund stock', () => {
  // Validating a move must be pure: it is a question, not an action.
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const house = w.eco.place('house', 300, 40);
  const before = { ...w.eco.batch };
  validateBuildingMove(w, house.id, 400, 40);
  assert.deepEqual(w.eco.batch, before, 'validating a move must not touch inventory');
});

// -------------------------------------------------------- demolition ---

test('a demolition preview names the building it would remove', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const house = w.eco.place('house', 300, 40);
  assert.ok(house);

  const p = demolitionPreview(w, house.x, house.y);
  assert.equal(p.kind, 'building');
  assert.deepEqual(p.buildingIds, [house.id]);
  assert.match(demolitionLabel(p), /house/i);
});

test('clicking a roundabout reports the WHOLE ring, not one piece', () => {
  // DESIGN section 1: an action must not take more than it appears to.
  const { w, junction } = crossroads();
  assert.ok(w.net.makeRoundabout(junction.id), 'fixture must build the roundabout');
  const ringEdge = [...w.net.edges.values()].find(e => e.ring);
  const mid = ringEdge.pts[Math.floor(ringEdge.pts.length / 2)];

  const p = demolitionPreview(w, mid[0], mid[1]);
  assert.equal(p.kind, 'roundabout');
  const allRing = [...w.net.edges.values()].filter(e => e.ring).length;
  assert.equal(p.edgeIds.length, allRing,
    `the preview must list all ${allRing} ring edges, listed ${p.edgeIds.length}`);
  assert.match(p.description, /whole roundabout/i);
});

test('a shared driveway reports every building that uses it', () => {
  // Two buildings either side of one road point share an access node.
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const a = w.eco.place('house', 300, 40);
  const b = w.eco.place('house', 300, -40);
  assert.ok(a && b, 'fixture must place both');
  assert.equal(a.drivewayNode, b.drivewayNode, 'fixture: they share an access node');

  const p = demolitionPreview(w, a.x, a.y);
  assert.equal(p.kind, 'building');
  assert.deepEqual([...p.buildingIds].sort(), [a.id, b.id].sort(),
    'the preview must name BOTH buildings sharing the driveway');
});

test('a plain road reports one edge, and empty ground reports nothing', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const p = demolitionPreview(w, 300, 0);
  assert.ok(['edge', 'node'].includes(p.kind), `expected a road piece, got ${p.kind}`);
  if (p.kind === 'edge') assert.equal(p.edgeIds.length, 1);

  const empty = demolitionPreview(w, 5000, 5000);
  assert.equal(empty.kind, 'none');
  assert.deepEqual(empty.buildingIds, []);
  assert.equal(demolitionLabel(empty), '');
});

test('the preview is pure and tolerates a missing world', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const house = w.eco.place('house', 300, 40);
  const before = JSON.stringify(serializeWorld(w)).replace(/"savedAt":\d+,?/, '');

  demolitionPreview(w, house.x, house.y);
  demolitionPreview(w, 0, 0);

  const after = JSON.stringify(serializeWorld(w)).replace(/"savedAt":\d+,?/, '');
  assert.equal(after, before, 'a preview must not change the world');
  assert.equal(demolitionPreview(null, 0, 0).kind, 'none');
  assert.equal(demolitionPreview({}, 0, 0).kind, 'none');
});

// -------------------------------------------------- twenty mixed edits ---

test('twenty mixed edits then undo-all restores the original snapshot', () => {
  // The task's acceptance criterion. Uses the REAL command layer, so this is the
  // integration of S03.1's undo with S03.4's edits.
  const w = world();
  // A T junction: a degree-3 node, which is what setSignal needs.
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  w.net.addRoad([[300, 0], [300, 600]], 'street');
  const junction = [...w.net.nodes.values()].find(n => n.edges.size === 3);
  assert.ok(junction, 'fixture must have a degree-3 junction');

  const strip = (x) => JSON.stringify(serializeWorld(x)).replace(/"savedAt":\d+,?/, '');
  const original = strip(w);

  const h = createHistory();
  let live = w;

  // Twenty mixed edits: placements, signal changes, removals and new roads.
  for (let i = 0; i < 20; i++) {
    const kind = i % 4;
    let cmd = null;
    if (kind === 0) {
      cmd = { kind: 'placeBuilding', type: 'house', x: 150 + i * 20, y: 60 };
    } else if (kind === 1) {
      cmd = { kind: 'setSignal', nodeId: junction.id, light: { cycle: 20 + (i % 10), greenRatio: 0.4, offset: 1 } };
    } else if (kind === 2) {
      const b = [...live.eco.buildings.values()][0];
      cmd = b ? { kind: 'removeBuilding', id: b.id } : null;
    } else {
      cmd = { kind: 'addRoad', controls: [[100, 400 + i * 10], [400, 400 + i * 10]], cls: 'street' };
    }
    if (!cmd) continue;
    const r = h.execute(live, cmd);
    if (r.ok) live = r.world;
  }

  const applied = h.depth;
  assert.ok(applied >= 10, `at least ten of the twenty edits must succeed, applied ${applied}`);

  // Undo every recorded edit.
  for (let i = 0; i < applied; i++) {
    const u = h.undo(live);
    assert.equal(u.ok, true, `undo ${i} failed: ${u.reason}`);
    live = u.world;
  }

  assert.equal(h.depth, 0, 'the history must be empty');
  assert.equal(strip(live), original,
    `undoing every edit must restore the original world exactly (${applied} undone)`);
});

test('closely spaced arms are refused at a SMALL radius', () => {
  // The chord between two adjacent arms is 2 * R * sin(gap / 2), so a BIGGER
  // ring spreads the mouths further apart. The failure mode is therefore a
  // radius too small for the arms, not too large: two mouths 8 degrees apart
  // need more circumference than a 24 wu ring has.
  const w = world();
  const a1 = (4 * Math.PI) / 180;
  const a2 = (12 * Math.PI) / 180;
  w.net.addRoad([[0, 0], [Math.cos(a1) * 600, Math.sin(a1) * 600]], 'street');
  w.net.addRoad([[0, 0], [Math.cos(a2) * 600, Math.sin(a2) * 600]], 'street');
  const junction = [...w.net.nodes.values()].find(n => n.edges.size === 2);
  assert.ok(junction, 'fixture must make a two-arm node');

  const small = validateRoundaboutRadius(w, junction.id, ROUNDABOUT_RADIUS.min);
  assert.equal(small.ok, false,
    '8-degree arms cannot fit on a 24 wu ring');
  assert.match(small.reason, /narrow an angle/i, `got: ${small.reason}`);
});

test('the same closely spaced arms ARE accepted at a large radius', () => {
  // The inverse, and the point of the rule being a threshold: 100 wu of
  // circumference spreads the same two mouths far enough apart.
  const w = world();
  const a1 = (4 * Math.PI) / 180;
  const a2 = (12 * Math.PI) / 180;
  w.net.addRoad([[0, 0], [Math.cos(a1) * 600, Math.sin(a1) * 600]], 'street');
  w.net.addRoad([[0, 0], [Math.cos(a2) * 600, Math.sin(a2) * 600]], 'street');
  const junction = [...w.net.nodes.values()].find(n => n.edges.size === 2);
  assert.ok(junction, 'fixture must make a two-arm node');

  const big = validateRoundaboutRadius(w, junction.id, ROUNDABOUT_RADIUS.max);
  assert.equal(big.ok, true, `a 100 wu ring should fit them, got: ${big.reason}`);
});

test('clicking a roundabout NODE also reports the whole ring', () => {
  // The preview has two branches that must agree: one for a ring NODE and one for
  // a ring EDGE. Both must report the entire ring, or a click near a junction
  // would under-report what it removes.
  const { w, junction } = crossroads();
  assert.ok(w.net.makeRoundabout(junction.id, 40), 'fixture must build the roundabout');

  const ringNode = [...w.net.nodes.values()].find(n => n.isRing);
  assert.ok(ringNode, 'fixture must have a ring node');

  const p = demolitionPreview(w, ringNode.x, ringNode.y);
  assert.equal(p.kind, 'roundabout');
  const allRing = [...w.net.edges.values()].filter(e => e.ring).length;
  assert.equal(p.edgeIds.length, allRing,
    `a ring-node click must list all ${allRing} ring edges, listed ${p.edgeIds.length}`);
});
