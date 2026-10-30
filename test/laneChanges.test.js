// S04.3: safe lane changes. Pure canChangeLane + transition record occupying
// both lanes + mandatory exit-lane planning + missed-turn reroute.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canChangeLane, planExitLane, LANE_CHANGE,
} from '../src/laneChanges.js';

const IDX = { cars: [], edge: { total: 500 } };

describe('S04.3 canChangeLane', () => {
  it('rejects when the target front gap is too small', () => {
    const idx = { ...IDX, cars: [{ lane: 1, s: 105, speed: 10 }] };
    const r = canChangeLane({ s: 100, speed: 10, lane: 0 }, 1, idx, { edgeTotal: 500 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /front/);
  });

  it('rejects when the target rear gap forces hard braking', () => {
    const idx = { ...IDX, cars: [{ lane: 1, s: 90, speed: 18 }] };
    const r = canChangeLane({ s: 100, speed: 10, lane: 0 }, 1, idx, { edgeTotal: 500 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /rear/);
  });

  it('accepts clear gaps at equality boundary', () => {
    // front gap exactly minFront (7+2.2), rear gap exactly headway need: OK.
    const idx = {
      ...IDX,
      cars: [
        { lane: 1, s: 100 + 7 + 7 + 2.2, speed: 10 },
        { lane: 1, s: 100 - (10 * 1.2 + 7) - 7, speed: 10 },
      ],
    };
    const r = canChangeLane({ s: 100, speed: 10, lane: 0 }, 1, idx, { edgeTotal: 500 });
    assert.equal(r.ok, true, r.reason);
  });

  it('rejects with too little remaining edge length', () => {
    const r = canChangeLane({ s: 490, speed: 10, lane: 0 }, 1, IDX, { edgeTotal: 500 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /length|room/i);
  });

  it('rejects a lane change within 25wu of the stop line when voluntary', () => {
    const r = canChangeLane({ s: 480, speed: 10, lane: 0 }, 1, IDX, {
      edgeTotal: 500, voluntary: true,
    });
    assert.equal(r.ok, false);
  });

  it('constants: 1.5s duration, 3s cooldown', () => {
    assert.equal(LANE_CHANGE.duration, 1.5);
    assert.equal(LANE_CHANGE.cooldown, 3);
    assert.equal(LANE_CHANGE.noChangeNearJunction, 25);
  });
});

describe('S04.3 planExitLane', () => {
  it('picks the lane the next connector needs, starting early enough', () => {
    const plan = planExitLane(
      { lane: 0, s: 0 },
      { toLane: 1, edgeTotal: 500, speed: 18 },
    );
    assert.equal(plan.targetLane, 1);
    assert.ok(plan.startS <= 500 - Math.max(60, 18 * 5));
  });

  it('reports missed when already past the planning point', () => {
    const plan = planExitLane(
      { lane: 0, s: 490 },
      { toLane: 1, edgeTotal: 500, speed: 18 },
    );
    assert.equal(plan.missed, true);
  });
});
