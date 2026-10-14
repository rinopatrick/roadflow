// One-shot mutation harness for S02.2a.
//
// Applies each mutation to the working tree, runs the browser UI suite, prints
// the failing test names, then restores the original file. A mutation that
// changes nothing means the assertion guarding it is ineffective.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: controller accepts unknown state keys',
    file: 'src/ui/controller.js',
    from: '    if (unknown.length) {',
    to: '    if (false) {',
  },
  {
    name: 'B: selecting a tool no longer opens its category',
    file: 'src/ui/toolbar.js',
    from: "  ui.set({ activeTool: id, openCategory: category });",
    to: "  ui.set({ activeTool: id });",
  },
  {
    name: 'C: closed categories keep their tools visible',
    file: 'src/ui/toolbar.js',
    from: '    btn.hidden = btn.dataset.toolCategory !== state.openCategory;',
    to: '    btn.hidden = false;',
  },
  {
    name: 'D: New map always confirms, dirty or not',
    file: 'src/main.js',
    from: "    if (dirty && !confirm('Start a new map? Unsaved progress is lost.')) return;",
    to: "    if (!confirm('Start a new map? Unsaved progress is lost.')) return;",
  },
  {
    name: 'E: building a road no longer marks the city dirty',
    file: 'src/main.js',
    from: '  if (res.edgeIds.length) { sfx.place(); dirty = true; }',
    to: '  if (res.edgeIds.length) { sfx.place(); }',
  },
  {
    name: 'F: speed labels go back to indistinguishable glyphs',
    file: 'index.html',
    from: '<button class="spd-btn" data-speed="3" aria-label="3x speed" title="Fast speed">3×</button>',
    to: '<button class="spd-btn" data-speed="3" aria-label="3x speed" title="Fast speed">▶▶</button>',
  },
  {
    name: 'G: the top band lets clicks through to the canvas',
    file: 'src/ui.css',
    from: '#brand { display: flex; flex-direction: column; gap: 3px; }',
    to: '#brand { display: flex; flex-direction: column; gap: 3px; }\n#topband { pointer-events: none; }',
  },
  {
    name: 'H: the inspector is allowed to cover the dock',
    file: 'src/ui.css',
    from: '  bottom: calc(var(--gap) + var(--dock-h) + var(--gap));',
    to: '  bottom: 0;',
  },
  {
    name: 'I: the menu button stops reporting aria-expanded',
    file: 'src/ui/menu.js',
    from: "    menuBtn.setAttribute('aria-expanded', String(open));",
    to: '    void open;',
  },
  {
    name: 'J: a hidden tool is still focusable',
    file: 'src/ui/toolbar.js',
    from: '    btn.hidden = btn.dataset.toolCategory !== state.openCategory;',
    to: '    btn.style.visibility = btn.dataset.toolCategory === state.openCategory ? "" : "hidden";',
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
