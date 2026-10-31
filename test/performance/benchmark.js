// S08.1 benchmark: small/medium/large CPU fixtures. Measures sim tick
// median/p95/p99 after warmup, route query p95, counts. Run: node bench.
import { RoadNetwork } from '../../src/roadNetwork.js';
import { Terrain } from '../../src/terrain.js';
import { TrafficSim } from '../../src/traffic.js';
import { Economy } from '../../src/economy.js';
import { createIdSource, makeRng } from '../../src/core.js';

function percentile(a, p) {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

function build(size) {
  const terrain = new Terrain(7);
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  // Grid of arterials.
  const n = size === 'small' ? 4 : size === 'medium' ? 10 : 16;
  const step = 300;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    nodes[i] = [];
    for (let j = 0; j < n; j++) {
      nodes[i][j] = net._makeNode((i - n / 2) * step, (j - n / 2) * step, 'plain');
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) { const e = net._makeEdge(nodes[i][j].id, nodes[i + 1][j].id, 'avenue', []); net.resampleEdge(e); }
      if (j + 1 < n) { const e = net._makeEdge(nodes[i][j].id, nodes[i][j + 1].id, 'avenue', []); net.resampleEdge(e); }
    }
  }
  const traffic = new TrafficSim(net, { rng: makeRng(7) });
  const eco = new Economy(net, terrain, 7);
  const ends = [];
  for (let i = 0; i < n; i++) {
    ends.push(nodes[i][0].id, nodes[i][n - 1].id, nodes[0][i].id, nodes[n - 1][i].id);
  }
  const target = size === 'small' ? 100 : size === 'medium' ? 1000 : 2500;
  const rng = makeRng(99);
  let spawned = 0, guard = 0;
  while (spawned < target && guard++ < target * 4) {
    const a = ends[Math.floor(rng() * ends.length)];
    let b = ends[Math.floor(rng() * ends.length)];
    if (a === b) continue;
    if (traffic.spawn(a, b)) spawned++;
    traffic.update(1 / 60);
  }
  return { net, traffic, eco, spawned };
}

function measure(label, size) {
  const { net, traffic } = build(size);
  // Warmup 10s.
  for (let t = 0; t < 600; t++) traffic.update(1 / 60);
  const ticks = [];
  for (let t = 0; t < 3600; t++) {
    const t0 = performance.now();
    traffic.update(1 / 60);
    ticks.push(performance.now() - t0);
  }
  ticks.sort((a, b) => a - b);
  const med = percentile(ticks, 50);
  const p95 = percentile(ticks, 95);
  const p99 = percentile(ticks, 99);
  console.log(`${label}: edges=${net.edges.size} cars=${traffic.cars.size} tick med=${med.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms trips=${traffic.stats.trips}`);
  return { label, edges: net.edges.size, med, p95, p99 };
}

const results = [measure('small', 'small'), measure('medium', 'medium')];
// Large only on request (slow): BENCH_LARGE=1.
if (process.env.BENCH_LARGE === '1') results.push(measure('large', 'large'));
const med = results.find(r => r.label === 'medium');
if (med && med.p95 > 8) {
  console.log(`NOTE: medium tick p95 ${med.p95.toFixed(2)}ms exceeds the 8ms target on this machine — recorded, not waived.`);
} else if (med) {
  console.log('medium tick p95 within the 8ms target on this machine.');
}
