// One-shot mutation harness for S03.1 (atomic commands, undo/redo).
//
// Every `from` pattern is a SINGLE line: the sources are CRLF.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'A: a command mutates the world it was given (breaks 4.6)',
    file: 'src/worldCommands.js',
    from: '    working = hydrateWorld(copyData(before), {});',
    to: '    working = world;',
  },
  {
    name: 'B: the snapshot data is shared with the live world (the aliasing bug)',
    file: 'src/worldCommands.js',
    from: '    working = hydrateWorld(copyData(before), {});',
    to: '    working = hydrateWorld(before, {});',
  },
  // C removed: the undo/redo copy was proven redundant by construction - the
  // entry is popped and discarded, so the restored world cannot alias a stored
  // snapshot. The copy was deleted from src/worldCommands.js rather than kept
  // as an unobservable guard.
  {
    name: 'D: undo returns the current world instead of the snapshot',
    file: 'src/worldCommands.js',
    from: '      return { ok: true, world: restored, label: entry.label };',
    to: '      return { ok: true, world, label: entry.label };',
  },
  {
    name: 'E: a refused command still records history',
    file: 'src/worldCommands.js',
    from: '      if (!result.ok) return result;',
    to: '      if (!result.ok && false) return result;',
  },
  {
    name: 'F: a new action does not clear the redo branch',
    file: 'src/worldCommands.js',
    from: '      redoStack.length = 0;',
    to: '      // redo kept',
  },
  {
    name: 'G: the entry limit is ignored',
    file: 'src/worldCommands.js',
    from: '      && (undoStack.length > limit || (undoBytes > byteLimit && undoStack.length > 1))) {',
    to: '      && (false)) {',
  },
  {
    name: 'H: the byte limit is ignored',
    file: 'src/worldCommands.js',
    from: '      && (undoStack.length > limit || (undoBytes > byteLimit && undoStack.length > 1))) {',
    to: '      && (undoStack.length > limit)) {',
  },
  // I removed: checkWorldInvariants on the dispatch path is a SAFETY NET. Every
  // handler validates its own inputs, so no current command produces an invalid
  // world and mutating the call site changes nothing. The function itself is
  // tested directly against corrupted worlds.
  {
    name: 'J: an unknown command kind is dispatched anyway',
    file: 'src/worldCommands.js',
    from: '  if (!handler) {\n    return { ok: false, reason: `unknown command kind: ${kind}`, world };\n  }',
    to: '  if (!handler) {\n    return { ok: true, world, change: { removedEdgeIds: [], addedEdgeIds: [], removedBuildingIds: [], addedBuildingIds: [], replacedEdges: [], topologyChanged: false }, warnings: [] };\n  }',
  },
  {
    name: 'K: removeBuilding refunds a house whatever was destroyed',
    file: 'src/worldCommands.js',
    from: '    world.eco.batch[refundType] = (world.eco.batch[refundType] || 0) + 1;',
    to: "    world.eco.batch.house = (world.eco.batch.house || 0) + 1;",
  },
  {
    // Incomplete as a single mutation: the fixture violates all three bounds, so
    // removing only the cycle check leaves the greenRatio check to refuse it.
    // All three must be mutated together for the guard to be observable.
    name: 'L: setSignal skips the range validation',
    file: 'src/worldCommands.js',
    parts: [
      ['    if (!(Number.isFinite(cycle) && cycle >= SIGNAL_LIMITS.cycleMin && cycle <= SIGNAL_LIMITS.cycleMax)) {', '    if (false) {'],
      ['      && greenRatio >= SIGNAL_LIMITS.greenRatioMin && greenRatio <= SIGNAL_LIMITS.greenRatioMax)) {', '      && false)) {'],
      ['    if (!(Number.isFinite(offset) && offset >= 0 && offset <= cycle)) {', '    if (false) {'],
    ],
  },
  {
    name: 'M: addRoad skips the road-class validation',
    file: 'src/worldCommands.js',
    from: '      roadDimensions(cls);',
    to: '      void cls;',
  },
  {
    name: 'N: addRoad skips the terrain validation',
    file: 'src/worldCommands.js',
    from: '      if (!world.terrain.isRoadable(p[0], p[1])) {',
    to: '      if (false) {',
  },
  {
    name: 'O: a dangling building access reference is accepted',
    file: 'src/worldCommands.js',
    from: '    if (!net.nodes.has(b.drivewayNode)) {',
    to: '    if (false) {',
  },
  {
    name: 'P: a dangling edge endpoint is accepted',
    file: 'src/worldCommands.js',
    from: '    if (!net.nodes.has(e.a)) return `edge ${e.id} has a missing endpoint ${e.a}`;',
    to: '    if (false) return `edge ${e.id} has a missing endpoint ${e.a}`;',
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
    results.push({ name: m.name, outcome: `INEFFECTIVE (pattern not found: ${missing[0][0].slice(0, 60)})` });
    continue;
  }
  let mutated = original;
  for (const [from, to] of parts) {
    mutated = to === '' ? mutated.split(from).join('') : mutated.replace(from, to);
  }
  writeFileSync(m.file, mutated);
  let out = '';
  try {
    out = execSync('node --test test/worldCommands.test.js', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
