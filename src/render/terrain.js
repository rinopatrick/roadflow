// Chunked terrain presentation — S02.4b.
//
// Why this replaces a single texture
// ----------------------------------
// The whole map was one 1024px texture over a 6400x6400 wu square, so one
// texture pixel covered ~6.25 wu. At zoom 3 that is a ~19 device-pixel blob on a
// HiDPI display: exactly the blur DESIGN section 4 calls out ("Current 1024
// texture over a 6400-wu square becomes blurry at close zoom").
//
// Terrain is now 512 wu tiles rasterised at 256 px base resolution (2 wu per
// pixel) with a 2x detail raster above DETAIL_ZOOM (1 wu per pixel), cached with
// a bound and LRU eviction, and only the visible tiles are generated. The terrain
// sample/buildability authority in src/terrain.js is untouched.
//
// Everything except the canvas plumbing is pure, so coverage, colour mapping,
// contouring, determinism and the cache are testable in Node.
import { makeRng, clamp } from '../core.js';
import { BIOME } from '../terrain.js';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** Linear blend of two hex colours at t. Same maths as the old render.js helper. */
function mixHex(a, b, t) {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return rgbToHex(c);
}

/** World units per terrain tile. */
export const TILE_WU = 512;

/** Base raster resolution of a tile, in pixels, at detail level 1. */
export const TILE_BASE_PX = 256;

/** At and above this zoom the 2x detail raster is used. */
export const DETAIL_ZOOM = 1.5;

/** Below this zoom tiles coarsen, so the visible count stays inside the cache. */
export const LOW_ZOOM = 0.5;

/** Maximum tiles held. TESTING: "Cache at most 64 tiles, evict least recently used." */
export const MAX_TILES = 64;

/** Water level used for shoreline shading inside a biome cell. */
const WATER_SHALLOW = 0.22;

/**
 * A tile's world span, in world units.
 *
 * Below LOW_ZOOM the tile covers four times the area, because at minimum zoom a
 * 1440px viewport spans 12000 wu: at 512 wu per tile that is 24x14 = 336 tiles,
 * which both exceeds the 64-tile bound and would regenerate the map every frame.
 */
export function tileWu(zoom) {
  return zoom < LOW_ZOOM ? TILE_WU * 4 : TILE_WU;
}

/** Raster detail level for a zoom: 2x strictly above DETAIL_ZOOM, else base. */
export function tileDetail(zoom) {
  return zoom > DETAIL_ZOOM ? 2 : 1;
}

/** A tile's raster size in pixels at a detail level. */
export function tilePx(detail) {
  return TILE_BASE_PX * detail;
}

/**
 * The grid tiles covering a world rectangle.
 *
 * The rectangle is treated as half-open: a tile is included only when it
 * overlaps [x0, x1). An inclusive upper bound would also return the tile the
 * rect merely touches, generating rasters nothing can see.
 *
 * @returns {Array<[number, number]>} [gx, gy] grid coordinates
 */
export function tilesForRect(x0, y0, x1, y1) {
  const out = [];
  const gx0 = Math.floor(x0 / TILE_WU);
  const gy0 = Math.floor(y0 / TILE_WU);
  // ceil(x1 / TILE_WU) - 1 is the last tile the half-open rect reaches.
  const gx1 = Math.max(gx0, Math.ceil(x1 / TILE_WU) - 1);
  const gy1 = Math.max(gy0, Math.ceil(y1 / TILE_WU) - 1);
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) out.push([gx, gy]);
  }
  return out;
}

/** The world rectangle visible through a camera and view, in world units. */
export function visibleRect(cam, view) {
  const halfW = view.width / 2 / cam.zoom;
  const halfH = view.height / 2 / cam.zoom;
  return {
    x0: cam.x - halfW,
    y0: cam.y - halfH,
    x1: cam.x + halfW,
    y1: cam.y + halfH,
  };
}

