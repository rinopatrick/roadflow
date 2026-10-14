// UI helpers — toasts, inspect panel.
import { icon } from './icons.js';
import { ui } from './ui/controller.js';

/**
 * Opens a panel, or closes whichever one is open when passed null.
 *
 * Panels are exclusive — the menu and the inspector cannot both be open — so
 * there is one value to keep consistent instead of two booleans that can drift.
 */
export function showPanel(name) {
  if (name !== 'inspect') document.getElementById('inspect').classList.remove('open');
  ui.set({ openPanel: name });
}

export function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 2600);
  setTimeout(() => el.remove(), 3100);
  while (box.children.length > 4) box.firstChild.remove();
}

export function openInspect(title, bodyHTML, onChange, iconId = null) {
  const panel = document.getElementById('inspect');
  const heading = document.getElementById('insTitle');
  // The icon is trusted markup from icons.js; the title is inserted as text so
  // a label can never become markup.
  heading.innerHTML = iconId ? icon(iconId) : '';
  heading.appendChild(document.createTextNode(title));
  const body = document.getElementById('insBody');
  body.innerHTML = bodyHTML;
  panel.classList.add('open');
  ui.set({ openPanel: 'inspect' });
  if (onChange) {
    body.querySelectorAll('input[type=range]').forEach(inp => {
      inp.addEventListener('input', () => onChange(inp.dataset.key, parseFloat(inp.value)));
    });
  }
}

export function closeInspect() {
  showPanel(null);
}

export function inspectOpen() {
  return ui.openPanel === 'inspect';
}
