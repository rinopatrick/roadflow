// Save/load storage: slots, backup, autosave, recovery, JSON export/import.
//
// Why this module exists
// ----------------------
// The v1 implementation was a bare `localStorage.setItem` / `getItem` pair with:
//
//  - no error handling around reads, so a disabled or full storage threw
//  - a single key, so a bad write destroyed the only copy of a city
//  - a `null` return that every caller treated as "make a new city", which meant
//    a failed load silently replaced the player's city AND then showed a
//    "City loaded." success toast (EVIDENCE E18)
//
// This module owns storage policy and returns STRUCTURED results. It never
// decides to start a new city, and it never reports success for a failure.
//
// All validation and hydration lives in `worldSnapshot.js`, so this file stays
// testable without a DOM by injecting a storage adapter.

import {
  serializeWorld, validateSnapshot, hydrateWorld, SNAPSHOT_VERSION,
} from './worldSnapshot.js';

/** Manual save slot. */
export const SAVE_KEY = 'roadflow.save';
/** Separate autosave slot, so an autosave can never clobber a manual save. */
export const AUTOSAVE_KEY = 'roadflow.autosave';
/** Last known-good copy of the manual slot, used for recovery. */
export const BACKUP_KEY = 'roadflow.save.backup';

/** How often the game may autosave, in wall milliseconds. */
export const AUTOSAVE_INTERVAL_MS = 30000;

/**
 * Resolves the storage backend.
 *
 * Accepts an injected adapter so tests can simulate quota errors and disabled
 * storage without a browser. Returns null when no storage is usable.
 */
function resolveStorage(injected) {
  if (injected) return injected;
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch {
    // Accessing localStorage can throw outright when storage is disabled.
    return null;
  }
}

/** Every storage read goes through here so a throw cannot escape. */
function read(storage, key) {
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch (e) {
    return { ok: false, error: `storage read failed: ${e.message}` };
  }
}

/** Every storage write goes through here so quota errors are reported. */
function write(storage, key, text) {
  try {
    storage.setItem(key, text);
    return { ok: true };
  } catch (e) {
    const quota = /quota|exceeded/i.test(e.name ?? '') || /quota|exceeded/i.test(e.message ?? '');
    return {
      ok: false,
      error: quota
        ? 'browser storage is full — export your city to a file and remove old saves'
        : `storage write failed: ${e.message}`,
      quota,
    };
  }
}

function remove(storage, key) {
  try {
    storage.removeItem(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `storage delete failed: ${e.message}` };
  }
}

// ------------------------------------------------------------------ save ---

/**
 * Serializes and stores the world.
 *
 * Before overwriting the manual slot, its current contents are copied to the
 * backup slot, so a bad save is always recoverable.
 *
 * @returns {{ok:true, key:string} | {ok:false, error:string}}
 */
export function saveGame(world, { key = SAVE_KEY, storage: injected, backup = true } = {}) {
  const storage = resolveStorage(injected);
  if (!storage) return { ok: false, error: 'browser storage is unavailable' };

  let text;
  try {
    text = JSON.stringify(serializeWorld(world));
  } catch (e) {
    return { ok: false, error: `could not serialize the city: ${e.message}` };
  }

  if (backup) {
    const existing = read(storage, key);
    if (existing.ok && existing.value) {
      // Best effort: failing to back up must not block the save.
      write(storage, BACKUP_KEY, existing.value);
    }
  }

  const written = write(storage, key, text);
  if (!written.ok) return { ok: false, error: written.error };
  return { ok: true, key };
}

/** Saves to the autosave slot only, never touching the manual save. */
export function autosave(world, options = {}) {
  return saveGame(world, { ...options, key: AUTOSAVE_KEY, backup: false });
}

// ------------------------------------------------------------------ load ---

