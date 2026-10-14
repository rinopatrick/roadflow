// One-shot mutation harness for S02.4a (camera projection, framing, starter).
//
// Applies each mutation, runs the camera unit tests, prints the failing test
// names, then restores the file. A mutation that changes nothing means the
// assertion guarding it is ineffective.
//
// Every `from` pattern is a SINGLE line on purpose: several sources are CRLF,
// and a multi-line pattern would silently fail to match.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: worldToCss forgets the camera offset',
    file: 'src/camera.js',
    from: '    (x - cam.x) * cam.zoom + view.width / 2,',
    to: '    x * cam.zoom + view.width / 2,',
  },
  {
    name: 'B: worldToCss divides instead of multiplying by zoom',
    file: 'src/camera.js',
    from: '    (x - cam.x) * cam.zoom + view.width / 2,',
    to: '    (x - cam.x) / cam.zoom + view.width / 2,',
  },
  {
    name: 'C: worldToDevice is not scaled by the DPR (the original DPR bug)',
    file: 'src/camera.js',
    from: '  return [sx * dpr, sy * dpr];',
    to: '  return [sx, sy];',
  },
  {
    name: 'D: cssToWorld is not the inverse (uses device offset)',
    file: 'src/camera.js',
    from: '    (sx - view.width / 2) / cam.zoom + cam.x,',
    to: '    (sx - view.width) / cam.zoom + cam.x,',
  },
  {
    name: 'E: cssToWorld ignores the camera offset',
    file: 'src/camera.js',
    from: '    (sx - view.width / 2) / cam.zoom + cam.x,',
    to: '    (sx - view.width / 2) / cam.zoom,',
  },
  {
    name: 'F: deviceToCss does not divide by the DPR',
    file: 'src/camera.js',
    from: '  return [dx / dpr, dy / dpr];',
    to: '  return [dx, dy];',
  },
  {
    name: 'G: zoom is not clamped',
    file: 'src/camera.js',
    from: '  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));',
    to: '  return zoom;',
  },
  {
    name: 'H: a non-finite zoom is allowed through',
    file: 'src/camera.js',
    from: '  if (!Number.isFinite(zoom)) return 1;',
    to: '  if (false) return 1;',
  },
  {
    name: 'I: anchored zoom forgets to re-anchor the camera',
    file: 'src/camera.js',
    from: '    x: wx - (px - view.width / 2) / next,',
    to: '    x: cam.x,',
  },
  {
    name: 'J: anchored zoom uses the old zoom for the anchor',
    file: 'src/camera.js',
    from: '    x: wx - (px - view.width / 2) / next,',
    to: '    x: wx - (px - view.width / 2) / cam.zoom,',
  },
  {
    name: 'K: bounds ignore buildings',
    file: 'src/camera.js',
    from: '  for (const b of eco?.buildings?.values?.() ?? []) add(b.x, b.y);',
    to: '',
  },
  {
    name: 'L: an empty world reports zero bounds instead of null',
    file: 'src/camera.js',
    from: '  return any ? { minX, minY, maxX, maxY } : null;',
    to: '  return { minX, minY, maxX, maxY };',
  },
  {
    name: 'M: fit ignores the margin',
    file: 'src/camera.js',
    from: '  const paddedX = spanX * (1 + 2 * margin);',
    to: '  const paddedX = spanX;',
  },
  {
    // Both axes must be mutated together: the minimum span is enforced per axis,
    // so removing it from one is compensated by the other and proves nothing.
    // This is the 'incomplete mutation' case from TESTING.md, not a weak test.
    name: 'N: fit ignores the minimum span',
    file: 'src/camera.js',
    parts: [
      ['  const spanX = Math.max(bounds.maxX - bounds.minX, minSpanWu);',
        '  const spanX = bounds.maxX - bounds.minX;'],
      ['  const spanY = Math.max(bounds.maxY - bounds.minY, minSpanWu);',
        '  const spanY = bounds.maxY - bounds.minY;'],
    ],
  },
  {
    name: 'N2: fit ignores the minimum span on the Y axis only',
    file: 'src/camera.js',
    from: '  const spanY = Math.max(bounds.maxY - bounds.minY, minSpanWu);',
    to: '  const spanY = bounds.maxY - bounds.minY;',
  },
  {
    name: 'O: fit does not clamp the zoom',
    file: 'src/camera.js',
    from: '  const zoom = clampZoom(Math.min(view.width / paddedX, view.height / paddedY));',
    to: '  const zoom = Math.min(view.width / paddedX, view.height / paddedY);',
  },
  {
    name: 'P: fit is not centred on the content',
    file: 'src/camera.js',
    from: '  return { x: cx, y: cy, zoom };',
    to: '  return { x: 0, y: 0, zoom };',
  },
  {
    name: 'Q: starter scan takes the first qualifying cell, not the nearest',
    file: 'src/camera.js',
    from: '  cells.sort((a, b) => a.dist - b.dist || a.x - b.x || a.y - b.y);',
    to: '  // unsorted',
  },
  {
    name: 'R: starter ignores the buildable threshold',
    file: 'src/camera.js',
    from: '  const best = cells.find(c => c.buildable >= o.minBuildable);',
    to: '  const best = cells[0];',
  },
  {
    name: 'S: starter never reports a fallback',
    file: 'src/camera.js',
    from: '    fallback: true,',
    to: '    fallback: false,',
  },
  {
    name: 'T: starter reports the whole rectangle buildable',
    file: 'src/camera.js',
    from: '  return total ? hits / total : 0;',
    to: '  return 1;',
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
    out = execSync('node --test test/camera.test.js', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
