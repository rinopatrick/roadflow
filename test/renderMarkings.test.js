// Lane marking geometry (S02.3a).
//
// These rules are tested here rather than through a screenshot because the two
// DESIGN section 3 rules they enforce are numeric:
//
//   1. markings must not extend beyond the pavement
//   2. markings must not be drawn as sub-pixel hairlines at low zoom
//
// The renderer consumes exactly these values, so a test here is a test of what
// gets stroked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DASH_MIN_ZOOM, DASH_WIDTH, CENTRELINE_WIDTH,
  markingTrim, clampTrim, laneDividerOffsets, laneMarkings,
  trimPolyline, offsetPolyline, pointAtArc,
} from '../src/render/markings.js';
import { roadDimensions, ROAD_PRESETS } from '../src/roadProfiles.js';

const CLASSES = Object.keys(ROAD_PRESETS);

// ---------------------------------------------------------------- zoom gate ---

test('dashes are hidden at low zoom instead of painted as hairlines', () => {
  for (const cls of CLASSES) {
    assert.equal(laneMarkings(cls, 0.12).showDashes, false,
      `${cls}: the minimum camera zoom must not draw dashes`);
    assert.equal(laneMarkings(cls, DASH_MIN_ZOOM - 0.01).showDashes, false,
      `${cls}: just below the threshold must not draw dashes`);
    assert.equal(laneMarkings(cls, DASH_MIN_ZOOM).showDashes, true,
      `${cls}: the threshold itself must draw dashes`);
    assert.equal(laneMarkings(cls, 1).showDashes, true, `${cls}: normal play shows dashes`);
    assert.equal(laneMarkings(cls, 3).showDashes, true, `${cls}: close zoom shows dashes`);
  }
});

test('a visible dash is never a sub-pixel hairline', () => {
  // The gate and the width must agree: the lowest zoom that shows dashes still
  // has to produce something a viewer can see.
  const m = laneMarkings('avenue', DASH_MIN_ZOOM);
  assert.ok(m.dashWidth >= 0.35,
    `a dash at the threshold must be at least a third of a pixel, got ${m.dashWidth}`);
  assert.ok(m.dash[0] >= 1.5,
    `a dash at the threshold must be at least ~2px long, got ${m.dash[0]}`);
});

// ------------------------------------------------------- divider placement ---

test('only roads wide enough to have interior lanes get divider dashes', () => {
  assert.deepEqual(laneDividerOffsets(roadDimensions('street')), [],
    'a two-lane street has no interior divider: its median is the centreline');
  assert.equal(laneDividerOffsets(roadDimensions('avenue')).length, 1,
    'a four-lane avenue has one divider per side');
  assert.equal(laneDividerOffsets(roadDimensions('highway')).length, 2,
    'a six-lane highway has two dividers per side');
});

test('every divider offset lies inside the pavement', () => {
  // DESIGN section 3: markings follow roadDimensions, and must not be painted
  // beyond the pavement the player can see.
  for (const cls of CLASSES) {
    const dim = roadDimensions(cls);
    const half = dim.width / 2;
    for (const off of laneDividerOffsets(dim)) {
      assert.ok(off > 0, `${cls}: divider offset must be positive, got ${off}`);
      assert.ok(off + DASH_WIDTH / 2 <= half,
        `${cls}: divider at ${off} plus its half-width exceeds the pavement half-width ${half}`);
    }
  }
});

test('dividers stay inside the pavement on a one-way road too', () => {
  const oneWay = roadDimensions({ cls: 'highway', oneway: true });
  assert.equal(oneWay.medianWidth, 0, 'a one-way road has no median');
  assert.deepEqual(laneDividerOffsets(oneWay), [],
    'a one-way road has no interior divider to draw');
});

