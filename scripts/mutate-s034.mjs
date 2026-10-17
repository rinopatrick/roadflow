// One-shot mutation harness for S03.4 (safe construction edits).
//
// EOL-aware: patterns are matched against an LF-normalised copy.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: an upgrade ignores building overlap (silently evicts a house)',
    file: 'src/constructionEdits.js',
    from: '    if (nearest < clearance) {',
    to: '    if (false) {',
  },
  {
    name: 'B: an upgrade ignores the widened footprint on terrain',
    file: 'src/constructionEdits.js',
    from: '      if (!world.terrain.isRoadable(ex, ey)) {',
    to: '      if (false) {',
  },
  {
    name: 'C: an upgrade to the same class is allowed',
    file: 'src/constructionEdits.js',
    from: '  if (edge.cls === newCls) return deny(`that road is already a ${newCls}`);',
    to: '  if (false) return deny(`that road is already a ${newCls}`);',
  },
  {
    name: 'D: a roundabout ring edge can be upgraded in place',
    file: 'src/constructionEdits.js',
    from: "  if (edge.ring) return deny('a roundabout ring cannot be upgraded');",
    to: "  if (false) return deny('a roundabout ring cannot be upgraded');",
  },
  {
    name: 'E: the radius bounds are not enforced',
    file: 'src/constructionEdits.js',
    from: '  if (radius < ROUNDABOUT_RADIUS.min || radius > ROUNDABOUT_RADIUS.max) {',
    to: '  if (false) {',
  },
  {
    name: 'F: a radius that would swallow an arm is allowed',
    file: 'src/constructionEdits.js',
    from: '    if (reach < radius) {',
    to: '    if (false) {',
  },
  {
    name: 'G: a driveway inside the ring is allowed',
    file: 'src/constructionEdits.js',
    from: '    if (dist(node.x, node.y, center.x, center.y) < radius) {',
    to: '    if (false) {',
  },
  {
    name: 'H: arms too close together are allowed',
    file: 'src/constructionEdits.js',
    from: '    if (chord < ringWidth) {',
    to: '    if (false) {',
  },
  {
    name: 'I: a moved building collides with ITSELF',
    file: 'src/constructionEdits.js',
    from: '    if (id !== buildingId) others.set(id, other);',
    to: '    others.set(id, other);',
  },
  {
    name: 'J: a move spends stock',
    file: 'src/constructionEdits.js',
    from: '    batch: { ...world.eco.batch, [b.type]: Math.max(1, world.eco.batch[b.type] ?? 0) },',
    to: '    batch: { ...world.eco.batch, [b.type]: 0 },',
  },
  {
    name: 'K: the demolition preview reports only ONE building on a shared driveway',
    file: 'src/constructionEdits.js',
    from: '      const ids = owners.length ? owners : [b.id];',
    to: '      const ids = [b.id];',
  },
  {
    name: 'L: clicking a roundabout reports only the clicked ring edge',
    file: 'src/constructionEdits.js',
    from: '      const ringEdges = [...net.edges.values()].filter(e => e.ring);',
    to: '      const ringEdges = [net.edges.get([...node.edges][0])];',
  },
  {
    name: 'M: the upgrade command does not change the class',
    file: 'src/worldCommands.js',
    from: '    edge.cls = cmd.cls;',
    to: '    void cmd.cls;',
  },
  {
    name: 'N: the upgrade command skips validation',
    file: 'src/worldCommands.js',
    from: '    const check = validateRoadUpgrade(world, cmd.edgeId, cmd.cls);\n    if (!check.ok) return fail(check.reason);',
    to: '    // not validated',
  },
  // O removed: attachDriveway already claims the building (idempotently), so the
  // explicit claimDriveway was DEAD CODE. It has been deleted rather than kept
  // as an unobservable line; the mutation could not fail anything.
  {
    name: 'P: the roundabout command ignores the requested radius',
    file: 'src/worldCommands.js',
    from: '    const res = world.net.makeRoundabout(cmd.nodeId, radius);',
    to: '    const res = world.net.makeRoundabout(cmd.nodeId);',
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
    out = execSync('node --test test/construction-edits.test.js test/worldCommands.test.js',
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
