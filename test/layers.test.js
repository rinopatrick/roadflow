// Analytic overlay model — S02.2b.
//
// The point of these tests is truthfulness: every overlay value must come from
// something the simulation computes. A layer that would display an invented
// field is a defect, not a placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';
import {
  LAYERS, LAYER_IDS, TRAFFIC_BANDS, ACCESS_STATE,
  trafficBand, trafficOverlay, accessOverlay, accessSummary, nextOverlay,
} from '../src/layers.js';
import { clamp01 } from '../src/metrics.js';

const mockTerrain = { isBuildable: () => true };

function world({ road = [[0, 0], [600, 0]], cls = 'street' } = {}) {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  net.addRoad(road, cls);
  const eco = new Economy(net, mockTerrain, 1);
  eco.onToast = () => {};
  eco.batch = { house: 10, shop: 10, factory: 10 };
  return { ids, net, eco, terrain: mockTerrain };
}

// ---------- layer declarations ----------

test('every declared layer names a real simulated data source', () => {
  assert.deepEqual(LAYER_IDS, ['traffic', 'access']);

  for (const layer of LAYERS) {
    assert.ok(layer.id && layer.label, `layer ${layer.id} needs an id and a visible label`);
    assert.ok(layer.icon, `layer ${layer.id} needs an icon id`);
    assert.ok(layer.dataSource && layer.dataSource.length > 10,
      `layer ${layer.id} must name the simulated field it reads, got ${JSON.stringify(layer.dataSource)}`);
    assert.ok(Array.isArray(layer.legend) && layer.legend.length >= 2,
      `layer ${layer.id} needs a labelled legend`);
    for (const entry of layer.legend) {
      assert.ok(entry.label, `layer ${layer.id} legend entry needs a label`);
      assert.ok(entry.tone, `layer ${layer.id} legend entry ${entry.key} needs a tone for its swatch`);
    }
  }
});

test('no pollution or noise layer exists, because no such field is simulated', () => {
  // DESIGN section 5: show only fields actually computed by the core. S06.3
  // owns environment/noise and will bring its own data. This guard exists so a
  // later change cannot quietly wire a toggle to invented values.
  for (const forbidden of ['pollution', 'noise', 'environment', 'emissions']) {
    assert.ok(!LAYER_IDS.includes(forbidden),
      `"${forbidden}" must not be a layer: the simulation has no such field`);
  }
  const sources = LAYERS.map(l => l.dataSource).join(' ');
  assert.ok(!/pollut|noise|emission/i.test(sources),
    `no layer may claim a pollution/noise source, got: ${sources}`);
});

// ---------- traffic ----------

test('traffic bands are ordered, distinct and labelled', () => {
  const mins = TRAFFIC_BANDS.map(b => b.min);
  assert.deepEqual(mins, [...mins].sort((a, b) => a - b), 'bands must be ordered by threshold');
  assert.equal(new Set(TRAFFIC_BANDS.map(b => b.label)).size, TRAFFIC_BANDS.length,
    'every band needs a distinct label, because the label is what the number shows');
  assert.equal(new Set(TRAFFIC_BANDS.map(b => b.tone)).size, TRAFFIC_BANDS.length,
    'every band needs a distinct tone');
});

test('a congestion share maps to the band that contains it', () => {
  assert.equal(trafficBand(0).level, 0);
  assert.equal(trafficBand(0.24).level, 0);
  assert.equal(trafficBand(0.25).level, 1);
  assert.equal(trafficBand(0.54).level, 1);
  assert.equal(trafficBand(0.55).level, 2);
  assert.equal(trafficBand(0.79).level, 2);
  assert.equal(trafficBand(0.8).level, 3);
  assert.equal(trafficBand(1).level, 3);
  // Above 1 and non-finite input clamp instead of inventing a band.
  assert.equal(trafficBand(4).level, 3);
  assert.equal(trafficBand(NaN).level, 0);
  assert.equal(trafficBand(undefined).level, 0);
});

test('the traffic overlay reads the per-edge congestion and vehicle count', () => {
  const w = world();
  const edges = [...w.net.edges.values()];

  edges[0]._congestion = 0.9;
  edges[0]._carCount = 7;
  if (edges[1]) { edges[1]._congestion = 0.3; edges[1]._carCount = 2; }

  const rows = trafficOverlay(w.net);
  const first = rows.find(r => r.edgeId === edges[0].id);
  assert.ok(first, 'an edge with traffic must appear in the overlay');
  assert.equal(first.cars, 7, 'vehicle count comes from edge._carCount');
  assert.equal(first.level, 3, 'congestion 0.9 is the jammed band');
  assert.equal(first.label, 'jammed', 'the row carries a label, not only a colour');
  assert.equal(first.tone, 'jammed');
  assert.ok(Math.abs(first.congestion - 0.9) < 1e-9, 'congestion is reported as the raw share');
});