/**
 * The grid tiles covering the camera frustum, at the zoom's own tile span.
 *
 * Exactly the frustum: no margin. The margin would triple the tile count at
 * normal zoom for no benefit - the leading tile during a pan is generated on
 * the frame it becomes visible either way.
 *
 * @returns {Array<[number, number, number]>} [gx, gy, spanWu]
 */
export function visibleTiles(cam, view) {
  const span = tileWu(cam.zoom);
  const r = visibleRect(cam, view);
  const gx0 = Math.floor(r.x0 / span);
  const gy0 = Math.floor(r.y0 / span);
  const gx1 = Math.max(gx0, Math.ceil(r.x1 / span) - 1);
  const gy1 = Math.max(gy0, Math.ceil(r.y1 / span) - 1);
  const out = [];
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) out.push([gx, gy, span]);
  }
  return out;
}

/** Terrain colours as [r, g, b]. Mirrors the old PALETTE values exactly. */
export const TERRAIN_COLOURS = {
  grass: hexToRgb('#efece3'),
  grass2: hexToRgb('#e6e2d4'),
  sand: hexToRgb('#f2e3bd'),
  water: hexToRgb('#a8c4e8'),
  water2: hexToRgb('#9ab9e2'),
  rock: hexToRgb('#a3a19a'),
  rock2: hexToRgb('#6f6d68'),
  // Shoreline and rock contour accents (DESIGN section 4). Darker and cooler
  // than the fill so one pixel reads as a line rather than a colour change.
  shore: hexToRgb('#7fa4cf'),
  rockEdge: hexToRgb('#4f4d49'),
};

/**
 * The biome colour for one world point, matching the previous single-texture
 * mapping, plus the contour decision.
 *
 * Exposed for the test so the mapping can be asserted without decoding a raster.
 */
export function classify(terrain, x, y) {
  const b = terrain.sample(x, y);
  if (b === BIOME.WATER) {
    return { biome: b, colour: terrain.elevation(x, y) < WATER_SHALLOW
      ? TERRAIN_COLOURS.water2 : TERRAIN_COLOURS.water };
  }
  if (b === BIOME.SAND) return { biome: b, colour: TERRAIN_COLOURS.sand };
  if (b === BIOME.ROCK) {
    // Elevation-shaded rock with high-frequency dithering (no flat blob).
    const v = terrain.elevation(x, y);
    const t = clamp((v - 0.7) / 0.22, 0, 1);
    const n = terrain.elevation(x * 7 + 13.7, y * 7 - 7.3);
    const mixed = mixHex(
      rgbToHex(TERRAIN_COLOURS.rock), rgbToHex(TERRAIN_COLOURS.rock2),
      clamp(t * 0.85 + (n - 0.5) * 0.3, 0, 1));
    return { biome: b, colour: hexToRgb(mixed) };
  }
  return { biome: b, colour: terrain.elevation(x, y) > 0.62
    ? TERRAIN_COLOURS.grass2 : TERRAIN_COLOURS.grass };
}

/**
 * Rasterises one tile into RGBA bytes.
 *
 * Pure: the same (terrain, gx, gy, detail) always produces the same bytes, and
 * no unseeded randomness is consulted, so a saved map reproduces its own look.
 *
 * @param {object} terrain the authority in src/terrain.js
 * @param {number} gx grid x of the tile
 * @param {number} gy grid y of the tile
 * @param {number} detail 1 or 2
 * @param {number} spanWu world span of the tile
 * @returns {Uint8ClampedArray} length px*px*4
 */
