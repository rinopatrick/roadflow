// S07.5: buses, stops, capacity-aware passengers. Buses only: 18wu long,
// 4 wide, 0.8 speed, capacity 20, dwell 6s + 0.3s/boarding capped 20s.
// Passengers: pending->wait->ride->completed; bounded 64/stop queues; a
// transit journey never also spawns a car.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUS, validateLine, dwellFor, chooseMode, TransitLine, TRANSIT_LIMITS,
} from '../src/transit.js';

describe('S07.5 transit', () => {
  it('bus dimensions registered, not car-sized', () => {
    assert.equal(BUS.length, 18);
    assert.equal(BUS.width, 4);
    assert.equal(BUS.speedFactor, 0.8);
    assert.equal(BUS.capacity, 20);
  });

  it('line needs 2+ stops, headway 30..300, max 8 buses', () => {
    assert.equal(validateLine({ stops: ['a'], headway: 60 }, () => true).ok, false);
    assert.equal(validateLine({ stops: ['a', 'b'], headway: 10 }, () => true).ok, false);
    assert.equal(validateLine({ stops: ['a', 'b'], headway: 60, buses: 9 }, () => true).ok, false);
    assert.equal(validateLine({ stops: ['a', 'b'], headway: 60 }, () => true).ok, true);
    assert.equal(TRANSIT_LIMITS.queuePerStop, 64);
    assert.equal(TRANSIT_LIMITS.maxBuses, 8);
  });

  it('line requires a legal route between every pair incl. last->first', () => {
    const ok = (a, b) => !(a === 'x' && b === 'y');
    assert.equal(validateLine({ stops: ['w', 'x', 'y'], headway: 60 }, ok).ok, false);
  });

  it('dwell 6s + 0.3s/pax capped at 20s', () => {
    assert.equal(dwellFor(0, 0), 6);
    assert.equal(dwellFor(10, 10), 12);
    assert.equal(dwellFor(100, 100), 20, 'capped');
  });

  it('mode choice: transit iff <= 1.15x car estimate and valid', () => {
    assert.equal(chooseMode({ car: 100, transit: 110, valid: true }), 'transit');
    assert.equal(chooseMode({ car: 100, transit: 116, valid: true }), 'car');
    assert.equal(chooseMode({ car: 100, transit: 50, valid: false }), 'car');
    assert.equal(chooseMode({ car: 0, transit: 0, valid: true }), 'transit');
  });

  it('queues bounded at 64/stop; overflow stays unserved, not dropped', () => {
    const line = new TransitLine({ id: 'L1', stops: ['a', 'b'], headway: 60 });
    for (let i = 0; i < 70; i++) line.enqueue('a', `j${i}`);
    assert.equal(line.queueAt('a').length, 64);
    assert.equal(line.refused, 6, 'overflow counted, not silently lost');
  });

  it('board only downstream buses; alight completes with same accounting', () => {
    const line = new TransitLine({ id: 'L1', stops: ['a', 'b', 'c'], headway: 60 });
    line.enqueue('a', 'j1');
    const boarded = line.board('a', 'bus1', ['b', 'c'], 20);
    assert.deepEqual(boarded, ['j1']);
    assert.equal(line.queueAt('a').length, 0);
    const done = line.alight('bus1', 'b');
    assert.deepEqual(done, ['j1']);
  });
});
