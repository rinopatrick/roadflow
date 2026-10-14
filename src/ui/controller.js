// The single owner of transient interface state (S02.2 item 2).
//
// Simulation state — stock, stats, the graph — is authoritative elsewhere. This
// holds only what the interface is currently showing, and every component reads
// and writes it through here. That is the whole point: before this module, the
// active tool lived in a `let` in main.js, in a `.active` CSS class on the
// button, and in the canvas element's class name, and those three could
// disagree.
//
// It is deliberately a module singleton. There is exactly one interface.
const FIELDS = ['activeTool', 'openCategory', 'openPanel', 'overlay', 'dialog'];

const state = {
  activeTool: 'road',
  openCategory: 'roads',
  openPanel: null,   // 'inspect' | 'menu' | null — panels are exclusive
  overlay: null,     // 'traffic' | 'access' | 'pollution' — wired to the renderer in S02.2b
  dialog: null,      // 'help' | null — a modal, so shortcuts are suppressed while set
};

const listeners = new Set();

export const ui = {
  get activeTool() { return state.activeTool; },
  get openCategory() { return state.openCategory; },
  get openPanel() { return state.openPanel; },
  get overlay() { return state.overlay; },
  get dialog() { return state.dialog; },

  /** A copy, so a reader cannot mutate the state behind the setter's back. */
  snapshot() { return { ...state }; },

  /**
   * Applies a patch and notifies subscribers once, returning the changed keys.
   *
   * An unknown key throws. A misspelled field would otherwise become silent
   * state that no component ever renders — the same class of bug as a second
   * copy of the active tool, just harder to see.
   */
  set(patch) {
    const unknown = Object.keys(patch).filter(k => !FIELDS.includes(k));
    if (unknown.length) {
      throw new Error(
        `unknown UI state field(s): ${unknown.join(', ')}; known fields are ${FIELDS.join(', ')}`);
    }
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (state[key] === value) continue;
      state[key] = value;
      changed.push(key);
    }
    if (changed.length) for (const fn of listeners) fn(state, changed);
    return changed;
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
