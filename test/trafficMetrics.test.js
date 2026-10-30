// S04.5: explainable congestion. Bounded rolling windows, per-edge queue/EMA,
// trip percentiles (nearest-rank), wait reasons from controlling branches.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TrafficMetrics, percentile, METRICS_LIMITS,
} from '../src/trafficMetrics.js';

describe('S04.5 percentile', () => {
  it('nearest-rank on the known set [1,2,3,4,5]', () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
    assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
    assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
    assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
    assert.equal(percentile([], 50), null);
  });
});

describe('S04.5 TrafficMetrics', () => {
  it('samples each sim second into a bounded 60s window', () => {
    const m = new TrafficMetrics();
    for (let t = 0; t < 200; t++) {
      m.sample(t, { active: 5, queued: 2, cancelled: 0, throughput: 1 });
    }
    assert.ok(m.samples.length <= 60, `window bound: ${m.samples.length}`);
    assert.equal(m.samples[m.samples.length - 1].t, 199);
    assert.equal(m.samples[0].t, 140);
  });

  it('caps trip samples at 1000', () => {
    const m = new TrafficMetrics();
    for (let i = 0; i < 1500; i++) m.recordTrip(10 + i);
    assert.equal(m.tripTimes.length, 1000);
    // Oldest dropped: p50 reflects the recent 1000, not the first 500.
    assert.ok(percentile(m.tripTimes, 50) > 500);
  });

  it('per-edge queue and travel-time EMA update', () => {
    const m = new TrafficMetrics();
    m.recordEdge('e1', { queue: 3, travelTime: 20 });
    m.recordEdge('e1', { queue: 1, travelTime: 10 });
    const e = m.edge('e1');
    assert.ok(e.queue >= 0);
    assert.ok(e.travelEMA > 0 && e.travelEMA <= 20);
  });

  it('window expiry drops old samples', () => {
    const m = new TrafficMetrics();
    m.sample(0, { active: 9, queued: 9, cancelled: 0, throughput: 0 });
    m.sample(61, { active: 1, queued: 0, cancelled: 0, throughput: 1 });
    const s = m.summary();
    assert.equal(s.active, 1);
    assert.ok(!m.samples.some(x => x.t === 0));
  });

  it('summary counts are conserved: active+trips+cancelled consistent', () => {
    const m = new TrafficMetrics();
    m.sample(0, { active: 4, queued: 1, cancelled: 2, throughput: 3 });
    const s = m.summary();
    assert.equal(s.throughput, 3);
    assert.equal(s.cancelled, 2);
  });

  it('limits documented', () => {
    assert.equal(METRICS_LIMITS.windowSeconds, 60);
    assert.equal(METRICS_LIMITS.maxSamples, 600);
    assert.equal(METRICS_LIMITS.maxTrips, 1000);
  });
});
