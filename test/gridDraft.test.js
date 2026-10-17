// Three-click rotated road grid (S03.3).
//
// The acceptance criterion says expected node and edge counts must come from
// ANALYTICAL counts, not from looking at a screenshot. So the tests compute what
// a lattice of N x M lines must produce and assert exactly that:
//
//   N perpendicular + M parallel lines, each spanning the full extent
//     -> N*M intersections
//     -> N*M nodes
//     -> N*(M-1) + M*(N-1) edges
//
// That is independent of rotation, which is the whole point of building the
// grid in a local frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';
import {
  axisStops, gridFrame, localToWorld, gridSegments, evaluateGridDraft,
  gridBounds, GRID_LIMITS, MIN_BASE_WU, MIN_WIDTH_WU, MAX_GRID_SEGMENTS,
} from '../src/gridDraft.js';

const FLAT = { isBuildable: () => true, isRoadable: () => true, sample: () => 0, elevation: () => 0.5, seed: 1 };
const RIVER = {
  isBuildable: (x) => !(x > 250 && x < 350),
  isRoadable: (x) => !(x > 250 && x < 350),
  sample: () => 0, elevation: () => 0.5, seed: 1,
};

function world({ terrain = FLAT } = {}) {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const eco = new Economy(net, terrain, 1);
  eco.onToast = () => {};
  return { net, terrain, eco, ids };
}

/** Rotates a point about the origin, for the rotated-grid fixtures. */
function rot([x, y], deg) {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
}

/** Analytical expectation for an N x M lattice of full-span lines. */
function lattice(nLines, mLines) {
  return {
    nodes: nLines * mLines,
    edges: nLines * (mLines - 1) + mLines * (nLines - 1),
  };
}

// ---------------------------------------------------------------- stops ---

test('axis stops always include both ends and are evenly spaced', () => {
  assert.deepEqual(axisStops(600, 200), [0, 200, 400, 600]);
  for (const [span, step] of [[410, 200], [100, 200], [400, 160], [37, 400]]) {
    const stops = axisStops(span, step);
    assert.equal(stops[0], 0, `span ${span}: must start at 0`);
    assert.ok(Math.abs(stops[stops.length - 1] - span) < 1e-9,
      `span ${span}: must end at the span, got ${stops[stops.length - 1]}`);
    assert.ok(stops.length >= 2, `span ${span}: needs at least two lines`);
    const gap = stops[1] - stops[0];
    for (let i = 1; i < stops.length; i++) {
      assert.ok(Math.abs((stops[i] - stops[i - 1]) - gap) < 1e-9,
        `span ${span}: spacing must be even`);
      assert.ok(stops[i] > stops[i - 1], `span ${span}: must ascend`);
    }
  }
});

test('axis stops never leave an unbuildable sliver at the far edge', () => {
  // A fixed 200 wu step on a 410 wu span would end in a 10 wu stub.
  const stops = axisStops(410, 200);
  const gap = stops[1] - stops[0];
  assert.ok(gap > MIN_BASE_WU, `spacing ${gap} must be buildable`);
  assert.ok(stops.length === 3, `410/200 rounds to 2 blocks, got ${stops.length - 1}`);
});

test('a degenerate span or step yields a single stop rather than throwing', () => {
  assert.deepEqual(axisStops(0, 200), [0]);
  assert.deepEqual(axisStops(-50, 200), [0]);
  assert.deepEqual(axisStops(600, 0), [0]);
  assert.deepEqual(axisStops(NaN, 200), [0]);
});

// ---------------------------------------------------------------- frame ---

