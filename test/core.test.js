import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splinePoints, polylineLengths, pointAt, projectOnPolyline, makeRng, clamp, catmullRom } from '../src/core.js';

test('splinePoints keeps endpoints and tracks control segments', () => {
  const pts = [[0, 0], [100, 0], [100, 100]];
  const { pts: out, segIdx } = splinePoints(pts, 10);
  assert.equal(out.length, segIdx.length, 'every point has a segment index');
  assert.deepEqual(out[0], [0, 0], 'first sample = first control point');
  assert.deepEqual(out[out.length - 1], [100, 100], 'last sample = last control point');
  assert.equal(segIdx[0], 0);
  assert.equal(segIdx[segIdx.length - 1], 1);
  // monotonic segment indices
  for (let i = 1; i < segIdx.length; i++) assert.ok(segIdx[i] >= segIdx[i - 1], 'segIdx monotonic');
});

test('polylineLengths computes cumulative arc length', () => {
  const { cum, total } = polylineLengths([[0, 0], [3, 4], [3, 14]]);
  assert.equal(total, 15);
  assert.equal(cum[1], 5);
  assert.equal(cum[2], 15);
});

test('pointAt returns endpoints with correct direction', () => {
  const pts = [[0, 0], [10, 0]];
  const { cum } = polylineLengths(pts);
  const start = pointAt(pts, cum, 0);
  assert.equal(start.x, 0); assert.equal(start.y, 0);
  assert.equal(start.dir, 0);
  const end = pointAt(pts, cum, 999);
  assert.equal(end.x, 10);
  assert.equal(end.dir, 0);
  const mid = pointAt(pts, cum, 5);
  assert.equal(mid.x, 5);
});

test('projectOnPolyline finds nearest arc position', () => {
  const pts = [[0, 0], [10, 0]];
  const { cum } = polylineLengths(pts);
  const r = projectOnPolyline(pts, cum, 5, 2);
  assert.equal(r.s, 5);
  assert.equal(r.d, 2);
});

test('makeRng is deterministic per seed', () => {
  const a = makeRng(42), b = makeRng(42), c = makeRng(43);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  const seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test('clamp and catmullRom basics', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  // straight-line control points => interpolation stays on the line
  const p = catmullRom([0, 0], [10, 0], [20, 0], [30, 0], 0.5);
  assert.equal(p[0], 15);
  assert.equal(p[1], 0);
});
