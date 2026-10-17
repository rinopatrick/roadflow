// One-shot mutation harness for S03.2 (road draft, snapping, footprint).
//
// EOL-aware: git checks these files out as CRLF on Windows, so patterns are
// matched against an LF-normalised copy and the original EOL is restored.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: footprint validation checks only the endpoints (the original defect)',
    file: 'src/roadDraft.js',
    from: '  for (const p of samples) {\n    if (!world.terrain.isRoadable(p[0], p[1])) {',
    to: '  for (const p of [samples[0], samples[samples.length - 1]]) {\n    if (!world.terrain.isRoadable(p[0], p[1])) {',
  },
  {
    name: 'B: the sample step is so large that nothing between endpoints is checked',
    file: 'src/roadDraft.js',
    from: 'export const MAX_SAMPLE_STEP = 4;',
    to: 'export const MAX_SAMPLE_STEP = 100000;',
  },
  {
    name: 'C: curve mode uses a different segment length from addRoad',
    file: 'src/roadDraft.js',
    from: 'export const SPLINE_SEG_LEN = 12;',
    to: 'export const SPLINE_SEG_LEN = 40;',
  },
  {
    name: 'D: addRoad ignores the authored geometry and re-splines',
    file: 'src/roadNetwork.js',
    from: '    const authored = Array.isArray(options?.pts) && options.pts.length >= 2 ? options.pts : null;',
    to: '    const authored = null;',
  },
  {
    name: 'E: snap=false still snaps',
    file: 'src/roadDraft.js',
    from: '  if (!snap) return { x: raw[0], y: raw[1], target: null };',
    to: '  if (false) return { x: raw[0], y: raw[1], target: null };',
  },
  {
    name: 'F: the node snap radius is not capped',
    file: 'src/roadDraft.js',
    from: '  return Math.min(px / z, capWu);',
    to: '  return px / z;',
  },
  {
    name: 'G: the angle snap uses 30 degrees instead of 15',
    file: 'src/roadDraft.js',
    from: 'export const ANGLE_SNAP_DEG = 15;',
    to: 'export const ANGLE_SNAP_DEG = 30;',
  },
  {
    name: 'H: an edge beats a node (priority inverted)',
    file: 'src/roadDraft.js',
    from: '  const node = nearestNode(world.net, raw[0], raw[1], snapRadiusWu(SNAP.nodePx, zoom, SNAP.nodeCapWu));\n  if (node) return { x: node.x, y: node.y, target: { kind: \'node\', id: node.nodeId } };',
    to: '  const node = null;',
  },
  {
    name: 'I: the building overlap check is skipped',
    file: 'src/roadDraft.js',
    from: '      if (nearest < def.size / 2 + halfWidth) {',
    to: '      if (false) {',
  },
  {
    name: 'J: straight mode silently splines the controls',
    file: 'src/roadDraft.js',
    from: '  return controls.map(p => [p[0], p[1]]);',
    to: '  return splinePoints(controls, SPLINE_SEG_LEN).pts;',
  },
  {
    name: 'K: an unknown road class is accepted',
    file: 'src/roadDraft.js',
    from: '  } catch {\n    return { ...empty, reason: `unknown road class: ${cls}` };\n  }',
    to: '  } catch {\n    /* accepted */\n  }',
  },
  {
    name: 'L: a draft collapsing to a point is accepted',
    file: 'src/roadDraft.js',
    from: '  if (!anyDistinct) {',
    to: '  if (false) {',
  },
  {
    name: 'M: controlArcByProjection is not forced monotonic',
    file: 'src/roadNetwork.js',
    from: '    const clamped = Math.max(previous, Math.min(s, total));',
    to: '    const clamped = Math.min(s, total);',
  },
  {
    name: 'N: the draft reports a fictional cost',
    file: 'src/roadDraft.js',
    from: '    cost: null,',
    to: '    cost: Math.round(total * 2),',
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
    out = execSync('node --test test/roadDraft.test.js test/construction.test.js',
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