test('dividers are evenly spaced by the lane width', () => {
  const dim = roadDimensions('highway');
  const offs = laneDividerOffsets(dim);
  for (let i = 1; i < offs.length; i++) {
    assert.ok(Math.abs((offs[i] - offs[i - 1]) - dim.laneWidth) < 1e-9,
      `divider ${i} must sit one lane width from the previous one`);
  }
  assert.ok(Math.abs(offs[0] - (dim.medianWidth / 2 + dim.laneWidth)) < 1e-9,
    'the first divider must sit one lane width from the median edge');
});

// --------------------------------------------------------------- centreline ---

test('the centreline appears only where there is a median to divide', () => {
  assert.equal(laneMarkings('street', 1).showCentreline, true);
  assert.equal(laneMarkings('avenue', 1).showCentreline, true);
  assert.equal(laneMarkings('highway', 1).showCentreline, true);
  assert.equal(laneMarkings({ cls: 'street', oneway: true }, 1).showCentreline, false,
    'a one-way road has no centre division');
  assert.equal(laneMarkings({ cls: 'street', ring: true }, 1).showCentreline, false,
    'roundabout ring edges are one-way and must not show a centreline');
});

test('marking widths scale with zoom, from a world-unit base', () => {
  assert.ok(Math.abs(laneMarkings('avenue', 2).centrelineWidth - CENTRELINE_WIDTH * 2) < 1e-9);
  assert.ok(Math.abs(laneMarkings('avenue', 0.5).centrelineWidth - CENTRELINE_WIDTH * 0.5) < 1e-9);
});

// ---------------------------------------------------------------- the trim ---

test('the trim grows with pavement width', () => {
  const street = markingTrim(roadDimensions('street'));
  const avenue = markingTrim(roadDimensions('avenue'));
  const highway = markingTrim(roadDimensions('highway'));
  assert.ok(street > 0 && avenue > street && highway > avenue,
    `trim must grow with width, got street ${street}, avenue ${avenue}, highway ${highway}`);
});

test('a short edge gets a clamped trim instead of losing its markings', () => {
  // An edge shorter than twice the trim would otherwise produce endTrim < trim,
  // and the marking would silently vanish rather than being drawn short.
  const trim = markingTrim(roadDimensions('highway'));
  const short = 10;
  const clamped = clampTrim(trim, short);
  assert.ok(clamped < trim, 'the trim must be clamped on a short edge');
  assert.ok(clamped <= short / 2, `clamped trim ${clamped} must not exceed half the edge`);
  assert.ok(clamped > 0, 'the marking must still have room to be drawn');

  const m = laneMarkings('highway', 1, short);
  assert.ok(m.trim <= short / 2, 'laneMarkings must apply the clamp');
  assert.ok(m.trim > 0, 'a short edge still gets a positive trim');
});

test('degenerate edge lengths are handled without throwing', () => {
  for (const length of [0, -5, NaN, Infinity, undefined]) {
    const m = laneMarkings('avenue', 1, length);
    assert.ok(Number.isFinite(m.trim), `length ${length} must produce a finite trim`);
    assert.ok(m.trim >= 0, `length ${length} must produce a non-negative trim`);
  }
});

test('the trim never consumes more than half the edge at any zoom', () => {
  for (const cls of CLASSES) {
    for (const length of [5, 20, 100, 600, 3200]) {
      const m = laneMarkings(cls, 1, length);
      assert.ok(m.trim <= length / 2,
        `${cls} at length ${length}: trim ${m.trim} exceeds half the edge`);
    }
  }
});

// ------------------------------------------------------- trimming a line ---

/** A straight two-point road: cum = [0, length]. */
const STRAIGHT = { pts: [[0, 0], [450, 0]], cum: [0, 450] };

/** A three-point bent road. */
const BENT = { pts: [[0, 0], [200, 0], [200, 300]], cum: [0, 200, 500] };

