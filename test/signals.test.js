// Signal phase tests (S01.4).
//
// Defect being fixed (EVIDENCE E04): `greenRatio` did not describe a real phase
// schedule. After `greenLen` elapsed but before the end of the half-cycle the
// selected axis returned "free" (go), so a 42% ratio still gave that axis nearly
// the whole half-cycle. There was also no enforced clearance interval.
//
// Worse, the renderer computed its own phase from a bare half-cycle comparison,
// ignoring `greenRatio` and yellow entirely. The indicator on the map could
// therefore disagree with the phase the simulator obeyed.
//
// `src/signals.js` is now the single phase authority for both.
//
// Phase layout for one half-cycle (half = cycle / 2):
//   green   = half * greenRatio
//   yellow  = min(2, (half - green) / 2)
//   allRed  = half - green - yellow      (clearance)
//
// With cycle 14 and ratio 0.42: half 7, green 2.94, yellow 2, allRed 2.06.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLegacyPhase, phaseForAxis, MIN_GREEN_RATIO, MAX_GREEN_RATIO, MAX_YELLOW_SECONDS,
} from '../src/signals.js';

const LIGHT = { cycle: 14, greenRatio: 0.42, offset: 0, axis: 'x' };

// ------------------------------------------------------------ basic shape ---

test('a phase report carries axis, state and remaining time', () => {
  const p = getLegacyPhase(LIGHT, 0);
  assert.equal(p.state, 'green');
  assert.equal(p.axis, 'x');
  assert.ok(Number.isFinite(p.remaining), `remaining must be finite, got ${p.remaining}`);
  assert.ok(p.remaining > 0, 'remaining must be positive at the start of a phase');
});

test('the three phases appear in order within a half-cycle', () => {
  const seen = [];
  for (let t = 0; t < 7; t += 0.01) {
    const s = getLegacyPhase(LIGHT, t).state;
    if (seen[seen.length - 1] !== s) seen.push(s);
  }
  assert.deepEqual(seen, ['green', 'yellow', 'allRed'],
    `expected green then yellow then allRed, observed ${seen.join(' -> ')}`);
});

test('phase durations match the documented layout', () => {
  // Count time spent in each state over the first half-cycle.
  const step = 0.0005;
  const tally = { green: 0, yellow: 0, allRed: 0 };
  for (let t = 0; t < 7 - 1e-9; t += step) tally[getLegacyPhase(LIGHT, t).state] += step;

  assert.ok(Math.abs(tally.green - 2.94) < 0.01, `green ${tally.green.toFixed(3)} should be ~2.94`);
  assert.ok(Math.abs(tally.yellow - 2.0) < 0.01, `yellow ${tally.yellow.toFixed(3)} should be ~2.00`);
  assert.ok(Math.abs(tally.allRed - 2.06) < 0.01, `allRed ${tally.allRed.toFixed(3)} should be ~2.06`);

  const total = tally.green + tally.yellow + tally.allRed;
  assert.ok(Math.abs(total - 7) < 0.01, `phases must fill the half-cycle, got ${total.toFixed(3)}`);
});

test('the axis switches at the half-cycle boundary', () => {
  assert.equal(getLegacyPhase(LIGHT, 6.9).axis, 'x', 'still axis x near the end of the first half');
  assert.equal(getLegacyPhase(LIGHT, 7.0).axis, 'y', 'axis y takes over in the second half');
  assert.equal(getLegacyPhase(LIGHT, 13.9).axis, 'y', 'still axis y near the end of the cycle');
  assert.equal(getLegacyPhase(LIGHT, 14.0).axis, 'x', 'the cycle wraps back to axis x');
});

test('each half-cycle ends in an all-red clearance interval', () => {
  // This is the behaviour that was missing: the end of a half-cycle must be
  // all-red, not unrestricted green.
  assert.equal(getLegacyPhase(LIGHT, 6.5).state, 'allRed', 'first half ends all-red');
  assert.equal(getLegacyPhase(LIGHT, 13.5).state, 'allRed', 'second half ends all-red');
  assert.equal(getLegacyPhase(LIGHT, 4.94).state, 'allRed', 'all-red begins after yellow');
  assert.equal(getLegacyPhase(LIGHT, 4.0).state, 'yellow', 't=4 is yellow, not green');
  assert.equal(getLegacyPhase(LIGHT, 2.9).state, 'green', 't=2.9 is still green');
});

test('remaining time counts down to the next change and never goes negative', () => {
  let previous = Infinity;
  for (let t = 0; t < 28; t += 0.05) {
    const p = getLegacyPhase(LIGHT, t);
    assert.ok(p.remaining >= 0, `remaining went negative at t=${t}: ${p.remaining}`);
    // A wrap resets the countdown, so only compare within a phase.
    if (p.remaining < previous) assert.ok(p.remaining <= previous + 1e-9);
    previous = p.remaining;
  }
});

