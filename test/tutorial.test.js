// Tutorial state machine (S02.6a).
//
// The tutorial's five steps are each completed by an ACTUAL WORLD CONDITION,
// never by clicking Next. The state is derived, not stored: the same world
// always produces the same step, so a saved city reproduces its own tutorial
// position and the state machine cannot desynchronise from the simulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TUTORIAL_STEPS, TUTORIAL_IDS, TUTORIAL_START,
  tutorialStep, tutorialWorldSnapshot,
} from '../src/tutorial.js';

/** The empty world: nothing has happened yet. */
const EMPTY = {
  camerasMoved: false, hasRoad: false, hasHome: false,
  hasShop: false, hasFactory: false, tripsCompleted: 0,
};

test('there are exactly five steps, in DESIGN order', () => {
  assert.equal(TUTORIAL_STEPS.length, 5);
  assert.deepEqual(TUTORIAL_IDS, ['pan', 'road', 'build', 'trip', 'work']);
  assert.equal(TUTORIAL_START, 'pan');
  // Every step has a label the player can read.
  for (const s of TUTORIAL_STEPS) {
    assert.ok(s.label && s.label.length > 5, `step ${s.id} needs a readable label`);
    assert.ok(s.condition, `step ${s.id} needs a completion condition`);
  }
});

test('an empty world starts at the pan step', () => {
  const r = tutorialStep(EMPTY);
  assert.equal(r.step, 'pan');
  assert.equal(r.index, 0);
  assert.equal(r.done, false);
});

test('each condition advances to the next step in order', () => {
  // Complete each condition one at a time and assert the step advances.
  const stages = [
    { ...EMPTY, camerasMoved: true },
    { ...EMPTY, camerasMoved: true, hasRoad: true },
    { ...EMPTY, camerasMoved: true, hasRoad: true, hasHome: true, hasShop: true },
    { ...EMPTY, camerasMoved: true, hasRoad: true, hasHome: true, hasShop: true, tripsCompleted: 1 },
    { ...EMPTY, camerasMoved: true, hasRoad: true, hasHome: true, hasShop: true, tripsCompleted: 1, hasFactory: true },
  ];
  const expected = ['road', 'build', 'trip', 'work', 'work'];
  for (let i = 0; i < stages.length; i++) {
    const r = tutorialStep(stages[i]);
    assert.equal(r.step, expected[i],
      `stage ${i}: expected step ${expected[i]}, got ${r.step}`);
  }
  // The last stage has every condition met: the tutorial is done.
  assert.equal(tutorialStep(stages[stages.length - 1]).done, true,
    'completing every condition finishes the tutorial');
});

test('the step is the earliest unmet condition, not the last completed one', () => {
  // A player who builds everything at once should land on the last step,
  // not be walked through each one individually.
  const everything = { ...EMPTY, camerasMoved: true, hasRoad: true, hasHome: true, hasShop: true, hasFactory: true, tripsCompleted: 3 };
  const r = tutorialStep(everything);
  assert.equal(r.done, true, 'building everything finishes the tutorial');
});

test('partial progress is reflected: home without shop stays on build', () => {
  const r = tutorialStep({ ...EMPTY, camerasMoved: true, hasRoad: true, hasHome: true });
  assert.equal(r.step, 'build', 'a home without a shop is still on the build step');
});

test('tutorialWorldSnapshot reads the live world without mutating it', () => {
  const edges = new Map([['e1', { id: 'e1' }]]);
  const buildings = new Map([
    ['b1', { type: 'house' }],
    ['b2', { type: 'shop' }],
  ]);
  const world = {
    net: { edges },
    eco: { buildings, totalTrips: 3 },
    camerasMoved: true,
  };
  const before = { edges: edges.size, buildings: buildings.size, trips: 3 };

  const snap = tutorialWorldSnapshot(world);
  assert.equal(snap.camerasMoved, true);
  assert.equal(snap.hasRoad, true);
  assert.equal(snap.hasHome, true);
  assert.equal(snap.hasShop, true);
  assert.equal(snap.hasFactory, false);
  assert.equal(snap.tripsCompleted, 3);

  // The world must be unchanged.
  assert.equal(edges.size, before.edges);
  assert.equal(buildings.size, before.buildings);
});

test('tutorialWorldSnapshot tolerates a missing world', () => {
  const snap = tutorialWorldSnapshot(null);
  assert.equal(snap.camerasMoved, false);
  assert.equal(snap.hasRoad, false);
  assert.equal(snap.tripsCompleted, 0);
});

test('the full progression is monotonic: no step is ever skipped back', () => {
  // Add conditions one at a time and verify the step index never decreases.
  const w = { ...EMPTY };
  let lastIndex = 0;
  const conditions = ['camerasMoved', 'hasRoad', 'hasHome', 'hasShop'];
  for (const cond of conditions) {
    w[cond] = true;
    const r = tutorialStep(w);
    assert.ok(r.index >= lastIndex,
      `adding ${cond} moved the step backwards from ${lastIndex} to ${r.index}`);
    lastIndex = r.index;
  }
  // Adding a factory + a trip completes the tutorial.
  w.hasFactory = true;
  w.tripsCompleted = 1;
  assert.equal(tutorialStep(w).done, true);
});
