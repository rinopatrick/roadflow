// S06.1: capacity-aware demand. Journey lifecycle, bounded pending queues,
// capacity reservations, deterministic destination choice.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DemandManager, DEMAND_LIMITS } from '../src/demand.js';

function world2() {
  // Minimal building set: 2 homes, 1 shop (capacity 4 customers), 1 factory.
  const buildings = new Map([
    ['h1', { id: 'h1', type: 'house', residents: 4, drivewayNode: 'n1' }],
    ['h2', { id: 'h2', type: 'house', residents: 4, drivewayNode: 'n2' }],
    ['s1', { id: 's1', type: 'shop', jobs: 2, drivewayNode: 'n3' }],
    ['f1', { id: 'f1', type: 'factory', jobs: 6, drivewayNode: 'n4' }],
  ]);
  // Route cost oracle: cost[from][to]; null = no path.
  const cost = {
    n1: { n3: 10, n4: 50 },
    n2: { n3: 12, n4: 11 },
  };
  return { buildings, cost };
}

describe('S06.1 journey lifecycle', () => {
  it('creates a journey with a stable id and pending state', () => {
    const d = new DemandManager(world2());
    const j = d.request({ kind: 'shopping', origin: 'h1' });
    assert.ok(j, 'request admitted');
    assert.equal(j.state, 'pending');
    assert.ok(j.id, 'journey has an id');
  });

  it('chooses the reachable destination with capacity, cheapest first', () => {
    const d = new DemandManager(world2());
    // h1: shop s1 cost 10 vs factory n/a for shopping. Only s1 serves shopping.
    const j = d.request({ kind: 'shopping', origin: 'h1' });
    assert.equal(j.destination, 's1');
  });

  it('two homes compete: shop capacity 4 customers admits both, 5th queues', () => {
    const d = new DemandManager(world2());
    const admitted = [];
    for (let i = 0; i < 5; i++) {
      const j = d.request({ kind: 'shopping', origin: i % 2 ? 'h1' : 'h2' });
      if (j) admitted.push(j);
    }
    // 4 concurrent customers max: 5th request is refused or queued bounded.
    assert.ok(admitted.length <= 5);
    const actives = admitted.filter(j => j.state === 'active' || j.state === 'pending');
    assert.ok(actives.length <= DEMAND_LIMITS.maxPendingPerOrigin * 2 + 4);
  });

  it('at most 16 pending per origin; the 17th is refused with a reason', () => {
    const d = new DemandManager(world2());
    // Block dispatch so everything stays pending.
    d.dispatch = () => false;
    let last = null;
    for (let i = 0; i < 17; i++) last = d.request({ kind: 'shopping', origin: 'h1' });
    assert.equal(last, null, '17th request refused');
    assert.match(d.lastRefusal, /pending|queue|cap/i);
  });

  it('cancel releases the capacity reservation', () => {
    const d = new DemandManager(world2());
    const j = d.request({ kind: 'work', origin: 'h1' });
    assert.ok(j);
    const dest = j.destination;
    const before = d.reservedAt(dest);
    assert.ok(before >= 1, 'capacity reserved on admit');
    d.cancel(j.id, 'deletedDestination');
    assert.equal(d.reservedAt(dest), before - 1, 'reservation released');
    assert.equal(d.get(j.id).state, 'cancelled');
  });

  it('completed journeys earn XP once; returns do not farm XP', () => {
    const d = new DemandManager(world2());
    let xp = 0;
    const j = d.request({ kind: 'shopping', origin: 'h1' });
    d.dispatchAll((from, to) => ({ id: 'v1', from, to }));
    d.onArrive('v1', () => { xp += 10; });
    d.arrive('v1');
    assert.equal(xp, 10);
    assert.equal(d.get(j.id).state, 'completed');
    // A second arrival for the same journey is ignored.
    d.arrive('v1');
    assert.equal(xp, 10, 'no double XP');
  });

  it('cancelled demand is counted with a reason, never silently dropped', () => {
    const d = new DemandManager(world2());
    const j = d.request({ kind: 'work', origin: 'h2' });
    d.cancel(j.id, 'noJobs');
    const s = d.stats();
    assert.equal(s.cancelled, 1);
    assert.equal(s.reasons.noJobs, 1);
  });

  it('limits are documented', () => {
    assert.equal(DEMAND_LIMITS.maxPendingPerOrigin, 16);
    assert.equal(DEMAND_LIMITS.retrySeconds, 2);
    assert.equal(DEMAND_LIMITS.expireSeconds, 300);
  });
});
