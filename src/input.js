// Pointer state machine and keyboard scoping — S02.5a.
//
// Why this is a separate pure module
// ----------------------------------
// Four defects lived in the inline handlers and none could be seen without
// deliberately triggering them:
//
//   1. There was NO pointercancel, lostpointercapture or window-blur handler.
//      A pan interrupted by an alt-tab left `panning` true forever, so the map
//      dragged with no button held.
//   2. The `dblclick` finaliser added a DUPLICATE final draft point, because the
//      second click of the double-click fires `pointerdown` first.
//   3. The keyboard guard checked INPUT/TEXTAREA/contentEditable but not SELECT,
//      and checked `ui.dialog` but not `ui.openPanel`, so with the MENU OPEN the
//      digit shortcuts still placed roads underneath it.
//   4. Space called `preventDefault()` unconditionally, which blocks a focused
//      button from ever being activated by the keyboard.
//
// Everything here is pure: the same event and scope always produce the same
// decision, and no DOM, RNG or network is touched.
//
// MODES
// -----
// The tracker owns PANNING (the transient state that must be cleaned up when a
// gesture is interrupted). DRAWING is the road draft, which lives in main.js —
// `inputMode` derives the overall mode from the tracker plus whether a draft is
// open, so all three of DESIGN's states (idle / drawing / panning) have a name.

/** Pointer interaction modes the tracker owns. */
export const POINTER_MODE = { IDLE: 'idle', PANNING: 'panning' };

/** Overall input mode, derived from the tracker plus the road draft. */
export const INPUT_MODE = { IDLE: 'idle', PANNING: 'panning', DRAWING: 'drawing' };

const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True when the event target is a control the user is typing into. */
export function isFormControl(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return FORM_TAGS.has(target.tagName);
}

/**
 * What a pointer-down event wants to do.
 *
 * Middle button, right button and shift+left are pans (matching the help text
 * and DESIGN section 5). Left is a click. Anything else is ignored, so a pen
 * barrel button or a gaming mouse's extra buttons cannot place buildings.
 */
export function pointerIntent({ button, shiftKey } = {}) {
  if (button === 1 || button === 2 || shiftKey) return 'pan';
  if (button === 0) return 'draw';
  return 'ignore';
}

/**
 * The camera position after panning from a recorded start to a pointer.
 *
 * Solved from the start position rather than applied incrementally, so the pan
 * cannot accumulate drift the way `cam += delta` did.
 *
 * @param {{sx:number,sy:number,camX:number,camY:number}} start
 * @param {number} px current pointer CSS x
 * @param {number} py current pointer CSS y
 * @param {number} zoom current camera zoom
 * @returns {{x:number,y:number}}
 */
export function panCamera(start, px, py, zoom) {
  return {
    x: start.camX - (px - start.sx) / zoom,
    y: start.camY - (py - start.sy) / zoom,
  };
}

/**
 * Pushes a road draft point, rejecting one that duplicates the previous point.
 *
 * Why: a double-click fires `pointerdown` twice, so the finaliser saw
 * `[A, B, C, C]` and built a road with a zero-length final segment. The
 * threshold of 1 wu is well below any segment a player would draw (the whole
 * map is 6000 wu) but catches a double-click at the same pixel at any zoom.
 *
 * Pure: returns a NEW array, or the same array if the point is rejected. The
 * caller assigns the result; the input is never mutated.
 *
 * @param {Array<[number, number]>} draft
 * @param {number} x world x
 * @param {number} y world y
 * @param {number} [minDist] minimum distance from the previous point, in wu
 */
export function pushDraftPoint(draft, x, y, minDist = 1) {
  if (draft.length) {
    const last = draft[draft.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) < minDist) return draft;
  }
  return [...draft, [x, y]];
}

/**
 * Tracks the transient pointer gesture that must be cleaned up when a pointer
 * is lost. Panning only: the road draft is game state and lives in main.js.
 */
export class PointerTracker {
  constructor() {
    this.reset();
  }

  /** Returns to idle and forgets the pan start. */
  reset() {
    this.mode = POINTER_MODE.IDLE;
    this.start = null;
  }

