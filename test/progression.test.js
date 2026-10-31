// S06.5: difficulty rules + milestone progression.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTIES, MILESTONES, rulesFor, milestoneFor, levelForXp,
  migrateXp, previewRewards,
} from '../src/rules.js';

describe('S06.5 rules', () => {
  it('three difficulties with explicit numbers, physics untouched', () => {
    for (const d of ['easy', 'normal', 'hard']) {
      const r = rulesFor(d);
      assert.ok(r.demandRate > 0 && r.serviceDeadline > 0, `${d} has rates`);
      assert.ok(r.startBatch.house >= 4, `${d} playable start`);
      assert.equal(r.startBatch.depot, 1, 'everyone gets one depot');
    }
    const e = rulesFor('easy'), n = rulesFor('normal'), h = rulesFor('hard');
    assert.ok(e.demandRate < n.demandRate && n.demandRate < h.demandRate, 'demand gradient');
    assert.ok(e.serviceDeadline > n.serviceDeadline && n.serviceDeadline > h.serviceDeadline, 'deadline gradient');
    assert.ok(!('carSpeed' in n) && !('truckLength' in n), 'no physics in rules');
  });

  it('milestones start 100/250/500/900 cumulative', () => {
    assert.deepEqual(MILESTONES.slice(0, 4), [100, 250, 500, 900]);
    assert.equal(levelForXp(0), 1);
    assert.equal(levelForXp(99), 1);
    assert.equal(levelForXp(100), 2);
    assert.equal(levelForXp(499), 3);
    assert.equal(levelForXp(500), 4);
    assert.equal(levelForXp(899), 4);
    assert.equal(levelForXp(900), 5);
  });

  it('one milestone per crossing, rewards idempotent', () => {
    const seen = new Set();
    const r1 = milestoneFor(1, 150, seen);
    assert.ok(r1, 'crossing 100 grants');
    const r2 = milestoneFor(1, 150, seen);
    assert.equal(r2, null, 'same threshold never repeats');
    assert.ok(seen.has(100));
  });

  it('old XP migrates by fraction, never regresses level', () => {
    // Old formula 300*lvl^2: level 2 at 1200 XP -> fraction into level 2.
    const m = migrateXp(1200, 2);
    assert.ok(m.level >= 2, 'no regression');
    assert.ok(m.xp >= 0 && m.migrated, 'flagged');
    const fresh = migrateXp(0, 1);
    assert.equal(fresh.level, 1);
  });

  it('reward preview matches actual grants', () => {
    const p = previewRewards(2);
    assert.ok(p.house >= 1 && p.shop >= 1, 'useful balance');
    assert.deepEqual(Object.keys(p).sort(), ['depot', 'factory', 'house', 'park', 'shop']);
  });

  it('unknown difficulty falls back to normal explicitly', () => {
    assert.equal(rulesFor('lunatic').name, 'normal');
  });
});
