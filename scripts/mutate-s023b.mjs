// One-shot mutation harness for S02.3b (junction geometry and shadows).
//
// Applies each mutation, runs the junction unit tests, prints the failing test
// names, then restores the file. A mutation that changes nothing means the
// assertion guarding it is ineffective.
//
// Every `from` pattern is a SINGLE line on purpose: several sources are CRLF,
// and a multi-line pattern would silently fail to match.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: every node gets a round cap again (the disk bug)',
    file: 'src/render/junctions.js',
    from: '  return degree <= 2 ? \'round\' : \'butt\';',
    to: '  return \'round\';',
  },
  {
    name: 'B: every node gets a square cap (bends lose their round join)',
    file: 'src/render/junctions.js',
    from: '  return degree <= 2 ? \'round\' : \'butt\';',
    to: '  return \'butt\';',
  },
  {
    name: 'C: a bend is treated as a junction and filled',
    file: 'src/render/junctions.js',
    from: '  if (entries.length < minDegree) return { quads: [], reach: 0 };',
    to: '  if (entries.length < 2) return { quads: [], reach: 0 };',
  },
  {
    name: 'D: a junction quad is drawn at the reach width, i.e. a disk',
    file: 'src/render/junctions.js',
    from: '    const px = dy * hw;\n    const py = -dx * hw;',
    to: '    const px = dy * reach;\n    const py = -dx * reach;',
  },
  {
    name: 'E: the mouth trim uses our own width again (the original bug)',
    file: 'src/render/junctions.js',
    from: '    reach = Math.max(reach, halfWidth(other));',
    to: '    reach = Math.max(reach, 0);',
  },
  {
    name: 'F: a bend is trimmed as if it were a junction',
    file: 'src/render/junctions.js',
    from: '  if (edges.length < 3) return 0;',
    to: '  if (edges.length < 1) return 0;',
  },
  {
    name: 'G: the marking margin is dropped, so markings touch the mouth',
    file: 'src/render/junctions.js',
    from: 'export const MARKING_MARGIN = 1.5;',
    to: 'export const MARKING_MARGIN = 0;',
  },
  {
    name: 'H: the shadow offset ignores object height',
    file: 'src/render/junctions.js',
    from: '  return [SHADOW_DIR[0] * height, SHADOW_DIR[1] * height];',
    to: '  return [SHADOW_DIR[0], SHADOW_DIR[1]];',
  },
  {
    name: 'I: the shadow offset is not counter-rotated (rotates with the object)',
    file: 'src/render/junctions.js',
    from: '  const cos = Math.cos(-rot);\n  const sin = Math.sin(-rot);',
    to: '  const cos = 1;\n  const sin = 0;',
  },
  {
    name: 'J: the counter-rotation is applied twice',
    file: 'src/render/junctions.js',
    from: '  const cos = Math.cos(-rot);\n  const sin = Math.sin(-rot);',
    to: '  const cos = Math.cos(-2 * rot);\n  const sin = Math.sin(-2 * rot);',
  },
  {
    name: 'K: an edge direction ignores which end the node is',
    file: 'src/render/junctions.js',
    from: '  if (edge.a === node.id) {',
    to: '  if (true) {',
  },
  {
    name: 'L: the junction footprint inset is ignored',
    file: 'src/render/junctions.js',
    from: '    entries.push({ dir, hw: halfWidth(e) + inset });',
    to: '    entries.push({ dir, hw: halfWidth(e) });',
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
    out = execSync('node --test test/junctions.test.js', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