export function rasterizeTile(terrain, gx, gy, detail, spanWu = TILE_WU) {
  const px = tilePx(detail);
  const data = new Uint8ClampedArray(px * px * 4);
  const step = spanWu / px;
  const x0 = gx * spanWu;
  const y0 = gy * spanWu;

  // Sample at pixel CENTRES, so the mapping is unambiguous at boundaries.
  for (let iy = 0; iy < px; iy++) {
    const wy = y0 + (iy + 0.5) * step;
    for (let ix = 0; ix < px; ix++) {
      const wx = x0 + (ix + 0.5) * step;
      const at = classify(terrain, wx, wy);
      let [r, g, b] = at.colour;

      // Contour: a pixel whose immediate neighbour is a different class is
      // darkened, which draws a one-pixel line along every class boundary. Both
      // the x and y neighbours are checked, or a shoreline running horizontally
      // would get no line at all while a vertical one did.
      // Decoration only - it never feeds buildability or pathing.
      const nb = classify(terrain, wx + step, wy).biome;
      const nbBelow = classify(terrain, wx, wy + step).biome;
      if (nb !== at.biome || nbBelow !== at.biome) {
        const edge = (at.biome === BIOME.ROCK || nb === BIOME.ROCK || nbBelow === BIOME.ROCK)
          ? TERRAIN_COLOURS.rockEdge : TERRAIN_COLOURS.shore;
        r = (r + edge[0]) >> 1;
        g = (g + edge[1]) >> 1;
        b = (b + edge[2]) >> 1;
      }

      const i = (iy * px + ix) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * Deterministic decorative patches for a terrain seed.
 *
 * Same shape as the previous single-texture decoration, so the map's look does
 * not change, but it now lives with the terrain presentation it belongs to.
 *
 * @returns {Array<{x:number,y:number,r:number,kind:string,trees:Array|null}>}
 */
export function decorativePatches(terrain) {
  const E = 3200; // the previous WORLD_EXTENT the decoration was scattered over
  const rng = makeRng(terrain.seed ^ 0x9e3779b9);
  const blobs = [];
  for (let i = 0; i < 36; i++) {
    const wx = (rng() * 2 - 1) * E * 0.9;
    const wy = (rng() * 2 - 1) * E * 0.9;
    if (terrain.sample(wx, wy) !== BIOME.GRASS) continue;
    const kind = rng() < 0.6 ? 'patch' : 'patch2';
    const r = 70 + rng() * 170;
    const blob = { x: wx, y: wy, r, kind, trees: null };
    if (kind === 'patch') {
      blob.trees = [];
      const n = 10 + Math.floor(rng() * 12);
      for (let k = 0; k < n; k++) {
        const a = rng() * Math.PI * 2;
        const rr = Math.sqrt(rng()) * r * 0.85;
        blob.trees.push([
          Math.cos(a) * rr,
          Math.sin(a) * rr * 0.72,
          (6 + rng() * 9),
          rng() < 0.5,
        ]);
      }
    }
    blobs.push(blob);
  }
  return blobs;
}

/**
 * A bounded LRU cache of rasterised tiles.
 *
 * Keyed by (gx, gy, detail, spanWu), because at low zoom a coarse tile and a
 * fine tile can share a grid coordinate while covering different world areas.
 */
export class TileCache {
  constructor({ max = MAX_TILES } = {}) {
    this.max = max;
    this.map = new Map(); // Map preserves insertion order = recency order
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /** Number of held tiles. */
  get size() {
    return this.map.size;
  }

  /**
   * Returns a cached tile, or null. A hit re-marks the entry as most recent.
   */
  get(gx, gy, detail, spanWu) {
    const key = `${gx},${gy},${detail},${spanWu}`;
    const hit = this.map.get(key);
    if (hit === undefined) {
      this.stats.misses++;
      return null;
    }
    // Re-insert so it becomes the most recently used.
    this.map.delete(key);
    this.map.set(key, hit);
    this.stats.hits++;
    return hit;
  }

  /**
   * Stores a tile, evicting the least recently used while over the bound.
   */
  put(gx, gy, detail, value, spanWu) {
    const key = `${gx},${gy},${detail},${spanWu}`;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.stats.evictions++;
    }
  }

  /** Empties the cache. Used when the terrain seed changes. */
  clear() {
    this.map.clear();
  }
}
