// Road geometry tests (S01.3).
//
// Defect being fixed (EVIDENCE E02): pavement width and lane centre offsets were
// derived from two independent, inconsistent sources. `ROAD_CLASS[cls].width`
// drove rendering, while `laneOffset()` computed positions from `laneW` plus a
// hard-coded 1.2 wu median. Measured overflow of the outermost lane centre plus
// half a car (1.8 wu) past the rendered pavement half-width:
//
//   street   5.65 vs 5.50  -> 0.15 wu outside
//   avenue  11.40 vs 8.00  -> 3.40 wu outside
//   highway 17.40 vs 12.00 -> 5.40 wu outside
//
// So vehicles and lane dashes floated off the road surface on avenue and
// highway. `roadProfiles.js` becomes the single dimension authority so the
// rendered surface, the lane centres, the markings, picking and the roundabout
// radius can no longer disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork, ROAD_CLASS } from '../src/roadNetwork.js';
import {
  roadDimensions, laneCenterOffset, CAR_HALF_WIDTH, ROAD_PRESETS,
} from '../src/roadProfiles.js';

/** Every preset, both directions, every lane index. */
const ALL_CASES = Object.keys(ROAD_PRESETS).flatMap((cls) => {
  const preset = ROAD_PRESETS[cls];
  const lanes = [];
  for (let i = 0; i < preset.forward; i++) lanes.push({ cls, dir: 1, lane: i });
  for (let i = 0; i < preset.backward; i++) lanes.push({ cls, dir: -1, lane: i });
  return lanes;
});

// ------------------------------------------------------- containment rule ---

test('the whole vehicle envelope stays inside the pavement', () => {
  for (const { cls, dir, lane } of ALL_CASES) {
    const d = roadDimensions({ cls });
    const offset = laneCenterOffset({ cls }, dir, lane);
    const outer = Math.abs(offset) + CAR_HALF_WIDTH;
    assert.ok(outer <= d.width / 2 + 1e-9,
      `${cls} dir ${dir} lane ${lane}: vehicle outer edge ${outer.toFixed(3)} `
      + `exceeds pavement half-width ${(d.width / 2).toFixed(3)}`);
  }
});

test('the lane envelope rule held before the fix for the reported overflow', () => {
  // Guards the specific numbers from EVIDENCE E02 so the regression cannot
  // silently return. Uses the profile model directly.
  const cases = [
    ['street', 5.65, 5.50],
    ['avenue', 11.40, 8.00],
    ['highway', 17.40, 12.00],
  ];
  for (const [cls, oldOuter, oldHalf] of cases) {
    const d = roadDimensions({ cls });
    const outerLane = ROAD_PRESETS[cls].forward - 1;
    const nowOuter = Math.abs(laneCenterOffset({ cls }, 1, outerLane)) + CAR_HALF_WIDTH;
    assert.ok(nowOuter <= d.width / 2 + 1e-9,
      `${cls}: was ${oldOuter} vs half ${oldHalf}, now ${nowOuter.toFixed(3)} vs ${(d.width / 2).toFixed(3)}`);
  }
});

test('pavement width equals lanes plus median plus shoulders', () => {
  for (const cls of Object.keys(ROAD_PRESETS)) {
    const p = ROAD_PRESETS[cls];
    const d = roadDimensions({ cls });
    const expected = (p.forward + p.backward) * p.laneWidth
      + p.medianWidth + 2 * p.shoulderWidth;
    assert.ok(Math.abs(d.width - expected) < 1e-9,
      `${cls}: width ${d.width} should be ${expected}`);
  }
});

test('road classes keep a strict width hierarchy', () => {
  const street = roadDimensions({ cls: 'street' }).width;
  const avenue = roadDimensions({ cls: 'avenue' }).width;
  const highway = roadDimensions({ cls: 'highway' }).width;
  assert.ok(highway > avenue, `highway ${highway} > avenue ${avenue}`);
  assert.ok(avenue > street, `avenue ${avenue} > street ${street}`);
});

// ------------------------------------------------------- offset symmetry ---

test('forward and backward lane offsets mirror across the centreline', () => {
  for (const { cls, lane } of ALL_CASES) {
    const fwd = laneCenterOffset({ cls }, 1, lane);
    const bwd = laneCenterOffset({ cls }, -1, lane);
    assert.ok(Math.abs(fwd + bwd) < 1e-9,
      `${cls} lane ${lane}: forward ${fwd} and backward ${bwd} should mirror`);
  }
});

test('lane centres are ordered outward and never overlap the median', () => {
  for (const cls of Object.keys(ROAD_PRESETS)) {
    const p = ROAD_PRESETS[cls];
    const halfMedian = p.medianWidth / 2;
    let previous = halfMedian;
    for (let lane = 0; lane < p.forward; lane++) {
      const off = laneCenterOffset({ cls }, 1, lane);
      assert.ok(off > previous,
        `${cls} lane ${lane} offset ${off} must be outward of ${previous}`);
      previous = off;
    }
  }
});

