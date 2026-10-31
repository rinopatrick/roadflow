// Inline SVG icon map — the only icon source in the project (no icon
// dependency, no emoji control, no external sprite).
//
// Contract (DESIGN §2): 24x24 viewBox, displayed at 20px, stroke 1.5,
// `currentColor`, rounded joins, decorative `aria-hidden`. A control's
// accessible name comes from its own text or aria-label, never from the icon.
//
// Road classes are distinguished by lane strokes, not by three unrelated
// glyphs: street draws one (dashed median), avenue two, highway three, and the
// pavement band grows with the class. It is a hierarchy cue, not a scale
// drawing.
const ROOT_ATTRS = 'viewBox="0 0 24 24" width="20" height="20" fill="none"'
  + ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round"'
  + ' stroke-linejoin="round" aria-hidden="true" focusable="false"';

const MEDIAN = '<path d="M4 12h16" stroke-dasharray="3 2.5"/>';

export const ICONS = {
  // ---- construction tools ----
  select: '<path d="M6 3.5v15l3.9-3.7 2.7 5.6 2.3-1.1-2.6-5.4h5.3z"/>',
  road: `<rect x="2" y="9" width="20" height="6" rx="1.5"/>${MEDIAN}`,
  avenue: '<rect x="2" y="7.5" width="20" height="9" rx="1.5"/><path d="M4 10.5h16M4 13.5h16"/>',
  highway: `<rect x="2" y="6" width="20" height="12" rx="1.5"/><path d="M4 9h16M4 15h16"/>${MEDIAN}`,
  roundabout: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3"/>'
    + '<path d="M14.6 4.8l2.2 1.4-2.2 1.4"/>',
  light: '<rect x="8.5" y="3" width="7" height="15" rx="2"/><path d="M12 18v3"/>'
    + '<circle cx="12" cy="6.5" r="1"/><circle cx="12" cy="10.5" r="1"/><circle cx="12" cy="14.5" r="1"/>',
  house: '<path d="M3.5 11.5L12 4.5l8.5 7"/><path d="M5.5 10.5v9h13v-9"/>'
    + '<path d="M10 19.5v-4.5h4v4.5"/>',
  shop: '<path d="M4 9.5h16v10H4z"/><path d="M3 9.5l1.5-4h15l1.5 4"/>'
    + '<path d="M9.5 19.5v-5h5v5"/>',
  factory: '<path d="M3 19.5V11l5 3v-3l5 3v-3l5 3v5.5z"/><path d="M17.5 11V4.5h3V11"/>',
  bulldoze: '<path d="M12 3.5v8"/><path d="M8.5 8L12 11.5 15.5 8"/>'
    + '<path d="M4.5 19.5h15"/><path d="M6.5 19.5v-3.5h11v3.5"/>',

  // ---- chrome ----
  save: '<path d="M12 3.5v10"/><path d="M8 9.5l4 4 4-4"/><path d="M4.5 16v4h15v-4"/>',
  load: '<path d="M12 13.5v-10"/><path d="M8 7.5l4-4 4 4"/><path d="M4.5 16v4h15v-4"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  undo: '<path d="M9 7L4.5 11.5L9 16"/><path d="M4.5 11.5H14a5.5 5.5 0 0 1 0 11h-3"/>',
  redo: '<path d="M15 7l4.5 4.5L15 16"/><path d="M19.5 11.5H10a5.5 5.5 0 0 0 0 11h3"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'
    + '<rect x="9" y="9" width="6" height="6" rx="1"/>',
  layers: '<path d="M12 3.5l8.5 4.5-8.5 4.5-8.5-4.5z"/><path d="M3.5 12.5L12 17l8.5-4.5"/>',
  traffic: '<path d="M4 8h9a3 3 0 0 1 0 6H8"/><path d="M10.5 11L8 14l2.5 3"/><path d="M17 6v12"/>',
  access: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/>'
    + '<path d="M8.2 10.8L15.8 7.2M8.2 13.2l7.6 3.6"/>',
  sound: '<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/>'
    + '<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18 7a7 7 0 0 1 0 10"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/><path d="M16 9.5l4 5M20 9.5l-4 5"/>',
  exportFile: '<path d="M12 3.5v10"/><path d="M8 9.5l4 4 4-4"/><path d="M4.5 16v4h15v-4"/>',
  importFile: '<path d="M12 13.5v-10"/><path d="M8 7.5l4-4 4 4"/><path d="M4.5 16v4h15v-4"/>',
  help: '<circle cx="12" cy="12" r="8.5"/>'
    + '<path d="M9.6 9.6a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.7"/><path d="M12 17v.01"/>',
  tunnel: '<path d="M4 16a8 6 0 0 1 16 0"/><path d="M4 16h16" stroke-dasharray="2 2"/>',
  air: '<path d="M4 10h12a3 3 0 0 1 0 6H7"/><path d="M7 14l-3 4M12 14l-2 4M17 14l-2 4"/>',
  noise: '<path d="M4 10v4h3l4 3V7l-4 3z"/><path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11"/>',
};

/** Ids the current UI must render (DESIGN §2), asserted by test/browser/ui.js. */
export const REQUIRED_ICON_IDS = [
  'select', 'road', 'avenue', 'highway', 'roundabout', 'light',
  'house', 'shop', 'factory', 'bulldoze', 'save', 'load',
  'close', 'help', 'menu',
  // DESIGN section 2 requires an icon for layers and for sound.
  'layers', 'sound', 'mute', 'fit', 'undo', 'redo',
];

/**
 * SVG markup for an icon id, or an empty string for an unknown id so a typo
 * degrades to a missing glyph instead of breaking the whole UI.
 */
export function icon(id, className = 'icon') {
  const body = ICONS[id];
  if (!body) return '';
  return `<svg class="${className}" ${ROOT_ATTRS}>${body}</svg>`;
}

/**
 * Renders every element that declares `data-icon` (static markup keeps its
 * visible text; icon-only controls carry an aria-label).
 */
export function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (el.querySelector('svg')) return;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  });
}
