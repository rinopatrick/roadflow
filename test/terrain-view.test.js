// Terrain presentation (S02.4b): chunked, cached terrain rasterisation.
//
// Why this module is pure
// -----------------------
// The whole map was one 1024px texture over a 6400x6400 wu square, so one
// texture pixel covered ~6.25 wu: at zoom 3 that is a ~19 device-pixel blob,
// which is exactly the blur DESIGN section 4 calls out. It was also regenerated
// as a unit, so nothing about it could be tested without a canvas.
//
// The chunk raster now lives in src/render/terrain.js as a pure function of
// (terrain, tile, detail) -> RGBA bytes, so coverage, colour mapping and the
// shoreline/rock contour can all be asserted in Node, and only the canvas
// plumbing stays in render.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, BIOME } from '../src/terrain.js';
import {
  TILE_WU, TILE_BASE_PX, DETAIL_ZOOM, LOW_ZOOM, MAX_TILES,
  tileWu, tileDetail, tilePx, tilesForRect, visibleTiles, visibleRect,
  rasterizeTile, decorativePatches, TileCache, TERRAIN_COLOURS,
} from '../src/render/terrain.js';

const view = (width, height, dpr = 1) => ({ width, height, dpr });

/** A terrain whose biome is chosen by quadrant, for exact mapping assertions. */
function fakeTerrain({ sample, elevation = () => 0.5 }) {
  return { sample, elevation, isBuildable: () => true, seed: 1 };
}

// ----------------------------------------------------------------- tiling ---

test('a tile covers exactly TILE_WU world units from its grid corner', () => {
  assert.equal(tileWu(1), TILE_WU);
  const tiles = tilesForRect(0, 0, TILE_WU * 2, TILE_WU);
  assert.deepEqual(tiles, [[0, 0], [1, 0]], 'one tile per TILE_WU span');
});

test('tilesForRect covers every interior corner of the requested rect', () => {
  // Half-open: the rect's far edge belongs to the NEXT tile, so only interior
  // corners are guaranteed covered - an edge-touching corner is deliberately
  // excluded, or the tiling would generate rasters nothing can see.
  const rect = { x0: -720, y0: -450, x1: 720, y1: 450 };
  const tiles = tilesForRect(rect.x0, rect.y0, rect.x1, rect.y1);
  assert.ok(tiles.length > 0);
  for (const [x, y] of [[rect.x0 + 1, rect.y0 + 1], [rect.x1 - 1, rect.y0 + 1],
    [rect.x0 + 1, rect.y1 - 1], [rect.x1 - 1, rect.y1 - 1]]) {
    const covered = tiles.some(([cx, cy]) =>
      x >= cx * TILE_WU && x < (cx + 1) * TILE_WU
      && y >= cy * TILE_WU && y < (cy + 1) * TILE_WU);
    assert.ok(covered, `interior corner (${x},${y}) is not inside any tile`);
  }
});

test('a negative rect is tiled with negative grid coordinates', () => {
  const tiles = tilesForRect(-1024, -1024, -1, -1);
  assert.ok(tiles.length > 0);
  for (const [cx, cy] of tiles) {
    assert.ok(cx < 0 && cy < 0, `tile (${cx},${cy}) should be negative for a negative rect`);
  }
});

test('visibleTiles matches the camera frustum', () => {
  const cam = { x: 0, y: 0, zoom: 1 };
  const tiles = visibleTiles(cam, view(1440, 900));
  // world rect is 1440x900 -> 4 x 2 grid of 512wu tiles
  assert.equal(tiles.length, 8, `expected 8 visible tiles at zoom 1, got ${tiles.length}`);
  assert.deepEqual(visibleRect(cam, view(1440, 900)), { x0: -720, y0: -450, x1: 720, y1: 450 });
});

test('detail rises above DETAIL_ZOOM and never below one', () => {
  assert.equal(tileDetail(0.12), 1);
  assert.equal(tileDetail(1), 1);
  assert.equal(tileDetail(DETAIL_ZOOM), 1, 'the threshold itself keeps base detail');
  assert.equal(tileDetail(DETAIL_ZOOM + 0.01), 2);
  assert.equal(tileDetail(5), 2);
  assert.ok(tilePx(2) === TILE_BASE_PX * 2, 'detail doubles the raster resolution');
});

test('below LOW_ZOOM the tile coarsens so the visible count stays bounded', () => {
  assert.equal(tileWu(LOW_ZOOM), TILE_WU, 'at the threshold the tile is still 512 wu');
  assert.equal(tileWu(LOW_ZOOM - 0.01), TILE_WU * 4,
    'below it, one tile covers four times the span, or the map would need hundreds of tiles');
});

