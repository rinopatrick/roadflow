# Stage 02 — A coherent, usable game

Read DESIGN.md in full. This is the first major player-visible milestone. Do not add late-stage feature buttons or invented data. All new UI behavior needs state and keyboard tests. S02 tasks may alter index.html and focused extracted UI code; do not rewrite simulation.

## S02.1 — Establish original design tokens and icons

**Depends:** S01.7. **Read:** index.html, main.js TOOLS/buildToolbar, ui.js, DESIGN.md. **Modify:** index.html, main.js toolbar markup, ui.js. **Create:** src/ui.css, src/icons.js, src/uiTokens.js, test/browser/ui.js.

1. Capture before-state at 1440×900 and1024×768. Move existing CSS into ui.css without changing behavior first; verify browser smoke.
2. Apply token scale, typography, consistent radius, shadow and focus treatment from DESIGN. Avoid backdrop blur on every button; one quiet surface per group.
3. Create inline SVG icon map. All tool buttons retain visible text and stable data-tool values. SVG is aria-hidden; accessible name not emoji. Test every icon string has a viewBox and no scripts/external references.
4. Replace toolbar/inspect emoji gradually in this task; leave building gameplay data unchanged. Remove hidden batch DOM only after searching all callers and migrating test/logic reads to real inventory badges; updateBatchUI has one stock source.
5. Add focus-visible, reduced-motion and disabled states. Screen capture all original tools active/hover/focus at compact and desktop viewports.

**Verify:** npm test; npm run test:browser; UI has no emoji-dependent control, keyboard focus visible, no missing inventory badge. **Approval:** human approves icon language and base tokens before S02.2; do not automatically accept screenshot differences.

## S02.2 — Restructure HUD, dock, menu and layers

**Depends:** S02.1. **Modify:** index.html, ui.css, main.js UI bindings/HUD; render overlay flags. **Create:** src/ui/hud.js, src/ui/toolbar.js, src/ui/menu.js only for extracted responsibilities; browser UI tests.

1. Implement DESIGN layout: grouped top status, compact categorical dock, contextual subtools, menu, right inspector. Preserve original tool shortcuts and button data attributes.
2. Define UI controller state `{activeTool,openCategory,openPanel,overlay,dialog}` in one location; do not let each component maintain conflicting active-tool copies. Simulation remains authoritative for stock/stats.
3. Provide Traffic and Pollution layer toggles with labelled legends wired to real renderer flags. Access layer can show currently reachable/unreachable buildings from existing graph; Noise appears only in S06.3.
4. Wire existing audio enable control and v2 Import/Export/Recovery flows. New map must not clear dirty city without confirmation. Speed labels are Pause/1×/3×/8×, not indistinguishable triangles.
5. Make inventory depletion discoverable: disabled choice gives reason and progression link; switching tools cannot consume inventory. Selection panel refreshes after deletion/load.
6. Add browser tests opening every menu/category, selecting every original tool, switching overlays, muting, export/import valid and invalid snapshot, compact inspector scroll. Verify no UI input reaches canvas underneath.

**Verify:** unit + browser; no offscreen action at1024×768; all buttons produce asserted state change. **Do not:** expose currency, noise, lane controls or buses before implementation.

## S02.3 — Make road/junction rendering truthful and readable

**Depends:** S02.2. **Read/modify:** render.js road/node/marking passes; profiles.js and signals.js are read-only unless a proven contract bug. **Create:** src/render/roads.js only if extracting road drawing reduces render.js without changing public Renderer API; visual fixture tests.

1. Use corrected dimension fixture from S01.3. Render casing/fill/markings in separate consistent passes; do not paint lane lines beyond pavement or through intersection centre.
2. Define junction mouth trim from connected widths and tangent directions. Keep no gap between pavement segments. Introduce conservative junction fill polygons if needed; do not use a giant circular disk for all geometries.
3. Check T,X,Y,acute intersections and one-way ring at zoom.25,1,3. At low zoom hide dashes rather than painting noisy hairlines. Stop-line colour and state consume signals.js.
4. Preserve lane geometry used by simulation. Road shadows use a single direction and do not imply nonexistent elevation.
5. Capture a 12-scene contact sheet: 3 road classes, T/X/Y/acute junction, roundabout, dense grid, curved road, car queue, invalid road draft. Inspect physically impossible overlaps and fix root geometry, not opacity.

**Verify:** all unit/browser tests; numeric lane containment; visual rubric no geometry zero. **Stop:** renderer would need private alternate road widths—repair profile contract first.

## S02.4 — Improve terrain, buildings and camera framing

