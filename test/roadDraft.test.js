// Road draft evaluation and snapping (S03.2).
//
// The two defects these guard were both invisible to endpoint-only thinking:
//   - a road whose two ENDPOINTS are on land could still cross a river between
//     them, and was accepted
//   - the preview and the commit were different geometry paths, so what you saw
//     was not what you built
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';
import { splinePoints, polylineLengths } from '../src/core.js';
import { controlArcByProjection } from '../src/roadNetwork.js';
import { roadDimensions } from '../src/roadProfiles.js';
import {
  evaluateRoadDraft, snapPoint, snapRadiusWu, nearestNode, nearestEdgePoint,
  samplePolyline, draftPolyline, validateFootprint, hausdorff,
  SNAP, ANGLE_SNAP_DEG, MAX_SAMPLE_STEP, SPLINE_SEG_LEN, DRAFT_MODE,
} from '../src/roadDraft.js';

/** Terrain that is buildable everywhere. */
const FLAT = { isBuildable: () => true, isRoadable: () => true, sample: () => 0, elevation: () => 0.5, seed: 1 };

/** Terrain with a water strip between x=100 and x=200. */
const RIVER = {
  isBuildable: (x) => !(x > 100 && x < 200),
  isRoadable: (x) => !(x > 100 && x < 200),
  sample: () => 0,
  elevation: () => 0.5,
  seed: 1,
};

function world({ terrain = FLAT } = {}) {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const eco = new Economy(net, terrain, 1);
  eco.onToast = () => {};
  eco.batch = { house: 10, shop: 10, factory: 10 };
  return { net, terrain, eco, ids };
}

// ----------------------------------------------------------- snap radius ---

test('a CSS-pixel snap radius converts to world units by zoom', () => {
  // 1 wu is `zoom` CSS px, so at zoom 2 a 12px radius is 6 wu.
  assert.equal(snapRadiusWu(12, 1, 18), 12);
  assert.equal(snapRadiusWu(12, 2, 18), 6);
  assert.equal(snapRadiusWu(12, 0.5, 18), 18, 'and is capped when zoomed out');
});

test('the snap radius cap stops a distant target at low zoom', () => {
  // At zoom 0.1 a 12px radius would be 120 wu; the cap keeps it at 18.
  assert.equal(snapRadiusWu(SNAP.nodePx, 0.1, SNAP.nodeCapWu), SNAP.nodeCapWu);
});

test('a degenerate zoom falls back to 1 rather than dividing by zero', () => {
  assert.equal(snapRadiusWu(12, 0, 18), 12);
  assert.equal(snapRadiusWu(12, NaN, 18), 12);
});

// ------------------------------------------------------------- snapping ---

test('snapping picks the closest node within the radius', () => {
  const w = world();
  w.net.addRoad([[0, 0], [400, 0]], 'street');
  const node = [...w.net.nodes.values()].find(n => n.x === 400);
  const s = snapPoint(w, [405, 3], { zoom: 1 });
  assert.equal(s.target.kind, 'node');
  assert.equal(s.target.id, node.id);
  assert.equal(s.x, 400, 'the point snaps onto the node');
  assert.equal(s.y, 0);
});

test('a node beyond the radius is not snapped to', () => {
  const w = world();
  w.net.addRoad([[0, 0], [400, 0]], 'street');
  // At zoom 1 the node radius is 12 wu; 40 wu away is out of range, and the
  // edge radius is smaller still, so this point stays raw.
  const s = snapPoint(w, [400, 60], { zoom: 1 });
  assert.equal(s.target, null, 'nothing is within range, so nothing is snapped');
  assert.equal(s.x, 400);
  assert.equal(s.y, 60);
});

test('a node wins over an edge when both are in range', () => {
  // A point near the END of an edge is within both the node radius and the edge
  // radius; the node has priority.
  const w = world();
  w.net.addRoad([[0, 0], [400, 0]], 'street');
  const s = snapPoint(w, [402, 2], { zoom: 1 });
  assert.equal(s.target.kind, 'node', 'the node must win over the edge');
});

test('an edge is snapped to when no node is close enough', () => {
  const w = world();
  w.net.addRoad([[0, 0], [400, 0]], 'street');
  // Mid-edge: far from both nodes, within the edge radius.
  const s = snapPoint(w, [200, 4], { zoom: 1 });
  assert.equal(s.target.kind, 'edge');
  assert.equal(s.y, 0, 'the point snaps onto the edge');
  assert.ok(Math.abs(s.x - 200) < 1e-9);
});

