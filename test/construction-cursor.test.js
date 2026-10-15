// Keyboard construction cursor and focus trap (S02.6b).
//
// DESIGN section 5: 'Provide keyboard construction cursor: arrow movement 10 wu,
// shift + arrow 1 wu; Enter sets point, explicit Finish button commits, Escape
// cancels; reachable Pan/Zoom/Fit controls.'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURSOR_STEP_WU, CURSOR_FINE_STEP_WU,
  ConstructionCursor, arrowDirection, FocusTrap,
} from '../src/construction.js';

test('the cursor moves CURSOR_STEP_WU per arrow press', () => {
  const c = new ConstructionCursor({ x: 0, y: 0, visible: true });
  const before = { ...c };
  c.move('right');
  assert.equal(c.x - before.x, CURSOR_STEP_WU, 'the step must be the declared width');
  assert.equal(c.y, before.y, 'a horizontal move must not change y');
});

test('the cursor moves in all four directions', () => {
  const c = new ConstructionCursor({ x: 0, y: 0, visible: true });
  c.move('right');  assert.equal(c.x, CURSOR_STEP_WU);
  c.move('left');   assert.equal(c.x, 0);
  c.move('down');   assert.equal(c.y, CURSOR_STEP_WU);
  c.move('up');     assert.equal(c.y, 0);
});

test('shift+arrow moves the fine step instead', () => {
  const c = new ConstructionCursor({ x: 0, y: 0, visible: true });
  c.move('right', true);
  assert.equal(c.x, CURSOR_FINE_STEP_WU, 'the fine step must be 1 wu');
  assert.ok(CURSOR_FINE_STEP_WU < CURSOR_STEP_WU, 'the fine step must be smaller');
});

test('show centres the cursor and makes it visible', () => {
  const c = new ConstructionCursor();
  assert.equal(c.visible, false, 'the cursor starts hidden');
  c.show(300, -200);
  assert.equal(c.x, 300);
  assert.equal(c.y, -200);
  assert.equal(c.visible, true);
});

test('hide makes the cursor invisible without moving it', () => {
  const c = new ConstructionCursor({ x: 5, y: 6, visible: true });
  c.hide();
  assert.equal(c.visible, false);
  assert.equal(c.x, 5, 'the position must be preserved');
});

test('arrow keys map to their directions', () => {
  assert.equal(arrowDirection('ArrowUp'), 'up');
  assert.equal(arrowDirection('ArrowDown'), 'down');
  assert.equal(arrowDirection('ArrowLeft'), 'left');
  assert.equal(arrowDirection('ArrowRight'), 'right');
});

test('non-arrow keys are not directions', () => {
  for (const key of ['1', 'Enter', 'Escape', ' ', 'f', 'a']) {
    assert.equal(arrowDirection(key), null, '"' + key + '" must not be a direction');
  }
  assert.equal(arrowDirection(undefined), null);
});

test('FocusTrap has capture and trap methods', () => {
  assert.equal(typeof FocusTrap.capture, 'function');
  assert.equal(typeof FocusTrap.trap, 'function');
});