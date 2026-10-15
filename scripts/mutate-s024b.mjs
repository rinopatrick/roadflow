// One-shot mutation harness for S02.4b (chunked terrain presentation).
//
// Applies each mutation, runs the terrain-view unit tests, prints the failing
// test names, then restores the file. A mutation that changes nothing means the
// assertion guarding it is ineffective.
//
// Every `from` pattern is a SINGLE line on purpose: several sources are CRLF,
// and a multi-line pattern would silently fail to match.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: every tile is drawn at base detail, ignoring DETAIL_ZOOM',
    file: 'src/render/terrain.js',
    from: '  return zoom > DETAIL_ZOOM ? 2 : 1;',
    to: '  return 1;',
  },
  {
    name: 'B: the low-zoom coarsening is removed (tiles stay 512 wu)',
    file: 'src/render/terrain.js',
    from: '  return zoom < LOW_ZOOM ? TILE_WU * 4 : TILE_WU;',
    to: '  return TILE_WU;',
  },
  {
    // Both axes must be mutated together: the test asserts the mapping in x
    // and in y, so mutating one axis alone is compensated by the other.
    name: 'C: tiles are sampled at pixel corners instead of centres',
    file: 'src/render/terrain.js',
    parts: [
      ['    const wx = x0 + (ix + 0.5) * step;', '    const wx = x0 + ix * step;'],
      ['    const wy = y0 + (iy + 0.5) * step;', '    const wy = y0 + iy * step;'],
    ],
  },
  {
    name: 'D: the class boundary contour is removed',
    file: 'src/render/terrain.js',
    from: '      if (nb !== at.biome || nbBelow !== at.biome) {',,
    to: '      if (false) {',
  },
  {
    // A properly-constructed version of the earlier attempt: the edge colour is
    // replaced by the pixel's own fill colour, so a contour pixel is
    // indistinguishable from a plain one and no line can be drawn.
    name: 'E: the contour uses the plain fill colour instead of an edge colour',
    file: 'src/render/terrain.js',
    from: '        const edge = (at.biome === BIOME.ROCK || nb === BIOME.ROCK || nbBelow === BIOME.ROCK)',
    to: '        const edge = at.colour;',
  },
  {
    name: 'F: the raster samples outside its own tile',
    file: 'src/render/terrain.js',
    from: '  const x0 = gx * spanWu;',
    to: '  const x0 = 0;',
  },
  {
    name: 'G: the raster is not opaque',
    file: 'src/render/terrain.js',
    from: '      data[i + 3] = 255;',
    to: '      data[i + 3] = 0;',
  },
  {
    name: 'H: water is painted grass (colour mapping broken)',
    file: 'src/render/terrain.js',
    from: '  if (b === BIOME.SAND) return { biome: b, colour: TERRAIN_COLOURS.sand };',
    to: '  if (b === BIOME.SAND) return { biome: b, colour: TERRAIN_COLOURS.grass };',
  },
  {
    name: 'I: the visible rect is half the frustum',
    file: 'src/render/terrain.js',
    from: '  const halfW = view.width / 2 / cam.zoom;',
    to: '  const halfW = view.width / 4 / cam.zoom;',
  },
  {
    name: 'J: the tiling includes the far-edge tile (inclusive upper bound)',
    file: 'src/render/terrain.js',
    from: '  const gx1 = Math.max(gx0, Math.ceil(x1 / TILE_WU) - 1);',
    to: '  const gx1 = Math.floor(x1 / TILE_WU);',
  },
  {
    name: 'K: visible tiles ignore the coarse low-zoom span',
    file: 'src/render/terrain.js',
    from: '  const span = tileWu(cam.zoom);\n  const r = visibleRect(cam, view);',
    to: '  const span = TILE_WU;\n  const r = visibleRect(cam, view);',
  },
  {
    name: 'L: the cache never evicts (unbounded growth)',
    file: 'src/render/terrain.js',
    from: '    while (this.map.size > this.max) {',
    to: '    while (false) {',
  },
  {
    name: 'M: a cache hit does not refresh recency',
    file: 'src/render/terrain.js',
    from: '    this.map.delete(key);\n    this.map.set(key, hit);',
    to: '    // no refresh',
  },
  {
    name: 'N: the cache key ignores the tile span',
    file: 'src/render/terrain.js',
    from: '    const key = `${gx},${gy},${detail},${spanWu}`;\n    if (this.map.has(key)) this.map.delete(key);',
    to: '    const key = `${gx},${gy},${detail}`;\n    if (this.map.has(key)) this.map.delete(key);',
  },
  {
    name: 'O: decoration is placed with unseeded randomness',
    file: 'src/render/terrain.js',
    from: '  const rng = makeRng(terrain.seed ^ 0x9e3779b9);',
    to: '  const rng = Math.random;',
  },
  {
    name: 'P: decoration lands on any biome, including water',
    file: 'src/render/terrain.js',
    from: '    if (terrain.sample(wx, wy) !== BIOME.GRASS) continue;',
    to: '    if (false) continue;',
  },
  {
    name: 'Q: the raster reads unseeded randomness',
    file: 'src/render/terrain.js',
    from: '  const data = new Uint8ClampedArray(px * px * 4);',
    to: '  if (Math.random() < -1) return new Uint8ClampedArray(px * px * 4);\n  const data = new Uint8ClampedArray(px * px * 4);',
  },
];

const only = process.argv.slice(2);
const results = [];
for (const m of MUTATIONS) {
  if (only.length && !only.some(p => m.name.startsWith(p))) continue;
  const original = readFileSync(m.file, 'utf8');
  const parts = m.parts ?? [[m.from, m.to]];
  const missing = parts.filter(([from]) => !original.includes(from));
  if (missing.length) {
    results.push({ name: m.name, outcome: `INEFFECTIVE (pattern not found: ${missing[0][0].slice(0, 50)})` });
    continue;
  }
  let mutated = original;
  for (const [from, to] of parts) mutated = mutated.replace(from, to);
  writeFileSync(m.file, mutated);
  let out = '';
  try {
    out = execSync('node --test test/terrain-view.test.js', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    writeFileSync(m.file, original);
  }
  const failed = [...out.matchAll(/^✖ (.+?) \(/gm)].map(x => x[1]);
  const unique = [...new Set(failed)];
  results.push({
    name: m.name,
    outcome: unique.length ? `${unique.length} failing` : 'NO FAILURE',
    tests: unique,
  });
}

for (const r of results) {
  console.log(`\n${r.name}\n  -> ${r.outcome}`);
  for (const t of r.tests ?? []) console.log(`     ${t}`);
}