test('the visible tile count never exceeds the cache at any supported zoom', () => {
  // The cache holds MAX_TILES; if more than that are visible the cache would
  // thrash and the map would be regenerated every frame, which the task forbids.
  for (const v of [view(1440, 900), view(1024, 768), view(1920, 1080)]) {
    for (const zoom of [0.12, 0.2, 0.34, 0.5, 0.8, 1, 1.5, 3, 5]) {
      const n = visibleTiles({ x: 0, y: 0, zoom }, v).length;
      assert.ok(n <= MAX_TILES,
        `${v.width}x${v.height} at zoom ${zoom}: ${n} visible tiles exceeds the cache of ${MAX_TILES}`);
    }
  }
});

test('panning the camera fully off-screen keeps the count bounded', () => {
  for (const [x, y] of [[6000, 6000], [-6000, -6000], [12000, 0]]) {
    for (const zoom of [0.12, 1, 3]) {
      const n = visibleTiles({ x, y, zoom }, view(1440, 900)).length;
      assert.ok(n <= MAX_TILES, `pan to (${x},${y}) at zoom ${zoom}: ${n} tiles`);
    }
  }
});

// ------------------------------------------------------------ rasterisation ---

const flatGrass = fakeTerrain({ sample: () => BIOME.GRASS });

test('a tile raster is the declared size and fully opaque', () => {
  const px = tilePx(1);
  const data = rasterizeTile(flatGrass, 0, 0, 1);
  assert.equal(data.length, px * px * 4, 'RGBA bytes for every pixel');
  for (let i = 3; i < data.length; i += 4) {
    assert.equal(data[i], 255, `pixel ${Math.floor(i / 4)} must be opaque`);
  }
});

const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) <= 2);

/** RGB at a pixel of a raster. */
function px(data, pxSize, ix, iy) {
  const i = (iy * pxSize + ix) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

test('the raster maps the coordinates of a non-origin tile', () => {
  // Tile (0,0) starts at world 0, so a mutation that clamps the tile origin to
  // zero is invisible against it: a boundary drawn at x0=0 looks identical.
  // Asserting a NEGATIVE tile catches it, because -1 * TILE_WU != 0.
  const split = fakeTerrain({ sample: (x) => (x < 255 ? BIOME.WATER : BIOME.GRASS) });
  const size = tilePx(1);

  // Tile (-1, 0) spans -512..0 wu: entirely water, and NOT the same raster as
  // tile (0,0), which contains the boundary.
  const west = rasterizeTile(split, -1, 0, 1);
  assert.ok(near(px(west, size, size - 3, size - 3), TERRAIN_COLOURS.water),
    'the last pixel of tile (-1,0) is water: its world x is near 0');

  // Tile (1, 0) spans 512..1024 wu: entirely grass.
  const east = rasterizeTile(split, 1, 0, 1);
  assert.ok(near(px(east, size, 2, 2), TERRAIN_COLOURS.grass),
    'the first pixel of tile (1,0) is grass: its world x is near 513');

  // And the two tiles must not be the same raster, which is what an origin
  // clamped to zero would produce.
  assert.notDeepEqual([...west], [...east],
    'different tiles must produce different rasters');
});

test('the raster maps y coordinates at pixel centres too', () => {
  // A horizontal boundary, because the vertical test cannot see a mutation that
  // only shifts the y sampling.
  const split = fakeTerrain({ sample: (x, y) => (y < 199 ? BIOME.WATER : BIOME.GRASS) });
  const size = tilePx(1);
  const step = TILE_WU / size;
  const data = rasterizeTile(split, 0, 0, 1);

  const boundaryIy = Math.floor(199 / step);
  // The contour lands on the last water row; either side of it is a plain fill.
  const contour = px(data, size, 5, boundaryIy - 1);
  assert.ok(!near(contour, TERRAIN_COLOURS.water) && !near(contour, TERRAIN_COLOURS.grass),
    `the last water row must be a contour blend, got rgb(${contour})`);
  assert.ok(near(px(data, size, 5, boundaryIy - 2), TERRAIN_COLOURS.water),
    'the row before the contour is plain water');
  assert.ok(near(px(data, size, 5, boundaryIy), TERRAIN_COLOURS.grass),
    'the first row past the contour is plain grass');
});

test('the raster maps world coordinates to pixels, quadrant by quadrant', () => {
  // Water | grass | sand in vertical strips. The splits sit at x=256 and x=384,
  // mid-tile, so both boundaries are INSIDE tile (0,0): a boundary on a tile
  // edge is drawn by no tile and the assertion would be vacuous.
  const split = fakeTerrain({
    sample: (x) => (x < 255 ? BIOME.WATER : x < 383 ? BIOME.GRASS : BIOME.SAND),
  });
  const detail = 1;
  const px = tilePx(detail);
  const data = rasterizeTile(split, 0, 0, detail);
  const step = TILE_WU / px;
  const water = TERRAIN_COLOURS.water;
  const grass = TERRAIN_COLOURS.grass;
  const sand = TERRAIN_COLOURS.sand;

  const at = (ix, iy) => {
    const i = (iy * px + ix) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) <= 2);

  const left = at(2, 4);
  const right = at(px - 3, 4);
  assert.ok(near(left, water),
    `the left strip must be water-coloured, got rgb(${left})`);
  assert.ok(near(right, sand),
    `the right strip must be sand-coloured, got rgb(${right})`);

  // THE EXACT BOUNDARY. A pixel must be painted from the terrain at ITS OWN
  // CENTRE: the last water pixel is the one whose centre is still below 256,
  // and the first grass pixel is the very next one. Corner sampling would shift
  // this by one pixel, and that shift is a real half-pixel misalignment of the
  // whole map against the roads drawn on top of it.
  const boundaryIx = Math.floor(255 / step); // first pixel whose centre is past 255
  // The contour lands on the LAST pixel of the old class: pixel boundaryIx-1
  // has its centre in water and its right neighbour in grass, so THAT one is
  // blended. Corner sampling would shift the whole boundary by one pixel,
  // which this pairing rules out.
  const contourIx = boundaryIx - 1;
  const contour = at(contourIx, 10);
  assert.ok(!near(contour, water) && !near(contour, grass),
    'the last pixel of the old class must be a contour blend, not a plain fill');
  assert.ok(near(at(contourIx - 1, 10), water),
    'the pixel before the contour is plain water');
  assert.ok(near(at(boundaryIx, 10), grass),
    'the first pixel of the new class must be plain grass');

  const sandIx = Math.floor(383 / step);
  const sandContour = at(sandIx - 1, 10);
  assert.ok(!near(sandContour, grass) && !near(sandContour, sand),
    'the grass/sand boundary must also be contoured');
  assert.ok(near(at(sandIx - 2, 10), grass), 'the strip before the contour is grass');
  assert.ok(near(at(sandIx, 10), sand), 'the strip past the contour is sand');
});