test('the frame is a right-handed local basis', () => {
  const f = gridFrame({ a: [0, 0], b: [600, 0], c: [0, 400] });
  assert.equal(f.ok, true, f.reason);
  assert.deepEqual(f.dir, [1, 0]);
  assert.deepEqual(f.normal, [0, 1]);
  assert.equal(f.baseLen, 600);
  assert.equal(f.width, 400);
  // The basis must be orthonormal.
  assert.ok(Math.abs(Math.hypot(...f.dir) - 1) < 1e-9, 'dir must be a unit vector');
  assert.ok(Math.abs(Math.hypot(...f.normal) - 1) < 1e-9, 'normal must be a unit vector');
  assert.ok(Math.abs(f.dir[0] * f.normal[0] + f.dir[1] * f.normal[1]) < 1e-9,
    'dir and normal must be perpendicular');
});

test('the frame is orthonormal at every rotation', () => {
  for (const deg of [0, 30, 45, 90, 137]) {
    const b = rot([600, 0], deg);
    const c = rot([0, 400], deg);
    const f = gridFrame({ a: [0, 0], b, c });
    assert.equal(f.ok, true, `${deg}deg: ${f.reason}`);
    assert.ok(Math.abs(f.baseLen - 600) < 1e-9, `${deg}deg: base length must be rotation-invariant`);
    assert.ok(Math.abs(f.width - 400) < 1e-9, `${deg}deg: width must be rotation-invariant`);
    assert.ok(Math.abs(f.dir[0] * f.normal[0] + f.dir[1] * f.normal[1]) < 1e-9,
      `${deg}deg: the basis must stay perpendicular`);
  }
});

test('dragging C to the other side mirrors the normal instead of failing', () => {
  const up = gridFrame({ a: [0, 0], b: [600, 0], c: [0, 400] });
  const down = gridFrame({ a: [0, 0], b: [600, 0], c: [0, -400] });
  assert.equal(up.ok, true);
  assert.equal(down.ok, true, down.reason);
  assert.equal(down.width, up.width, 'the width is a magnitude');
  assert.deepEqual(down.normal, [0, -1], 'and the normal flips to match the drag');
});

test('a reversed base (B behind A) still gives a positive base length', () => {
  const f = gridFrame({ a: [600, 0], b: [0, 0], c: [600, 400] });
  assert.equal(f.ok, true, f.reason);
  assert.equal(f.baseLen, 600);
  assert.deepEqual(f.dir, [-1, 0], 'the direction follows A to B');
});

// ------------------------------------------------------------ rejections ---

test('a base axis shorter than the minimum is refused', () => {
  const f = gridFrame({ a: [0, 0], b: [MIN_BASE_WU - 1, 0], c: [0, 400] });
  assert.equal(f.ok, false);
  assert.match(f.reason, /base axis/i);
});

test('a grid narrower than the minimum is refused', () => {
  const f = gridFrame({ a: [0, 0], b: [600, 0], c: [0, MIN_WIDTH_WU - 1] });
  assert.equal(f.ok, false);
  assert.match(f.reason, /wide/i);
});

test('non-finite coordinates are refused by name', () => {
  for (const [name, req] of [
    ['a', { a: [NaN, 0], b: [600, 0], c: [0, 400] }],
    ['b', { a: [0, 0], b: [Infinity, 0], c: [0, 400] }],
    ['c', { a: [0, 0], b: [600, 0], c: [0, NaN] }],
  ]) {
    const f = gridFrame(req);
    assert.equal(f.ok, false, `${name} must be refused`);
    assert.match(f.reason, new RegExp(`point ${name}`), `the reason must name ${name}: ${f.reason}`);
  }
});

test('block length and row spacing are range checked', () => {
  for (const [field, bad] of [
    ['blockLength', GRID_LIMITS.blockMin - 1],
    ['blockLength', GRID_LIMITS.blockMax + 1],
    ['rowSpacing', GRID_LIMITS.rowMin - 1],
    ['rowSpacing', GRID_LIMITS.rowMax + 1],
  ]) {
    const f = gridFrame({ a: [0, 0], b: [600, 0], c: [0, 400], [field]: bad });
    assert.equal(f.ok, false, `${field}=${bad} must be refused`);
  }
});

