# Implementation contracts

These are **proposed interfaces**, not exports already available. Each interface has an owning task. Never import it before that task exists. Keep existing public methods until every caller and test is migrated in the same task. Use plain JavaScript with JSDoc where a record is non-obvious.

## 1. Current entry points to preserve initially

- `new RoadNetwork()`; `addRoad(controls, cls)` → `{nodeIds, edgeIds}`.
- `net.nodes: Map<string, Node>`; `net.edges: Map<string, Edge>`; `net.version` invalidates route/geometry caches.
- `findPath(net, fromId, toId)` → `{nodes, time}` or `null`.
- `pathToSteps(net, nodes)` → `[{edgeId, from, to, dir}]` or `null`.
- `new TrafficSim(net)`; `spawn(fromNodeId, toNodeId)` → `Car|null`; `update(dt)`.
- `new Economy(net, terrain, seed)`; `place(type,x,y)` → building or null; `update`; `processReturns`; `checkLevelUp`.
- `new Renderer(canvas)`; `draw(state)`; `screenToWorld`; `worldToScreen`.
- `saveGame(state)` → boolean; `loadGame()` currently returns reconstructed objects or null. S01.7 changes the loading boundary and all callers together.
- DOM IDs `game`, `toolbar`, `hPop`, `hTrips`, `hAvg`, `hCong`, `hLevel`, `xpfill`, `badge_house`, `badge_shop`, `badge_factory`, `btnSave`, `btnLoad`, `btnNew`, `btnHelp`, `inspect`, `insTitle`, `insBody` remain stable through S02. Selectors can change only with same-task browser test migration.

## 2. Units, coordinates and determinism — S01.1/S01.3

Canonical runtime world assembled in S01.1: `{terrain, net, traffic, eco, ids, camera, settings}`. `camera` is the same object used by `renderer.cam`; renderer is a view, not persisted world state. `settings = {speed, audio}` initially. Main may keep its existing local references during migration, but `getWorld()` assembles this exact shape and one `replaceWorld(world)` rebinds all references/callbacks/camera. S01.7 uses that replacement boundary; S03.1 reuses it. Renderer draw continues to receive its existing view-state record including tool/selection/preview, which are not simulation fields. Later tasks add runtime services and serialization fields explicitly; none may depend on a hidden global world singleton.

- World coordinates: x right, y down. World distance unit `wu`; time seconds of simulation. UI camera positions in wu; pointer coordinates in CSS px; canvas storage in device pixels.
- Never mix device pixels with CSS pixels in hit tests. Current `worldToScreen` returns device pixels; preserve it initially and introduce an explicit `worldToCss` helper for browser tests/UI. Do not silently change its meaning.
- Direction `dir=1`: edge.a→edge.b; `dir=-1`: edge.b→edge.a. Lane 0 is innermost in its direction. Keep right-hand driving for core releases.
- Tick interval `STEP = 1/60`. `TrafficSim.update(STEP)` is the only increment of its simulation clock. Main loop accumulates wall seconds × selected speed; renderer reads that clock.
- Accumulator caps wall-frame contribution at 0.25 seconds and work at 120 ticks per rendered frame. On overload, retain at most 2 simulated seconds and count discarded time in diagnostics. On hidden-tab resume, reset wall timestamp rather than simulating hours. Tests step ticks directly, never depend on requestAnimationFrame timing.
- `makeRng(seed)` remains callable and gains `getState(): uint32`, `setState(uint32): void`. New `createIdSource(next=1)` returns `{next(prefix):string, getState():number}`; own one per world and preserve counters on load. Existing random v1 IDs remain valid; generated IDs skip existing IDs after migration.
- Split random streams: simulation, economy and cosmetic. Rendering must not consume simulation RNG. Stable Map iteration/tie breaks use IDs. Exact cross-browser floating-point bit identity is not promised; same-runtime normalized snapshots use a 1e-6 tolerance for positions.

## 3. Shared road dimensions — S01.3, extended S04.1

Own in `src/roadProfiles.js`:

```js
// S01.3 keeps legacy cls presets; S04.1 adds profile records per edge.
export function roadDimensions(edge) { /* {laneWidth, medianWidth, shoulderWidth, forward, backward, width} */ }
export function laneCenterOffset(edge, dir, index) { /* signed offset in wu */ }
```

