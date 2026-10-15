// One-shot mutation harness for S02.5b (preview validity, dialog semantics).
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: the preview reverts to stock+terrain only (the original bug)',
    file: 'src/render/preview.js',
    from: '  const result = evaluateBuildingPlacement(world, { type, x, y });',
    to: '  const ok = world.eco.canPlace(type) && world.terrain.isBuildable(x, y);\n  return { ok, reason: ok ? null : "cannot place", colour: ok ? "accent" : "danger", label: ok ? null : "Cannot place here" };',
  },
  {
    name: 'B: every preview is valid (never shows danger)',
    file: 'src/render/preview.js',
    from: '  if (result.ok) {',
    to: '  if (true) {',
  },
  {
    name: 'C: the reason label is generic',
    file: 'src/render/preview.js',
    from: '      return `No ${plural} left`;',
    to: '      return "Cannot place";',
  },
  {
    name: 'D: the help overlay loses its dialog role',
    file: 'index.html',
    from: '<div id="help" role="dialog" aria-modal="true" aria-label="Roadflow help">',
    to: '<div id="help">',
  },
  {
    name: 'E: toasts lose their polite live region',
    file: 'index.html',
    from: '<div id="toasts" role="status" aria-live="polite"></div>',
    to: '<div id="toasts"></div>',
  },
  {
    name: 'F: a slider loses its label association',
    file: 'src/main.js',
    from: "<label for=\"sliderCycle\">Cycle length</label>",
    to: '<span>Cycle length</span>',
  },
  {
    name: 'G: a slider loses its aria-label',
    file: 'src/main.js',
    from: 'aria-label="Cycle length in seconds"',
    to: '',
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
  const testFile = m.file.includes('index.html') || m.file.includes('main.js')
    ? 'test/browser/ui.js' : 'test/preview.test.js';
  try {
    out = execSync(`node --test ${testFile}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