test('a grid over the segment limit is refused with the count', () => {
  // A huge base at the smallest block length makes far more lines than allowed.
  const f = gridFrame({ a: [0, 0], b: [40000, 0], c: [0, 40000], blockLength: 120, rowSpacing: 120 });
  assert.equal(f.ok, false);
  assert.match(f.reason, new RegExp(`${MAX_GRID_SEGMENTS}`),
    `the reason must name the limit, got: ${f.reason}`);
  assert.match(f.reason, /\d+ roads/, 'and how many were needed');
});

// ------------------------------------------------------------- segments ---

test('segments are ordered perpendicular-first, then parallel', () => {
  const f = gridFrame({ a: [0, 0], b: [600, 0], c: [0, 400] });
  const segs = gridSegments(f);
  assert.equal(segs.length, f.uStops.length + f.vStops.length);
  const axes = segs.map(s => s.axis);
  const firstV = axes.indexOf('v');
  assert.ok(axes.slice(0, firstV).every(a => a === 'u'), 'all u segments come first');
  assert.ok(axes.slice(firstV).every(a => a === 'v'), 'then all v segments');
  segs.forEach((s, i) => assert.equal(s.index, i, 'indices must be sequential'));
});

test('a 0-degree grid produces exactly the lattice geometry', () => {
  const f = gridFrame({ a: [0, 0], b: [600, 0], c: [0, 400] });
  const segs = gridSegments(f);
  const vertical = segs.filter(s => s.axis === 'u');
  const horizontal = segs.filter(s => s.axis === 'v');

  assert.equal(vertical.length, 4, 'four perpendicular lines');
  assert.equal(horizontal.length, 4, 'four parallel lines');
  for (const s of vertical) {
    assert.equal(s.from[0], s.to[0], 'a perpendicular line has constant x');
    assert.equal(s.from[1], 0, 'and spans from the base');
    assert.ok(Math.abs(s.to[1] - 400) < 1e-9, 'to the full width');
  }
  for (const s of horizontal) {
    assert.equal(s.from[1], s.to[1], 'a parallel line has constant y');
    assert.equal(s.from[0], 0);
    assert.ok(Math.abs(s.to[0] - 600) < 1e-9);
  }
});

test('a 30-degree grid produces the same lattice, rotated', () => {
  const deg = 30;
  const f = gridFrame({ a: [0, 0], b: rot([600, 0], deg), c: rot([0, 400], deg) });
  assert.equal(f.ok, true, f.reason);
  const segs = gridSegments(f);

  const vertical = segs.filter(s => s.axis === 'u');
  const horizontal = segs.filter(s => s.axis === 'v');
  assert.equal(vertical.length, 4);
  assert.equal(horizontal.length, 4);

  // A line at constant u extends along the NORMAL (base + 90 degrees), and a
  // line at constant v extends along the BASE direction. Getting this backwards
  // is the classic local-frame mistake, so it is asserted explicitly.
  const angleOf = (s) => ((Math.atan2(s.to[1] - s.from[1], s.to[0] - s.from[0]) * 180) / Math.PI + 360) % 360;
  for (const s of vertical) {
    const a = angleOf(s);
    const want = (deg + 90) % 360;
    assert.ok(Math.abs(a - want) < 1e-6,
      `a constant-u line runs along the normal: expected ${want}deg, got ${a}deg`);
  }
  for (const s of horizontal) {
    const a = angleOf(s);
    assert.ok(Math.abs(a - deg) < 1e-6,
      `a constant-v line runs along the base: expected ${deg}deg, got ${a}deg`);
  }
});

test('a 90-degree grid is the transposed 0-degree grid', () => {
  const f = gridFrame({ a: [0, 0], b: [0, 600], c: [-400, 0] });
  assert.equal(f.ok, true, f.reason);
  const segs = gridSegments(f);
  const vertical = segs.filter(s => s.axis === 'u');
  // Perpendicular lines now run along -x.
  for (const s of vertical) {
    assert.equal(s.from[1], s.to[1], 'perpendicular lines now have constant y');
    assert.ok(Math.abs(s.to[0] - s.from[0] + 400) < 1e-9, 'and span 400 wu in x');
  }
});