Initial values: laneWidth 6, medianWidth 1.2 on two-way roads (0 on one-way), shoulderWidth 1 each side. Presets: street 1+1 lanes, avenue 2+2, highway 3+3. `width = (forward+backward)*laneWidth + medianWidth + 2*shoulderWidth`. For asymmetric profiles, let `F = forward*laneWidth`, `B = backward*laneWidth`, `M = medianWidth`. The median centre offset relative to the centred pavement is `(B-F)/2`. Forward lane offset is `(B-F)/2 + M/2 + (index+0.5)*laneWidth`; backward lane offset is `(B-F)/2 - M/2 - (index+0.5)*laneWidth`. For one-way set M=0. Multiply the right-hand normal of a→b by this signed offset; do not multiply by dir again. Validate index against the selected direction before computing. Car width 3.6, length 7; vehicle dimensions become type-specific in S06.2. Bounds tests include half vehicle width and shoulders. All render, snap/pick, preview, lane offset and roundabout-radius logic use this model.

S04.1 adds:

```js
// edge.profile; index numbers count from the median/inside outward.
{ forward: 1, backward: 1, laneWidth: 6, medianWidth: 1.2,
  shoulderWidth: 1, speed: 14, access: 'local' }
// access: local | arterial | motorway
```

Forward/backward integers 0..4, sum 1..8. Speed 1..40 wu/s. Existing `cls` remains the preset/style label, not a second lane-count truth. Ring edges use forward 1, backward 0, no median. Motorway driveways rejected for new placement; legacy driveway access is preserved and flagged until the player changes it.

## 4. Topology and construction — S01.5/S01.6/S03

Every committed world must satisfy:

1. Every edge endpoint exists and lists the edge. Node edge sets contain no missing edge.
2. All geometry finite, each edge length > 0, stored geometry endpoints agree with nodes within 1e-6.
3. Ground crossings connect unless explicitly excluded by grade rules in S05. Geometrical overlap is rejected with a reason, not silently duplicated.
4. One-way/ring/profile/grade metadata survives splits and merges. Split children preserve physical geometry within 0.5 wu of the parent reference polyline.
5. Building driveway references point to existing access nodes or are explicitly marked disconnected; never an accidental dangling reference.
6. A failed construction does not change graph, inventory, money, selection, RNG or ID counters.

S01.6 replaces singular ownership with `node.buildingIds: string[]`. Keep `building.drivewayNode` as the access node reference. Migration gathers ownership from the building list, not from potentially overwritten `drivewayFor`. Removing one owner never removes another's access.

S03.1 owns `src/worldCommands.js`:

```js
export function applyWorldCommand(world, command) {
  // {ok:true, world, change, warnings:[]} | {ok:false, reason, world}
}
export function createHistory(limit = 50) { /* execute(world,command), undo(world), redo(world), clear() */ }
```

Commands are JSON records with `kind`, payload and no functions. Initial kinds: `addRoad`, `placeBuilding`, `removeBuilding`, `removeRoad`, `makeRoundabout`, `removeRoundabout`, `setSignal`, `upgradeRoad`, `moveBuilding`. Later tasks extend a single dispatcher. `change` is `{removedEdgeIds, replacedEdges, removedBuildingIds, topologyChanged}`. `replacedEdges` entries contain old edge ID, ordered new edge IDs and old/new arc ranges for remapping cars. Each segment records `{oldEdgeId,newEdgeId,oldStart,oldEnd,newStart,newEnd,orientation:1|-1}` with arc coordinates measured a→b on both edges. Reverse-travelling car converts its travel s to old geometric arc first, then back to travel s after remapping; direction and lane-side profile must follow orientation. Snapshots include simulation state, queued trips, RNG and inventory. Full bounded snapshots are acceptable first; optimize only after measurement. Undo explicitly rewinds world/simulation to pre-edit checkpoint and pauses, rather than pretending to undo only geometry while retaining inconsistent time.

S03.2 owns `src/roadDraft.js`:

```js
export function evaluateRoadDraft(world, {points, cls, mode, snap, grade}) {
  // {ok, reason, controls, polyline, length, intersections, cost}
}
```

