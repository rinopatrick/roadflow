# Stage 03 — A reliable construction workbench

Read CONTRACTS sections4/7 and TESTING. All build actions become validated transactions. No signal/lane/elevation feature UI before its owning stage. The world must remain playable after every task.

## S03.1 — Atomic commands and bounded undo/redo

**Depends:** S02.6. **Read:** main.js action functions, network construction, snapshot serialization and live-edit reconciliation. **Create:** src/worldCommands.js, test/worldCommands.test.js. **Modify:** main action handlers, menu/dock bindings, browser edit tests.

1. Add test: failed road/building/roundabout command produces byte-equivalent normalized world (including inventory/RNG/counters); no partial graph changes. Save before/after explicit fixture.
2. Implement applyWorldCommand and createHistory per CONTRACTS. Commands dispatch existing validated methods; do not duplicate their algorithms. Use a temporary hydrated snapshot for risky graph edits, validate invariants, then replace live references through one main `replaceWorld` boundary.
3. Add JSON command kinds for current actions; maintain change records and call reconcileTrafficAfterEdit before publication. Register UI listeners once; replaceWorld must not accumulate handlers.
4. Store up to50 successful edit snapshots or32MiB, whichever is lower. Failed/no-op actions add no history. New action after undo clears redo. Snapshot limit visibly documented if reached.
5. Undo pauses and rewinds to pre-edit simulation snapshot; redo restores post-edit snapshot. Camera can remain at current view; all simulation fields and inventory must match recorded state. Show 'City restored to before edit; paused' to avoid a misleading timeline.
6. Add toolbar Undo/Redo, Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z with text-field guards. New/load clears history after confirmation; undo cannot resurrect a previous city.
7. Tests: road with auto-split undo, building refund undo, signal edit undo, roundabout conversion undo, repeated20 cycles no ID collision, active-trip snapshots restored without double XP.

**Verify:** npm test; browser undo/redo via actual controls; compare normalized snapshots. **Stop:** memory budget exceeded without eviction or closures missing after restore. **Rollback:** commands can be reverted locally; preserve v2 save compatibility.

## S03.2 — One authoritative road draft and predictable snapping

**Depends:** S03.1. **Create:** src/roadDraft.js, test/roadDraft.test.js. **Modify:** main/input road gestures, render previews, network addRoad options.

1. Define evaluateRoadDraft contract. Inputs: raw points, road preset, straight/curve mode, snap enabled, ground grade default. Output includes final controls/polyline/intersection preview and exact failure reason; no world mutation.
2. Implement snap priority: explicit locked target → closest node within12 CSSpx converted to wu with cap18wu → closest edge within8 CSSpx cap12wu → angle snap multiples15° when modifier held. At ties sort stable IDs. Show target glyph and allow Alt to temporarily disable snapping.
3. Evaluate geometry continuously: subdivide every straight segment to <=4wu and curves to equivalent arc spacing; validate road half-width footprint against terrain and building footprint. Test land endpoints with water strip between, acute curve overshoot and near-tangent overlaps. Endpoint-only samples are insufficient.
4. Preview uses the exact evaluated polyline; commit reevaluates if graph version changed and then applies same record. Avoid separate curved preview versus linked-node build algorithms.
5. Provide click start/end straight mode, multi-point curve mode, Backspace removes last draft point only when drawing, Escape cancels, Enter/Finish commits. No inventory/money effects until success.
6. Test preview/committed geometry equality after snapping, at DPR2, after changing tool/camera, and after an external graph edit invalidates target. Invalid result retains editable draft and shows reason.

**Verify:** unit + browser; max Hausdorff distance preview/build <=0.5wu; all invalid commits leave world unchanged. **Stop:** inconsistent sample authority or water-crossing ground road accepted.

## S03.3 — Three-click rotated road grid

**Depends:** S03.2. **Create:** src/gridDraft.js, test/gridDraft.test.js. **Modify:** toolbar Roads options and command dispatcher.

