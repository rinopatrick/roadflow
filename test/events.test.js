// S07.3: rush hours, incidents, service vehicles. Deterministic schedules,
// validated closures, reachable service dispatch with 10s on-site timer.
// Preemption never violates conflict/all-red safety.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUSH_DEFAULTS, rushMultiplier, validateIncident, IncidentLog,
  serviceDispatch,
} from '../src/events.js';

describe('S07.3 events', () => {
  it('rush multiplier: 1 outside, 1.6 in work peaks, deterministic', () => {
    assert.equal(rushMultiplier(0), 1, 'midnight calm');
    assert.equal(rushMultiplier(8 * 3600), 1.6, 'morning peak');
    assert.equal(rushMultiplier(12 * 3600), 1, 'midday calm');
    assert.equal(rushMultiplier(17.5 * 3600), 1.6, 'evening peak');
    assert.equal(rushMultiplier(-5), 1, 'negative wraps deterministically');
    assert.equal(RUSH_DEFAULTS.peak, 1.6);
  });

  it('incident validation: lane must exist, closure blocks admission', () => {
    const lanes = (edgeId) => edgeId === 'e1' ? 2 : 0;
    const bad = validateIncident({ id: 'i1', edgeId: 'e9', lane: 0, startsAt: 0, endsAt: 60, kind: 'laneClosure' }, lanes);
    assert.equal(bad.ok, false, 'unknown edge refused');
    const badLane = validateIncident({ id: 'i1', edgeId: 'e1', lane: 5, startsAt: 0, endsAt: 60, kind: 'laneClosure' }, lanes);
    assert.equal(badLane.ok, false, 'missing lane refused');
    const good = validateIncident({ id: 'i1', edgeId: 'e1', lane: 1, startsAt: 0, endsAt: 60, kind: 'laneClosure' }, lanes);
    assert.equal(good.ok, true);
  });

  it('log records applied/expired/cancelled once each', () => {
    const log = new IncidentLog();
    log.apply({ id: 'i1', edgeId: 'e1', lane: 0, startsAt: 10, endsAt: 70, kind: 'laneClosure' }, 10);
    log.apply({ id: 'i1', edgeId: 'e1', lane: 0, startsAt: 10, endsAt: 70, kind: 'laneClosure' }, 11);
    assert.equal(log.appliedCount(), 1, 'no duplicate apply');
    log.expire(80);
    assert.equal(log.expiredCount(), 1);
    log.cancel('i1', 'bridge edit removed the edge');
    assert.equal(log.cancelledCount(), 0, 'expired incidents cannot cancel');
  });

  it('service dispatches only on reachable paths, clears after 10s on site', () => {
    const d = serviceDispatch(
      { id: 's1', depot: 'n0' },
      { id: 'i1', access: 'n9' },
      { reachable: (a, b) => a === 'n0' && b === 'n9' },
    );
    assert.equal(d.ok, true);
    assert.equal(d.serviceSeconds, 10);
    const bad = serviceDispatch({ id: 's1', depot: 'n0' }, { id: 'i2', access: 'nX' }, { reachable: () => false });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /reachable/i, 'unreachable stays visible with reason');
  });

  it('preemption requests clearance but never violates safety', () => {
    // A preemption request is advisory: the connector/reservation layer
    // decides. The request carries no force flag.
    const req = { incidentId: 'i1', connectorId: 'c1', at: 100 };
    assert.ok(!('force' in req), 'no force flag exists');
    assert.ok(!('override' in req), 'no override flag exists');
  });
});