test('a straight road keeps its markings instead of losing them entirely', () => {
  // Regression: the previous implementation only kept EXISTING vertices that
  // fell inside the trim, so on a two-point road both endpoints were outside the
  // range and nothing was stroked at all. A straight avenue drew no centreline.
  const trimmed = trimPolyline(STRAIGHT.pts, STRAIGHT.cum, 20);
  assert.ok(trimmed.length >= 2,
    `a straight road must still produce a drawable line, got ${trimmed.length} point(s)`);
  assert.deepEqual(trimmed[0], [20, 0], 'the line must start at the trim distance');
  assert.deepEqual(trimmed[trimmed.length - 1], [430, 0], 'and end at the mirrored distance');
});

test('trimming interpolates rather than filtering vertices', () => {
  const trimmed = trimPolyline(STRAIGHT.pts, STRAIGHT.cum, 100);
  assert.deepEqual(trimmed, [[100, 0], [350, 0]],
    'the trimmed span must be interpolated exactly, not rounded to vertices');
});

test('trimming a bent road keeps its interior vertices', () => {
  const trimmed = trimPolyline(BENT.pts, BENT.cum, 50);
  assert.deepEqual(trimmed[0], [50, 0], 'starts 50wu along the first segment');
  assert.deepEqual(trimmed[1], [200, 0], 'keeps the interior vertex');
  assert.deepEqual(trimmed[trimmed.length - 1], [200, 250], 'ends 50wu before the far end');
  assert.equal(trimmed.length, 3, 'no vertex may be dropped');
});

test('a road too short to trim is clamped, never drawn inverted', () => {
  // clampTrim deliberately keeps a short edge drawable (a sliver) rather than
  // dropping its marking, so the invariant to assert is ordering, not emptiness.
  const trimmed = trimPolyline(STRAIGHT.pts, STRAIGHT.cum, 300);
  assert.ok(trimmed.length >= 2, 'a clamped trim must still produce a drawable line');
  const xs = trimmed.map(p => p[0]);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b),
    `a clamped line must stay ordered along the edge, got ${xs.join(',')}`);
  assert.ok(xs[0] >= 0 && xs[xs.length - 1] <= 450,
    'a clamped line must stay inside the road');
  assert.ok(xs[xs.length - 1] - xs[0] > 0,
    'a clamped line must have positive length, not be inverted');

  // Genuinely un-drawable geometry produces nothing.
  assert.deepEqual(trimPolyline([[0, 0], [0, 0]], [0, 0], 5), [],
    'a zero-length edge must produce nothing');
  assert.deepEqual(trimPolyline([[0, 0]], [0], 5), [],
    'a single-point edge must produce nothing');
  assert.deepEqual(trimPolyline(null, null, 5), [], 'a missing edge must produce nothing');
  assert.deepEqual(trimPolyline(STRAIGHT.pts, [0, 450, 900], 20), [],
    'a cum array that does not match the points must be refused, not misread');
});

test('trimming never extends the line beyond its own ends', () => {
  for (const trim of [0, 1, 20, 224.5]) {
    const trimmed = trimPolyline(STRAIGHT.pts, STRAIGHT.cum, trim);
    for (const [x] of trimmed) {
      assert.ok(x >= -1e-9 && x <= 450 + 1e-9,
        `trim ${trim} produced x=${x}, outside the road`);
    }
  }
});

test('pointAtArc lands exactly on vertices and interpolates between them', () => {
  assert.deepEqual(pointAtArc(BENT.pts, BENT.cum, 0), [0, 0]);
  assert.deepEqual(pointAtArc(BENT.pts, BENT.cum, 200), [200, 0]);
  assert.deepEqual(pointAtArc(BENT.pts, BENT.cum, 350), [200, 150]);
  assert.deepEqual(pointAtArc(BENT.pts, BENT.cum, 500), [200, 300]);
  assert.deepEqual(pointAtArc(BENT.pts, BENT.cum, 999), [200, 300],
    'beyond the end clamps instead of extrapolating');
  assert.deepEqual(pointAtArc(BENT.pts, BENT.cum, -5), [0, 0],
    'before the start clamps instead of extrapolating');
});