**Depends:** S02.3. **Modify:** render.js terrain/building/camera code, main.js new/fit/zoom; terrain query remains authority. **Create:** src/render/terrain.js, src/render/buildings.js, test/camera.test.js, test/terrain-view.test.js.

1. Add worldToCss helper and round-trip camera tests at DPR1/2, zoom.12/1/5. Pointer-centred zoom holds anchor within0.1wu. Fit-city includes network/buildings+12% margin and minimum200wu span.
2. Deterministically search buildable starter regions on a200wu grid; choose nearest qualifying area to origin with >=80% buildable samples in600×400wu rectangle, tie by coordinates. Bounded fallback uses largest sampled buildable patch and explains restricted terrain.
3. Replace blurry single texture presentation with cached visible terrain chunks (e.g.512wu tiles with256px base raster,2× detail when zoom>1.5). Cache at most64 tiles, evict least recently used. Terrain sample/buildability unchanged. Record generation cost; no per-frame full-world generation.
4. Add shoreline and rock contour accents derived from terrain class boundaries. Decoration never changes path validity. Stable seeded vegetation, lower detail at low zoom.
5. Draw three silhouette variants each for house/shop/factory; orient entry to access node, retain geometry size. Factory larger roof bays, shop awning, home ridge/yard. Draw consistent shadows and driveway anchors.
6. Test variant stability after save/load; no sim RNG consumed by drawing; run same tick sequence with/without rendering and compare simulation state.

**Verify:** all tests; seeds1,7,42 at desktop/compact/DPR2; no blurred giant pixels at zoom3; tile cache bounded after panning. **Performance:** measure, do not add workers until S08.1 identifies need.

## S02.5 — Precise input, previews and accessibility

**Depends:** S02.4. **Modify:** main input/UI bindings, render preview, ui.css. **Create:** src/input.js, test/input.test.js; extend browser UI tests. Extract only event handling and state transitions, not entire controller.

1. Define pointer states idle/drawing/panning; handle pointercancel/lostcapture/window blur. Right/middle/Shift drag pans; double-click finalization does not add duplicate final point. Document exact behavior in help.
2. Preview building validity comes from evaluateBuildingPlacement; red reason matches commit failure. Road draft full geometry equivalence is S03.2; until then display invalid sample segments from S01.5 validation and do not promise advanced snapping.
3. Keyboard events ignore INPUT/TEXTAREA/SELECT/contenteditable and interactive modal scope. Escape cancels innermost operation; Space activates a focused button rather than also pausing game. Shortcuts never edit beneath dialogs.
4. Add semantic dialog roles, focus trap, initial focus, restore focus, Escape behavior; polite aria-live for actionable status. Labels for every slider, keyboard numeric alternative.
5. Provide keyboard construction cursor: arrow movement10wu, Shift+arrow1wu; Enter sets point, explicit Finish button commits, Escape cancels; reachable Pan/Zoom/Fit controls. This is equivalent core access, not a claim that Canvas alone is screen-reader accessible.
6. Test pointercancel, drag outside canvas, keyboard-only first road/building, focus restoration, tooltip edge clamping and reduced motion.

**Verify:** unit + browser; keyboard walkthrough; no accidental demolition while typing; contrast thresholds measured. **Stop:** any control visually present but unreachable without mouse.

## S02.6 — Guided first session and R1 acceptance

**Depends:** S02.5. **Modify:** index help/start screen, main new/continue flow, UI controller. **Create:** src/tutorial.js, test/tutorial.test.js, test/browser/tutorial.js.

1. Replace mandatory text wall with Tutorial/Sandbox/Continue. Do not advertise Scenarios until S07.1. Preserve Help as searchable/sectioned controls reference.
2. Tutorial state machine follows DESIGN steps1–5. Each transition listens to actual world condition: road committed, home/shop connected, trip completed, workplace added, saved. Never award success merely for clicking Next.
3. Tutorial keeps economic demand paused until viable network exists; seed and placements deterministic; skip/restart requires no reload. Save tutorial progress separately from ordinary city progress.
4. Add a browser run completing tutorial using real controls and bounded waits on state, not arbitrary sleeps. Force invalid road/building once; recovery instruction visible, inventory unchanged.
5. Run R1 fixture screenshots and five-player study procedure. Log issues as observations with reproduction, not generic 'polish needed'. Fix blockers within S02; do not open S03 until approved.

**Verify:** unit + browser + soak; visual score >=16/20 with mandatory items nonzero; at least4/5 novice users complete first connection within5min if participants available. If not available, mark user study unverified, request approval to proceed on provisional gate. **R1 result:** enjoyable, coherent core—not advanced parity yet.
