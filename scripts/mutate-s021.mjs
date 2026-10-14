// One-shot mutation harness for S02.1.
//
// Applies each mutation to the working tree, runs the browser UI suite, prints
// the failing test names, then restores the original file. A mutation that
// changes nothing means the assertion guarding it is ineffective.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: drop the prefers-reduced-motion block',
    file: 'src/ui.css',
    from: '@media (prefers-reduced-motion: reduce) {',
    to: '@media (prefers-reduced-motion: no-preference) {',
  },
  {
    name: 'B: focus ring back to 1px',
    file: 'src/ui.css',
    from: ':focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }',
    to: ':focus-visible { outline: 1px solid var(--focus); outline-offset: 0; }',
  },
  {
    name: 'C: active tool text uses --ink instead of the raised surface',
    file: 'src/ui.css',
    from: '.tool-btn.active { background: var(--accent); border-color: var(--accent); color: var(--surface-raised); }',
    to: '.tool-btn.active { background: var(--accent); border-color: var(--accent); color: var(--ink); }',
  },
  {
    name: 'D: remove the --focus token',
    file: 'src/ui.css',
    from: '  --focus: #096ca9;\n',
    to: '',
  },
  {
    name: 'E: put an emoji back into a tool icon',
    file: 'src/main.js',
    from: "{ id: 'road', icon: 'road', label: 'Road', key: '1' }",
    to: "{ id: 'road', icon: '\u{1F6E3}\u{FE0F}', label: 'Road', key: '1' }",
  },
  {
    name: 'F: badges stop following the real stock',
    file: 'src/main.js',
    from: '    badge.textContent = stock;',
    to: '    badge.textContent = badge.textContent;',
  },
  {
    name: 'G: uiTokens accent drifts from --accent',
    file: 'src/uiTokens.js',
    from: "  accent: '#146b68',",
    to: "  accent: '#2bb8e8',",
  },
  {
    name: 'H: toolbar loses its visible text label',
    file: 'src/main.js',
    from: '<span class="label">${t.label}</span>',
    to: '',
  },
];

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    results.push({ name: m.name, outcome: 'INEFFECTIVE (pattern not found)' });
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let out = '';
  try {
    out = execSync('node --test test/browser/ui.js', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
