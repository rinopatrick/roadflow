// Simulation clock tests (S01.1).
//
// The clock converts wall-clock frames into a fixed number of simulation
// ticks. It exists because the previous loop multiplied one frame's delta by
// the speed multiplier, so physics changed with frame rate and a speed change
// could inject an arbitrarily large step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulationClock, STEP, SUPPORTED_SPEEDS } from '../src/simulationClock.js';

const collect = () => {
  const ticks = [];
  return { ticks, stepFn: (dt) => ticks.push(dt) };
};

test('STEP is 1/60 and the supported speeds are pause/1/3/8', () => {
  assert.equal(STEP, 1 / 60);
  assert.deepEqual(SUPPORTED_SPEEDS, [0, 1, 3, 8]);
});

test('advance runs fixed-size ticks, never variable deltas', () => {
  const { ticks, stepFn } = collect();
  const clock = createSimulationClock(stepFn);
  const ran = clock.advance(0.1, 3);
  assert.equal(ran, 18, `0.1s at 3x should run 18 ticks, ran ${ran}`);
  assert.equal(ticks.length, 18);
  assert.ok(ticks.every(dt => dt === STEP), 'every tick must be exactly STEP');
});

test('partitioning wall time differently produces the same tick count', () => {
  // This is the core regression: tick count must depend on elapsed simulated
  // time, not on how the browser chopped that time into frames.
  const run = (chunks) => {
    const { ticks, stepFn } = collect();
    const clock = createSimulationClock(stepFn);
    for (const c of chunks) clock.advance(c, 1);
    return ticks.length;
  };

  const oneBigFrame = run([0.25]);
  const manySmallFrames = run([0.05, 0.05, 0.05, 0.05, 0.05]);
  assert.equal(oneBigFrame, 15, `one 0.25s frame should run 15 ticks, ran ${oneBigFrame}`);
  assert.equal(manySmallFrames, 15, `five 0.05s frames should also run 15 ticks, ran ${manySmallFrames}`);
  assert.equal(oneBigFrame, manySmallFrames, 'frame partitioning must not change simulation outcome');
});

test('partitioning equivalence holds at 1x, 3x and 8x', () => {
  for (const speed of [1, 3, 8]) {
    const one = collect();
    const a = createSimulationClock(one.stepFn);
    a.advance(0.2, speed);

    const many = collect();
    const b = createSimulationClock(many.stepFn);
    for (let i = 0; i < 8; i++) b.advance(0.025, speed);

    assert.equal(one.ticks.length, many.ticks.length,
      `speed ${speed}: one frame ran ${one.ticks.length}, eight frames ran ${many.ticks.length}`);
    assert.equal(one.ticks.length, Math.round(0.2 * speed / STEP),
      `speed ${speed}: expected ${Math.round(0.2 * speed / STEP)} ticks`);
  }
});

test('pause advances zero ticks and consumes no paused wall time', () => {
  const { ticks, stepFn } = collect();
  const clock = createSimulationClock(stepFn);

  clock.advance(0.5, 0);
  assert.equal(ticks.length, 0, 'paused frames must not tick');
  assert.equal(clock.backlogSeconds, 0, 'paused frames must not accumulate backlog');

  // Resuming must not replay the paused period.
  clock.advance(1 / 60, 1);
  assert.equal(ticks.length, 1, 'resume runs exactly one tick, not the paused backlog');
});

test('a long stall cannot simulate hours of catch-up', () => {
  const { ticks, stepFn } = collect();
  const clock = createSimulationClock(stepFn);

  // Simulate a hidden tab: one enormous wall gap.
  clock.advance(3600, 1);

  assert.ok(clock.droppedSeconds > 3500,
    `most of the stall should be dropped, dropped=${clock.droppedSeconds}`);
  assert.ok(clock.backlogSeconds <= 2 + 1e-9,
    `backlog must be capped at 2s, got ${clock.backlogSeconds}`);
  assert.ok(ticks.length <= 120,
    `one frame must not run unbounded ticks, ran ${ticks.length}`);
  assert.ok(ticks.length > 0, 'some catch-up still runs');
});

test('backlog is capped and the dropped amount is reported, not hidden', () => {
  const { ticks, stepFn } = collect();
  const clock = createSimulationClock(stepFn);
  clock.advance(10, 1);
  assert.ok(ticks.length <= 120, `tick budget respected, ran ${ticks.length}`);
  assert.ok(clock.droppedSeconds > 0, 'dropped time must be measurable');
  assert.ok(Number.isFinite(clock.droppedSeconds));
});

test('reset clears backlog without touching simulation time or RNG', () => {
  const { ticks, stepFn } = collect();
  const clock = createSimulationClock(stepFn);
  clock.advance(0.1, 3);
  const before = ticks.length;
  clock.reset();
  assert.equal(clock.backlogSeconds, 0, 'backlog cleared on reset');
  assert.equal(ticks.length, before, 'reset must not run ticks');
  clock.advance(1 / 60, 1);
  assert.equal(ticks.length, before + 1, 'clock still usable after reset');
});

test('invalid inputs are rejected rather than silently clamped', () => {
  const { stepFn } = collect();
  const clock = createSimulationClock(stepFn);
  assert.throws(() => clock.advance(-1, 1), /wallSeconds/);
  assert.throws(() => clock.advance(NaN, 1), /wallSeconds/);
  assert.throws(() => clock.advance(Infinity, 1), /wallSeconds/);
  assert.throws(() => clock.advance(0.1, 2), /speed/);
  assert.throws(() => clock.advance(0.1, -1), /speed/);
  assert.throws(() => clock.advance(0.1, NaN), /speed/);
});

test('a custom step and tick budget are honoured', () => {
  const { ticks, stepFn } = collect();
  const clock = createSimulationClock(stepFn, { step: 1 / 30, maxTicks: 4 });
  const ran = clock.advance(1, 1);
  assert.equal(ran, 4, `maxTicks budget must cap the frame, ran ${ran}`);
  assert.ok(ticks.every(dt => dt === 1 / 30), 'custom step used');
});

test('sub-step remainders accumulate instead of being discarded', () => {
  const { ticks, stepFn } = collect();
  const clock = createSimulationClock(stepFn);
  // 0.01s is less than one 1/60 step, so nothing runs yet.
  clock.advance(0.01, 1);
  assert.equal(ticks.length, 0, 'partial step must not run early');
  assert.ok(clock.backlogSeconds > 0, 'partial time is retained as backlog');

  // Enough further time to cross the step boundary.
  clock.advance(0.01, 1);
  assert.equal(ticks.length, 1, 'remainder accumulated into a full tick');
});
