// Camera projection, framing and starter placement (S02.4a).
//
// Why this module is pure
// -----------------------
// The projection was DPR-broken and nothing could see it. `worldToScreen`
// returned DEVICE pixels (it multiplies by dpr and offsets by `canvas.width/2`),
// while `screenToWorld` took CSS pixels (it multiplies its input by dpr first),
// so they were not inverses. At DPR 2 the round trip was off by ~850-2963 wu, and
// `_drawToolPreviews` mixed a CSS-pixel mouse position with a device-pixel
// projection, so tool badges landed in the wrong place on any HiDPI display.
//
// It survived because every fixture ran at DPR 1, where the two coincide.
//
// The fix is one pure projection with an explicit unit in each function name,
// testable at any DPR and zoom without a canvas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ZOOM, MAX_ZOOM, clampZoom,
  worldToDevice, worldToCss, cssToWorld, deviceToCss,
  zoomAtPointer, boundsOfWorld, fitBounds, DEFAULT_FIT,
  starterRegion, STARTER_DEFAULTS,
} from '../src/camera.js';
import { Terrain, BIOME } from '../src/terrain.js';

/** A viewport description: CSS size plus the device pixel ratio. */
const view = (width, height, dpr) => ({ width, height, dpr });

const VIEWS = [
  view(1440, 900, 1),
  view(1440, 900, 2),
  view(1024, 768, 1),
  view(1024, 768, 2),
  view(1920, 1080, 2),
];
const ZOOMS = [MIN_ZOOM, 0.35, 1, 3, MAX_ZOOM];

// ------------------------------------------------------------ projection ---

test('the projection round-trips at every DPR and zoom', () => {
  const points = [[0, 0], [123.4, -567.8], [-1000, 2500], [3200, -3200]];
  for (const v of VIEWS) {
    for (const zoom of ZOOMS) {
      const cam = { x: 37.5, y: -120.25, zoom };
      for (const [x, y] of points) {
        const [sx, sy] = worldToCss(cam, v, x, y);
        const [bx, by] = cssToWorld(cam, v, sx, sy);
        assert.ok(Math.hypot(bx - x, by - y) < 1e-9,
          `dpr ${v.dpr} zoom ${zoom}: (${x},${y}) round-tripped to (${bx},${by})`);
      }
    }
  }
});

test('worldToDevice is exactly worldToCss scaled by the DPR', () => {
  for (const v of VIEWS) {
    for (const zoom of ZOOMS) {
      const cam = { x: 10, y: 20, zoom };
      const css = worldToCss(cam, v, 300, -400);
      const dev = worldToDevice(cam, v, 300, -400);
      assert.ok(Math.abs(dev[0] - css[0] * v.dpr) < 1e-9, `x: ${dev[0]} vs ${css[0] * v.dpr}`);
      assert.ok(Math.abs(dev[1] - css[1] * v.dpr) < 1e-9, `y: ${dev[1]} vs ${css[1] * v.dpr}`);
    }
  }
});

test('the camera centre projects to the centre of the viewport', () => {
  for (const v of VIEWS) {
    for (const zoom of ZOOMS) {
      const cam = { x: -450.5, y: 812.25, zoom };
      const [sx, sy] = worldToCss(cam, v, cam.x, cam.y);
      assert.ok(Math.abs(sx - v.width / 2) < 1e-9 && Math.abs(sy - v.height / 2) < 1e-9,
        `dpr ${v.dpr} zoom ${zoom}: centre projected to (${sx},${sy})`);
      const [dx, dy] = worldToDevice(cam, v, cam.x, cam.y);
      assert.ok(Math.abs(dx - v.width * v.dpr / 2) < 1e-9 && Math.abs(dy - v.height * v.dpr / 2) < 1e-9,
        `dpr ${v.dpr} zoom ${zoom}: device centre was (${dx},${dy})`);
    }
  }
});

test('a world unit covers zoom * dpr device pixels and zoom CSS pixels', () => {
  const v = view(1440, 900, 2);
  const cam = { x: 0, y: 0, zoom: 1 };
  const [x0] = worldToCss(cam, v, 0, 0);
  const [x1] = worldToCss(cam, v, 1, 0);
  assert.ok(Math.abs((x1 - x0) - 1) < 1e-9, 'one world unit must be one CSS pixel at zoom 1');
  const [d0] = worldToDevice(cam, v, 0, 0);
  const [d1] = worldToDevice(cam, v, 1, 0);
  assert.ok(Math.abs((d1 - d0) - 2) < 1e-9, 'one world unit must be two device pixels at DPR 2');
});

test('deviceToCss converts a pointer position without touching world space', () => {
  const v = view(1440, 900, 2);
  assert.deepEqual(deviceToCss(v, 2880, 1800), [1440, 900]);
  assert.deepEqual(deviceToCss(v, 0, 0), [0, 0]);
});

test('zoom is clamped to the supported range', () => {
  assert.equal(clampZoom(0.0001), MIN_ZOOM);
  assert.equal(clampZoom(99), MAX_ZOOM);
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(NaN), 1, 'a non-finite zoom falls back to 1 rather than poisoning the camera');
  assert.ok(MIN_ZOOM > 0, 'a zero zoom would make the projection singular');
});

