# Stage 05 — Grade separation and interchanges

Read CONTRACTS topology/route/save sections. This is not achieved by drawing a bridge sprite over an ordinary intersection. Route connectivity, picking, construction, shadows and persistence must agree.

## S05.1 — Add an explicit grade model

**Depends:** S04.6. **Modify:** network node/edge model, geometry/snap/crossing validation, worldSnapshot migrations, route/junction generation. **Create:** src/grades.js, test/grades.test.js, v4 fixtures.

1. Establish `node.z` in wu, default0. `edge.grade = {kind:'ground'|'bridge'|'ramp'|'tunnel', za, zb}` matching endpoint elevations; ramps interpolate height by normalized arc length. Bridge/tunnel decks have equal endpoint height except ramp segments. Ground z follows0 in this simplified model, not terrain noise elevation.
2. Vertical levels offered initially -12,0,+12wu. Ramp max slope0.15 => minimum80wu length for12wu change. Cross-level clearance >=8wu. This is a stylized top-down model; do not advertise engineering-standard bridge geometry.
3. XY crossings connect only if both paths intend junction and heights differ <=0.5wu; ground-ground defaults to junction. Different grades with >=8wu clearance do not connect. Height gap0.5..8wu is invalid collision; reject transaction. Ramp interior intersections rejected initially, except explicit endpoints.
4. Snap candidates filtered by compatible z; a ground pointer beneath bridge cannot snap to its elevated node. Add selected elevation layer and cycle-overlapping-target action for precise picking.
5. Endpoints: ground↔bridge only through ramp; tunnel needs portal/ramp links. No automatic vertical teleport edge.
6. v4 migration assigns z0/ground to all older edges/nodes and preserves one-way/profile/connector restrictions. Connectors only within equal-height nodes. Save/undo/templatization include grades.
7. Tests XY cross same grade creates junction, different grade never creates route, insufficient clearance rejects, endpoint ramp connects, too-short ramp rejects, reverse-oriented ramp interpolates correctly, split ramp preserves height at split.

**Verify:** unit + browser picking fixture; graph route query cannot jump from road below onto bridge above. **Stop:** any serializer or split drops grade fields.

## S05.2 — Bridge and ramp construction

**Depends:** S05.1. **Modify:** roadDraft, worldCommands, profiles/validation, toolbar controls, rendering. **Create:** test/bridge-draft.test.js, test/browser/bridges.js.

1. Roads options add Ground/Bridge and elevation control; ramps generated explicitly between selected levels with previewed slope. Tool shows span, clearance and invalid segments.
2. Bridge path can cross water and lower roads; deck itself may not cut rock/building footprint at its height. Abutments require buildable ground; no support pillar rules implied until modeled. Validate both endpoint ramp footprints.
3. Construction command creates approach/ramp/deck/ramp as one atomic transaction and one undo. Player can alternatively connect existing same-level elevated nodes without duplicate ramps.
4. Render deck/shadow/vehicles by grade, not three global road passes ignoring height: lower roads and cars first, bridge shadow, elevated deck then its cars. Trim hidden lower markings beneath deck; selection overlay can reveal hidden route.
5. Buildings never attach driveway directly to bridge or ramp. Show why, rather than rejecting as generic invalid terrain. Upgrade bridge lanes revalidates deck width and clearance footprint.
6. Tests river spanning trip completes via bridge; deleting bridge cancels/reroutes only affected trips; bridge above busy road remains disconnected; undo/save/load preserves grades and cars. Capture both normal and selected-grade view.

**Verify:** unit/browser/soak; no accidental ground junction beneath bridge, no cars visually on wrong deck. **Do not:** add road-budget mechanics; display length/material type only until S07.4.

## S05.3 — Tunnels and underground inspection

**Depends:** S05.2. **Modify:** grade validator, road draft, picking, route renderer, save/command flows. **Create:** test/tunnels.test.js, browser tunnel scenario.

1. Tunnel kind at z=-12 can pass beneath rock and existing surface roads. Portals require buildable approach ground and compliant ramp length. Water tunnelling disabled initially with explicit rejection; this is a stated game rule, not a random failure.
2. Render portals and muted dashed underground alignment only when selected or Underground layer on. Surface roads remain visible normally; vehicles inside tunnel hidden from normal map but selectable through route/underground view.
3. Crossing tunnels at same elevation require explicit intended junction; normal tunnel cross defaults reject rather than creating an unseen dangerous junction. Different elevation tunnels need same clearance rule; initial tool only offers one underground level, so reject incompatible intersections clearly.
4. Picking chooses active layer and allows cycling; delete warning states selected tunnel span and connected portals. Full-span undo restores exactly.
5. Tests mountain bypass trip, too-short portal ramp, tunnel under surface road no junction, tunnel-water rejection, export/import grade fidelity, live edit while a vehicle is underground accounted without fake arrival.

**Verify:** unit/browser; underground view matches actual routed geometry. **Stop:** invisible clickable ghost edges or ordinary road deletion selecting an unintended tunnel.

## S05.4 — Interchange templates and grade acceptance

**Depends:** S05.3. **Modify:** templates.js, construction preview/menu, tutorial/help reference. **Create:** test/interchanges.test.js, grade showcase fixture.

1. Add three authored, original data templates: diamond interchange, dumbbell interchange (two roundabouts), directional T interchange. Define approaches, one-way ramp directions, grades and lane profiles in JSON records, not imperative special-case graph code.
2. Derive ramp shapes from explicit geometry; minimum curve radius30wu for highway ramps and slope<=0.15. Reject a transformed template if geometric/terrain/building validation fails. No scaling that silently changes legal clearances.
3. Validate all intended OD pairs between approach portals; assert no forbidden wrong-way shortcut. Each template includes expected connectivity matrix and queue-stress fixture.
4. Preview labels entry/exit direction and elevation; ghost segments indicate failed clearance. One placement command, one undo; save/load and local template export use v4.
5. Run combined traffic/elevation stress: crossing road and bridge, ramp queue backing up, tunnel bypass, signals below elevated deck. Count vehicles and legal connector permissions.
6. Update feature matrix evidence: bridges/ramps/tunnels/interchanges only 'implemented' after tests and screenshots pass. Tunnels are Roadflow scope, not a verified Trafficity promise.

**Verify:** all tests + grade-specific browser tour; each template routes its allowed OD pairs and rejects reverse lanes. **Gate:** human inspects crossings and picking at DPR2, zoom.3/1/3. **Rollback:** retain before-placement save and reversible command.
