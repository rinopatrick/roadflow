// Fixed-step simulation clock.
//
// Problem this solves
// -------------------
// The original loop did `dt = rawDt * speed` and fed that straight into the
// simulation. Consequences:
//   - physics depended on frame rate (a 120Hz monitor simulated differently
//     from a 60Hz one),
//   - changing speed injected one oversized step,
//   - returning from a hidden tab could advance a huge amount in one frame.
//
// This clock converts elapsed wall time into a fixed number of STEP-sized
// ticks. The simulation therefore advances identically regardless of how the
// browser chopped time into frames.
//
// Contract (see docs/roadmap/CONTRACTS.md §2 and ALGORITHMS.md recipe A):
//   createSimulationClock(stepFn, {step, maxTicks})
//     -> { advance(wallSeconds, speed), reset(), backlogSeconds, droppedSeconds }

export const STEP = 1 / 60;
export const SUPPORTED_SPEEDS = [0, 1, 3, 8];

const MAX_FRAME_SECONDS = 0.25;   // ignore wall gaps larger than this per frame
const MAX_BACKLOG_SECONDS = 2;    // never carry more than 2s of pending work
const DEFAULT_MAX_TICKS = 120;    // per-frame tick budget (~2s at STEP)

/**
 * @param {(dt:number)=>void} stepFn called once per fixed step
 * @param {{step?:number, maxTicks?:number}} [options]
 */
export function createSimulationClock(stepFn, options = {}) {
  if (typeof stepFn !== 'function') throw new TypeError('createSimulationClock requires a step function');

  const step = options.step ?? STEP;
  const maxTicks = options.maxTicks ?? DEFAULT_MAX_TICKS;
  if (!Number.isFinite(step) || step <= 0) throw new RangeError('step must be a positive finite number');
  if (!Number.isInteger(maxTicks) || maxTicks < 1) throw new RangeError('maxTicks must be a positive integer');

  let backlog = 0;
  let dropped = 0;

  function advance(wallSeconds, speed) {
    if (typeof wallSeconds !== 'number' || !Number.isFinite(wallSeconds) || wallSeconds < 0) {
      throw new RangeError(`wallSeconds must be a finite number >= 0, got ${wallSeconds}`);
    }
    if (!SUPPORTED_SPEEDS.includes(speed)) {
      throw new RangeError(`speed must be one of ${SUPPORTED_SPEEDS.join(', ')}, got ${speed}`);
    }

    // Paused: consume no wall time at all, so resuming does not replay the pause.
    if (speed === 0) return 0;

    // Cap a single frame's contribution. A hidden tab or a breakpoint can hand
    // us a multi-second (or multi-hour) delta; simulating all of it at once
    // would teleport every vehicle and could freeze the page.
    //
    // The clamped-away time is counted as dropped rather than silently
    // discarded: "dropped" means "wall time we did not simulate".
    const frameSeconds = Math.min(wallSeconds, MAX_FRAME_SECONDS);
    dropped += (wallSeconds - frameSeconds) * speed;
    backlog += frameSeconds * speed;

    // Bound retained work so a long stall cannot accumulate unbounded catch-up.
    // Note MAX_FRAME_SECONDS * 8 === MAX_BACKLOG_SECONDS === maxTicks * STEP,
    // so all three limits agree on "at most 2 simulated seconds per frame".
    if (backlog > MAX_BACKLOG_SECONDS) {
      dropped += backlog - MAX_BACKLOG_SECONDS;
      backlog = MAX_BACKLOG_SECONDS;
    }

    let ran = 0;
    // Small epsilon absorbs floating-point drift so exact multiples of STEP
    // (e.g. 15 steps from 0.25s) are not lost to representation error.
    while (backlog + 1e-10 >= step && ran < maxTicks) {
      stepFn(step);
      backlog -= step;
      ran++;
    }

    if (ran >= maxTicks && backlog >= step) {
      // Frame budget exhausted: drop the remainder and report it rather than
      // letting the deficit grow into a later stall.
      dropped += backlog;
      backlog = 0;
    }

    // Clamp tiny negative residue produced by floating-point subtraction.
    if (backlog < 0) backlog = 0;

    return ran;
  }

  function reset() {
    backlog = 0;
  }

  return {
    advance,
    reset,
    get backlogSeconds() { return backlog; },
    get droppedSeconds() { return dropped; },
  };
}