test('localToWorld round-trips through the frame', () => {
  const f = gridFrame({ a: [100, -50], b: [700, -50], c: [100, 350] });
  const p = localToWorld(f, 200, 100);
  // Recover u and v by projecting back onto the basis.
  const dx = p[0] - f.origin[0];
  const dy = p[1] - f.origin[1];
  const u = dx * f.dir[0] + dy * f.dir[1];
  const v = dx * f.normal[0] + dy * f.normal[1];
  assert.ok(Math.abs(u - 200) < 1e-9, `u was ${u}`);
  assert.ok(Math.abs(v - 100) < 1e-9, `v was ${v}`);
});

// ---------------------------------------------------------- evaluation ---

test('a valid grid evaluates every segment', () => {
  const w = world();
  const g = evaluateGridDraft(w, { a: [0, 0], b: [600, 0], c: [0, 400] });
  assert.equal(g.ok, true, g.reason);
  assert.equal(g.count, 8, `expected 8 segments, got ${g.count}`);
  assert.equal(g.failIndex, null);
  assert.ok(g.totalLength > 0, 'the grid has a total length');
  for (const s of g.segments) {
    assert.equal(s.ok, true, `segment ${s.index}: ${s.reason}`);
    assert.ok(s.polyline.length >= 2, 'each segment carries geometry');
  }
});

test('one failing segment rejects the whole grid and names it', () => {
  // The river is the strip x in (250,350). Constant-u lines sit at u = 0, 200,
  // 400, 600, so none of them is inside the strip; every constant-v line runs the
  // full base in x and therefore crosses it. The first failure must therefore be
  // the first constant-v line.
  const w = world({ terrain: RIVER });
  const g = evaluateGridDraft(w, { a: [0, 0], b: [600, 0], c: [0, 400] });
  assert.equal(g.ok, false, 'a grid crossing water must be refused');
  assert.ok(g.failIndex !== null, 'and must say which segment failed');
  assert.ok(g.reason && g.reason.length > 5, `with a reason, got ${g.reason}`);

  const failed = g.segments[g.failIndex];
  assert.equal(failed.axis, 'v',
    `the failing segment must be a constant-v line spanning the river, got axis ${failed.axis}`);
  // And its geometry must genuinely pass through the water strip.
  const spansRiver = failed.from[0] < 250 && failed.to[0] > 350;
  assert.ok(spansRiver,
    `segment ${g.failIndex} runs x ${failed.from[0]}..${failed.to[0]}, which does not span the river`);
});

test('a grid against an existing highway resolves its crossings', () => {
  const w = world();
  // A highway running through where the grid will go.
  const hw = w.net.addRoad([[-200, 200], [800, 200]], 'highway');
  assert.ok(hw.edgeIds.length > 0, 'fixture must build the highway');

  const g = evaluateGridDraft(w, { a: [0, 0], b: [600, 0], c: [0, 400] });
  assert.equal(g.ok, true, g.reason);

  // Commit every segment in order, as the command will.
  let built = 0;
  for (const s of g.segments) {
    const res = w.net.addRoad(s.polyline, 'street', { pts: s.polyline });
    if (res.edgeIds.length) built++;
  }
  assert.equal(built, g.count, 'every segment must build');

  // The highway must have been SPLIT at each crossing, not left whole.
  const hwEdges = [...w.net.edges.values()].filter(e => e.cls === 'highway');
  assert.ok(hwEdges.length > 1,
    `the highway must be split by the crossings, still ${hwEdges.length} edge(s)`);

  // No two edges may overlap exactly: that would be a duplicate road.
  const dupes = findDuplicateEdges(w.net);
  assert.deepEqual(dupes, [], `no duplicate overlapping roads, found ${dupes.length}`);
});

