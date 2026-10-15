// Keyboard construction cursor and focus trap — S02.6b remaining code.
//
// DESIGN section 5: "Provide keyboard construction cursor: arrow movement 10 wu,
// shift + arrow 1 wu; Enter sets point, explicit Finish button commits, Escape
// cancels; reachable Pan/Zoom/Fit controls."
//
// The cursor is a virtual pointer position in world space. Everything is pure:
// the same inputs always produce the same cursor position.

/** How far the keyboard cursor moves per arrow press, in world units. */
export const CURSOR_STEP_WU = 10;
/** How far it moves with Shift held, in world units. */
export const CURSOR_FINE_STEP_WU = 1;

/**
 * A virtual cursor for keyboard-only construction.
 *
 * The cursor has a world position and a visibility flag. The renderer draws a
 * crosshair at the cursor so the player can see where they are.
 */
export class ConstructionCursor {
  constructor({ x = 0, y = 0, visible = false } = {}) {
    this.x = x;
    this.y = y;
    this.visible = visible;
  }

  /**
   * Moves the cursor by one step in a direction.
   * @param {'up'|'down'|'left'|'right'} direction
   * @param {boolean} fine true for the fine (1 wu) step
   */
  move(direction, fine = false) {
    const step = fine ? CURSOR_FINE_STEP_WU : CURSOR_STEP_WU;
    switch (direction) {
      case 'up':    this.y -= step; break;
      case 'down':  this.y += step; break;
      case 'left':  this.x -= step; break;
      case 'right': this.x += step; break;
    }
  }

  /** Shows the cursor and centres it on a position. */
  show(x, y) {
    this.x = x;
    this.y = y;
    this.visible = true;
  }

  hide() {
    this.visible = false;
  }
}

/**
 * Maps an arrow key press to a cursor direction.
 * @param {string} key 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
 * @returns {string|null} the direction, or null for a non-arrow key
 */
export function arrowDirection(key) {
  switch (key) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    default: return null;
  }
}

/**
 * A simple focus trap for a modal container.
 *
 * When a dialog opens, focus moves to the first focusable child. Tab cycles
 * within the container. When the dialog closes, focus is restored to the
 * element that had it before.
 */
export class FocusTrap {
  /**
   * @param {HTMLElement} container the dialog or popover element
   * @returns {{ focusables: HTMLElement[], previous: HTMLElement|null }}
   */
  static capture(container) {
    const focusables = [...container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter(el => !el.hidden && el.offsetParent !== null);
    return { focusables, previous: document.activeElement };
  }

  /**
   * Traps a Tab keypress inside a set of focusable elements.
   * @param {KeyboardEvent} ev
   * @param {HTMLElement[]} focusables
   * @returns {boolean} true if the trap handled the key
   */
  static trap(ev, focusables) {
    if (!focusables.length) return false;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      last.focus();
      return true;
    }
    if (!ev.shiftKey && document.activeElement === last) {
      first.focus();
      return true;
    }
    return false;
  }
}
