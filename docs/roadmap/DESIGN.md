# Roadflow visual and interaction specification

**Proposed direction:** an original, precise transport atlas with a warm physical-map surface. Treat Trafficity as a readability reference, not a template to trace. User already preferred inline monochrome SVG icons. Visual implementation begins in S02 and requires human screenshot approval before advanced features.

## 1. Layout contract

Desktop baseline: 1440×900 CSS pixels; also test 1280×800 and 1920×1080 at DPR 1 and 2. Compact desktop: 1024×768. At 768×1024 allow collapsed panels; phone play is not claimed in the core scope.

```
┌──────────────────────────────────────────────────────────────────┐
│ ROADFLOW / City name       Population   Served/min   Level         │
│                     compact status band        Pause 1× 3× 8× ☰ │
│                                                                  │
│ Layers                                                      ┌───┐│
│ Traffic / Access / Air / Noise                    selection │   ││
│                                                   inspector │   ││
│                  LARGE UNOBSTRUCTED MAP                      │   ││
│                                                             └───┘│
│                  contextual options, only for active tool         │
│       [ Select ][ Roads ][ Junctions ][ Buildings ][ Demolish ]    │
│  Click to start · Enter to finish · Esc cancel      Zoom − Fit +  │
└──────────────────────────────────────────────────────────────────┘
```

- Top status band height 56 px, exterior gap 16 px. Use a single grouped surface rather than separate floating pills for every action.
- Bottom main tool dock max width 760 px, height 64 px, 16 px safe margin. Categories open a compact second row, not a ten-button strip spanning the window.
- Main categories are buttons with persistent icon + visible text. Active tool has accent border/fill and `aria-pressed`. Preserve numeric shortcuts 1–0 for the original tools even when grouped.
- Inspector width 296 px, anchored right below the top band; maximum height viewport minus 160 px, internal vertical scroll. It does not cover the dock. Below 1100 px width it collapses by default and opens as a dismissible sheet.
- Context help above dock shows the current action and invalid reason. Put essential failures there; toast is supplemental, never the only explanation.
- Menu groups Save/Load/Import/Export/Settings/New city. New city requires confirmation when dirty. Shortcuts not accepted while a modal is open or text/control field has focus.
- Layer controls have labels and legend. Traffic overlay is colour + line thickness + numbers, not red/green alone. One analytic overlay active at a time; selection routes can coexist.
- No inert future buttons. A tool may be locked only if the UI explains the prerequisite and an implemented unlock exists.

## 2. Token defaults

S02.1 creates `src/ui.css` and `src/uiTokens.js` (canvas-facing semantic colours only). Do not make CSS and JS duplicate arbitrary full palettes; document corresponding semantic names and verify the handful of shared values.

```css
:root {
  --surface: #fbfaf6;
  --surface-raised: #ffffff;
  --ink: #222a2b;
  --muted: #596465;
  --line: #c9cfcb;
  --accent: #146b68;
  --accent-soft: #e2efea;
  --warning: #8a5108;
  --danger: #a33036;
  --focus: #096ca9;
  --radius-sm: 6px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
}
```

Use the installed system font stack first; optional self-hosted licensed font only after approval. UI base 14 px, label 12 px, section 16 px, major value 20 px. Body line-height 1.4, tabular numbers for statistics. Avoid uppercase microtext for ordinary instructions. Target 4.5:1 text contrast and 3:1 controls/focus; measure, do not infer from hex choices. Disabled state still legible and explanatory.

SVG icons: 24×24 viewBox, displayed 20 px, stroke 1.5, `currentColor`, rounded joins, decorative `aria-hidden=true`. Button accessible name comes from text. Distinguish road presets by number of lane strokes, not three unrelated emoji. Icons required for select, road, avenue, highway, roundabout, signals, house, shop, factory, demolition, layers, save, load, sound, zoom and undo. Reuse a minimal local icon map, no icon dependency.

Controls minimum 40×40 px (44×44 for primary controls), focus ring 2 px with 2 px offset; sliders get text label, output value and numeric input. Animations 100–160 ms; disable nonessential motion with `prefers-reduced-motion`. Sound optional, with visible mute state and no audio before user gesture.

## 3. Road and city art rules

Fix lane geometry in S01 before styling it.

