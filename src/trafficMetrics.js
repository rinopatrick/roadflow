// Explainable congestion — S04.5.
//
// Bounded rolling windows sampled each sim second: throughput, active/queued/
// cancelled counts, trip-time samples, per-edge queue and travel-time EMA.
// At most 600 aggregated samples and 1000 trip samples; no ever-growing array.
// Percentiles use nearest-rank on the known sample set.
export const METRICS_LIMITS = {
  windowSeconds: 60,
  maxSamples: 600,
  maxTrips: 1000,
};

/**
 * Nearest-rank percentile. p50 of [1,2,3,4,5] is 3; p0 is the min, p100 max.
 * Returns null for an empty set.
 */
export function percentile(sortedOrUnsorted, p) {
  const arr = [...sortedOrUnsorted].sort((a, b) => a - b);
  if (!arr.length) return null;
  if (p <= 0) return arr[0];
  if (p >= 100) return arr[arr.length - 1];
  const rank = Math.ceil((p / 100) * arr.length);
  return arr[Math.min(rank - 1, arr.length - 1)];
}

export class TrafficMetrics {
  constructor() {
    this.samples = []; // {t, active, queued, cancelled, throughput}
    this.tripTimes = [];
    this.edges = new Map(); // edgeId -> {queue, travelEMA, flow}
    this.cancelled = 0;
    this.throughput = 0;
  }

  /** One sample per sim second: {active, queued, cancelled, throughput}. */
  sample(t, counts) {
    this.samples.push({
      t,
      active: counts.active ?? 0,
      queued: counts.queued ?? 0,
      cancelled: counts.cancelled ?? 0,
      throughput: counts.throughput ?? 0,
    });
    this.cancelled = counts.cancelled ?? this.cancelled;
    this.throughput = (this.throughput ?? 0) + (counts.throughput ?? 0);
    // Window: keep the last 60 sim-seconds AND cap at 600 samples.
    while (this.samples.length > METRICS_LIMITS.maxSamples) this.samples.shift();
    const cutoff = t - METRICS_LIMITS.windowSeconds;
    while (this.samples.length && this.samples[0].t <= cutoff) this.samples.shift();
  }

  /** Records a completed trip time (bounded at 1000, oldest dropped). */
  recordTrip(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.tripTimes.push(seconds);
    while (this.tripTimes.length > METRICS_LIMITS.maxTrips) this.tripTimes.shift();
  }

  /** Per-edge queue + travel-time EMA. */
  recordEdge(edgeId, { queue = 0, travelTime = null, flow = 0 } = {}) {
    let e = this.edges.get(edgeId);
    if (!e) {
      e = { queue: 0, travelEMA: travelTime ?? 0, flow: 0 };
      this.edges.set(edgeId, e);
    }
    e.queue = queue;
    e.flow = flow;
    if (travelTime !== null && Number.isFinite(travelTime)) {
      const alpha = 0.2;
      e.travelEMA = e.travelEMA === 0 ? travelTime : e.travelEMA + (travelTime - e.travelEMA) * alpha;
    }
    return e;
  }

  edge(edgeId) {
    return this.edges.get(edgeId) ?? { queue: 0, travelEMA: 0, flow: 0 };
  }

  tripStats() {
    return {
      count: this.tripTimes.length,
      p50: percentile(this.tripTimes, 50),
      p95: percentile(this.tripTimes, 95),
    };
  }

  summary() {
    const last = this.samples[this.samples.length - 1];
    return {
      active: last?.active ?? 0,
      queued: last?.queued ?? 0,
      cancelled: last?.cancelled ?? 0,
      throughput: last?.throughput ?? 0,
      ...this.tripStats(),
    };
  }
}
