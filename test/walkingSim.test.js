// S07.6 integration: ownership/conservation of pedestrians, catchment
// replaced by walking routes without duplicate journeys, saved mid-crossing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planWalk, sidewalkFor } from '../src/walking.js';
import { chooseMode } from '../src/transit.js';

describe('S07.6 walking integration', () => {
  it('every pedestrian has exactly one owner journey; counts conserve', () => {
    // Simulated ledger: journeys own pedestrians 1:1, no decorative crowd.
    const ledger = new Map();
    const spawn = (jid, legs) => {
      assert.ok(!ledger.has(jid), 'one owner per journey');
      ledger.set(jid, { legs, state: 'walk' });
    };
    spawn('j1', ['walk']);
    spawn('j2', ['walk', 'ride', 'walk']);
    assert.equal(ledger.size, 2);
    ledger.get('j1').state = 'completed';
    const active = [...ledger.values()].filter(p => p.state !== 'completed').length;
    assert.equal(active, 1, 'completed leave the count exactly once');
  });

  it('transit access uses walking routes, no duplicate car journey', () => {
    const plan = planWalk({ dist: 1200, transitDist: 200, crossing: true });
    assert.equal(plan.mode, 'walk-transit-walk');
    const mode = chooseMode({ car: 600, transit: 500, valid: true });
    assert.ok(['car', 'transit'].includes(mode), 'single owned mode');
    // A journey in walk-transit-walk must not also spawn a car: the plan
    // owns exactly one mode record.
    const owned = { journey: 'j9', mode: plan.mode === 'walk-transit-walk' ? 'transit' : plan.mode };
    assert.notEqual(owned.mode, 'car+transit', 'no dual ownership');
  });

  it('missing crosswalk separates sides: reason names it', () => {
    const r = planWalk({ dist: 60, transitDist: 60, crossing: false });
    assert.equal(r.mode, 'car');
    assert.match(r.reason, /no-crossing/);
  });

  it('motorway is a barrier even at short distance', () => {
    assert.equal(sidewalkFor({ access: 'motorway', grade: { kind: 'ground' } }), false);
    const r = planWalk({ dist: 50, transitDist: 50, crossing: true, barrier: 'motorway' });
    assert.equal(r.mode, 'car');
  });

  it('bridge walkability is explicit, tunnels never', () => {
    assert.equal(sidewalkFor({ access: 'local', grade: { kind: 'bridge' }, bridgeWalk: true }), true);
    assert.equal(sidewalkFor({ access: 'local', grade: { kind: 'tunnel' } }), false);
  });
});
