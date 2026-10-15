// Pointer state machine and keyboard scoping (S02.5a).
//
// These rules are numeric, so they are asserted numerically rather than through
// a browser. The defects they guard were all live in the inline handlers before
// this module existed:
//
//   - no pointercancel/lostcapture/blur handler, so a pan interrupted by
//     alt-tab left `panning` true forever
//   - the dblclick finaliser added a duplicate final draft point
//   - the keyboard guard skipped INPUT/TEXTAREA but not SELECT, and skipped
//     `ui.dialog` but not `ui.openPanel`, so digit shortcuts still placed roads
//     underneath the open menu
//   - Space called preventDefault unconditionally, blocking keyboard activation
//     of any focused button
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POINTER_MODE, INPUT_MODE,
  pointerIntent, panCamera, pushDraftPoint, isFormControl,
  PointerTracker, inputMode, keyboardAction,
} from '../src/input.js';

// ------------------------------------------------------------ pointer intent ---

test('left button draws, middle/right/shift pans, others are ignored', () => {
  assert.equal(pointerIntent({ button: 0, shiftKey: false }), 'draw');
  assert.equal(pointerIntent({ button: 1, shiftKey: false }), 'pan');
  assert.equal(pointerIntent({ button: 2, shiftKey: false }), 'pan');
  assert.equal(pointerIntent({ button: 0, shiftKey: true }), 'pan');
  assert.equal(pointerIntent({ button: 3, shiftKey: false }), 'ignore',
    'an extra mouse button must not place buildings');
  assert.equal(pointerIntent({}), 'ignore', 'a missing button is not a draw');
});

// -------------------------------------------------------------- panning ---

test('panning from a pointer position preserves the world under it', () => {
  // Dragging the map 100 px right moves the camera 100/zoom wu LEFT (the world
  // under the pointer stays under it), and likewise for y.
  const start = { sx: 500, sy: 400, camX: 200, camY: -100 };
  const cam = panCamera(start, 600, 440, 2);
  assert.ok(Math.abs(cam.x - 150) < 1e-9, `expected cam.x 150, got ${cam.x}`);
  assert.ok(Math.abs(cam.y + 120) < 1e-9, `expected cam.y -120, got ${cam.y}`);
});

test('panning back to the start restores the original camera', () => {
  const start = { sx: 500, sy: 400, camX: 200, camY: -100 };
  const out = panCamera(start, 500, 400, 1);
  assert.ok(Math.abs(out.x - 200) < 1e-9 && Math.abs(out.y + 100) < 1e-9,
    'panning back to the start pointer must restore the camera');
});

test('panCamera is pure: the same inputs give the same output', () => {
  const start = { sx: 100, sy: 100, camX: 0, camY: 0 };
  const a = panCamera(start, 150, 160, 1);
  const b = panCamera(start, 150, 160, 1);
  assert.deepEqual(a, b);
});

// ------------------------------------------------------------ pointer tracker ---

test('the tracker starts idle, not panning', () => {
  const t = new PointerTracker();
  assert.equal(t.mode, POINTER_MODE.IDLE);
  assert.equal(t.isPanning, false);
  assert.equal(t.panTo(0, 0, 1), null, 'a pan with no start must produce nothing');
});

test('beginPan enters panning and panTo tracks the camera', () => {
  const t = new PointerTracker();
  t.beginPan(500, 400, 200, -100);
  assert.equal(t.isPanning, true);
  const cam = t.panTo(600, 440, 2);
  assert.ok(Math.abs(cam.x - 150) < 1e-9 && Math.abs(cam.y + 120) < 1e-9);
});

test('endPan returns to idle and panTo produces nothing', () => {
  const t = new PointerTracker();
  t.beginPan(500, 400, 200, -100);
  t.endPan();
  assert.equal(t.isPanning, false);
  assert.equal(t.panTo(600, 440, 2), null);
});

test('cancel returns to idle from panning', () => {
  const t = new PointerTracker();
  t.beginPan(500, 400, 200, -100);
  t.cancel();
  assert.equal(t.isPanning, false, 'a cancelled pan must not keep dragging');
  assert.equal(t.panTo(600, 440, 2), null, 'a cancelled pan must produce no camera');
});

test('cancel from idle is safe', () => {
  const t = new PointerTracker();
  t.cancel();
  assert.equal(t.isPanning, false);
});

// -------------------------------------------------------------- input mode ---

test('the input mode is derived from the tracker and the draft', () => {
  const t = new PointerTracker();
  assert.equal(inputMode(t, false), INPUT_MODE.IDLE);
  assert.equal(inputMode(t, true), INPUT_MODE.DRAWING, 'an open draft is a drawing state');
  t.beginPan(0, 0, 0, 0);
  assert.equal(inputMode(t, true), INPUT_MODE.PANNING, 'a pan overrides a drawing');
  t.cancel();
  assert.equal(inputMode(t, true), INPUT_MODE.DRAWING, 'cancelling the pan resumes the drawing');
  assert.equal(inputMode(t, false), INPUT_MODE.IDLE);
});

// ------------------------------------------------------------ draft points ---

test('the first draft point is pushed', () => {
  assert.deepEqual(pushDraftPoint([], 100, 50), [[100, 50]]);
});

test('a point that duplicates the previous one is rejected', () => {
  // This is the double-click defect: the second pointerdown of a double-click
  // landed on the same pixel and added a zero-length final segment.
  const draft = [[100, 50], [300, 200]];
  const result = pushDraftPoint(draft, 300, 200);
  assert.equal(result, draft, 'a duplicate point must return the SAME array unchanged');
  assert.equal(result.length, 2, 'and must not grow');
});