- Road surface warm near-white, outline subdued dark grey, narrow amber centre division, neutral dashed lane lines. Highway uses slightly stronger casing, never a giant black slab.
- Width and lane markings follow `roadDimensions`, not hand-tuned class widths in the renderer.
- Paint lanes continuously through normal segments, trim at junction mouths, draw turn arrows only near their relevant approach and at sufficient zoom.
- Junction visual fill uses actual connected footprint. Hide internal seam/casing strokes; do not merely paint a circular disk over every junction at every scale.
- Bridges have coherent elevation shadow, edge parapet and occlusion. Tunnel portals are distinct; underground alignment visible only when selected or underground layer enabled.
- Stop line colour and displayed signal match `signals.js`; renderer never independently computes green timing.
- House: roof ridge + small yard silhouette. Shop: flat roof + awning/entry apron. Factory: longer roof bays + vents/chimneys + loading side. Three deterministic visual variants per type, no copied sprites.
- Building orientation aligns with driveway/nearest road tangent. Variants and shading are seeded from stable building ID, not re-randomized during draw.
- Driveways show plausible access; do not draw hundreds-of-units spindles without telling the player about the access distance. Local access target <=120 wu for new buildings; preserve older placements and show warnings.
- Parking detail decorative at R1; never imply a simulated capacity until S06 defines it. One shadow direction across all geometry, e.g. screen (+3,+4) wu; physical height scaled consistently.
- Vehicle movement is the focal detail: smooth position/heading, readable head/tail direction, brake lights at appropriate zoom. Trucks and buses later differ in shape/length, not only colour.

## 4. Terrain and camera

Current 1024 texture over a 6400-wu square becomes blurry at close zoom. S02.4 replaces the single-scale presentation with cached terrain chunks/contours appropriate to zoom; retain terrain.sample as buildability authority.

- Distinct readable water, bank, buildable ground, forest decoration, and non-buildable rock. Decorative trees must not suggest collision rules that do not exist.
- Subtle shoreline contour, no noisy per-pixel texture as the main aesthetic. Keep roads highest local contrast.
- Starter camera frames a buildable area plus one recognizable geographic feature. Do not assume origin is a good spawn for every seed. Search deterministically for a buildable rectangle and show a bounded fallback.
- Fit-city button frames building/road bounds plus margin, excluding remote unused terrain. Zoom at pointer keeps world anchor stable; presets cannot make buildings unselectable.
- At zoom <0.35: simplified building footprints and road hierarchy; hide tiny marks, trees and text. At 0.35–1.5: normal detail. Above 1.5: curb, roof and junction editing details. Do not inflate every feature to a fixed screen size; only interaction handles/icons have screen-space minimums.
- Camera pan bounded to meaningful map extents plus 15% margin. On resize clamp HUD, not world camera unexpectedly.

## 5. Feedback and state completeness

For every tool, verify idle, hover, active, valid preview, invalid preview, success, cancellation, unavailable inventory, occupied location and stale selection states.

Road preview includes length, road type, snap marker, elevation and invalid segments. Before optional budgets exist, show length only, not fictional currency/cost. Building preview evaluates terrain, road access, overlap and stock with the exact commit validator. It must not show valid cyan when placement will fail.

Selection:
- Road: lanes/directions, speed, queue count, throughput, edit actions.
- Junction: permitted turns, signal phase diagram, conflicts and queues.
- Building: access, employees/customers/goods/environment as implemented, reason for failed needs.
- Vehicle: origin, destination, purpose, wait reason, current path; read-only until an actual edit action exists.

For R1, show only fields actually computed by core simulation. Add deeper fields with their owning tasks, not mock values.

## 6. Guided start

Do not open a wall of text on every fresh launch. Present Play tutorial / Sandbox / Continue when available. Tutorial should guide, then release control:

1. Pan and zoom once; show Fit button.
2. Draw one street, Enter to finish.
3. Place home and shop in valid access zones.
4. Watch a trip arrive, then explain XP and unmet work access.
5. Add workplace, inspect a building, save.
6. Demonstrate undo only after S03.1 exists; until then omit the tutorial step.

Progress triggered by actual game state/event, not by clicking Next. Can skip, replay and use keyboard. Tutorial pauses demand until enough connected destinations exist. Background game is inert during menu/dialog interaction, not invisible click-through.

## 7. Visual acceptance rubric

Capture identical fixture, viewport, DPR and camera before/after. Human review scores 0–2 per item:

1. Road/lane geometry coherent.
2. Junctions and grade separation readable.
3. Building classes recognizable without colour alone.
4. UI hierarchy clear; map remains primary.
5. No clipped text, overlapping controls or unscrollable panel.
6. Active/hover/disabled/focus states consistent.
7. Text and controls pass contrast/size checks.
8. Invalid actions explain actual reason.
9. Traffic motion readable at normal zoom.
10. Original style consistent across map, panels and icons.

R1 gate: >=16/20, no zero for items 1, 5, 7 or 8, and operator approval of desktop and compact screenshots. Automated pixel diffs detect change, not taste; do not auto-approve new goldens. “Looks cleaner” without artifacts is not acceptance.