test('committing a grid twice does not duplicate roads', () => {
  const w = world();
  const g = evaluateGridDraft(w, { a: [0, 0], b: [600, 0], c: [0, 400] });
  assert.equal(g.ok, true, g.reason);

  for (const s of g.segments) w.net.addRoad(s.polyline, 'street', { pts: s.polyline });
  const afterFirst = { nodes: w.net.nodes.size, edges: w.net.edges.size };

  // The same grid again: the geometry is identical, so nothing new is needed.
  for (const s of g.segments) w.net.addRoad(s.polyline, 'street', { pts: s.polyline });
  const afterSecond = { nodes: w.net.nodes.size, edges: w.net.edges.size };

  assert.deepEqual(afterSecond, afterFirst,
    `a repeated grid must not add roads: ${JSON.stringify(afterFirst)} -> ${JSON.stringify(afterSecond)}`);
  assert.deepEqual(findDuplicateEdges(w.net), [], 'and must not create duplicate edges');
});

test('the built lattice matches the analytical node and edge count', () => {
  const w = world();
  const g = evaluateGridDraft(w, { a: [0, 0], b: [600, 0], c: [0, 400] });
  assert.equal(g.ok, true, g.reason);
  const nLines = g.frame.uStops.length;
  const mLines = g.frame.vStops.length;

  for (const s of g.segments) w.net.addRoad(s.polyline, 'street', { pts: s.polyline });

  const expected = lattice(nLines, mLines);
  assert.equal(w.net.nodes.size, expected.nodes,
    `${nLines}x${mLines} lattice must have ${expected.nodes} nodes, got ${w.net.nodes.size}`);
  assert.equal(w.net.edges.size, expected.edges,
    `${nLines}x${mLines} lattice must have ${expected.edges} edges, got ${w.net.edges.size}`);
});

test('the analytical count holds at 30 degrees too', () => {
  const deg = 30;
  const w = world();
  const g = evaluateGridDraft(w, {
    a: [0, 0], b: rot([600, 0], deg), c: rot([0, 400], deg),
  });
  assert.equal(g.ok, true, g.reason);
  for (const s of g.segments) w.net.addRoad(s.polyline, 'street', { pts: s.polyline });

  const expected = lattice(g.frame.uStops.length, g.frame.vStops.length);
  assert.equal(w.net.nodes.size, expected.nodes,
    `30deg: expected ${expected.nodes} nodes, got ${w.net.nodes.size}`);
  assert.equal(w.net.edges.size, expected.edges,
    `30deg: expected ${expected.edges} edges, got ${w.net.edges.size}`);
});

// --------------------------------------------------- endpoint crossings ---

test('a crossing at another edge EXACT endpoint still makes the junction', () => {
  // THE regression this task found. Two lines crossing where one of them ENDS:
  // the intersection parameter for that edge computes to 1 plus floating-point
  // noise (measured 1.0000000000000007), so a strict `<= 1` test rejected a real
  // intersection and the crossing edge was never split. A rotated grid lost one
  // street because of it.
  const w = world();
  // Horizontal line, and a vertical one that ends exactly on it.
  w.net.addRoad([[0, 100], [600, 100]], 'street');
  const second = w.net.addRoad([[300, 0], [300, 100]], 'street');
  assert.ok(second.edgeIds.length > 0, 'fixture must build the second line');

  // The horizontal line must have been split at x=300: 2 edges, and a node at
  // (300,100) shared by all four arms.
  const at300 = [...w.net.nodes.values()].find(n => Math.abs(n.x - 300) < 0.5 && Math.abs(n.y - 100) < 0.5);
  assert.ok(at300, 'a junction node must exist at the crossing point');
  assert.equal(at300.edges.size, 3, `the junction must join three arms, has ${at300.edges.size}`);

  const horizontal = [...w.net.edges.values()].filter(e => Math.abs(e.pts[0][1] - 100) < 0.5);
  assert.equal(horizontal.length, 2,
    `the horizontal line must be split into 2 edges, got ${horizontal.length}`);
});