/**
 * Loads a slot and returns a hydrated world.
 *
 * Structured result: a caller can distinguish "nothing saved" from "saved but
 * corrupt", which the v1 `null` return could not express.
 *
 * @returns {{ok:true, world:object, warnings:string[], source:string}
 *          | {ok:false, error:string, empty?:boolean}}
 */
export function loadGame({ key = SAVE_KEY, storage: injected, hooks } = {}) {
  const storage = resolveStorage(injected);
  if (!storage) return { ok: false, error: 'browser storage is unavailable' };

  const got = read(storage, key);
  if (!got.ok) return { ok: false, error: got.error };
  if (!got.value) return { ok: false, error: 'no save found', empty: true };

  const verdict = validateSnapshot(got.value);
  if (!verdict.ok) {
    return { ok: false, error: `save is not usable: ${verdict.errors.join('; ')}` };
  }

  try {
    const world = hydrateWorld(verdict.data, hooks);
    return { ok: true, world, warnings: verdict.warnings, source: key };
  } catch (e) {
    return { ok: false, error: `save could not be restored: ${e.message}` };
  }
}

/** True when a slot exists AND parses. Never throws. */
export function hasSave({ key = SAVE_KEY, storage: injected } = {}) {
  const storage = resolveStorage(injected);
  if (!storage) return false;
  const got = read(storage, key);
  if (!got.ok || !got.value) return false;
  return validateSnapshot(got.value).ok;
}

/** True when a valid backup exists, i.e. recovery is possible. */
export function hasRecoverableBackup({ storage: injected } = {}) {
  const storage = resolveStorage(injected);
  if (!storage) return false;
  const got = read(storage, BACKUP_KEY);
  if (!got.ok || !got.value) return false;
  return validateSnapshot(got.value).ok;
}

/** Restores the backup into the manual slot and loads it. */
export function recoverFromBackup({ storage: injected, hooks } = {}) {
  const storage = resolveStorage(injected);
  if (!storage) return { ok: false, error: 'browser storage is unavailable' };

  const got = read(storage, BACKUP_KEY);
  if (!got.ok) return { ok: false, error: got.error };
  if (!got.value) return { ok: false, error: 'no backup available' };

  const verdict = validateSnapshot(got.value);
  if (!verdict.ok) {
    return { ok: false, error: `backup is not usable: ${verdict.errors.join('; ')}` };
  }

  try {
    const world = hydrateWorld(verdict.data, hooks);
    write(storage, SAVE_KEY, got.value);
    return { ok: true, world, warnings: verdict.warnings, source: BACKUP_KEY };
  } catch (e) {
    return { ok: false, error: `backup could not be restored: ${e.message}` };
  }
}

/** Deletes every slot. Used by tests and an explicit "clear saves" action. */
export function clearSaves({ storage: injected } = {}) {
  const storage = resolveStorage(injected);
  if (!storage) return { ok: false, error: 'browser storage is unavailable' };
  for (const key of [SAVE_KEY, AUTOSAVE_KEY, BACKUP_KEY]) remove(storage, key);
  return { ok: true };
}

// ------------------------------------------------------------- import/export ---

/** Serialized text for a file download. */
export function exportGame(world) {
  return JSON.stringify(serializeWorld(world), null, 2);
}

/**
 * Validates imported text and hydrates it WITHOUT touching the current world.
 *
 * The caller decides whether to adopt the result, so a bad import cannot destroy
 * a city in progress.
 */
export function importGame(text, hooks) {
  const verdict = validateSnapshot(text);
  if (!verdict.ok) {
    return { ok: false, error: `import is not usable: ${verdict.errors.join('; ')}` };
  }
  try {
    const world = hydrateWorld(verdict.data, hooks);
    return { ok: true, world, warnings: verdict.warnings };
  } catch (e) {
    return { ok: false, error: `import could not be restored: ${e.message}` };
  }
}

/** Filename for an exported city, so exports are distinguishable by date. */
export function exportFilename(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `roadflow-city-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

export { SNAPSHOT_VERSION };