test('the traffic overlay omits empty edges instead of tinting the whole map', () => {
  const w = world();
  for (const e of w.net.edges.values()) { e._congestion = 0; e._carCount = 0; }
  assert.deepEqual(trafficOverlay(w.net), [],
    'a quiet network must produce no overlay rows');
});

test('the traffic overlay keeps a congested edge even with no vehicles on it now', () => {
  const w = world();
  const edge = [...w.net.edges.values()][0];
  edge._congestion = 0.7;
  edge._carCount = 0;
  const rows = trafficOverlay(w.net);
  assert.equal(rows.length, 1, 'the residual congestion EMA must still be shown');
  assert.equal(rows[0].cars, 0);
  assert.equal(rows[0].level, 2);
});

test('the traffic overlay tolerates a missing or partial network', () => {
  assert.deepEqual(trafficOverlay(null), []);
  const w = world();
  for (const e of w.net.edges.values()) { delete e._congestion; delete e._carCount; }
  assert.deepEqual(trafficOverlay(w.net), [],
    'absent telemetry must read as no traffic, never as a fabricated value');
});

// ---------- access ----------

test('a building with no neighbour to reach is unreachable', () => {
  const w = world();
  const lone = w.eco.place('house', 300, 60);
  assert.ok(lone, 'fixture must place the building');
  const states = accessOverlay(w);
  assert.equal(states.get(lone.id).state, ACCESS_STATE.UNREACHABLE,
    'one building alone on the map cannot reach anything');
  assert.deepEqual(accessSummary(states), { reachable: 0, unreachable: 1, total: 1 });
});

test('buildings joined by a road are reachable', () => {
  const w = world();
  const a = w.eco.place('house', 100, 60);
  const b = w.eco.place('shop', 500, 60);
  assert.ok(a && b, 'fixture must place both buildings');

  const states = accessOverlay(w);
  assert.equal(states.get(a.id).state, ACCESS_STATE.REACHABLE, 'a road joins them');
  assert.equal(states.get(b.id).state, ACCESS_STATE.REACHABLE);
  assert.deepEqual(accessSummary(states), { reachable: 2, unreachable: 0, total: 2 });
});

test('buildings sharing one access point are reachable to each other', () => {
  const w = world();
  // Opposite sides of the same road point share a driveway node by design.
  const a = w.eco.place('house', 300, 60);
  const b = w.eco.place('house', 300, -60);
  assert.ok(a && b, 'fixture must place both buildings');
  assert.equal(a.drivewayNode, b.drivewayNode,
    'fixture assumption: these two share an access node');

  const states = accessOverlay(w);
  assert.equal(states.get(a.id).state, ACCESS_STATE.REACHABLE);
  assert.equal(states.get(b.id).state, ACCESS_STATE.REACHABLE);
});

test('the access overlay is pure and tolerates a missing world', () => {
  const w = world();
  w.eco.place('house', 100, 60);
  const before = [...w.net.edges.values()].map(e => e.id).sort();
  const version = w.net.version;

  accessOverlay(w);
  accessOverlay(w);
  assert.deepEqual([...w.net.edges.values()].map(e => e.id).sort(), before,
    'evaluating access must not change the graph');
  assert.equal(w.net.version, version, 'evaluating access must not bump the version');

  assert.equal(accessOverlay(null).size, 0);
  assert.equal(accessOverlay({}).size, 0);
});

// ---------- one at a time ----------

test('only one analytic overlay can be active, and it can be turned off', () => {
  assert.equal(nextOverlay(null, 'traffic'), 'traffic');
  assert.equal(nextOverlay('traffic', 'access'), 'access',
    'switching layers replaces the active one rather than stacking');
  assert.equal(nextOverlay('access', 'access'), null,
    'asking for the active layer again turns it off');
  assert.equal(nextOverlay(null, null), null);
});

test('an unknown overlay id is refused rather than stored', () => {
  assert.equal(nextOverlay('traffic', 'pollution'), 'traffic',
    'a layer with no data source must not become active');
  assert.equal(nextOverlay(null, 'pollution'), null);
  assert.equal(nextOverlay('access', undefined), 'access');
});

// ---------- shared metric ----------

test('overlay congestion uses the same clamp as the city figure', () => {
  const w = world();
  const edge = [...w.net.edges.values()][0];
  edge._congestion = 1.4;
  edge._carCount = 1;
  const row = trafficOverlay(w.net)[0];
  assert.equal(row.congestion, clamp01(1.4), 'both must clamp identically');
});