test('out-of-range lane indices are rejected, not silently clamped', () => {
  for (const cls of Object.keys(ROAD_PRESETS)) {
    const p = ROAD_PRESETS[cls];
    assert.throws(() => laneCenterOffset({ cls }, 1, p.forward), /lane/i,
      `${cls}: forward lane ${p.forward} should be rejected`);
    assert.throws(() => laneCenterOffset({ cls }, -1, p.backward), /lane/i,
      `${cls}: backward lane ${p.backward} should be rejected`);
    assert.throws(() => laneCenterOffset({ cls }, 1, -1), /lane/i, `${cls}: negative lane`);
    assert.throws(() => laneCenterOffset({ cls }, 0, 0), /direction/i, `${cls}: dir 0`);
  }
});

test('a one-way road has no median and centres its single lane', () => {
  const edge = { cls: 'street', oneway: true };
  const d = roadDimensions(edge);
  assert.equal(d.medianWidth, 0, 'one-way roads have no median');
  assert.equal(d.backward, 0, 'one-way roads have no reverse lanes');
  const off = laneCenterOffset(edge, 1, 0);
  assert.ok(Math.abs(off) <= d.width / 2, `lane centre ${off} inside half ${d.width / 2}`);
});

// ------------------------------------------------- RoadNetwork integration ---

test('RoadNetwork.laneOffset agrees with the profile model', () => {
  const net = new RoadNetwork();
  for (const { cls, lane } of ALL_CASES) {
    const viaNet = net.laneOffset({ cls }, lane);
    const viaProfile = Math.abs(laneCenterOffset({ cls }, 1, lane));
    assert.ok(Math.abs(viaNet - viaProfile) < 1e-9,
      `${cls} lane ${lane}: net ${viaNet} vs profile ${viaProfile}`);
  }
});

test('lanePoint places vehicles inside the pavement on both directions', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [400, 0]], 'highway');
  const edge = [...net.edges.values()][0];
  const d = roadDimensions(edge);

  for (const dir of [1, -1]) {
    for (let lane = 0; lane < ROAD_PRESETS.highway.forward; lane++) {
      const p = net.lanePoint(edge, dir, lane, 200);
      const lateral = Math.abs(p.y);
      assert.ok(lateral + CAR_HALF_WIDTH <= d.width / 2 + 1e-9,
        `dir ${dir} lane ${lane}: lateral ${lateral.toFixed(3)} + half car exceeds `
        + `${(d.width / 2).toFixed(3)}`);
    }
  }
});

test('lanePoint still offsets right of travel direction', () => {
  // Existing behaviour from test/roadNetwork.test.js must be preserved.
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [100, 0]]);
  const e = [...net.edges.values()][0];
  const p = net.lanePoint(e, 1, 0, 50);
  assert.ok(p.y > 0, 'eastbound lane 0 is right of the centreline');
  const q = net.lanePoint(e, -1, 0, 50);
  assert.ok(q.y < 0, 'westbound lane 0 is on the other side');
});

test('one-way ring edges keep a single centred lane', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [200, 0]], 'street');
  net.addRoad([[100, -200], [100, 200]], 'street');
  const junction = [...net.nodes.values()].find(n => n.edges.size === 4);
  assert.ok(junction, 'fixture created a 4-way junction');
  net.makeRoundabout(junction.id);

  const ringEdges = [...net.edges.values()].filter(e => e.ring);
  assert.ok(ringEdges.length > 0, 'roundabout produced ring edges');
  for (const e of ringEdges) {
    const d = roadDimensions(e);
    assert.equal(d.backward, 0, `ring edge ${e.id} is one-way`);
    assert.equal(d.medianWidth, 0, `ring edge ${e.id} has no median`);
    const off = Math.abs(laneCenterOffset(e, 1, 0));
    assert.ok(off + CAR_HALF_WIDTH <= d.width / 2 + 1e-9,
      `ring edge ${e.id} lane centre ${off} exceeds half ${d.width / 2}`);
  }
});

// --------------------------------------------------- roundabout radius ---

test('roundabout radius accounts for the new pavement widths', () => {
  const net = new RoadNetwork();
  // Four arms of the widest class, to exercise the max-width path.
  net.addRoad([[-300, 0], [300, 0]], 'highway');
  net.addRoad([[0, -300], [0, 300]], 'highway');
  const junction = [...net.nodes.values()].find(n => n.edges.size === 4);
  assert.ok(junction);
  const result = net.makeRoundabout(junction.id);
  assert.ok(result, 'roundabout built');

  const center = { x: junction.x, y: junction.y };
  for (const id of result.ringNodeIds) {
    const n = net.nodes.get(id);
    const r = Math.hypot(n.x - center.x, n.y - center.y);
    const halfHighway = roadDimensions({ cls: 'highway' }).width / 2;
    assert.ok(r > halfHighway,
      `ring node ${id} radius ${r.toFixed(2)} must clear half a highway ${halfHighway}`);
  }
});

test('ROAD_CLASS width is consistent with the profile model', () => {
  // ROAD_CLASS remains the preset/style label, but its width must not be a
  // second, divergent source of truth.
  for (const cls of Object.keys(ROAD_PRESETS)) {
    const d = roadDimensions({ cls });
    assert.equal(ROAD_CLASS[cls].width, d.width,
      `${cls}: ROAD_CLASS.width ${ROAD_CLASS[cls].width} must equal profile ${d.width}`);
    assert.equal(ROAD_CLASS[cls].lanesPerDir, d.forward,
      `${cls}: ROAD_CLASS.lanesPerDir must equal profile forward`);
  }
});
