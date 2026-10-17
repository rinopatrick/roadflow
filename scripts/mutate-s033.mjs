// One-shot mutation harness for S03.3 (road grid) and the crossing fix.
//
// EOL-aware: patterns are matched against an LF-normalised copy.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: the intersection parameter test excludes endpoints again (the 30deg bug)',
    file: 'src/roadNetwork.js',
    from: '        if (t >= -CROSS_PARAM_EPS && t <= 1 + CROSS_PARAM_EPS\n          && u >= -CROSS_PARAM_EPS && u <= 1 + CROSS_PARAM_EPS) {',
    to: '        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {',
  },
  {
    name: 'B: the epsilon is so large that near-misses count as crossings',
    file: 'src/roadNetwork.js',
    from: 'const CROSS_PARAM_EPS = 1e-9;',
    to: 'const CROSS_PARAM_EPS = 0.5;',
  },
  {
    name: 'C: splitEdge creates the node before checking it can split (dangling node)',
    file: 'src/roadNetwork.js',
    from: '    if (!ptsA || !ptsB) return null; // cannot split: change nothing at all',
    to: '    if (!ptsA || !ptsB) return this._makeNode(0, 0, \'plain\');',
  },
  {
    name: 'D: an already-paved slice is not detected (duplicate edges from a chain)',
    file: 'src/roadNetwork.js',
    from: '      if (this._sliceCovered(slice)) { skipped++; continue; }',
    to: '      if (false) { skipped++; continue; }',
  },
  {
    name: 'E: axis stops leave a sliver at the far edge',
    file: 'src/gridDraft.js',
    from: '  const n = Math.max(1, Math.round(span / step));',
    to: '  const n = Math.max(1, Math.floor(span / step));\n  if (false) return out;',
  },
  {
    name: 'F: the grid normal is not flipped for a reversed drag',
    file: 'src/gridDraft.js',
    from: '  if (signedWidth < 0) normal = [(-normal[0]) + 0 || 0, (-normal[1]) + 0 || 0];',
    to: '  if (false) normal = [(-normal[0]) + 0 || 0, (-normal[1]) + 0 || 0];',
  },
  {
    name: 'G: the minimum base length is not enforced',
    file: 'src/gridDraft.js',
    from: '  if (baseLen < MIN_BASE_WU) {',
    to: '  if (false) {',
  },
  {
    name: 'H: the minimum width is not enforced',
    file: 'src/gridDraft.js',
    from: '  if (width < MIN_WIDTH_WU) {',
    to: '  if (false) {',
  },
  {
    name: 'I: the segment limit is not enforced',
    file: 'src/gridDraft.js',
    from: '  if (count > MAX_GRID_SEGMENTS) {',
    to: '  if (false) {',
  },
  {
    name: 'J: block length is not range checked',
    file: 'src/gridDraft.js',
    from: '  if (!(Number.isFinite(bl) && bl >= GRID_LIMITS.blockMin && bl <= GRID_LIMITS.blockMax)) {',
    to: '  if (false) {',
  },
  {
    name: 'K: grid segments run along the base instead of the normal',
    file: 'src/gridDraft.js',
    from: '      to: localToWorld(frame, u, frame.width),',
    to: '      to: localToWorld(frame, u + frame.width, 0),',
  },
  {
    // NOT a usable mutation: a two-point segment splines to itself, so curve and
    // straight modes produce IDENTICAL geometry for a grid line. The flag is kept
    // as the correct expression of intent (it would matter if a segment ever had
    // intermediate points) and the property is pinned by 'a grid segment is
    // exactly its two endpoints', which no mutation of the mode flag can break.
    name: 'L: a grid segment is evaluated in curve mode (unobservable: 2 points)',
    file: 'src/gridDraft.js',
    from: "      mode: 'straight',",
    to: "      mode: 'curve',",
  },
  {
    name: 'M: one failing segment does not reject the whole grid',
    file: 'src/gridDraft.js',
    from: '    if (!rec.ok) {\n      return { ...empty, frame, segments, failIndex: i, count: raw.length, reason: rec.reason };\n    }',
    to: '    if (!rec.ok) { /* keep going */ }',
  },
  {
    name: 'N: the addGrid command tolerates a failing segment',
    file: 'src/worldCommands.js',
    from: "      if (!res.edgeIds.length && !/already runs along/.test(res.reason ?? '')) {",
    to: '      if (false) {',
  },
  {
    name: 'O: a repeated grid is treated as an error instead of idempotent',
    file: 'src/worldCommands.js',
    from: "      if (!res.edgeIds.length && !/already runs along/.test(res.reason ?? '')) {",
    to: '      if (!res.edgeIds.length) {',
  },
];

const only = process.argv.slice(2);
const results = [];
for (const m of MUTATIONS) {
  if (only.length && !only.some(p => m.name.startsWith(p))) continue;
  const rawOriginal = readFileSync(m.file, 'utf8');
  const original = rawOriginal.replace(/\r\n/g, '\n');
  const crlf = rawOriginal.includes('\r\n');
  const parts = m.parts ?? [[m.from, m.to]];
  const missing = parts.filter(([from]) => from && !original.includes(from));
  if (missing.length) {
    results.push({ name: m.name, outcome: `INEFFECTIVE (pattern not found: ${missing[0][0].slice(0, 60)})` });
    continue;
  }
  let mutated = original;
  for (const [from, to] of parts) {
    mutated = to === '' ? mutated.split(from).join('') : mutated.replace(from, to);
  }
  if (crlf) mutated = mutated.replace(/\n/g, '\r\n');
  writeFileSync(m.file, mutated);
  let out = '';
  try {
    out = execSync('node --test test/gridDraft.test.js test/worldCommands.test.js test/construction.test.js',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    writeFileSync(m.file, rawOriginal);
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
