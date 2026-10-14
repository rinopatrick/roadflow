// Canvas-facing semantic colours, shared with src/ui.css.
//
// The canvas cannot read CSS custom properties, so the handful of colours that
// must look identical in the DOM UI and on the map are declared in both places.
// ui.css owns the full token set; this module declares only what the renderer
// draws, and test/browser/ui.js asserts every entry below equals the matching
// custom property, so the two can never drift apart silently.
//
//   accent        -> --accent          valid preview, snap ring, connect affordance
//   danger        -> --danger          invalid preview, error label
//   ink           -> --ink             default canvas label text
//   muted         -> --muted           secondary canvas label text
//   surfaceRaised -> --surface-raised  canvas badge / pill background
//
// Deliberately NOT shared: --warning and the renderer's selection green are
// map-only highlights whose contrast is judged against the terrain, not against
// a UI surface. The render colour pass is S02.3.
export const UI_TOKENS = {
  accent: '#146b68',
  danger: '#a33036',
  ink: '#222a2b',
  muted: '#596465',
  surfaceRaised: '#ffffff',
};

/** rgba() form of a hex token, for translucent canvas fills. */
export function alpha(hex, a) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
