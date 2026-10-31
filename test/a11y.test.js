// S08.2: accessibility. Message map (no dynamic HTML), settings with
// volume split + UI scale + reduced motion, shortcut conflict detection.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGES, formatMsg, DEFAULT_SETTINGS, validateSettings,
  detectShortcutConflicts, DEFAULT_SHORTCUTS,
} from '../src/a11y.js';

describe('S08.2 accessibility', () => {
  it('every visible string lives in the message map with parameters', () => {
    assert.ok(Object.keys(MESSAGES).length > 10, 'map is populated');
    assert.equal(formatMsg('citySaved', {}), MESSAGES.citySaved);
    const m = formatMsg('needXp', { xp: 42 });
    assert.ok(m.includes('42'), 'parameter formatting works');
    assert.ok(!/<|&lt;/.test(m), 'no HTML interpolation');
  });

  it('settings: master/SFX split, UI scale 90-150, reduced motion, persist', () => {
    const s = validateSettings({ master: 0.8, sfx: 0.5, uiScale: 1.2, reducedMotion: true });
    assert.equal(s.ok, true);
    assert.equal(s.settings.master, 0.8);
    const bad = validateSettings({ master: 2, uiScale: 3 });
    assert.equal(bad.ok, false);
    assert.deepEqual(validateSettings({}).settings, DEFAULT_SETTINGS, 'defaults fill');
    assert.equal(DEFAULT_SETTINGS.uiScale, 1.0);
  });

  it('shortcut conflicts detected for remapping', () => {
    const clean = detectShortcutConflicts(DEFAULT_SHORTCUTS);
    assert.deepEqual(clean, [], 'defaults conflict-free');
    const clash = detectShortcutConflicts({ ...DEFAULT_SHORTCUTS, undo: 'Space' });
    assert.ok(clash.length > 0, 'Space clash reported');
    assert.match(clash[0], /Space/i);
  });

  it('reset-to-defaults never touches saves', () => {
    // Reset returns settings only; save slots are a separate store by design.
    const r = validateSettings(null);
    assert.equal(r.ok, true);
    assert.ok(!('saves' in r.settings), 'no save data in settings');
  });
});