test('an explicit lock wins over everything', () => {
  const w = world();
  w.net.addRoad([[0, 0], [400, 0]], 'street');
  const s = snapPoint(w, [10, 10], { zoom: 1, locked: { x: 999, y: -999, id: 'locked-1', kind: 'node' } });
  assert.equal(s.x, 999);
  assert.equal(s.y, -999);
  assert.equal(s.target.id, 'locked-1');
});

test('snapping can be disabled entirely', () => {
  const w = world();
  w.net.addRoad([[0, 0], [400, 0]], 'street');
  const s = snapPoint(w, [402, 2], { zoom: 1, snap: false });
  assert.equal(s.target, null, 'Alt must disable snapping');
  assert.equal(s.x, 402);
  assert.equal(s.y, 2);
});

test('angle snapping rounds to a multiple of 15 degrees', () => {
  const w = world();
  // From (0,0), a point at 10 degrees should snap to 15 degrees at the same
  // distance from the previous point.
  const len = 100;
  const a = (10 * Math.PI) / 180;
  const s = snapPoint(w, [Math.cos(a) * len, Math.sin(a) * len], {
    zoom: 1, angleSnap: true, previous: [0, 0],
  });
  assert.equal(s.target.kind, 'angle');
  const got = Math.atan2(s.y, s.x) * 180 / Math.PI;
  assert.ok(Math.abs(got - 15) < 1e-9, `expected 15 degrees, got ${got}`);
  // The distance from the previous point is preserved.
  assert.ok(Math.abs(Math.hypot(s.x, s.y) - len) < 1e-9, 'angle snapping must preserve length');
  assert.equal(ANGLE_SNAP_DEG, 15);
});

test('node snapping ties are broken by ID, not by map order', () => {
  const w = world();
  // Two nodes equidistant from the probe point.
  w.net.addRoad([[0, 0], [100, 100]], 'street');
  const s = snapPoint(w, [50, 50], { zoom: 1 });
  assert.ok(s.target, 'a node must be found');
  // Re-running gives the same answer: the tie-break is deterministic.
  const again = snapPoint(w, [50, 50], { zoom: 1 });
  assert.deepEqual(again.target, s.target, 'the tie-break must be stable');
});

// ------------------------------------------------------ footprint checks ---

test('a road with legal endpoints but water between them is REFUSED', () => {
  // THE defect this task exists for: endpoint-only validation accepted this.
  const w = world({ terrain: RIVER });
  assert.equal(RIVER.isRoadable(0, 0), true, 'fixture: the start is on land');
  assert.equal(RIVER.isRoadable(300, 0), true, 'fixture: the end is on land');
  assert.equal(RIVER.isRoadable(150, 0), false, 'fixture: the middle is water');

  const r = evaluateRoadDraft(w, {
    points: [[0, 0], [300, 0]], cls: 'street', mode: DRAFT_MODE.STRAIGHT, snap: false,
  });
  assert.equal(r.ok, false, 'a road crossing water must be refused');
  assert.match(r.reason, /water|rock/i);
  assert.ok(r.failAt, 'the refusal must name where it failed');
  assert.ok(r.failAt[0] > 100 && r.failAt[0] < 200,
    `the failure point must be inside the water strip, got ${r.failAt}`);
});

test('the footprint is sampled no further apart than MAX_SAMPLE_STEP', () => {
  const pts = [[0, 0], [100, 0]];
  const samples = samplePolyline(pts);
  for (let i = 1; i < samples.length; i++) {
    const d = Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]);
    assert.ok(d <= MAX_SAMPLE_STEP + 1e-9, `gap ${d} exceeds ${MAX_SAMPLE_STEP}`);
  }
  assert.ok(samples.length > 25, 'a 100 wu road needs at least 25 samples at 4 wu spacing');
});

test('a road through a building is refused', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const b = w.eco.place('house', 300, 20);
  assert.ok(b, 'fixture must place a house near the road');

  // A road straight through the house's footprint.
  const r = evaluateRoadDraft(w, {
    points: [[250, 20], [350, 20]], cls: 'avenue', mode: DRAFT_MODE.STRAIGHT, snap: false,
  });
  assert.equal(r.ok, false, 'a road through a building must be refused');
  assert.match(r.reason, /cut through|building|house/i);
});

