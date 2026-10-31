// S07.2: bottleneck lab. Demand trace, paired before/after runs, honest
// metrics, rule-based bottleneck explanations. No opaque scores.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordTrace, replayTrace, compareReports, explainBottlenecks,
  EXPERIMENT_LIMITS,
} from '../src/experiments.js';

const trace = () => ([
  { t: 0, origin: 'h1', dest: 's1', kind: 'shopping' },
  { t: 5, origin: 'h2', dest: 'f1', kind: 'work' },
  { t: 10, origin: 'h1', dest: 's1', kind: 'shopping' },
]);

describe('S07.2 experiments', () => {
  it('trace records semantic requests and replays identically', () => {
    const rec = recordTrace();
    for (const r of trace()) rec.add(r.t, r);
    assert.equal(rec.requests.length, 3);
    const frozen = JSON.parse(JSON.stringify(rec.requests));
    assert.deepEqual(frozen.map(r => [r.origin, r.dest]), [['h1', 's1'], ['h2', 'f1'], ['h1', 's1']]);
    const replayed = replayTrace(frozen);
    assert.equal(replayed.length, 3, 'replay is lossless');
  });

  it('deleted buildings mark requests cancelled, never removed from denominator', () => {
    const rep = compareReports(
      { requested: 10, served: 8, cancelled: 2, p50: 30, p95: 60, maxQueue: 3, freight: 4 },
      { requested: 10, served: 5, cancelled: 5, p50: 45, p95: 90, maxQueue: 6, freight: 2 },
      { deletedBuildings: ['s1'] },
    );
    assert.equal(rep.denominatorNote, 'cancelled requests stay in the denominator');
    assert.ok(rep.paired.served.delta === -3, 'paired delta reported');
    assert.ok(!('score' in rep), 'no opaque single score');
  });

  it('no-op alternative is equal within tolerance', () => {
    const base = { requested: 10, served: 8, cancelled: 2, p50: 30, p95: 60, maxQueue: 3, freight: 4 };
    const rep = compareReports(base, { ...base }, {});
    assert.equal(rep.verdict, 'no change within tolerance');
  });

  it('bottleneck explanations cite wait reasons with evidence', () => {
    const exp = explainBottlenecks([
      { junction: 'n1', reason: 'downstreamBlocked', share: 0.67, n: 40 },
      { junction: 'n2', reason: 'signal', share: 0.2, n: 12 },
    ]);
    assert.ok(exp[0].action.includes('downstream'), 'rule-based action');
    assert.ok(exp[0].evidence.includes('67%'), 'evidence cited');
    assert.ok(!/optimal/i.test(exp[0].action), 'no optimality claims');
  });

  it('limits documented: 600s runs, 60s warmup, 10MiB caps', () => {
    assert.equal(EXPERIMENT_LIMITS.runSeconds, 600);
    assert.equal(EXPERIMENT_LIMITS.warmupSeconds, 60);
    assert.equal(EXPERIMENT_LIMITS.maxBytes, 10 * 1024 * 1024);
  });
});
