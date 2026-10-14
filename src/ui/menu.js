// Speed control, the menu popover and the help dialog.
//
// This module owns the controls, not the consequences: every action arrives as
// an injected handler, so nothing here reaches into the world, the save layer
// or the renderer. Both the popover and the help dialog derive their visibility
// from the controller, which is the single owner of `openPanel` and `dialog`.
import { ui } from './controller.js';
import { showPanel } from '../ui.js';

/**
 * @param {{onSpeed: (s: number) => void, onSave: () => void, onLoad: () => void,
 *          onRecover: () => void, onNewMap: () => void}} handlers
 */
export function initMenu(handlers) {
  const menuBtn = document.getElementById('menubtn');
  const popover = document.getElementById('menupop');
  const help = document.getElementById('help');
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

  const item = (id, fn) => document.getElementById(id).addEventListener('click', () => {
    showPanel(null);
    fn();
  });
  item('btnSave', handlers.onSave);
  item('btnLoad', handlers.onLoad);
  item('btnRecover', handlers.onRecover);
  item('btnNew', handlers.onNewMap);
  item('btnHelp', openHelp);

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
  };
}

export function openHelp() { ui.set({ dialog: 'help' }); }
export function closeHelp() { ui.set({ dialog: null }); }