test('a grid rotation sweep always matches the analytical lattice count', () => {
  // Sweeps enough rotations that a floating-point endpoint case is certain to
  // appear, and asserts the exact node and edge counts every time.
  for (const deg of [0, 7, 15, 22, 30, 37, 45, 60, 75, 90, 113, 137, 180, 271]) {
    const w = world();
    const g = evaluateGridDraft(w, {
      a: [0, 0], b: rot([600, 0], deg), c: rot([0, 400], deg),
    });
    assert.equal(g.ok, true, `${deg}deg: ${g.reason}`);
    for (const s of g.segments) w.net.addRoad(s.polyline, 'street', { pts: s.polyline });

    const n = g.frame.uStops.length;
    const m = g.frame.vStops.length;
    const expected = lattice(n, m);
    assert.equal(w.net.nodes.size, expected.nodes,
      `${deg}deg: expected ${expected.nodes} nodes, got ${w.net.nodes.size}`);
    assert.equal(w.net.edges.size, expected.edges,
      `${deg}deg: expected ${expected.edges} edges, got ${w.net.edges.size}`);
    assert.deepEqual(findDuplicateEdges(w.net), [], `${deg}deg: no duplicate edges`);
  }
});

// ------------------------------------------------------------- purity ---

test('evaluateGridDraft never mutates the world', () => {
  const w = world();
  w.net.addRoad([[0, -100], [0, 500]], 'street');
  const before = { nodes: w.net.nodes.size, edges: w.net.edges.size, version: w.net.version };
  evaluateGridDraft(w, { a: [0, 0], b: [600, 0], c: [0, 400] });
  assert.equal(w.net.nodes.size, before.nodes, 'no nodes may be created');
  assert.equal(w.net.edges.size, before.edges, 'no edges may be created');
  assert.equal(w.net.version, before.version, 'and the version must not change');
});

test('the grid consumes no unseeded randomness', () => {
  const real = Math.random;
  Math.random = () => { throw new Error('grid drafting consumed Math.random'); };
  try {
    evaluateGridDraft(world(), { a: [0, 0], b: [600, 0], c: [0, 400] });
  } finally {
    Math.random = real;
  }
});

test('gridBounds covers every segment endpoint', () => {
  const g = evaluateGridDraft(world(), { a: [0, 0], b: [600, 0], c: [0, 400] });
  assert.ok(g.bounds, 'a valid grid has bounds');
  for (const s of g.segments) {
    for (const [x, y] of [s.from, s.to]) {
      assert.ok(x >= g.bounds.minX - 1e-9 && x <= g.bounds.maxX + 1e-9, `x ${x} outside bounds`);
      assert.ok(y >= g.bounds.minY - 1e-9 && y <= g.bounds.maxY + 1e-9, `y ${y} outside bounds`);
    }
  }
  assert.equal(gridBounds([]), null, 'an empty set has no bounds');
});

// ------------------------------------------------------------- helpers ---

/** Edges whose endpoint pairs coincide, ignoring direction. */
function findDuplicateEdges(net) {
  const seen = new Map();
  const dupes = [];
  for (const e of net.edges.values()) {
    const key = [e.a, e.b].sort().join('|');
    if (seen.has(key)) dupes.push([seen.get(key), e.id]);
    else seen.set(key, e.id);
  }
  return dupes;
}

test('a grid segment is exactly its two endpoints, with no spline samples', () => {
  // Grid lines are straight runs between grid lines. If they were evaluated in
  // curve mode they would bulge off the line the player drew - and for a
  // two-point segment a spline is identical, so this asserts the property
  // directly rather than relying on the mode flag being read.
  const w = world();
  const g = evaluateGridDraft(w, { a: [0, 0], b: [600, 0], c: [0, 400] });
  assert.equal(g.ok, true, g.reason);
  for (const s of g.segments) {
    assert.equal(s.polyline.length, 2,
      `a grid segment must be exactly two points, got ${s.polyline.length}`);
    assert.deepEqual(s.polyline[0], s.from, 'the first point is the segment start');
    assert.deepEqual(s.polyline[1], s.to, 'the second point is the segment end');
  }
});