test('a class boundary draws a contour pixel per boundary crossing', () => {
  const split = fakeTerrain({ sample: (x) => (x < 256 ? BIOME.WATER : BIOME.GRASS) });
  const detail = 1;
  const px = tilePx(detail);
  const data = rasterizeTile(split, 0, 0, detail);

  // Every row crosses the vertical boundary exactly once, so exactly one pixel
  // per row is contoured.
  const lum = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const waterLum = (() => {
    const c = TERRAIN_COLOURS.water;
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  })();

  let contoured = 0;
  for (let iy = 0; iy < px; iy++) {
    let rowHits = 0;
    for (let ix = 0; ix < px; ix++) {
      const i = (iy * px + ix) * 4;
      // A contoured water pixel is measurably darker than plain water.
      if (lum(i) < waterLum - 12) rowHits++;
    }
    assert.ok(rowHits <= 1, `row ${iy} has ${rowHits} contoured pixels; a boundary crossing draws one`);
    contoured += rowHits;
  }
  assert.equal(contoured, px,
    `every one of the ${px} rows must cross the vertical boundary exactly once, got ${contoured}`);
});

test('rasterisation is deterministic for the same tile', () => {
  const terrain = new Terrain(7);
  const a = rasterizeTile(terrain, -1, 0, 1);
  const b = rasterizeTile(terrain, -1, 0, 1);
  assert.deepEqual(a, b, 'the same tile must rasterise to identical bytes');
  // And a different detail level is a different, larger raster - not the same
  // image silently reused.
  const hi = rasterizeTile(terrain, -1, 0, 2);
  assert.equal(hi.length, tilePx(2) * tilePx(2) * 4);
});

test('rasterisation consumes no unseeded randomness', () => {
  // If drawing reached for Math.random, two runs of the same tile would differ
  // and a save could not reproduce its own map. Make any call throw.
  const real = Math.random;
  Math.random = () => { throw new Error('drawing consumed Math.random'); };
  try {
    const terrain = new Terrain(42);
    rasterizeTile(terrain, 0, 0, 1);
    decorativePatches(terrain);
  } finally {
    Math.random = real;
  }
});

