// One-shot mutation harness for S02.3a (lane marking geometry).
//
// Applies each mutation to the working tree, runs the marking unit tests, prints
// the failing test names, then restores the original file. A mutation that
// changes nothing means the assertion guarding it is ineffective.
//
// Every `from` pattern is a SINGLE line on purpose: several sources are CRLF,
// and a multi-line pattern would silently fail to match.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: trimming reverts to keeping only existing vertices (the original bug)',
    file: 'src/render/markings.js',
    from: '  const out = [pointAtArc(pts, cum, start)];',
    to: '  const out = [];',
  },
  {
    name: 'B: the low-zoom dash gate is removed',
    file: 'src/render/markings.js',
    from: 'export const DASH_MIN_ZOOM = 0.35;',
    to: 'export const DASH_MIN_ZOOM = 0;',
  },
  {
    name: 'C: the dash gate is raised above normal play',
    file: 'src/render/markings.js',
    from: 'export const DASH_MIN_ZOOM = 0.35;',
    to: 'export const DASH_MIN_ZOOM = 2;',
  },
  {
    name: 'D: divider offsets ignore the median (one-way roads get dividers)',
    file: 'src/render/markings.js',
    from: '  if (dim.medianWidth <= 0) return [];',
    to: '  if (false) return [];',
  },
  {
    name: 'F: the trim is no longer clamped on a short edge',
    file: 'src/render/markings.js',
    from: '  return Math.max(0, Math.min(trim, length / 2 - 0.5));',
    to: '  return trim;',
  },
  {
    name: 'G: the centreline is drawn on one-way roads too',
    file: 'src/render/markings.js',
    from: '    showCentreline: dim.medianWidth > 0,',
    to: '    showCentreline: true,',
  },
  {
    name: 'H: the first divider sits on the median instead of one lane out',
    file: 'src/render/markings.js',
    from: '    offsets.push(dim.medianWidth / 2 + i * dim.laneWidth);',
    to: '    offsets.push(i * dim.laneWidth);',
  },
  {
    name: 'I: lane offsetting ignores the segment direction',
    file: 'src/render/markings.js',
    from: '    out.push([p[0] + Math.sin(ang) * off, p[1] - Math.cos(ang) * off]);',
    to: '    out.push([p[0], p[1] + off]);',
  },
  {
    name: 'J: a zero-length segment is allowed to produce NaN',
    file: 'src/render/markings.js',
    from: '    if (len === 0) { out.push([p[0], p[1]]); continue; }',
    to: '    if (false) { out.push([p[0], p[1]]); continue; }',
  },
  {
    name: 'L: a mismatched cum array is misread instead of refused',
    file: 'src/render/markings.js',
    from: '  if (!Array.isArray(cum) || cum.length !== pts.length) return [];',
    to: '  if (!Array.isArray(cum)) return [];',
  },
];

const only = process.argv.slice(2);
const results = [];
for (const m of MUTATIONS) {
  if (only.length && !only.some(p => m.name.startsWith(p))) continue;
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    results.push({ name: m.name, outcome: 'INEFFECTIVE (pattern not found)' });
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let out = '';
  try {
    out = execSync('node --test test/renderMarkings.test.js', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