No mutation. Renderer previews this record; commit reevaluates against current graph version then applies the same geometry. `mode` is straight | curve; `snap` enables endpoint/edge/angle snapping. Legacy addRoad receives final authoritative sampled geometry through a backward-compatible options argument. Do not generate separate preview and construction splines.

## 5. Routes and junction movement — S04.2

Route calculation becomes edge/lane-aware without deleting the old node API until all consumers migrate:

```js
export function findVehicleRoute(net, fromNodeId, toNodeId, options = {}) {
  // {steps:[{edgeId, from, to, dir, lane, connectorId:null|string}], time, version} | null
}
```

`options.vehicleType` defaults to car. A connector belongs to a node and maps an incoming `{edgeId,dir,lane}` to an outgoing tuple. ID is stable for unchanged tuples, e.g. serialized tuple string; `net.connectors: Map<id,Connector>` is derived except user restrictions stored in the world. Connector record: `{id,nodeId,from,to,turn,pts,length,conflicts:string[]}`; turn = left | through | right | uturn. No automatic U-turn except explicit dead-end policy. `connectorId` on a route step describes the movement **after that edge**. Last step has null.

S04.2 owns connector geometry and legal route graph; S04.3 owns physical lane change; S04.4 owns signal permission. These are different responsibilities. A legal path does not automatically mean a movement is currently permitted by a red signal.

Each car state has `mode: 'edge'|'connector'`, `s`, `step`, `lane`; while on a connector, `s` is connector distance. A car reserves its connector/conflict zone before entry and releases after its rear leaves. Downstream capacity must exist before reservation. Two conflicting movements must never hold reservations simultaneously. First version uses conservative conflicts from swept paths with vehicle half-width margin; false-positive yielding is acceptable, allowing crossing collisions is not.

## 6. Signals and statistics — S01.4/S04.4

S01.4 owns `src/signals.js: getLegacyPhase(light, simTime)` returning `{axis:'x'|'y', state:'green'|'yellow'|'allRed'}`. Non-active axis is red. Preserve `cycle` as full-cycle length. For each half-cycle: green duration = `half*greenRatio`; yellow duration = `min(2, (half-greenDuration)/2)`; remainder all-red. Clamp/validate values at input. This corrects the previous misleading ratio behavior. Both renderer and yielding use the returned record.

S04.4 adds `getSignalState(program, simTime)`:

```js
// program stored on node.signalProgram
{ offset: 0, phases: [
  { id: 'p1', green: 12, yellow: 2, allRed: 1, connectorIds: [] }
] }
// result: {phaseId, state:'green'|'yellow'|'allRed', remaining, allowedConnectorIds:[]}
```

Durations finite; green >= 3, yellow >= 1, allRed >= 1, complete cycle <= 180 seconds. Reject programs containing conflicting connectors in the same protected phase. Legacy programs migrate conservatively, splitting conflicting movements, not granting every axis turn simultaneous priority. Yellow prohibits new entry unless physically unable to stop safely; an already reserved vehicle clears. UI computes cycle from phases; no second cycle variable.

Congestion: per-edge stopped vehicle share in [0,1], EMA tau=5 simulation seconds. Empty edge decays toward zero. UI shows percentage directly; city figure weighted by present vehicles and clearly labelled. Also report queue count, trip p50/p95, completed throughput, active/pending/cancelled journeys. No debug statistic should create vehicle scans inside a nested per-car loop.

## 7. Saves and exact resume — S01.7, schema extensions later

`src/worldSnapshot.js` owns data-only serialization/validation/hydration. Storage and download behavior stays in `save.js`.

```js
export function serializeWorld(world) { /* JSON-compatible snapshot */ }
export function validateSnapshot(raw) { /* {ok:true,data,warnings} | {ok:false,errors} */ }
export function hydrateWorld(data) { /* world with callbacks reconstructed */ }
```

Snapshot v2 base:

```js
{ v: 2, savedAt: 0,
  map: { seed: 1, generatorVersion: 1, profile: 'island' },
  net: { nodes: [], edges: [] },
  eco: { buildings: [], xp: 0, level: 1, batch: {}, totalTrips: 0,
         pendingReturns: [], rngState: 0 },
  traffic: { time: 0, cars: [], stats: {}, rngState: 0, nextCarId: 1 },
  ids: { next: 1 }, camera: { x: 0, y: 0, zoom: 1 },
  settings: { speed: 0, audio: true },
  extensions: {} }
```

