// Speed control, the sound toggle, the menu popover and the help dialog.
//
// This module owns the controls, not the consequences: every action arrives as
// an injected handler, so nothing here reaches into the world, the save layer
// or the renderer. Both the popover and the help dialog derive their visibility
// from the controller, which is the single owner of `openPanel` and `dialog`.
import { ui } from './controller.js';
import { showPanel } from '../ui.js';
import { icon } from '../icons.js';

/**
 * @param {{onSpeed: (s: number) => void, onSound: (enabled: boolean) => void,
 *          onSave: () => void, onLoad: () => void, onExport: () => void,
 *          onImport: (text: string, filename: string) => void,
 *          onRecover: () => void, onNewMap: () => void,
 *          isSoundEnabled: () => boolean}} handlers
 */
export function initMenu(handlers) {
  const menuBtn = document.getElementById('menubtn');
  const popover = document.getElementById('menupop');
  const soundBtn = document.getElementById('soundbtn');
  const help = document.getElementById('help');
  const importInput = document.getElementById('importfile');
  const speedButtons = [...document.querySelectorAll('.spd-btn')];

  const sync = (state) => {
    const open = state.openPanel === 'menu';
    popover.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    help.classList.toggle('open', state.dialog === 'help');
  };
  ui.subscribe(sync);
  sync(ui.snapshot());

  menuBtn.addEventListener('click', () => showPanel(ui.openPanel === 'menu' ? null : 'menu'));

  speedButtons.forEach(btn => btn.addEventListener('click', () => {
    handlers.onSpeed(parseFloat(btn.dataset.speed));
  }));

  // Sound: a real toggle with a visible state, so "muted" is never something
  // the player has to guess from the absence of noise.
  function applySound(enabled) {
    soundBtn.setAttribute('aria-pressed', String(enabled));
    soundBtn.innerHTML = icon(enabled ? 'sound' : 'mute');
    soundBtn.setAttribute('aria-label', enabled ? 'Sound on' : 'Sound off');
    soundBtn.title = enabled ? 'Sound on — click to mute' : 'Sound off — click to unmute';
  }
  applySound(handlers.isSoundEnabled());
  soundBtn.addEventListener('click', () => {
    const next = soundBtn.getAttribute('aria-pressed') !== 'true';
    handlers.onSound(next);
    applySound(next);
  });

  const item = (id, fn) => document.getElementById(id).addEventListener('click', () => {
    showPanel(null);
    fn();
  });
  item('btnSave', handlers.onSave);
  item('btnLoad', handlers.onLoad);
  item('btnExport', handlers.onExport);
  item('btnRecover', handlers.onRecover);
  item('btnNew', handlers.onNewMap);
  item('btnHelp', openHelp);
  item('btnImport', () => importInput.click());

  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch (err) {
      handlers.onImport('', file.name);
      return;
    }
    handlers.onImport(text, file.name);
    // Reset so choosing the same file twice fires again.
    importInput.value = '';
  });

  // Clicking away closes the popover, the way a menu is expected to behave.
  document.addEventListener('pointerdown', (e) => {
    if (ui.openPanel !== 'menu') return;
    if (popover.contains(e.target) || menuBtn.contains(e.target)) return;
    showPanel(null);
  });

  // Clicking the backdrop of the modal closes it.
  help.addEventListener('click', (e) => { if (e.target === help) closeHelp(); });
  document.getElementById('helpClose').addEventListener('click', closeHelp);

  return {
    /** Reflects the authoritative speed without owning it. */
    applySpeed(speed) {
      speedButtons.forEach(b => b.classList.toggle('active', parseFloat(b.dataset.speed) === speed));
    },
    applySound,
  };
}

export function openHelp() { ui.set({ dialog: 'help' }); }
export function closeHelp() { ui.set({ dialog: null }); }