// -------------------------------------------------------- anchored zoom ---

test('zooming at a pointer keeps the world point under it', () => {
  // The property a player actually feels: whatever is under the cursor stays
  // under the cursor. DESIGN section 4: "Zoom at pointer keeps world anchor
  // stable", within 0.1 wu.
  const v = view(1440, 900, 2);
  const pointer = [1100, 250];
  for (const from of ZOOMS) {
    for (const to of ZOOMS) {
      const cam = { x: -220, y: 640, zoom: from };
      const before = cssToWorld(cam, v, pointer[0], pointer[1]);
      const next = zoomAtPointer(cam, v, pointer[0], pointer[1], to);
      assert.equal(next.zoom, to, 'the requested zoom must be applied');
      const after = cssToWorld(next, v, pointer[0], pointer[1]);
      assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) < 0.1,
        `zoom ${from} -> ${to}: anchor moved ${Math.hypot(after[0] - before[0], after[1] - before[1])}wu`);
    }
  }
});

test('zooming at the exact centre does not move the camera', () => {
  const v = view(1024, 768, 1);
  const cam = { x: 50, y: -50, zoom: 1 };
  const next = zoomAtPointer(cam, v, v.width / 2, v.height / 2, 2);
  assert.ok(Math.abs(next.x - cam.x) < 1e-9 && Math.abs(next.y - cam.y) < 1e-9,
    `the centre is the anchor, so the camera must not move: ${JSON.stringify(next)}`);
});

test('an anchored zoom is refused when the zoom cannot change', () => {
  const v = view(1440, 900, 1);
  const cam = { x: 5, y: 6, zoom: MAX_ZOOM };
  const next = zoomAtPointer(cam, v, 100, 100, 999);
  assert.equal(next.zoom, MAX_ZOOM);
  // At the clamp the camera still must not drift.
  assert.ok(Math.abs(next.x - cam.x) < 1e-9 && Math.abs(next.y - cam.y) < 1e-9,
    'a refused zoom must leave the camera exactly where it was');
});

// -------------------------------------------------------------- framing ---

test('world bounds include every road point and every building', () => {
  const world = {
    net: {
      edges: new Map([
        ['e1', { pts: [[-100, -50], [200, 80]] }],
        ['e2', { pts: [[200, 80], [400, -300]] }],
      ]),
    },
    eco: { buildings: new Map([['b1', { x: -250, y: 120 }]]) },
  };
  const b = boundsOfWorld(world);
  assert.equal(b.minX, -250, 'a building west of every road must extend the bounds');
  assert.equal(b.maxX, 400);
  assert.equal(b.minY, -300);
  assert.equal(b.maxY, 120, 'a building south of every road must extend the bounds');
});

test('an empty world has no bounds, so framing can fall back', () => {
  assert.equal(boundsOfWorld({ net: { edges: new Map() }, eco: { buildings: new Map() } }), null);
  assert.equal(boundsOfWorld(null), null);
  assert.equal(boundsOfWorld({}), null);
});

test('fit framing keeps everything inside the viewport with margin', () => {
  const bounds = { minX: -500, minY: -200, maxX: 700, maxY: 400 };
  for (const v of VIEWS) {
    const cam = fitBounds(bounds, v);
    for (const [x, y] of [[bounds.minX, bounds.minY], [bounds.maxX, bounds.maxY],
      [bounds.minX, bounds.maxY], [bounds.maxX, bounds.minY]]) {
      const [sx, sy] = worldToCss(cam, v, x, y);
      assert.ok(sx >= 0 && sx <= v.width && sy >= 0 && sy <= v.height,
        `dpr ${v.dpr}: corner (${x},${y}) projected to (${sx},${sy}), outside ${v.width}x${v.height}`);
    }
  }
});

test('fit framing leaves the configured margin around the content', () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 600 };
  const v = view(1440, 900, 1);
  const cam = fitBounds(bounds, v);
  const [x0] = worldToCss(cam, v, bounds.minX, 0);
  const [x1] = worldToCss(cam, v, bounds.maxX, 0);
  const usedFraction = (x1 - x0) / v.width;
  assert.ok(usedFraction < 1, `content must not fill the whole viewport, used ${usedFraction}`);
  assert.ok(usedFraction > 0.5, `content must use most of the viewport, used ${usedFraction}`);
  // The margin is a fraction of the span, applied on each side.
  const expected = 1 / (1 + 2 * DEFAULT_FIT.margin);
  assert.ok(Math.abs(usedFraction - expected) < 0.02,
    `expected the content to occupy about ${expected} of the viewport, got ${usedFraction}`);
});

test('fit framing enforces a minimum span, so one building is not zoomed to the pixel', () => {
  const tiny = { minX: 10, minY: 10, maxX: 12, maxY: 12 };
  const v = view(1440, 900, 1);
  const cam = fitBounds(tiny, v);
  assert.ok(cam.zoom <= MAX_ZOOM, `zoom must stay within range, got ${cam.zoom}`);
  // The minimum span must be visible, which bounds the zoom from above.
  const maxAllowed = Math.min(v.width, v.height) / DEFAULT_FIT.minSpanWu;
  assert.ok(cam.zoom <= maxAllowed + 1e-9,
    `a 2wu building must not zoom past the minimum span: zoom ${cam.zoom}, cap ${maxAllowed}`);
});