  /**
   * Begins a pan from a pointer-down at CSS `(sx, sy)` with the camera at
   * `(camX, camY)`.
   */
  beginPan(sx, sy, camX, camY) {
    this.start = { sx, sy, camX, camY };
    this.mode = POINTER_MODE.PANNING;
  }

  /** Ends a pan normally (pointer-up). */
  endPan() {
    this.reset();
  }

  /** Ends a pan abnormally (pointercancel, lost capture, window blur). */
  cancel() {
    this.reset();
  }

  /** True while a pan gesture is in progress. */
  get isPanning() {
    return this.mode === POINTER_MODE.PANNING;
  }

  /**
   * The camera position for the current pointer, or null when not panning.
   * Delegates to the pure `panCamera`.
   */
  panTo(px, py, zoom) {
    if (!this.start) return null;
    return panCamera(this.start, px, py, zoom);
  }
}

/**
 * The overall input mode, for callers that need to know whether the player is
 * idle, mid-draw, or mid-pan. Derived, not stored: there is one source of truth
 * for each input (the tracker for pans, the draft array for draws).
 */
export function inputMode(tracker, hasDraft) {
  if (tracker.isPanning) return INPUT_MODE.PANNING;
  if (hasDraft) return INPUT_MODE.DRAWING;
  return INPUT_MODE.IDLE;
}

/**
 * Decides what a keyboard event should do, given the current UI scope.
 *
 * Returns `{ action, preventDefault }`. The action is one of:
 *
 *   'none'           do nothing (and do not prevent the browser default)
 *   'escape'         cancel the innermost open thing
 *   'fit'            frame the built city
 *   'finish-road'    commit the road draft
 *   'toggle-speed'   pause or resume
 *   'bulldoze'       switch to the demolish tool
 *   'tool-shortcut'  a key that main.js should map to a tool
 *
 * Order matters:
 *
 *   1. A form control the user is typing into always wins — the game must never
 *      steal a key from a text field, including Escape.
 *   2. Escape is next, because it is how the user GETS OUT of whatever is open.
 *   3. An open dialog or panel owns the rest: a shortcut for a tool the user
 *      cannot see is worse than no shortcut.
 *   4. Space on a focused button activates that button (the browser default);
 *      preventDefault here would make the button keyboard-unreachable.
 */
export function keyboardAction(ev, scope = {}) {
  const { dialog = null, panel = null, hasDraft = false } = scope;
  const target = ev?.target ?? {};

  // 1. A control the user is typing into always wins.
  if (isFormControl(target)) return { action: 'none', preventDefault: false };

  // 2. Escape: the way out of whatever is open, even from inside it.
  if (ev.key === 'Escape') return { action: 'escape', preventDefault: false };

  // 3. A dialog or open panel owns the keyboard. A shortcut for a tool the user
  //    cannot see past is worse than no shortcut.
  if (dialog || panel) return { action: 'none', preventDefault: false };

  // Undo and redo. Handled after the scope guards, so a shortcut never edits
  // the city beneath an open panel, and after the form-control guard, so a
  // text field keeps its own Ctrl+Z.
  if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) {
    return { action: ev.shiftKey ? 'redo' : 'undo', preventDefault: true };
  }

  // 4. Space on a focused button or link activates it (the browser's default);
  //    preventDefault here would make the control keyboard-unreachable.
  if (ev.key === ' ') {
    if (target.tagName === 'BUTTON' || target.tagName === 'A') {
      return { action: 'none', preventDefault: false };
    }
    return { action: 'toggle-speed', preventDefault: true };
  }

  if (ev.key === 'f' || ev.key === 'F') return { action: 'fit', preventDefault: false };

  if (ev.key === 'Enter') {
    return hasDraft
      ? { action: 'finish-road', preventDefault: false }
      : { action: 'none', preventDefault: false };
  }

  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    return { action: 'bulldoze', preventDefault: false };
  }

  // A possible tool shortcut; main.js maps the key to a tool.
  return { action: 'tool-shortcut', preventDefault: false };
}
