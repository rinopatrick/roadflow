// Preview placement validity (S02.5b item 2).
//
// The defect: the preview checked `eco.canPlace(tool)` and `terrain.isRoadable`
// but ignored OVERLAP and NO_ROAD, both of which `evaluateBuildingPlacement`
// checks. The preview showed valid teal over an existing building and past the
// road reach, and the commit then failed with a reason the preview never
// mentioned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';
import { previewPlacement } from '../src/render/preview.js';
import { PLACEMENT_REASON, ACCESS_MAX_DISTANCE } from '../src/access.js';

const mockTerrain = { isBuildable: () => true };

function world({ road = [[0, 0], [600, 0]], cls = 'street' } = {}) {
  const ids = createIdSource();
  const n = new RoadNetwork({ ids });
  n.addRoad(road, cls);
  const eco = new Economy(n, mockTerrain, 1);
  eco.onToast = () => {};
  eco.batch = { house: 10, shop: 10, factory: 10 };
  return { net: n, terrain: mockTerrain, eco };
}

test('a valid placement previews as accent', () => {
  const w = world();
  const r = previewPlacement(w, 'house', 300, 60);
  assert.equal(r.ok, true);
  assert.equal(r.colour, 'accent');
  assert.equal(r.reason, null);
  assert.equal(r.label, null, 'a valid placement needs no failure label');
});

test('no stock previews with the stock reason, not a generic one', () => {
  const w = world();
  w.eco.batch.house = 0;
  const r = previewPlacement(w, 'house', 300, 60);
  assert.equal(r.ok, false);
  assert.equal(r.reason, PLACEMENT_REASON.NO_STOCK);
  assert.equal(r.colour, 'danger');
  assert.match(r.label, /No houses left/);
});

test('water previews as invalid terrain', () => {
  const water = { isBuildable: () => false, isRoadable: () => false };
  const w = world();
  w.terrain = water;
  const r = previewPlacement(w, 'house', 300, 60);
  assert.equal(r.ok, false);
  assert.equal(r.reason, PLACEMENT_REASON.TERRAIN);
  assert.match(r.label, /terrain/i);
});

test('overlap previews as too close, which the old preview missed', () => {
  const w = world();
  const existing = w.eco.place('house', 300, 60);
  assert.ok(existing, 'fixture must place the first building');
  // Another building at the same spot overlaps it.
  const r = previewPlacement(w, 'house', 300, 60);
  assert.equal(r.ok, false);
  assert.equal(r.reason, PLACEMENT_REASON.OVERLAP);
  assert.match(r.label, /close/i);
});

test('a position past the road reach previews as no road', () => {
  const w = world();
  // The road is at y=0; ACCESS_MAX_DISTANCE is 120 wu. A point 200 wu away has
  // no road within reach, which the old preview missed entirely.
  const r = previewPlacement(w, 'house', 300, ACCESS_MAX_DISTANCE + 80);
  assert.equal(r.ok, false);
  assert.equal(r.reason, PLACEMENT_REASON.NO_ROAD);
  assert.match(r.label, /road/i);
});

test('a position just inside the road reach previews as valid', () => {
  const w = world();
  const r = previewPlacement(w, 'house', 300, ACCESS_MAX_DISTANCE - 20);
  assert.equal(r.ok, true, `a point ${ACCESS_MAX_DISTANCE - 20} wu from the road must be within reach`);
});

test('the preview agrees with the commit for every failure mode', () => {
  // The whole point: if the preview says ok, the commit must succeed; if the
  // preview says no, the commit must fail with the same reason.
  const w = world();
  w.eco.place('house', 300, 60);
  w.eco.batch.house = 0;

  const cases = [
    { x: 300, y: 60 },    // overlap + no stock
    { x: 300, y: ACCESS_MAX_DISTANCE + 80 },  // no road
    { x: 150, y: ACCESS_MAX_DISTANCE + 80 },  // no road, different x
  ];
  for (const { x, y } of cases) {
    const preview = previewPlacement(w, 'house', x, y);
    const commit = w.eco.place('house', x, y);
    assert.equal(preview.ok, !!commit,
      `preview ok=${preview.ok} but commit ${commit ? 'succeeded' : 'failed'} at (${x},${y})`);
    if (commit) w.eco.remove(commit.id);
  }
});
