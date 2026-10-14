// One-shot mutation harness for S02.2b.
//
// Applies each mutation to the working tree, runs the browser UI suite, prints
// the failing test names, then restores the original file. A mutation that
// changes nothing means the assertion guarding it is ineffective.
//
// Every `from` pattern is a SINGLE line on purpose: several sources are CRLF,
// and a multi-line pattern would silently fail to match.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: nextOverlay stores an unknown layer id',
    file: 'src/layers.js',
    from: '  if (!LAYER_IDS.includes(id)) return current;',
    to: '  if (false) return current;',
  },
  {
    name: 'B: the access layer is relabelled as a pollution layer',
    file: 'src/layers.js',
    from: "    id: 'access',",
    to: "    id: 'pollution',",
  },
  {
    name: 'C: the renderer regains a showPollution flag',
    file: 'src/render.js',
    from: '    this.cam = { x: 0, y: 0, zoom: 1 };',
    to: '    this.cam = { x: 0, y: 0, zoom: 1 };\n    this.showPollution = false;',
  },
  {
    name: 'D: the fabricated pollution overlay is restored',
    file: 'src/render.js',
    from: '  _drawSelection(ctx, sel, zoom, net, eco) {',
    to: '  _drawPollution(ctx, eco, zoom) { return 620 * zoom; }\n\n  _drawSelection(ctx, sel, zoom, net, eco) {',
  },
  {
    name: 'E: the traffic overlay tints every edge, including empty ones',
    file: 'src/layers.js',
    from: '    if (cars <= 0 && congestion < TRAFFIC_BANDS[1].min) continue;',
    to: '    if (false) continue;',
  },
  {
    name: 'F: every building is reported reachable',
    file: 'src/layers.js',
    from: '      state: via ? ACCESS_STATE.REACHABLE : ACCESS_STATE.UNREACHABLE,',
    to: '      state: ACCESS_STATE.REACHABLE,',
  },
  {
    name: 'G: the traffic legend reports a fabricated count',
    file: 'src/main.js',
    from: "    for (const row of trafficOverlay(net)) counts[`band-${row.level}`]++;",
    to: "    counts['band-0'] = 999;",
  },
  {
    name: 'H: the sound toggle does not reach the audio setting',
    file: 'src/ui/menu.js',
    from: '    handlers.onSound(next);',
    to: '    void next;',
  },
  {
    name: 'I: a failed import replaces the city anyway',
    file: 'src/main.js',
    from: '    if (!result.ok) {',
    to: '    if (false) {',
  },
  {
    name: 'J: the depletion message drops the progression link',
    file: 'src/main.js',
    from: '  const need = LEVEL_XP(eco.level) - eco.xp;',
    to: '  const need = 0;',
  },
  {
    // The static hidden attribute is NOT a usable mutation target: sync() sets
    // legend.hidden on boot, so removing the attribute changes nothing and
    // proves nothing. This mutates the real logic instead.
    name: 'K: the legend stays visible when no layer is on',
    file: 'src/ui/layers.js',
    from: '    legend.hidden = state.overlay === null;',
    to: '    legend.hidden = false;',
  },
  {
    name: 'L: every layer legend block is shown at once',
    file: 'src/ui/layers.js',
    from: '      block.hidden = block.dataset.legend !== state.overlay;',
    to: '      block.hidden = false;',
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
    out = execSync('node --test test/browser/ui.js test/layers.test.js', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
