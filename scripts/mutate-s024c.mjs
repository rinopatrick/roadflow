// One-shot mutation harness for S02.4c (building silhouettes).
//
// Every `from` pattern is a SINGLE line on purpose: several sources are CRLF.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: the variant is constant (every building wears the same silhouette)',
    file: 'src/render/buildings.js',
    from: '  return h % count;',
    to: '  return 0;',
  },
  {
    name: 'B: the variant is out of range',
    file: 'src/render/buildings.js',
    from: '  return h % count;',
    to: '  return h % (count + 3);',
  },
  {
    // NOT a usable mutation: the contract is "the variant is a deterministic
    // function of the id", and this alternative hash satisfies it too. No test
    // can distinguish two hash functions that both meet the contract, so this
    // proves nothing and is dropped rather than counted.
    name: 'C: the variant uses a different hash function',
    file: 'src/render/buildings.js',
    from: '    h ^= s.charCodeAt(i);',
    to: '    h ^= s.charCodeAt(i) + i * 7919;',
  },
  {
    name: 'D: the entry angle points AWAY from the driveway',
    file: 'src/render/buildings.js',
    from: '  return Math.atan2(dy, dx);',
    to: '  return Math.atan2(dy, dx) + Math.PI;',
  },
  {
    name: 'E: a missing driveway falls back to a guess instead of null',
    file: 'src/render/buildings.js',
    from: '  if (!n) return null;',
    to: '  if (!n) return 0;',
  },
  {
    name: 'F: a coincident driveway falls back to a guess',
    file: 'src/render/buildings.js',
    from: '  if (dx === 0 && dy === 0) return null;',
    to: '  if (false) return null;',
  },
  {
    name: 'G: one variant loses its geometry (silently identical to another)',
    file: 'src/render/buildings.js',
    from: "  const shapes = geo[variant];",
    to: "  const shapes = geo[0];",
  },
  {
    name: 'H: house v0 loses its yard (variant becomes the same shape as another)',
    file: 'src/render/buildings.js',
    from: "      { kind: 'rect', role: 'yard', x: 0.34, y: 0, w: 0.24, h: 0.34 },",
    to: '',
  },
  {
    name: 'I: geometry spills past the footprint',
    file: 'src/render/buildings.js',
    from: "      { kind: 'rect', role: 'accent', x: 0.38, y: 0, w: 0.14, h: 0.56 },",
    to: "      { kind: 'rect', role: 'accent', x: 0.42, y: 0, w: 0.2, h: 0.56 },",
  },
  {
    name: 'J: the shop awning moves to the back of the lot',
    file: 'src/render/buildings.js',
    from: "      { kind: 'rect', role: 'accent', x: 0.38, y: 0, w: 0.14, h: 0.56 },",
    to: "      { kind: 'rect', role: 'accent', x: -0.38, y: 0, w: 0.14, h: 0.56 },",
  },
];

const only = process.argv.slice(2);
const results = [];
for (const m of MUTATIONS) {
  if (only.length && !only.some(p => m.name.startsWith(p))) continue;
  const original = readFileSync(m.file, 'utf8');
  const parts = m.parts ?? [[m.from, m.to]];
  const missing = parts.filter(([from]) => from && !original.includes(from));
  if (missing.length) {
    results.push({ name: m.name, outcome: `INEFFECTIVE (pattern not found: ${missing[0][0].slice(0, 50)})` });
    continue;
  }
  let mutated = original;
  for (const [from, to] of parts) {
    mutated = to === '' ? mutated.split(from).join('') : mutated.replace(from, to);
  }
  writeFileSync(m.file, mutated);
  let out = '';
  try {
    out = execSync('node --test test/buildings-view.test.js', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
