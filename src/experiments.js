// Bottleneck lab — S07.2.
//
// Fair before/after comparison on the SAME admitted-demand trace for the SAME
// sim duration with the same seed/rules. The current city is never
// overwritten: the alternative runs on a copy. Deleted buildings mark their
// requests cancelled/unserved but stay in the denominator — removing demand
// can never game the score. No single opaque 'better city' score: paired
// metric deltas plus rule-based bottleneck explanations with evidence.
export const EXPERIMENT_LIMITS = {
  runSeconds: 600,
  warmupSeconds: 60,
  maxBytes: 10 * 1024 * 1024,
  maxSnapshots: 2,
  maxTraces: 1,
  tolerance: 1e-6,
};

/** Records demand requests at semantic origin/destination ids. */
export function recordTrace() {
  const requests = [];
  return {
    requests,
    add(t, req) {
      if (!Number.isFinite(t)) throw new Error('trace time must be finite');
      if (!req?.origin || !req?.dest) throw new Error('trace needs origin/dest ids');
      requests.push({ t, origin: req.origin, dest: req.dest, kind: req.kind ?? 'trip' });
    },
    bytes() {
      return JSON.stringify(requests).length;
    },
  };
}

/** Replays a frozen trace (validates shape, preserves order). */
export function replayTrace(frozen) {
  if (!Array.isArray(frozen)) throw new Error('trace must be an array');
  return frozen.map((r, i) => {
    if (!Number.isFinite(r?.t) || !r?.origin || !r?.dest) {
      throw new Error(`trace request ${i} is malformed`);
    }
    return { t: r.t, origin: r.origin, dest: r.dest, kind: r.kind ?? 'trip' };
  });
}

/** Paired comparison of two run reports. No opaque score. */
export function compareReports(before, after, context = {}) {
  const keys = ['requested', 'served', 'cancelled', 'p50', 'p95', 'maxQueue', 'freight'];
  const paired = {};
  for (const k of keys) {
    const a = before[k] ?? 0;
    const b = after[k] ?? 0;
    paired[k] = { before: a, after: b, delta: b - a };
  }
  const same = keys.every(k => Math.abs(paired[k].delta) <= EXPERIMENT_LIMITS.tolerance);
  return {
    paired,
    denominatorNote: 'cancelled requests stay in the denominator',
    deletedBuildings: context.deletedBuildings ?? [],
    verdict: same ? 'no change within tolerance'
      : paired.served.delta > 0 ? 'alternative serves more'
      : paired.served.delta < 0 ? 'alternative serves fewer'
      : 'mixed: see paired deltas',
  };
}

const ACTIONS = {
  downstreamBlocked: 'downstream blockage dominates; extra green alone will not clear it — add exit capacity',
  signal: 'signal-bound: retime phases or check the cycle against demand',
  connectorConflict: 'conflicting turns overlap: separate phases or re-lane the approach',
  following: 'car-following queue: capacity, not control, is the limit',
  laneChangeWait: 'lane-change friction: longer weaving room or earlier lane choice',
  noRoute: 'missing legal route: connectivity, not timing, blocks these trips',
};

/** Rule-based bottleneck explanations from wait-reason shares. */
export function explainBottlenecks(rows) {
  return [...rows]
    .sort((a, b) => b.share - a.share)
    .map(r => ({
      junction: r.junction,
      reason: r.reason,
      share: r.share,
      evidence: `${Math.round(r.share * 100)}% waiting (${r.n} samples) at ${r.junction} is ${r.reason}`,
      action: ACTIONS[r.reason] ?? 'unclassified: collect more samples',
    }));
}
