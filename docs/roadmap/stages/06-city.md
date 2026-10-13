# Stage 06 — Economic demand, environment and replayable maps

Read CONTRACTS sections7/8. Economy should create understandable transport decisions, not turn Roadflow into an unrelated spreadsheet simulator. A journey is not the same thing as a vehicle. All balances/counters finite and serializable.

## S06.1 — Capacity-aware work and shopping demand

**Depends:** S05.4. **Create:** src/demand.js, test/demand.test.js. **Modify:** economy.js, traffic arrival dispatch, worldSnapshot v5, building inspector.

1. Introduce Journey record and bounded lifecycle per CONTRACTS. Adapt existing outbound/return callback handling into ID-based arrival dispatch; preserve one XP award per served request.
2. Buildings gain `{capacity,assignedWorkers,serviceSlots,needs}`. Initial capacities: house4 residents, shop2jobs/4concurrent customers, factory6jobs; conserve assigned workers globally, <= population. Shop jobs become valid workplaces, not just decorative counts.
3. Choose destinations by reachable route cost with available capacity, stable ID ties. Cache by net.version plus capacity revision; a full destination invalidates capacity cache without mutating topology version.
4. Generate work and shopping demand on deterministic timers; retain initial25–70s distribution until S06.5 balance tuning. At most16pending/origin, retry2s, cancellation timeout300s. Unmet demand appears in stats with reason (no path/no jobs/no stock/no capacity), never silently discarded.
5. Reserve job/customer capacity when admitting journey; release on cancel/deletion. Return trips complete journey lifecycle; commuter already active cannot spawn duplicate work vehicle each timer tick.
6. Tests two homes compete for one workplace, nearer full versus farther available shop, disconnect/reconnect, deleted destination mid-trip, blocked spawn and queue cap. Check job allocation <= jobs and workers <= residents after every tick.
7. Building inspector explains workers/customers and unmet reasons; show no raw-material/goods needs until S06.2.

**Verify:** unit/browser; conservation of pending/active/completed/cancelled journeys, full save-resume equality; old city migrates with inferred/default capacities and warning only when needed.

## S06.2 — A real freight supply chain

**Depends:** S06.1. **Create:** src/logistics.js, test/logistics.test.js, freight fixture. **Modify:** economy building definitions, traffic vehicle types/dimensions, renderer/inspector, snapshot schema5.

1. Add external depot building (connects to local network) with raw production2units/10sim seconds, storage40. Factory consumes2raw + assigned worker availability to produce2goods per20s, storage20raw/20goods. Shop storage20goods, consumes1good per served shopping request. Values are initial tuning defaults, not final economy claims.
2. Truck capacity8, length12wu,width3.8,speedFactor.8; use vehicle-specific following, spawn clearance, connector sweep and rendering dimensions. Every existing car-dimension assumption must be searched/migrated.
3. Dispatch freight when destination stock below25% and source available; reserve source cargo and destination capacity, max one outstanding shipment per pair/item until delivered/cancelled. Truck uses legal route graph and signals; arrival commits inventory transfer.
4. Factory production requires at least one assigned worker and raw inventory; no workers => visible stalled reason. Shop with no goods cannot serve shopping demand, retains bounded pending requests.
5. Deletion/failure releases reservations; cargo loss only when explicitly cancelled with reason, counted separately. No inventory negative or duplicated after retries/undo/load.
6. Add depot to tutorial sandbox grant once and explain delivery chain in optional lesson; do not deadlock old saves. Migrated cities get initial stocks plus one available depot and a clear notice.
7. Tests mass balance over300sim seconds, blocked freight spawn, disconnected depot, destroyed destination, long truck clearing intersection, save before delivery then resume rewards/inventory once.

**Verify:** unit/browser; visible truck from depot→factory→shop and shopping service depends on deliveries. **Stop:** freight simulated by instant inventory teleport or cosmetic trucks.

## S06.3 — Meaningful pollution, noise and happiness

**Depends:** S06.2. **Create:** src/environment.js, test/environment.test.js. **Modify:** economy happiness/progression inputs, layers/inspector, renderer.

1. Preserve factory-distance pollution behavior as one normalized component, but separate environment calculation from XP directly. Emit by active production rate; stopped factory not treated identically to full production.
2. Noise uses nearby traffic flow and vehicle class/speed, sampled on spatial grid64wu every2sim seconds, falloff exp(-distance/120), clamped0..1. Pollution radius260wu, same cached grid. Do not perform building×vehicle full scans every frame.
3. Home satisfaction = clamp(0.45*workAccess +0.35*shoppingService +0.20*(1-environmentPenalty),0,1), with EMA tau30s. environmentPenalty = clamp(.6*air+.4*noise,0,1). Inspector exposes components; low happiness slows growth, does not instantly delete population.
4. Add small park/noise-buffer decoration as meaningful optional building: park contributes at most.1 satisfaction within120wu; cannot cancel missing jobs/goods and does not magically absorb all industrial pollution. Explicit stock/cost policy via earned batch at later levels.
5. Add Air and Noise overlays, legends, colour-independent hatch/intensity and selected-home explanation. Values in overlay and inspector use same cached sample.
6. Tests distance decay, increased truck flow increases noise, relocation reduces exposure, parked/no traffic decay, satisfaction boundaries and no double-counting with XP. Save environment cache not required; deterministic rebuild from state required.

