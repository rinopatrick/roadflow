// One-shot mutation harness for S03.5 (templates).
//
// EOL-aware: patterns are matched against an LF-normalised copy.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: an unknown template field is ignored instead of rejected',
    file: 'src/templates.js',
    from: '    if (!TEMPLATE_FIELDS.has(key)) return fail(`unknown template field: ${key}`);',
    to: '    if (false) return fail(`unknown template field: ${key}`);',
  },
  {
    name: 'B: an unknown segment field is ignored',
    file: 'src/templates.js',
    from: '      if (!SEGMENT_FIELDS.has(key)) return fail(`segment ${i + 1} has unknown field: ${key}`);',
    to: '      if (false) return fail(`segment ${i + 1} has unknown field: ${key}`);',
  },
  {
    name: 'C: a future schema version is accepted',
    file: 'src/templates.js',
    from: '  if (raw.version !== TEMPLATE_VERSION) {',
    to: '  if (false) {',
  },
  {
    name: 'D: the wrong schema identifier is accepted',
    file: 'src/templates.js',
    from: '  if (raw.schema !== TEMPLATE_SCHEMA) {',
    to: '  if (false) {',
  },
  {
    name: 'E: the segment count limit is not enforced',
    file: 'src/templates.js',
    from: '  if (raw.segments.length > TEMPLATE_LIMITS.segments) {',
    to: '  if (false) {',
  },
  {
    name: 'F: coordinates are not bounded',
    file: 'src/templates.js',
    from: '        if (Math.abs(v) > TEMPLATE_LIMITS.coordinate) {',
    to: '        if (false) {',
  },
  {
    name: 'G: a zero-length segment is accepted',
    file: 'src/templates.js',
    from: '    if (dist(s.from[0], s.from[1], s.to[0], s.to[1]) < 1) {',
    to: '    if (false) {',
  },
  {
    name: 'H: a supplied bbox is trusted instead of derived',
    file: 'src/templates.js',
    from: '  const bbox = boundsOf(segments);',
    to: '  const bbox = raw.bbox ?? boundsOf(segments);',
  },
  {
    name: 'I: rotation is not required to be a multiple of 15',
    file: 'src/templates.js',
    from: '  if (rotateDeg % ROTATION_STEP_DEG !== 0) {',
    to: '  if (false) {',
  },
  {
    name: 'J: rotation does not actually rotate',
    file: 'src/templates.js',
    from: '    (x * cos - y * sin) + 0 || 0,\n    (x * sin + y * cos) + 0 || 0,',
    to: '    x,\n    y,',
  },
  {
    name: 'K: translation is ignored',
    file: 'src/templates.js',
    from: '    return [(rx + dx) + 0 || 0, (ry + dy) + 0 || 0];',
    to: '    return [rx, ry];',
  },
  {
    name: 'L: the oversize guard is removed from parseTemplate',
    file: 'src/templates.js',
    from: '  if (text.length > TEMPLATE_LIMITS.bytes) {',
    to: '  if (false) {',
  },
  {
    name: 'M: a template filename is built by stripping, so a separator survives',
    file: 'src/templates.js',
    from: "    .replace(/[^a-z0-9]+/g, '-')",
    to: "    .replace(/\\s+/g, '-')",
  },
  {
    name: 'N: exporting a partial roundabout is allowed',
    file: 'src/templates.js',
    from: '    if (ringEdges.length !== allRing.length) {',
    to: '    if (false) {',
  },
  {
    name: 'O: the applyTemplate command tolerates a failing segment',
    file: 'src/worldCommands.js',
    from: "      if (!res.edgeIds.length && !/already runs along/.test(res.reason ?? '')) {",
    to: '      if (false) {',
  },
  {
    name: 'P: the applyTemplate command skips terrain validation',
    file: 'src/worldCommands.js',
    from: '        if (!world.terrain.isRoadable(p[0], p[1])) {',
    to: '        if (false) {',
  },
  {
    name: 'Q: the applyTemplate command ignores roundabout markers',
    file: 'src/worldCommands.js',
    from: '    for (let i = 0; i < roundabouts.length; i++) {',
    to: '    for (let i = 0; i < 0; i++) {',
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
    out = execSync('node --test test/templates.test.js test/worldCommands.test.js',
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