1. Interaction: click A, click B defines base vector and length, move/click C defines perpendicular extent. Settings: block length120..400wu step20 (default200), row spacing120..400wu (default160), road preset. Preview every proposed segment before commit.
2. Pure function `evaluateGridDraft(world,{a,b,c,blockLength,rowSpacing,cls})` projects C onto base normal, creates ordered local-grid lines then transforms to world. Reject base length<40wu, |width|<40wu, >100 road segments or nonfinite coordinates with explicit reason.
3. Reuse evaluateRoadDraft for each segment against a temporary evolving graph, including existing road intersections. One failing segment rejects whole grid; list first invalid segment and highlight it. No half-grid built accidentally.
4. Apply as one composite command and one undo entry. Shared endpoints deduplicated; crossing resolution sees every segment.
5. Tests grids at0°,30°,90°; reversed drag; grid crossing river; grid against existing highway; repeated commit no duplicate overlapping roads; one undo returns exact prior world.
6. Browser build rotated block grid in three clicks, place buildings on it and verify actual routes/trips.

**Verify:** unit/browser; expected nodes/edges from fixture analytical counts, not screenshot inference. **No:** procedural building auto-fill yet; user still places earned buildings.

## S03.4 — Safe upgrades, roundabout controls and building relocation

**Depends:** S03.3. **Modify:** command dispatcher, road profile validation, roundabout methods, economy/access, inspector. **Create:** test/construction-edits.test.js.

1. Road inspector upgrade street↔avenue↔highway in place. Validate widened footprint/crossings/access before commit. Preserve edge ID where topology unchanged; otherwise emit replacement map and reconcile active cars. No silently deleting adjacent buildings.
2. Roundabout tool gains radius control24..100wu and preflight preview. Radius changes rebuild a temporary ring; verify all arms can connect without overlap, no attached building access loss. Invalid radius red with reason. Keep single circulating lane until S04.6.
3. Building relocation command preserves ID, type, trip/job ownership and stock; choose destination via same placement validator excluding the moved building. Reattach driveway atomically; cancel/replan affected journeys explicitly.
4. Demolition preview lists affected buildings/road pieces; deleting ring means entire ring, and UI says so. Refund only actual building types. Undo restores pre-edit state.
5. Tests widen road beside house (reject), valid upgrade with moving car, roundabout grow/shrink and asymmetric arms, invalid relocation unchanged, successful move no free extra inventory.

**Verify:** unit/browser; 20 mixed edits + undo all restore original snapshot; migration fixtures still load. **Stop:** command must silently evict a building or invalidate data to succeed.

## S03.5 — Local construction templates

**Depends:** S03.4. **Create:** src/templates.js, test/templates.test.js. **Modify:** Roads menu, preview/command dispatch, export validation.

1. Add three built-in data templates using current capabilities: T-junction, four-way roundabout, rectangular block. Template is a bounded JSON command list with relative points, preset metadata, schema version and bounding box; not executable code.
2. Pure transform supports rotation in15° increments and translation. Scale fixed1 initially; avoid impossible lane scaling. Preview transformed graph through same validators.
3. One transaction applies entire template; reject collisions/invalid terrain as a whole. One undo reverses it. Snapshot captures deterministic IDs.
4. Add save selected road subgraph as local template, excluding buildings, vehicles and external dangling connectors. If selection includes unsupported partial ring, explain/reject. JSON import <=1MiB and <=100 segments, schema/reference/coordinate validation.
5. Test roundtrip template export/import and rotated placement; reject malicious extra fields/unknown commands; no new Function/eval. UI enables at most implemented templates—interchange templates arrive S05.4.

**Verify:** unit/browser; each built-in drives a legal trip after placement, not just decorative lines. **Stage gate:** novice can draw, snap, grid, undo and upgrade without losing city state.