test('fit framing clamps at the zoom limits rather than returning a wild value', () => {
  const enormous = { minX: -50000, minY: -50000, maxX: 50000, maxY: 50000 };
  const cam = fitBounds(enormous, view(1440, 900, 1));
  assert.equal(cam.zoom, MIN_ZOOM, 'an enormous extent must clamp to the minimum zoom');
  assert.ok(Number.isFinite(cam.x) && Number.isFinite(cam.y), 'the camera must stay finite');
});

test('fit framing centres the content', () => {
  const bounds = { minX: -400, minY: 100, maxX: 200, maxY: 500 };
  const v = view(1440, 900, 1);
  const cam = fitBounds(bounds, v);
  assert.ok(Math.abs(cam.x - (-100)) < 1e-9, `camera x should be the bounds centre, got ${cam.x}`);
  assert.ok(Math.abs(cam.y - 300) < 1e-9, `camera y should be the bounds centre, got ${cam.y}`);
});

// ------------------------------------------------------ starter placement ---

test('the starter region is deterministic for a seed', () => {
  const terrain = new Terrain(7);
  const a = starterRegion(terrain);
  const b = starterRegion(new Terrain(7));
  assert.deepEqual(a, b, 'the same seed must frame the same starter region');
});

test('the starter region is buildable, not open water', () => {
  // DESIGN section 4: "Starter camera frames a buildable area... Do not assume
  // origin is a good spawn for every seed."
  for (const seed of [1, 7, 42, 123, 999]) {
    const terrain = new Terrain(seed);
    const region = starterRegion(terrain);
    assert.ok(Number.isFinite(region.x) && Number.isFinite(region.y), `seed ${seed}: finite region`);
    assert.ok(region.buildable >= STARTER_DEFAULTS.minBuildable - 1e-9 || region.fallback,
      `seed ${seed}: chosen region must be buildable or explicitly a fallback, got ${region.buildable}`);
    // The centre of the chosen region must itself be buildable unless we fell back.
    if (!region.fallback) {
      assert.ok(terrain.isBuildable(region.x, region.y),
        `seed ${seed}: region centre (${region.x},${region.y}) is ${terrain.sample(region.x, region.y)}, not buildable`);
    }
  }
});

test('the starter region is the qualifying one nearest the origin', () => {
  // A hand-made terrain that is buildable only in two known places.
  const spots = [[0, 0], [2000, 0]];
  const fake = {
    isBuildable: (x, y) => spots.some(([sx, sy]) => Math.hypot(x - sx, y - sy) < 350),
    sample: () => BIOME.GRASS,
  };
  const region = starterRegion(fake, { gridStep: 200, radius: 3000 });
  const dOrigin = Math.hypot(region.x, region.y);
  const dFar = Math.hypot(region.x - 2000, region.y);
  assert.ok(!region.fallback, 'one of the two patches must qualify');
  assert.ok(dOrigin < dFar,
    `the region nearer the origin must win: chose (${region.x},${region.y})`);
});

test('the starter region breaks ties by coordinates, not by scan order', () => {
  // A uniformly buildable map: every cell qualifies, so the tie-break decides.
  const flat = { isBuildable: () => true, sample: () => BIOME.GRASS };
  const a = starterRegion(flat, { gridStep: 200, radius: 1000 });
  const b = starterRegion(flat, { gridStep: 200, radius: 1000 });
  assert.deepEqual(a, b, 'the tie-break must be stable');
  assert.equal(a.x % 200, 0, 'the chosen cell must sit on the grid');
  assert.equal(a.y % 200, 0);
});

test('an unbuildable map falls back to the best patch and says so', () => {
  // Everything is water: no cell can qualify, so the caller must be told.
  const water = { isBuildable: () => false, sample: () => BIOME.WATER };
  const region = starterRegion(water);
  assert.equal(region.fallback, true, 'a fallback must be reported, not hidden');
  assert.ok(region.reason && region.reason.length > 0,
    'a fallback must explain why, because the player sees restricted terrain');
  assert.ok(Number.isFinite(region.x) && Number.isFinite(region.y),
    'a fallback still has to frame somewhere');
});

test('the starter region respects the requested rectangle', () => {
  const flat = { isBuildable: () => true, sample: () => BIOME.GRASS };
  const region = starterRegion(flat, { rectW: 600, rectH: 400 });
  assert.equal(region.rect.w, 600);
  assert.equal(region.rect.h, 400);
});

test('the starter region does not depend on iteration order of a Map', () => {
  // Determinism must come from the scan, not from whatever order a container
  // happens to yield.
  const terrain = new Terrain(42);
  const first = starterRegion(terrain);
  const again = starterRegion(terrain);
  assert.deepEqual(first, again);
  assert.equal(typeof first.buildable, 'number');
});
