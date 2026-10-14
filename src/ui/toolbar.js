// The bottom dock: five categories, each opening its own row of tools.
//
// DESIGN section 1: "Main categories are buttons with persistent icon + visible
// text. Active tool has accent border/fill and aria-pressed. Preserve numeric
// shortcuts 1-0 for the original tools even when grouped."
//
// So the ten tools stay in the DOM in declaration order — which is also the
// shortcut order — and only the active category's row is visible. Nothing is
// removed from the DOM when a category closes, so data-tool, the shortcut keys
// and every existing test keep addressing the same buttons.
import { ui } from './controller.js';
import { icon } from '../icons.js';

/** The five main categories, in DESIGN order. */
export const CATEGORIES = [
  { id: 'select', label: 'Select', icon: 'select' },
  { id: 'roads', label: 'Roads', icon: 'road' },
  { id: 'junctions', label: 'Junctions', icon: 'roundabout' },
  { id: 'buildings', label: 'Buildings', icon: 'house' },
  { id: 'demolish', label: 'Demolish', icon: 'bulldoze' },
];

/**
 * The ten original tools. `key` is the 1-0 shortcut; `category` is the dock
 * group that owns the tool; `hint` is the context-help line shown above the dock.
 */
export const TOOLS = [
  { id: 'road', icon: 'road', label: 'Road', key: '1', category: 'roads', hint: 'click to set points, Enter to finish' },
  { id: 'avenue', icon: 'avenue', label: 'Avenue', key: '2', category: 'roads', hint: 'click to set points, Enter to finish' },
  { id: 'highway', icon: 'highway', label: 'Highway', key: '3', category: 'roads', hint: 'click to set points, Enter to finish' },
  { id: 'roundabout', icon: 'roundabout', label: 'Roundabout', key: '4', category: 'junctions', hint: 'click a junction to convert it' },
  { id: 'light', icon: 'light', label: 'Traffic light', key: '5', category: 'junctions', hint: 'click a junction, then inspect it to tune the phases' },
  { id: 'house', icon: 'house', label: 'House', key: '6', category: 'buildings', hint: 'place on buildable land near a road' },
  { id: 'shop', icon: 'shop', label: 'Shop', key: '7', category: 'buildings', hint: 'place on buildable land near a road' },
  { id: 'factory', icon: 'factory', label: 'Factory', key: '8', category: 'buildings', hint: 'place on buildable land near a road' },
  { id: 'bulldoze', icon: 'bulldoze', label: 'Bulldoze', key: '9', category: 'demolish', hint: 'click a building or junction to remove it' },
  { id: 'select', icon: 'select', label: 'Select', key: '0', category: 'select', hint: 'click anything on the map to inspect it' },
];

/** The category that owns a tool, or null for an unknown id. */
export function categoryOf(toolId) {
  return TOOLS.find(t => t.id === toolId)?.category ?? null;
}

/**
 * Builds the dock and keeps it in sync with the controller.
 * Returns nothing: the controller is the only way to change what is selected.
 */
export function buildToolbar() {
  const catBar = document.getElementById('categories');
  const subBar = document.getElementById('subtools');
  catBar.innerHTML = '';
  subBar.innerHTML = '';

  for (const c of CATEGORIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cat-btn';
    btn.dataset.category = c.id;
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = `${icon(c.icon)}<span class="label">${c.label}</span>`;
    btn.addEventListener('click', () => openCategory(c.id));
    catBar.appendChild(btn);
  }

  for (const t of TOOLS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool-btn';
    btn.dataset.tool = t.id;
    // The owning category, so a test can open it without duplicating the map.
    // Deliberately NOT `data-category`: that belongs to the five category
    // buttons, and sharing it would make every `[data-category="..."]`
    // selector ambiguous.
    btn.dataset.toolCategory = t.category;
    btn.setAttribute('aria-pressed', 'false');
    const isBuilding = t.id === 'house' || t.id === 'shop' || t.id === 'factory';
    // Visible text plus a decorative icon; the accessible name is the label and
    // the stock count, never the glyph.
    btn.innerHTML = `${icon(t.icon)}<span class="label">${t.label}</span>${isBuilding ? `<span class="tool-count" id="badge_${t.id}">0</span>` : ''}`;
    btn.title = `${t.label} (${t.key})`;
    btn.addEventListener('click', () => setTool(t.id));
    subBar.appendChild(btn);
  }

  ui.subscribe(render);
  render(ui.snapshot());
}

/** Opens a category without changing the active tool. */
export function openCategory(id) {
  if (!CATEGORIES.some(c => c.id === id)) return;
  ui.set({ openCategory: id });
}

/** Selects a tool and reveals the category that owns it. */
export function setTool(id) {
  const category = categoryOf(id);
  if (!category) return;
  ui.set({ activeTool: id, openCategory: category });
}

function render(state) {
  for (const btn of document.querySelectorAll('[data-category]')) {
    const open = btn.dataset.category === state.openCategory;
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  }

  for (const btn of document.querySelectorAll('[data-tool]')) {
    btn.hidden = btn.dataset.toolCategory !== state.openCategory;
    const active = btn.dataset.tool === state.activeTool;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }

  const tool = TOOLS.find(t => t.id === state.activeTool);
  document.getElementById('ctxhelp').textContent =
    tool ? `${tool.label} — ${tool.hint}  (${tool.key})` : '';
}