test('a point within the dedup threshold is rejected, one past it is kept', () => {
  const draft = [[0, 0]];
  assert.equal(pushDraftPoint(draft, 0.5, 0, 1), draft, '0.5 wu is within the 1 wu threshold');
  const kept = pushDraftPoint(draft, 2, 0, 1);
  assert.equal(kept.length, 2, '2 wu is a deliberate short segment and is kept');
});

test('pushDraftPoint does not mutate the input array', () => {
  const draft = [[0, 0], [50, 0]];
  const result = pushDraftPoint(draft, 100, 0);
  assert.equal(draft.length, 2, 'the input must be unchanged');
  assert.equal(result.length, 3, 'the result is a new array with the point added');
});

// ------------------------------------------------------------- form controls ---

test('form controls are recognised for keyboard scoping', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(isFormControl({ tagName: tag }), true, `${tag} is a form control`);
  }
  assert.equal(isFormControl({ isContentEditable: true }), true, 'contentEditable is a form control');
  assert.equal(isFormControl({ tagName: 'BUTTON' }), false, 'a button is not a typing target');
  assert.equal(isFormControl({ tagName: 'CANVAS' }), false);
  assert.equal(isFormControl(null), false);
});

// ------------------------------------------------------------ keyboard scoping ---

const canvasTarget = { tagName: 'CANVAS' };
const buttonTarget = { tagName: 'BUTTON' };
const inputTarget = { tagName: 'INPUT' };
const selectTarget = { tagName: 'SELECT' };

test('keys are ignored while the user is typing in a form control', () => {
  // Including Escape: the game must never steal a key from a text field.
  for (const target of [inputTarget, selectTarget, { isContentEditable: true }]) {
    for (const key of ['1', 'Escape', ' ', 'f', 'Delete', 'Enter']) {
      const r = keyboardAction({ key, target }, {});
      assert.equal(r.action, 'none', `${key} on ${target.tagName ?? 'editable'} must be ignored`);
      assert.equal(r.preventDefault, false, `${key} on a form control must not be prevented`);
    }
  }
});

test('Escape is always available to cancel the innermost open thing', () => {
  assert.equal(keyboardAction({ key: 'Escape', target: canvasTarget }, { dialog: 'help' }).action, 'escape');
  assert.equal(keyboardAction({ key: 'Escape', target: canvasTarget }, { panel: 'menu' }).action, 'escape');
  assert.equal(keyboardAction({ key: 'Escape', target: canvasTarget }, {}).action, 'escape');
});

test('a shortcut never edits the city beneath an open dialog or panel', () => {
  // The menu-popover leak: with the menu OPEN, digit shortcuts still placed
  // roads underneath it, because the guard checked ui.dialog but not ui.openPanel.
  for (const scope of [{ dialog: 'help' }, { panel: 'menu' }]) {
    for (const key of ['1', '2', '9', '0', 'f', 'Delete', 'Enter']) {
      const r = keyboardAction({ key, target: canvasTarget }, scope);
      assert.equal(r.action, 'none',
        `key "${key}" must be ignored while ${JSON.stringify(scope)} is open`);
    }
  }
});

test('Space activates a focused button instead of pausing the game', () => {
  // The defect: preventDefault was called unconditionally, so a focused button
  // could never be activated by the keyboard.
  const onButton = keyboardAction({ key: ' ', target: buttonTarget }, {});
  assert.equal(onButton.action, 'none', 'Space on a focused button must activate it, not pause');
  assert.equal(onButton.preventDefault, false, 'and must not block the browser default');

  const onCanvas = keyboardAction({ key: ' ', target: canvasTarget }, {});
  assert.equal(onCanvas.action, 'toggle-speed', 'Space on the map pauses');
  assert.equal(onCanvas.preventDefault, true, 'and prevents the page scroll');

  // Even inside a dialog, Space on a button activates the button.
  const inDialog = keyboardAction({ key: ' ', target: buttonTarget }, { dialog: 'help' });
  assert.equal(inDialog.action, 'none', 'Space on a focused button inside a dialog activates it');
  assert.equal(inDialog.preventDefault, false);
});

test('known keys map to their actions when nothing is in the way', () => {
  assert.equal(keyboardAction({ key: 'f', target: canvasTarget }, {}).action, 'fit');
  assert.equal(keyboardAction({ key: 'F', target: canvasTarget }, {}).action, 'fit');
  assert.equal(keyboardAction({ key: 'Delete', target: canvasTarget }, {}).action, 'bulldoze');
  assert.equal(keyboardAction({ key: 'Backspace', target: canvasTarget }, {}).action, 'bulldoze');
});

test('Enter finishes a road only when a draft is open', () => {
  assert.equal(keyboardAction({ key: 'Enter', target: canvasTarget }, { hasDraft: true }).action, 'finish-road');
  assert.equal(keyboardAction({ key: 'Enter', target: canvasTarget }, {}).action, 'none',
    'Enter with no draft must do nothing');
});

test('unrecognised keys become tool shortcuts for main.js to map', () => {
  const r = keyboardAction({ key: '1', target: canvasTarget }, {});
  assert.equal(r.action, 'tool-shortcut', 'a digit is a possible tool shortcut');
  assert.equal(r.preventDefault, false);
  // The dialog and form-control guards come first.
  assert.equal(keyboardAction({ key: '1', target: inputTarget }, {}).action, 'none');
  assert.equal(keyboardAction({ key: '1', target: canvasTarget }, { panel: 'menu' }).action, 'none');
});

test('the result is pure: the same event and scope give the same decision', () => {
  const ev = { key: ' ', target: canvasTarget };
  const scope = { dialog: null, panel: null, hasDraft: false };
  const a = keyboardAction(ev, scope);
  const b = keyboardAction(ev, scope);
  assert.deepEqual(a, b);
});
