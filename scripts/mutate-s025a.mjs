// One-shot mutation harness for S02.5a (pointer state machine, keyboard scoping).
//
// Every `from` pattern is a SINGLE line: several sources are CRLF.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: a right-click draws instead of panning',
    file: 'src/input.js',
    from: '  if (button === 1 || button === 2 || shiftKey) return \'pan\';',
    to: '  if (button === 1 || shiftKey) return \'pan\';',
  },
  {
    name: 'B: a shift+left click draws instead of panning',
    file: 'src/input.js',
    from: '  if (button === 1 || button === 2 || shiftKey) return \'pan\';',
    to: '  if (button === 1 || button === 2) return \'pan\';',
  },
  {
    name: 'C: a pan does not account for the zoom',
    file: 'src/input.js',
    from: '    x: start.camX - (px - start.sx) / zoom,',
    to: '    x: start.camX - (px - start.sx),',
  },
  {
    name: 'D: the pan does not preserve the world under the pointer',
    file: 'src/input.js',
    from: '    x: start.camX - (px - start.sx) / zoom,',
    to: '    x: start.camX + (px - start.sx) / zoom,',
  },
  {
    name: 'E: a draft point is never deduplicated',
    file: 'src/input.js',
    from: '    if (Math.hypot(x - last[0], y - last[1]) < minDist) return draft;',
    to: '    if (false) return draft;',
  },
  {
    name: 'F: the dedup threshold is so large no point is ever pushed',
    file: 'src/input.js',
    from: '    if (Math.hypot(x - last[0], y - last[1]) < minDist) return draft;',
    to: '    if (Math.hypot(x - last[0], y - last[1]) < 1e9) return draft;',
  },
  {
    name: 'G: a form control does not win (typing a 1 selects a tool)',
    file: 'src/input.js',
    from: '  if (isFormControl(target)) return { action: \'none\', preventDefault: false };',
    to: '  if (false) return { action: \'none\', preventDefault: false };',
  },
  {
    name: 'H: SELECT is not treated as a form control',
    file: 'src/input.js',
    from: "  return FORM_TAGS.has(target.tagName);",
    to: '  return target.tagName === \'INPUT\' || target.tagName === \'TEXTAREA\';',
  },
  {
    name: 'I: an open panel does not block shortcuts',
    file: 'src/input.js',
    from: '  if (dialog || panel) return { action: \'none\', preventDefault: false };',
    to: '  if (dialog) return { action: \'none\', preventDefault: false };',
  },
  {
    name: 'J: an open dialog does not block shortcuts',
    file: 'src/input.js',
    from: '  if (dialog || panel) return { action: \'none\', preventDefault: false };',
    to: '  if (panel) return { action: \'none\', preventDefault: false };',
  },
  {
    name: 'K: Space always pauses, even on a focused button',
    file: 'src/input.js',
    from: '    if (target.tagName === \'BUTTON\' || target.tagName === \'A\') {',
    to: '    if (false) {',
  },
  {
    name: 'L: the pointer tracker never leaves panning',
    file: 'src/input.js',
    from: '  reset() {\n    this.mode = POINTER_MODE.IDLE;\n    this.start = null;\n  }',
    to: '  reset() {\n    this.mode = POINTER_MODE.PANNING;\n  }',
  },
  {
    name: 'M: the tracker never enters panning',
    file: 'src/input.js',
    from: '    this.mode = POINTER_MODE.PANNING;',
    to: '    this.mode = POINTER_MODE.IDLE;',
  },
  {
    name: 'N: inputMode never reports drawing',
    file: 'src/input.js',
    from: '  if (hasDraft) return INPUT_MODE.DRAWING;',
    to: '  if (false) return INPUT_MODE.DRAWING;',
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
    out = execSync('node --test test/input.test.js', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