// --------------------------------------------------------- lane offsetting ---

test('offsetting keeps every lane centre inside the pavement', () => {
  const off = 6;
  const shifted = offsetPolyline(BENT.pts, off);
  assert.equal(shifted.length, BENT.pts.length, 'offsetting must not drop points');
  for (const [x, y] of shifted) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), 'offset points must be finite');
  }
  // The first segment runs +x, so its offset must be purely in y.
  assert.ok(Math.abs(shifted[0][0] - 0) < 1e-9, 'the offset must be perpendicular to the segment');
  assert.ok(Math.abs(Math.abs(shifted[0][1]) - off) < 1e-9, `expected a ${off}wu lateral offset`);
});

test('the offset stays perpendicular on a diagonal road, not axis-aligned', () => {
  // An axis-aligned fixture cannot tell a real perpendicular offset from a
  // hardcoded y shift, so this uses a 45-degree segment and checks the dot
  // product against the direction is zero.
  const off = 8;
  const diagonal = { pts: [[0, 0], [100, 100]] };
  const [a, b] = offsetPolyline(diagonal.pts, off);

  // The offset distance is the displacement of each point from its original
  // position, NOT the length of the offset segment (which is the road length).
  const displacement = Math.hypot(a[0] - 0, a[1] - 0);
  assert.ok(Math.abs(displacement - off) < 1e-9,
    `the offset distance must equal ${off} regardless of heading, got ${displacement}`);
  assert.ok(Math.abs(b[0] - a[0] - 100) < 1e-9 && Math.abs(b[1] - a[1] - 100) < 1e-9,
    'both points must move by the same vector');

  // Dot product of the offset vector with the road direction must vanish.
  const dot = (a[0] * 100 + a[1] * 100) / Math.hypot(100, 100);
  assert.ok(Math.abs(dot) < 1e-9,
    `the offset must be perpendicular to a 45-degree road, dot product was ${dot}`);
});

test('a point with no segment direction keeps its position exactly', () => {
  // A repeated point has no direction, so shifting it would silently move a lane
  // marking off its road. atan2(0, 0) is 0, not NaN, so without the guard the
  // point would be displaced by a full offset in an arbitrary direction.
  const degenerate = offsetPolyline([[10, 20], [10, 20], [60, 20]], 7);
  assert.deepEqual(degenerate[0], [10, 20],
    'a point whose only segment is zero-length must not be displaced');
  // Index 1 DOES begin a real segment, so it is offset correctly.
  assert.deepEqual(degenerate[1], [10, 13],
    'a point that begins a real segment must still be offset');
  assert.deepEqual(degenerate[2], [60, 13], 'the far end must be offset too');
});

test('offsetting a degenerate polyline is safe', () => {
  assert.deepEqual(offsetPolyline([], 5), []);
  assert.deepEqual(offsetPolyline([[1, 2]], 5), []);
  assert.deepEqual(offsetPolyline(null, 5), []);
  const zero = offsetPolyline([[0, 0], [0, 0]], 5);
  for (const [x, y] of zero) assert.ok(Number.isFinite(x) && Number.isFinite(y),
    'a zero-length segment must not produce NaN');
});

// -------------------------------------------------------------- integration ---

test('laneMarkings reports the same geometry roadDimensions describes', () => {
  for (const cls of CLASSES) {
    const dim = roadDimensions(cls);
    const m = laneMarkings(cls, 1, 600);
    assert.equal(m.showCentreline, dim.medianWidth > 0,
      `${cls}: centreline visibility must follow the median`);
    assert.deepEqual(m.dividerOffsets, laneDividerOffsets(dim),
      `${cls}: laneMarkings must not re-derive the offsets`);
  }
});

test('an unknown class is refused rather than silently drawn as a street', () => {
  assert.throws(() => laneMarkings('motorway-x', 1), RangeError,
    'an unknown road class must throw, as roadDimensions does');
});
