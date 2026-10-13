// Generates test/fixtures/legacy-v1.json from the REAL v1 modules.
//
// Usage: node scripts/make-legacy-fixture.mjs
//
// Why a generator instead of a hand-written JSON file
// --------------------------------------------------
// The v1 migration fixture must be an authentic artifact of the current
// serializer. Hand-writing JSON that merely *looks* like a v1 save would let a
// migration test pass against a schema the real code never produced. This
// script builds a world through the public APIs, serializes it with the real
// `toJSON()` methods, and writes the exact payload that `saveGame` would store.
//
// The output is committed and frozen. Re-running this script is only needed if
// the v1 serializer itself changes, which the migration rules forbid.
//
// IMPORTANT — not byte-reproducible
// --------------------------------
// v1 IDs come from `uid()`, which uses Math.random. Re-running this script
// therefore produces a payload with DIFFERENT node/edge/building IDs while the
// structure stays equivalent. The committed file is the canonical fixture;
// treat re-running as "replace the frozen artifact", never as "refresh it".
// Deterministic IDs arrive with the ID source in S01.1.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Terrain } from '../src/terrain.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 1;

const terrain = new Terrain(SEED);
const net = new RoadNetwork();
const eco = new Economy(net, terrain, SEED);

// --- main east-west street through the buildable band (verified buildable) ---
net.addRoad([[-600, 0], [600, 0]], 'street');

// --- buildings first, exactly as a player would place them ---
const placements = [
  ['house', -350, 60],
  ['shop', 0, 80],
  ['factory', 350, 100],
];
for (const [type, x, y] of placements) {
  if (!terrain.isBuildable(x, y)) throw new Error(`seed ${SEED} is not buildable at ${x},${y}`);
  const b = eco.place(type, x, y);
  if (!b) throw new Error(`failed to place ${type} at ${x},${y}`);
}

// --- a cross road west of centre, turned into a signalised junction ---
net.addRoad([[-150, -200], [-150, 200]], 'street');
const lightNode = [...net.nodes.values()].find(n => n.edges.size === 4 && Math.abs(n.x + 150) < 1);
if (!lightNode) throw new Error('expected a 4-way junction near x=-150');
lightNode.type = 'light';
lightNode.light = { cycle: 14, offset: 0, greenRatio: 0.42 };

// --- a second cross road east of centre, converted to a roundabout ---
net.addRoad([[300, -200], [300, 200]], 'street');
const rbNode = [...net.nodes.values()].find(n => n.edges.size === 4 && Math.abs(n.x - 300) < 1);
if (!rbNode) throw new Error('expected a 4-way junction near x=300');
const rb = net.makeRoundabout(rbNode.id);
if (!rb) throw new Error('roundabout conversion failed');

// --- accumulate some progress so the snapshot carries non-zero economy state ---
eco.xp = 120;
eco.totalTrips = 3;

const snapshot = {
  v: 1,
  savedAt: 1750000000000, // frozen timestamp: fixtures must not drift
  seed: SEED,
  net: net.toJSON(),
  eco: eco.toJSON(),
  camera: { x: 0, y: 0, zoom: 1 },
  simTime: 42,
};

const outDir = path.join(ROOT, 'test', 'fixtures');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'legacy-v1.json');
writeFileSync(outFile, JSON.stringify(snapshot, null, 2) + '\n');

const rings = [...net.nodes.values()].filter(n => n.isRing).length;
console.log(JSON.stringify({
  wrote: path.relative(ROOT, outFile).split(path.sep).join('/'),
  seed: SEED,
  nodes: snapshot.net.nodes.length,
  edges: snapshot.net.edges.length,
  buildings: snapshot.eco.buildings.length,
  lights: snapshot.net.nodes.filter(n => n.type === 'light').length,
  ringNodes: rings,
  ringEdges: snapshot.net.edges.filter(e => e.ring).length,
  oneWayEdges: snapshot.net.edges.filter(e => e.oneway).length,
}, null, 2));