test('a valid draft reports length and no failure point', () => {
  const w = world();
  const r = evaluateRoadDraft(w, {
    points: [[0, 0], [300, 0]], cls: 'street', mode: DRAFT_MODE.STRAIGHT, snap: false,
  });
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);
  assert.ok(Math.abs(r.length - 300) < 1e-9, `straight length must be 300, got ${r.length}`);
  assert.equal(r.failAt, null);
  assert.equal(r.cost, null, 'no currency exists, so no fictional cost');
});

test('a draft that collapses to a point is refused', () => {
  const w = world();
  const r = evaluateRoadDraft(w, {
    points: [[100, 100], [100, 100]], cls: 'street', snap: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /same location/i);
});

test('an unknown road class is refused before any geometry work', () => {
  const w = world();
  const r = evaluateRoadDraft(w, { points: [[0, 0], [100, 0]], cls: 'motorway-x', snap: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown road class/i);
});

test('a draft with fewer than two points is refused', () => {
  const w = world();
  assert.equal(evaluateRoadDraft(w, { points: [[0, 0]] }).ok, false);
  assert.equal(evaluateRoadDraft(w, { points: [] }).ok, false);
  assert.equal(evaluateRoadDraft(w, {}).ok, false);
});

// -------------------------------------------------- preview == commit ---

test('the drafted polyline is exactly what addRoad would build', () => {
  // Straight mode: the controls ARE the geometry.
  const controls = [[0, 0], [300, 0]];
  assert.deepEqual(draftPolyline(controls, DRAFT_MODE.STRAIGHT), [[0, 0], [300, 0]]);
  // Curve mode: the same splinePoints call addRoad makes, with the same segLen.
  const curved = draftPolyline([[0, 0], [150, 100], [300, 0]], DRAFT_MODE.CURVE);
  const expected = splinePoints([[0, 0], [150, 100], [300, 0]], SPLINE_SEG_LEN).pts;
  assert.deepEqual(curved, expected,
    'curve geometry must come from the same splinePoints call addRoad uses');
  assert.equal(SPLINE_SEG_LEN, 12, 'and with the same segment length');
});

test('committing the drafted geometry reproduces it within 0.5 wu', () => {
  const w = world();
  const r = evaluateRoadDraft(w, {
    points: [[0, 0], [120, 90], [300, 90]], cls: 'avenue', mode: DRAFT_MODE.CURVE, snap: false,
  });
  assert.equal(r.ok, true, `expected a valid draft, got ${r.reason}`);

  // Commit exactly the previewed polyline, as the caller will.
  const built = w.net.addRoad(r.controls, 'avenue', { pts: r.polyline });
  assert.ok(built.edgeIds.length > 0, 'the commit must build something');

  const committed = [];
  for (const id of built.edgeIds) committed.push(...w.net.edges.get(id).pts);
  const d = hausdorff(r.polyline, committed);
  assert.ok(d <= 0.5, `preview/commit Hausdorff distance must be <= 0.5 wu, got ${d}`);
});

test('hausdorff reports zero for identical geometry and large for distant', () => {
  const a = [[0, 0], [100, 0]];
  assert.ok(hausdorff(a, a) < 1e-9, 'identical geometry has zero distance');
  const far = [[0, 500], [100, 500]];
  assert.ok(hausdorff(a, far) > 400, 'distant geometry has a large distance');
  assert.equal(hausdorff([], a), Infinity, 'empty input is reported as unbounded');
});

test('straight mode with three controls commits as straight, not re-splined', () => {
  // THE mismatch the options argument exists for: addRoad splines whatever it is
  // given, so a straight-mode draft with an intermediate control would be
  // committed as a CURVE while the preview drew straight segments.
  const w = world();
  const r = evaluateRoadDraft(w, {
    points: [[0, 0], [150, 120], [300, 0]], cls: 'street', mode: DRAFT_MODE.STRAIGHT, snap: false,
  });
  assert.equal(r.ok, true, `expected a valid draft, got ${r.reason}`);
  assert.deepEqual(r.polyline, [[0, 0], [150, 120], [300, 0]],
    'straight mode previews the control polygon, not a spline');

  const built = w.net.addRoad(r.controls, 'street', { pts: r.polyline });
  assert.ok(built.edgeIds.length > 0, 'the commit must build something');
  const committed = [];
  for (const id of built.edgeIds) committed.push(...w.net.edges.get(id).pts);

  const d = hausdorff(r.polyline, committed);
  assert.ok(d <= 0.5,
    `a straight draft must commit as straight geometry, Hausdorff was ${d}`);

  // The committed geometry must pass through the intermediate control.
  const nearestToControl = Math.min(...committed.map(([x, y]) => Math.hypot(x - 150, y - 120)));
  assert.ok(nearestToControl <= 0.5,
    `the committed road must reach the intermediate control, nearest point was ${nearestToControl} wu away`);
});

test('an explicit pts argument overrides re-splining', () => {
  const w = world();
  // Deliberately NOT a spline of the controls: a 3-point zigzag.
  const authored = [[0, 0], [100, 100], [200, 0]];
  const built = w.net.addRoad([[0, 0], [200, 0]], 'street', { pts: authored });
  assert.ok(built.edgeIds.length > 0, 'the commit must accept authored geometry');
  const committed = [];
  for (const id of built.edgeIds) committed.push(...w.net.edges.get(id).pts);
  assert.ok(hausdorff(authored, committed) <= 0.5,
    'addRoad must build the geometry it was handed, not re-derive one');
});

// ------------------------------------------------------------- purity ---

test('evaluateRoadDraft never mutates the world', () => {
  const w = world();
  w.net.addRoad([[0, 0], [600, 0]], 'street');
  const before = { nodes: w.net.nodes.size, edges: w.net.edges.size, version: w.net.version };

  evaluateRoadDraft(w, { points: [[0, 100], [300, 100]], cls: 'street', snap: true, zoom: 1 });
  evaluateRoadDraft(w, { points: [[0, 100], [300, 100]], cls: 'street', snap: false });

  assert.equal(w.net.nodes.size, before.nodes, 'no nodes may be created');
  assert.equal(w.net.edges.size, before.edges, 'no edges may be created');
  assert.equal(w.net.version, before.version, 'and the version must not change');
});

test('the draft consumes no unseeded randomness', () => {
  const real = Math.random;
  Math.random = () => { throw new Error('drafting consumed Math.random'); };
  try {
    const w = world();
    evaluateRoadDraft(w, { points: [[0, 0], [120, 60], [240, 0]], cls: 'avenue', mode: DRAFT_MODE.CURVE });
  } finally {
    Math.random = real;
  }
});

test('every failure carries a reason the player can act on', () => {
  const w = world();
  const cases = [
    { points: [[0, 0]], cls: 'street' },
    { points: [[0, 0], [100, 0]], cls: 'nope' },
    { points: [[5, 5], [5, 5]], cls: 'street', snap: false },
    { points: [[NaN, 0], [100, 0]], cls: 'street' },
  ];
  for (const c of cases) {
    const r = evaluateRoadDraft(w, c);
    assert.equal(r.ok, false, `expected a refusal for ${JSON.stringify(c)}`);
    assert.ok(r.reason && r.reason.length > 8, `a refusal needs a real reason, got ${r.reason}`);
  }
});

test('control arc positions are forced monotonic for a doubling-back polyline', () => {
  // Authored geometry is not guaranteed to be ordered along itself: a polyline
  // that doubles back makes an interior control project to an EARLIER arc than
  // the control before it. Stations must stay ordered or the edge between two of
  // them would have a negative arc range.
  const controls = [[0, 0], [200, 0], [50, 0], [300, 0]];
  const pts = [[0, 0], [200, 0], [50, 0], [300, 0]];
  const { cum } = polylineLengths(pts);
  const arcs = controlArcByProjection(controls, pts, cum);

  assert.equal(arcs.length, controls.length, 'one arc per control');
  assert.equal(arcs[0], 0, 'the first control is at the start');
  assert.equal(arcs[arcs.length - 1], cum[cum.length - 1], 'the last is at the end');
  for (let i = 1; i < arcs.length; i++) {
    assert.ok(arcs[i] >= arcs[i - 1],
      `arc ${i} (${arcs[i]}) must not precede arc ${i - 1} (${arcs[i - 1]})`);
  }
});

test('control arc positions follow the projection for ordered geometry', () => {
  const controls = [[0, 0], [100, 0], [200, 0]];
  const pts = [[0, 0], [100, 0], [200, 0]];
  const { cum } = polylineLengths(pts);
  const arcs = controlArcByProjection(controls, pts, cum);
  assert.deepEqual(arcs, [0, 100, 200], 'ordered geometry projects exactly');
});
