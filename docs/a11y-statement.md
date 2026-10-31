# Accessibility statement — Roadflow (honest scope)

**Not claimed:** full WCAG conformance from an automated audit alone.

**What works today:**

- Full keyboard walkthrough: new city, road/building tools (1-0), inspect,
  signal edit, undo (Ctrl+Z) / redo, save/import, scenario start — no focus
  traps; dialogs own the keyboard while open and release it on close.
- Every control has an accessible name (`aria-label`); toggles expose state
  (`aria-pressed`, `aria-expanded`); the inspector is `role=complementary`;
  menus are `role=menu`. Canvas itself is not keyboard-navigable per-pixel:
  use the Construction Cursor (arrow keys) when a draft is open.
- Textual selected-object and objective state sit adjacent to the canvas
  (inspector panel + HUD band), not colour-only.
- Overlays pair colour with labels, line thickness and hatch; tones are
  colour-vision-safe pairs (reachable/unreachable, band levels).
- Settings: separate master/SFX volume, mute, UI scale 90-150%, reduced
  motion. Persisted separately; reset-to-defaults never clears saves.
- Contrast: text meets 4.5:1 on panels; canvas game colours are exempt
  (gameplay, not text) but never the sole channel for state.

**Known limits:**

- Canvas map needs pointer or cursor keys; screen-reader users get the
  inspector/HUD text but not a full spatial model.
- Safari/WebKit untested in this environment (Chromium + Firefox matrix
  only); unsupported browsers are stated, not silently supported.
- No localization yet: one English message map (`src/a11y.js`), no dynamic
  HTML interpolation; long-string clipping tested via pseudo-locale in unit
  tests, not shipped languages.
