// Accessibility support — S08.2.
//
// One English message map with parameter formatting (no dynamic HTML
// interpolation; no translation without review). Settings: separate
// master/SFX volume, UI scale 90-150%, reduced motion, persisted separately
// from saves. Shortcut remap helper with conflict detection. Honest scope:
// canvas navigation limits are documented, not claimed away.
export const MESSAGES = {
  citySaved: 'City saved.',
  cityLoaded: 'City loaded.',
  cityExported: 'City exported.',
  newMap: 'New map generated.',
  undoDone: 'City restored to before edit; paused.',
  redoDone: 'Edit restored; paused.',
  noSave: 'No save found.',
  needXp: 'Level up grants more ({xp} XP to go).',
  noStock: 'No {label} left.',
  signalInstalled: 'Signal installed.',
  bridgePlaced: 'Bridge placed.',
  tunnelPlaced: 'Tunnel placed.',
  roundaboutBuilt: 'Roundabout built — traffic circulates counterclockwise.',
  roundaboutRemoved: 'Roundabout removed.',
  roadRemoved: 'Road removed.',
  importDone: 'Imported {name}.',
  importFailed: 'Import failed: {reason}. The current city is unchanged.',
  recoverDone: 'Recovered the previous save.',
  noBackup: 'No backup is available to recover.',
  accessDenied: 'That junction serves a building; remove the building instead.',
};

export function formatMsg(key, params = {}) {
  let s = MESSAGES[key];
  if (typeof s !== 'string') throw new Error(`unknown message: ${key}`);
  for (const [k, v] of Object.entries(params)) {
    s = s.replaceAll(`{${k}}`, String(v));
  }
  if (/{[a-zA-Z]+}/.test(s)) throw new Error(`unfilled parameter in ${key}`);
  return s;
}

export const DEFAULT_SETTINGS = {
  master: 1.0,
  sfx: 1.0,
  uiScale: 1.0,
  reducedMotion: false,
};

export const DEFAULT_SHORTCUTS = {
  pause: 'Space',
  undo: 'ctrl+z',
  redo: 'ctrl+shift+z',
  bulldoze: 'Delete',
  fit: 'f',
  escape: 'Escape',
};

export function validateSettings(raw) {
  if (raw == null) return { ok: true, settings: { ...DEFAULT_SETTINGS } };
  const s = { ...DEFAULT_SETTINGS, ...raw };
  if (!(s.master >= 0 && s.master <= 1)) return { ok: false, reason: 'master volume must be 0..1' };
  if (!(s.sfx >= 0 && s.sfx <= 1)) return { ok: false, reason: 'sfx volume must be 0..1' };
  if (!(s.uiScale >= 0.9 && s.uiScale <= 1.5)) return { ok: false, reason: 'UI scale must be 90..150%' };
  s.reducedMotion = !!s.reducedMotion;
  return { ok: true, settings: { master: s.master, sfx: s.sfx, uiScale: s.uiScale, reducedMotion: s.reducedMotion } };
}

/** Returns conflict descriptions for a shortcut map (empty = clean). */
export function detectShortcutConflicts(map) {
  const seen = new Map();
  const out = [];
  for (const [action, key] of Object.entries(map)) {
    const k = String(key).toLowerCase();
    if (seen.has(k)) out.push(`"${key}" is bound to both ${seen.get(k)} and ${action}`);
    else seen.set(k, action);
  }
  return out;
}