Runtime callback closures are not serialized. Car `purpose/homeId/destId` become data; `hydrateWorld` rebinds completion via a single economy arrival handler. Completion fires once. Serialize timers, pending queues and RNG/counters. Discard derived reachability caches and rebuild them; save active route positions or explicitly migrate invalid routes with a warning. No array of missing cars may silently become an empty simulation.

Use versioned migrations: v1→v2 in S01.7; v3 lanes/connectors in S04; v4 grades in S05; v5 city/logistics/map settings in S06; v6 scenarios/transit/editor in S07. Extension migrations add deterministic defaults to all earlier supported versions; never reinterpret old procedural terrain with a new generator accidentally. Version 1 terrain remains available for old saves.

Import limits: input <=10 MiB, nodes <=20,000, edges <=30,000, buildings <=10,000, active vehicles <=5,000; finite coordinates within ±20,000 wu; camera zoom 0.12..5; IDs unique; enums recognized; all references checked. These are safety caps, not performance promises. Reject unsupported future versions with current world untouched. Parse only known keys; avoid merging untrusted objects into prototypes. User names enter DOM via textContent.

Storage errors (disabled storage/quota/corruption) produce actionable UI, not newGame. Keep last-good backup before replacing a slot; autosave in a distinct key, max once per 30 wall seconds while dirty, no overwrite of manual slot. Validate/hydrate in temporary memory; only replace current world after success and user confirmation. Camera/audio are independent settings but represented in save metadata for a predictable resume.

## 8. City, freight and multimodal records — S06/S07

S06.1 owns `src/demand.js`:

```js
// One journey record, independent of the current vehicle representation.
{ id, kind:'work'|'shopping'|'return'|'freight'|'transit', originBuildingId,
  destinationBuildingId, createdAt, state:'pending'|'active'|'dwell'|'completed'|'cancelled',
  vehicleId:null, retries:0, cancellationReason:null }
```

No infinite demand creation under blocked spawning. Pending queues are bounded per origin (initial 16), excess unmet requests increment a separate counter. Retry every 2 simulation seconds; expire only at explicit scenario policy (default 300 seconds), retaining a cancelled count/reason. Job/stock capacity reservations are released on cancellation or deletion. Work and shopping services earn XP once per served request; return movements do not farm XP.

S06.2 owns `src/logistics.js`: inventories `{raw,goods}`, capacities, production timers, cargo `{kind,amount,sourceId,destinationId}`. Sources are finite-rate external depots; factories consume raw + available workers and produce goods; shops consume goods on successful service. Trucks traverse the same legal network and signals. Dispatch reserves cargo/capacity; delivery commits transfer; cancellation returns reservations or records explicit loss, never duplicates goods.

S07.5/S07.6 own `src/transit.js` and `src/walking.js`. Transit stop `{id,edgeId,dir,s,capacity}`; line `{id,stopIds,headway,vehicleLimit}`; passenger `{journeyId,mode:'walk'|'wait'|'ride',position,stopId,vehicleId}`. Same journey cannot also spawn a car. Deterministic mode choice compares walk+wait+ride with car travel estimate, no random deletion of demand. Initial walking links use validated sidewalks and signal-aware marked crossings, not unrestricted straight lines through water/highways.

S07.1 owns `src/scenarios.js`: `{id,version,title,initialSnapshot,objectives,events,seed}`. Events use simulation time; supported objective predicates are explicit numeric comparisons with sustained windows. Completion/rewards idempotent and saved. Local editor writes these same data records, not runnable JavaScript.

## 9. Small model implementation rules

- Extract a module only in its owning task, with the exact existing callers migrated. No mass reorganization.
- No generated generic event bus, dependency injection container, plugin architecture or compatibility wrapper for hypothetical callers.
- Implement a pure function and its test before adding UI for complex algorithms.
- A missing helper named in a task is a planned new export, not evidence it already exists. Create it with tests in that task.
- For graph/geometry work, store an explicit before/after fixture and report invariant counts. Do not rely only on a screenshot.
- A task that needs an undefined policy is blocked. Propose one precise amendment; do not improvise across later stages.