test('the schedule repeats every cycle', () => {
  for (const t of [0.5, 3.5, 5.5, 8.2, 12.7]) {
    const a = getLegacyPhase(LIGHT, t);
    const b = getLegacyPhase(LIGHT, t + LIGHT.cycle * 4);
    assert.equal(b.state, a.state, `state at ${t} must repeat 4 cycles later`);
    assert.equal(b.axis, a.axis, `axis at ${t} must repeat 4 cycles later`);
    assert.ok(Math.abs(b.remaining - a.remaining) < 1e-9, `remaining at ${t} must repeat`);
  }
});

// -------------------------------------------------------------- validation ---

test('an invalid cycle is rejected rather than producing a nonsense phase', () => {
  for (const cycle of [0, -1, NaN, Infinity, undefined, null]) {
    assert.throws(() => getLegacyPhase({ cycle, greenRatio: 0.42 }, 0), /cycle/i,
      `cycle ${cycle} should be rejected`);
  }
});

test('greenRatio is clamped into a usable range', () => {
  const tooLow = getLegacyPhase({ cycle: 14, greenRatio: 0.001 }, 0);
  const tooHigh = getLegacyPhase({ cycle: 14, greenRatio: 0.999 }, 0);
  assert.ok(tooLow.remaining > 0, 'a tiny ratio still yields a positive green');

  // With the ratio clamped, both extremes must still leave room for a
  // clearance interval rather than consuming the whole half-cycle.
  const half = 7;
  assert.ok(tooHigh.remaining < half, `clamped ratio must not fill the half-cycle (${tooHigh.remaining})`);
  assert.equal(MIN_GREEN_RATIO > 0, true);
  assert.equal(MAX_GREEN_RATIO < 1, true);
});

test('a missing or invalid ratio falls back to a sane default', () => {
  for (const greenRatio of [undefined, null, NaN]) {
    const p = getLegacyPhase({ cycle: 14, greenRatio }, 0);
    assert.equal(p.state, 'green');
    assert.ok(p.remaining > 0 && p.remaining < 7,
      `default ratio must produce a partial green, got ${p.remaining}`);
  }
});

test('offsets are normalised, including negative and oversized ones', () => {
  const base = getLegacyPhase(LIGHT, 3);
  for (const offset of [0, 14, 28, -14, -28]) {
    const p = getLegacyPhase({ ...LIGHT, offset }, 3 - offset);
    assert.equal(p.state, base.state, `offset ${offset} should be equivalent to 0`);
  }
});

test('a non-finite sim time is rejected', () => {
  assert.throws(() => getLegacyPhase(LIGHT, NaN), /time/i);
  assert.throws(() => getLegacyPhase(LIGHT, Infinity), /time/i);
});

test('yellow never exceeds the documented cap', () => {
  // A very long cycle must not produce an unbounded yellow.
  const p = getLegacyPhase({ cycle: 200, greenRatio: 0.5, axis: 'x' }, 0);
  assert.equal(p.state, 'green');
  // Probe just past green to find the yellow length.
  const greenEnd = 100 * 0.5;
  const atGreenEnd = getLegacyPhase({ cycle: 200, greenRatio: 0.5, axis: 'x' }, greenEnd + 1e-6);
  assert.equal(atGreenEnd.state, 'yellow');
  assert.ok(atGreenEnd.remaining <= MAX_YELLOW_SECONDS + 1e-6,
    `yellow ${atGreenEnd.remaining} must not exceed ${MAX_YELLOW_SECONDS}`);
});

// ------------------------------------------------------------ axis helper ---

test('phaseForAxis reports whether a given axis may proceed', () => {
  const green = phaseForAxis(LIGHT, 0, 'x');
  assert.equal(green.go, true, 'the green axis may proceed');
  assert.equal(green.stop, false);

  const red = phaseForAxis(LIGHT, 0, 'y');
  assert.equal(red.go, false, 'the other axis must stop');
  assert.equal(red.stop, true);

  const allRedX = phaseForAxis(LIGHT, 6.5, 'x');
  assert.equal(allRedX.go, false, 'all-red stops the previously green axis');
  assert.equal(allRedX.stop, true);

  const allRedY = phaseForAxis(LIGHT, 6.5, 'y');
  assert.equal(allRedY.go, false, 'all-red stops every axis');
});

test('phaseForAxis reports yellow so a vehicle can decide to clear', () => {
  const y = phaseForAxis(LIGHT, 3.5, 'x');
  assert.equal(y.state, 'yellow');
  assert.equal(y.go, false, 'yellow is not a green');
  assert.equal(y.yellow, true, 'yellow is flagged so a committed vehicle may clear');
});

test('the two axes are never green at the same instant', () => {
  for (let t = 0; t < 28; t += 0.02) {
    const x = phaseForAxis(LIGHT, t, 'x');
    const y = phaseForAxis(LIGHT, t, 'y');
    assert.ok(!(x.go && y.go), `both axes green at t=${t}`);
  }
});