**Verify:** unit/browser; clearing factory changes air after decay, road detour changes noise; no new fake sustainability score.

## S06.4 — Four map profiles with distinct constraints

**Depends:** S06.3. **Modify:** terrain.js generator selection, renderer cache keys, new-city screen, snapshots. **Create:** src/mapProfiles.js, test/mapProfiles.test.js.

1. Preserve generatorVersion1 exactly for all old saves. New generatorVersion2 profiles: `plains` (broad connected buildable area), `river` (two banks needing bridges), `coast` (inlets/land bottlenecks), `highlands` (rock corridors favor tunnels).
2. Use deterministic seed/profile, not random reroll during rendering. Define starting region validator from S02.4; each profile must provide at least600×400wu playable starter region and enough reachable land for early city. River starter includes usable bridge abutments; highlands starter is not trapped with locked tunnel tool.
3. Parameters live in data file with named noise scales/water/rock thresholds; sample diagnostics on100wu grid report buildable fraction, connected regions, potential crossing sites. Reject/reseed internally only with deterministic bounded attempts<=20; then show explicit generation failure without clearing existing city.
4. New-city preview shows profile, seed, difficulty and starter area. Copy seed; regenerate same seed produces same terrain hash and camera. No feature claims of four 'biomes' just because terrain has four tile classes.
5. Test seeds1..30 for each profile: playable start, finite samples, deterministic hash, water/rock constraints distinguishing profiles. Golden sample coordinates protect generator version stability.
6. Cache key includes seed+profile+generatorVersion; load cannot accidentally show prior terrain texture.

**Verify:** unit/browser;120seed checks, save/load old island and all new profiles; manual visual review four maps. **Stop:** inaccessible essential resource or unbuildable tutorial spawn.

## S06.5 — Difficulty and progression tuned through fixtures

**Depends:** S06.4. **Create:** src/rules.js, test/progression.test.js. **Modify:** economy timers/batches/XP, setup menu, inspect/unlock explanations.

1. Define rules objects Easy/Normal/Hard with explicit numbers: demandRate .7/1/1.3; service deadline450/300/240s; environmental weight .7/1/1.2; starting batch Easy6house/3shop/2factory, Normal4/2/1, Hard4/2/1. All receive1depot when freight enabled. Do not alter vehicle physics or hide facts between difficulties.
2. Replace LEVEL_XP growth with data-driven cumulative milestones that target first meaningful level-up in3–5min for a competent normal tutorial city. Start proposed thresholds100,250,500,900; measure fixture and adjust documented values, not tests to arbitrary achieved result. Migrated old XP converted by level/progress fraction; no level regression or duplicate award.
3. Batch rewards include useful demand balance; ensure households/jobs/goods growth stays solvable. Road/signal core tools always available in Sandbox; tutorial unlock only sequences explanations. Advanced grade tools available when map requires them, not after impossible prerequisites.
4. Pause/slow demand during onboarding and while modal setup open. Challenge modes may impose deadlines explicitly; free sandbox never ends silently.
5. Run30min simulated city fixtures on all difficulties with scripted reasonable expansion; record delivered/failed services, XP, congestion and stock starvation. Same design should have observable challenge gradient without inevitable deadlock.
6. Add level reward preview and milestone history; saved and idempotent. Exact counters match inventory awarded.

**Verify:** unit/integration/browser; one milestone per crossing threshold, no reward repeats after save/load, game remains recoverable after poor placement. **Approval:** operator approves pacing from actual play, not accelerated trace alone.

## S06.6 — Parity candidate validation and R2 gate

**Depends:** S06.5. **Modify:** documentation, fixture pack, only necessary defect fixes via split subtasks. **Create:** artifacts/R2 evidence and acceptance report.

1. Replay complete loop: new map→roads/grid→homes/jobs→freight→shop service→XP→expansion→congestion→diagnosis→signals/lane/grade solution→save→reload.
2. Build Trafficity advertised-feature checklist from EVIDENCE: individual lane additions, lane connections, protected turns, rotated grid, overpass, roundabout, raw/goods chain, noise/pollution, four profiles/three difficulties. Each row links implementation/tests and screenshot, or marked failing—no wishful 'supported'.
3. Run45min real-time mixed session at normal and3× speed; add/remove roads, toggle layers, import/export, use keyboard and resize; inspect console/memory trends. Do not claim passing from90s soak alone.
4. Review UI density with freight/profile controls. Keep optional complexity behind selection/context; new user can still find basic street and house.
5. Re-run R1 visual rubric and user task study. Compare before/after, not subjective parity percentage. Record each unresolved issue severity.

**Verify:** all tests and acceptance matrix, no P0/P1 bugs, every advertised-target row implemented or stage fails. **R2 is a candidate:** does not claim proven superiority or identical behavior to an unreleased reference. Stop before S07 if core game remains confusing.