test('a real seed rasterises its starter area as buildable-coloured ground', () => {
  // Ties the raster to the terrain authority: the starter region is buildable
  // (S02.4a), so its tile must not paint it as open water.
  const terrain = new Terrain(7);
  const cx = 0;
  const cy = 0;
  const data = rasterizeTile(terrain, cx, cy, 1);
  const px = tilePx(1);
  const i = Math.floor((px * px) / 2) * 4; // tile centre
  const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
  const water = TERRAIN_COLOURS.water;
  const isWaterish = Math.abs(r - water[0]) < 8 && Math.abs(g - water[1]) < 8 && Math.abs(b - water[2]) < 8;
  assert.ok(!isWaterish || !terrain.isBuildable(cx * TILE_WU + TILE_WU / 2, cy * TILE_WU + TILE_WU / 2),
    'the tile centre is painted water only where the terrain actually says water');
});

// ------------------------------------------------------------------- cache ---

test('the cache evicts least-recently-used and stays bounded', () => {
  const cache = new TileCache({ max: 4 });
  const put = (k) => cache.put(k, 0, 1, `v${k}`, TILE_WU);
  put(1); put(2); put(3); put(4);
  assert.equal(cache.size, 4);

  // Touch 1 so 2 becomes the least recently used.
  assert.equal(cache.get(1, 0, 1, TILE_WU), 'v1');
  put(5);
  assert.equal(cache.size, 4, 'the cache must never exceed its bound');
  assert.equal(cache.get(2, 0, 1, TILE_WU), null, 'the least recently used entry must have been evicted');
  assert.equal(cache.get(1, 0, 1, TILE_WU), 'v1', 'a recently used entry must survive');
  assert.equal(cache.stats.evictions, 1);
  // Two hits: the touch of 1 that made 2 the LRU, and the confirmation read.
  assert.equal(cache.stats.hits, 2);
});

test('a cache miss is reported as a miss, and counted', () => {
  const cache = new TileCache({ max: 2 });
  assert.equal(cache.get(9, 9, 1, TILE_WU), null);
  assert.equal(cache.stats.hits, 0, 'a miss is not a hit');
  cache.put(1, 1, 1, 'x', TILE_WU);
  assert.equal(cache.get(1, 1, 1, TILE_WU), 'x');
  assert.equal(cache.stats.hits, 1);
});

test('tiles of different size or detail do not collide', () => {
  const cache = new TileCache({ max: 8 });
  cache.put(0, 0, 1, 'base', TILE_WU);
  cache.put(0, 0, 2, 'detail', TILE_WU);
  assert.equal(cache.get(0, 0, 1, TILE_WU), 'base');
  assert.equal(cache.get(0, 0, 2, TILE_WU), 'detail');
  // Coarse low-zoom tiles cover a different world area under the same grid
  // coordinate, so they must not alias the fine ones either.
  cache.put(0, 0, 1, 'coarse', TILE_WU * 4);
  assert.equal(cache.get(0, 0, 1, TILE_WU), 'base');
  assert.equal(cache.get(0, 0, 1, TILE_WU * 4), 'coarse');
});

test('clearing the cache drops everything but keeps the bound', () => {
  const cache = new TileCache({ max: 2 });
  cache.put(1, 1, 1, 'a', TILE_WU);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get(1, 1, 1, TILE_WU), null);
  cache.put(2, 2, 1, 'b', TILE_WU);
  assert.equal(cache.get(2, 2, 1, TILE_WU), 'b');
});

// -------------------------------------------------------------- vegetation ---

test('decorative patches are seeded and stable', () => {
  const terrain = new Terrain(7);
  const a = decorativePatches(terrain);
  const b = decorativePatches(new Terrain(7));
  assert.deepEqual(a, b, 'the same seed must produce the same decoration');
  assert.ok(a.length > 0, 'a real seed should produce some decoration');
  assert.ok(a.length <= 36, 'decoration is bounded');
  for (const blob of a) {
    assert.ok(Number.isFinite(blob.x) && Number.isFinite(blob.y));
    assert.ok(blob.r > 0, 'a patch needs a radius');
    if (blob.trees) {
      assert.ok(blob.trees.length > 0, 'a forest patch needs its trees');
      for (const t of blob.trees) {
        assert.ok(Number.isFinite(t[0]) && Number.isFinite(t[1]) && t[2] > 0,
          'each tree needs a position and a radius');
      }
    }
  }
});

test('decoration never claims unbuildable ground', () => {
  const terrain = new Terrain(7);
  for (const blob of decorativePatches(terrain)) {
    assert.equal(terrain.sample(blob.x, blob.y), BIOME.GRASS,
      `a patch at (${blob.x},${blob.y}) must sit on grass, or it implies a collision rule that does not exist`);
  }
});
