# Evidence and competitive gap analysis

## Evidence boundary

Inspected public sources and current local source during the planning session. File line numbers below are navigation hints for the inspected snapshot; locate by symbol after edits. Package metadata `version: 1.0.0` is not proof of release readiness.

### External sources

- **T1 — Primary product description:** https://store.steampowered.com/app/5185750/Trafficity/
- **T2 — Primary metadata/screenshots:** https://store.steampowered.com/api/appdetails?appids=5185750&l=english
- **T3 — Developer website and six visual references:** https://onramp.games/
- **T4 — Linked trailer:** https://www.youtube.com/watch?v=fUkBn6H-d-A

T1/T2 describe agent-based traffic; queue avoidance and slip lanes; gridless roads; three-click rotated grids; individual added lanes; overpasses; roundabouts; protected left turns; signal phases; lane connections; resident/shop/factory needs; raw materials and products; pollution and road noise; level-up building batches; four biomes; three difficulties; procedural maps.

T2 reported developer Onramp Games, Windows/macOS, coming soon, date `16 Nov, 2026`. T3 screenshots visibly show network hierarchy, grade-separated interchange shapes, parking/driveway details, roof silhouettes, distinct terrain boundaries, dense urban layouts and restrained road colours. The static screenshots do **not** prove simulation throughput, usability, price, final performance or completeness. T4 was discovered, but automated video retrieval failed because `yt-dlp` was not installed; no trailer-only claims enter this plan. Search aggregators largely repeated Steam and were not used as independent confirmation.

Reference capture: `shots/trafficity-reference.png` is an analysis screenshot of T3, not a Roadflow asset. Do not bundle it in a release or treat it as permission to redistribute the underlying art.

## Fresh Roadflow checks

- Current project: `C:/Users/patri/roadflow`.
- `git rev-parse --show-toplevel` originally returned `C:/Users/patri`, not the game directory. S00.1 created a project-local repository; `main` holds one pristine baseline commit and all work lands on `roadmap/implementation` via task branches.
- `npm test`: **184 passed, 0 failed** as of S01.5. This is the baseline, not a coverage or correctness guarantee.
- Browser suites live in `test/browser/` and are run separately (`npm run test:browser`, `npm run test:soak`), so the unit suite stays fast and browser-free.
- Source modules reviewed: core, terrain, network, pathfinding, traffic, economy, main, save, UI; renderer geometry and preview paths inspected.

## Feature matrix

Legend: **advertised** means primary Trafficity listing, not independently tested. **Partial** means implementation exists but does not satisfy end-to-end parity.

| Area | Trafficity evidence | Roadflow now | Planned owner |
|---|---|---|---|
| Gridless roads | Advertised | Splines, snapping and auto-splitting exist and are structurally sound as of S01.5; segment-level terrain validation and short-segment building still open | S03.2 |
| Road hierarchy | Advertised | Three fixed presets with a single profile-derived dimension model (S01.3) | S04.1 |
| Rotated grids in three clicks | Advertised | Missing | S03.3 |
| Add lanes / slip lanes / legal lane connectors | Advertised | Random lane choice per edge; no lane changes or editable connectors | S04.1–S04.3 |
| Congestion-aware route choice | Advertised | A* graph cost exists; congestion is now an honest timestep-independent share (S01.4); live rerouting policy still missing | S04.5 |
| Roundabouts | Advertised | One-way ring, tests and metadata-preserving splits exist | S04.6 |
| Full signal phases / protected lefts | Advertised | Shared phase authority with real green/yellow/all-red (S01.4); movement-based programs still missing | S04.4 |
| Overpasses / interchanges | Advertised | All XY crossings connect; no grade model | S05.1–S05.4 |
| Resident/work/shop demand | Advertised | House-generated trips with working outbound and return legs (S01.2); no job allocation | S06.1 |
| Raw materials / goods freight | Advertised | Missing | S06.2 |
| Pollution and road noise | Advertised | Factory distance field reduces trip XP; noise missing | S06.3 |
| Building batch progression | Advertised | Exists, level cap 50; low early pace | S06.5–S06.6 |
| Four map profiles / three difficulties | Advertised | One island generator. GRASS/SAND/WATER/ROCK are terrain classes, **not four playable biomes** | S06.4–S06.5 |
| Readable art and dense urban detail | Observed in screenshots | Generic UI pills, emoji controls, sparse boxes | S02 |
| Data overlays | Reference genre need | Renderer flags exist but no user control changes them | S02.2, S04.5 |
| Undo, robust saves, tutorial | Not established from reviewed sources | No undo; one local save key; help paragraph | S01.7, S02.6, S03.1 |
| Explainable diagnostic + A/B demand lab | Roadflow proposal; Trafficity unknown | Missing | S04.5, S07.2 |
| Scenarios, buses, walking, incidents, editor | Roadflow proposal; Trafficity unknown | Missing | S07 |

Do not market proposals as features Trafficity lacks. Absence from a store description is not proof of absence.

## Reproduced defects

### E01 — Return trips passed building IDs into a node routing API (FIXED in S01.2)

`src/economy.js:processReturns` called `spawnCar(r.from, r.to)`. `_completeTrip` stored building IDs there; `TrafficSim.spawn` expects graph node IDs. A probe created a home/shop, completed a trip, advanced return time and captured the callback arguments: both were building IDs, neither existed in `net.nodes`. The pending return was removed anyway, so the failure was completely silent — no car, no error, no counter.

**Fix (S01.2):** pending returns store building IDs and resolve them to CURRENT access nodes at dispatch time, because a building may be deleted, moved or re-attached during the dwell. A blocked spawn now retains the request and retries after 2 s instead of dropping it; a request whose origin, destination or access node no longer exists is cancelled exactly once with a recorded reason (`deletedOrigin` / `deletedDestination` / `noAccessNode`). A no-op `setTimeout(() => {}, 0)` was removed.

**Verified in-browser** (seed 1, loop road, 2 houses + 1 shop, 3x): `t+32s` outbound completes → `trips=1, pendingReturns=1`; `t+40s` → **a car with `purpose: 'return'` is actually driving**, `pendingReturns=0`; `t+48s` next outbound starts. Zero cancellations, zero errors.

**Observable consequence:** the 90-second soak changed from 10 trips / 2 cars / 0% congestion to 8 trips / 8 cars / 2% congestion. This is the expected effect of returns actually spawning cars, not a regression: more vehicles share the same network. The soak gate (`trips >= 1`) still passes.

**Mutation-verified:** reverting `spawnCar(fromNode, toNode)` to `spawnCar(r.from, r.to)` fails 3 of 12 tests.

### E02 — Lane geometry exceeded the rendered pavement (FIXED in S01.3)

`src/roadNetwork.js:ROAD_CLASS`, `laneOffset`; `src/render.js:_drawEdgeFill`; car half-width 1.8:

| Class | Outermost lane centre | Outer car extent | Rendered half road width |
|---|---:|---:|---:|
| Street | 3.85 | 5.65 | 5.5 |
| Avenue | 9.6 | 11.4 | 8 |
| Highway | 15.6 | 17.4 | 12 |

Numbers derived directly from the current formulas. The avenue/highway error is not a palette problem; vehicles and lane markings can sit outside the road surface.

**Correction made during S01.3 — where the inconsistency actually was.** My first description implied the lane offsets were wrong. Measuring both formulas side by side showed the **lane centres were already correct and are unchanged by the fix**:

| Class | Lane | Offset (old = new) | Old half-width | New half-width | Fitted before? |
|---|---:|---:|---:|---:|---|
| street | 0 | 3.85 | 5.50 | 8.10 | **no** |
| avenue | 1 | 9.60 | 8.00 | 13.60 | **no** |
| highway | 2 | 15.60 | 12.00 | 19.60 | **no** |

The defect was a **too-narrow pavement**, not misplaced lanes. `ROAD_CLASS.width` was a hand-chosen number (11/16/24) that did not follow from the lane formula (`laneW` plus a hard-coded 1.2 median). The two were independent sources of truth.

This mattered for verification: my first mutation reverted the *offset* formula, which reproduced nothing (1 incidental failure in a one-way case). The **accurate** mutation reverts the *width* to 11/16/24 and fails 4 tests with exactly the E02 numbers (`5.650 exceeds 5.500`, `15.600 exceeds 12.000`). Testing the wrong half of a two-part inconsistency is a trap worth recording.

**Fix (S01.3):** `src/roadProfiles.js` becomes the single dimension authority. `width = (forward + backward) * laneWidth + medianWidth + 2 * shoulderWidth`, and `laneCenterOffset(edge, dir, lane)` derives positions from the same record. `ROAD_CLASS.width`/`lanesPerDir`/`laneW` are now **recomputed from the profile model at module load**, so they cannot diverge again. Rendering (casing, shadow, fill, lane dashes, centreline, congestion overlay, road preview) and the roundabout radius all read the profile model.

Resulting widths: street 16.2, avenue 27.2, highway 39.2 wu. Verified in-browser: 12 lanes measured across all three classes, **0 containment violations**, worst case avenue lane 1 at 2.2 wu of slack inside the pavement (was 3.4 wu outside).

**Simulation is unaffected** because lane centres did not move: the 90-second soak is byte-identical to S01.2 (8 trips, 8 cars, 2% congestion, avg 33 s, XP 25.5361%). Only the drawn surface changed.

### E03 — Congestion EMA was timestep-sensitive, attenuated, and hid a gridlock (FIXED in S01.4)

`src/traffic.js:update`: old value multiplied by `.98`; input by `.02 * (dt * 60) * .05`. At 60 Hz with every car stopped, its equilibrium is **0.05**, not 1. HUD further rescaled by `/0.6`. Changing speed/dt changed the effective measurement.

**Fix (S01.4):** `alpha = 1 - exp(-dt / tau)` with `tau = 5`, exactly timestep independent (after simulated time T the value is `1 - exp(-T / tau)` however T was subdivided). Values clamp to 0..1 and represent a true stopped-vehicle share. The city figure in `src/metrics.js` is **weighted by vehicles present**, so a jammed road is not diluted by empty ones, and the `/0.6` HUD fudge is gone. Verified: 60/30/120 Hz agree within 1e-6, the closed-form value matches after a known duration, and reverting the old scaling fails 7 of 14 tests.

**The fix revealed a pre-existing gridlock.** The soak went from reporting 2% to 94%, so this was investigated rather than accepted. See E14.

### E04 — Signal ratio did not represent a real phase schedule (FIXED in S01.4)

`src/traffic.js:_mustYield`: after `greenLen` but before the end of a half-cycle, the selected axis returns `null` (go), except for a short preceding yellow condition. Probe at time 4, cycle 14, ratio .42 found no stop despite green length 2.94. `Renderer._drawNode` computed its own simpler half-cycle indicator and ignored yellow/clearance entirely.

**Fix (S01.4):** `src/signals.js` is the single phase authority. Per half-cycle: `green = half * greenRatio`, `yellow = min(2, (half - green)/2)`, `allRed = half - green - yellow`. For cycle 14 / ratio 0.42: green 2.94, yellow 2.00, all-red 2.06 — so t=4 is yellow and t=6 is all-red, where the old code allowed unrestricted passage. `greenRatio` is clamped to 0.05..0.90 so a clearance interval always survives; invalid cycles and non-finite times are rejected rather than producing a nonsense phase.

`_drawNode` now calls `getLegacyPhase` instead of its own comparison, so the dot can no longer show green while the simulator holds traffic. Verified by a **pixel-level browser test** sampling the junction centre at t=1 (green), 5 (yellow), 8 (all-red) and 11 (axis y green, so the dot is red).

A duplicate clock was removed at the same time: `main.js` kept a separate `simTime` counter that the renderer read, which is exactly how the two could disagree. The renderer now reads `traffic.time` directly. S04.4 replaces axis phases with movement phases; this stage keeps the conservative legacy shape so the fix stays focused.

### E05 — Crossing resolution silently stopped at six (FIXED in S01.5)

`src/roadNetwork.js:resolveCrossings`: loop limited to six iterations. Probe with eight parallel roads intersected by one new cross-road produced **six degree-four junctions**, not eight.

**Fix (S01.5):** `resolveCrossings` now walks a frontier of edges and keeps splitting until no crossing remains, bounded by `max(200, edges * 8)`. Each split replaces one edge with two, so the edge count strictly increases and the walk terminates. Budget exhaustion returns `false`, and the caller rolls the whole transaction back rather than accepting a partially resolved road.

Verified: `eightCrossingsWorld` reports **8 junctions** at `x = 0,100,200,300,400,500,600,700`; a 20-crossing fixture reports 20. Mutation (budget back to 12) fails 2 tests. The S00.3 characterization test was flipped from the observed 6 to the target 8, exactly as that test's comment specified.

### E12 — `addRoad` with multiple control points built malformed topology (FIXED in S01.5)

A four-corner closed loop drawn as **one** `addRoad` call **used to** produce **6 edges and 5 nodes** instead of 4 edges:

```
n1 (-250,30) degree=1     <- two SEPARATE nodes at identical coordinates
n8 (-250,30) degree=1     <- the loop never closes
n2 (150,30)  degree=6     <- a 6-way hub where a simple corner should be
```

Drawing the identical loop as four two-point calls gives the expected 4 edges and a clean degree-2 ring:

| Variant | edges | max degree | vehicles | stopped | trips | max wait |
|---|---:|---:|---:|---:|---:|---:|
| one `addRoad` call | 10 | 6 | 8 | **8** | 8 | 69s |
| four `addRoad` calls | 8 | 2 | 4 | 2 | **10** | 33s |

**Root cause:** each link passed `controls.slice(1, i)` as its midpoints, so later segments repeated earlier control points and overlapped; `resolveCrossings` then split them into spurious junctions.

**Fix (S01.5):** `addRoad` samples the whole control path once and segments it at real junctions and endpoints only, slicing the sampled polyline rather than re-splicing repeated control prefixes. A path returning to its own start is treated as a closed loop and reuses the first station node; `splitEdge` slices the polyline exactly and preserves one-way/ring metadata; failed constructions roll back completely.

**Result:** the loop is now **4 edges / 4 nodes, all degree 2**, and the one-call loop matches the four-call loop in node count and degree profile. Mutation (removing loop closure) fails 2 tests.

**Correction to my earlier claim:** this was a *contributor* to `GAP-loop-gridlock`, not the primary cause. Repairing it took the fixture from 8 of 8 vehicles stopped (92% congestion) to 3 of 7 (43% congestion), but a deadlock remains on the now-clean ring. The residual cause is E14 below.

### E14 — Mutual yielding at a degree-2 node deadlocked two-way traffic (FIXED in S01.5b)

A **bend is not an intersection**, but `TrafficSim._mustYield` applied intersection logic whenever `node.edges.size > 1`, which includes degree-2 nodes.

Reproduced in the four-building soak fixture with a clean degree-2 ring (so malformed topology was ruled out): car 7 sat on `e8 dir -1` wanting `e23`, and car 10 sat on `e23 dir 1` wanting `e8`. Both stopped 1.5 wu short of the same node and each waited for the other:

- **car 10** was held by the yield-to-the-right scan — `e8` counted as coming from its right, and cars 7/8 sat within 60 wu at under 3 wu/s
- **car 7** was held by the occupied-intersection-zone check — car 10 was within 10 wu of the node on a crossing axis, and `_crosses(a, b)` is simply `a !== b`

At a **corner** the two edges always have different axes, so `_crosses()` is always true and the occupied-zone check fires in both directions simultaneously. Two opposing cars on a two-way road therefore blocked each other permanently.

**Impact:** gameplay-breaking for small cities, and previously **invisible** because the broken congestion metric reported about 2% while every vehicle was stopped (E03). The S01.4 metric fix is what made it observable.

**Fix (S01.5b):** `_mustYield` exempts degree-2 nodes from the cross-traffic logic — both the occupied-zone check and the yield-to-the-right scan. A bend has no cross traffic to yield to.

**Deliberately NOT exempted:** the anti-gridlock check ("do not enter a continuation that is jammed at its start") still applies at degree-2 nodes. Once a car crosses the node it belongs to a different `(edgeId, dir, lane)` group, so per-lane car following cannot see the stopped car ahead and a rear-end overlap would become possible.

| Metric (four-building fixture, 270 sim seconds) | Before S01.5 | After S01.5 | After S01.5b |
|---|---:|---:|---:|
| vehicles stopped | 8 of 8 | 3 of 7 | **0 of 3** |
| completed trips | 8 | 8 | **11** |
| max wait | 69 s | 131 s | **0.1 s** |
| city congestion | 92% | 43% | **1.4%** |

The 90-second soak agrees: **11 trips and 1% congestion with XP 35.1%**, versus 8 trips / 43% / 25.5% before this fix. Congestion no longer climbs over time, which is the signature of a permanent deadlock clearing.

**Mutation-verified:** reverting the exemption fails 1 test; removing the anti-gridlock check fails 1 test. `scripts/diagnose-gridlock.mjs` now exits 0.

**Process note:** S01.4 and S01.5 both deferred this to S04.2 on the reasoning that S04.2 replaces the yielding model wholesale. That deferral was wrong for the deadlock itself — it is a correctness bug, not a modelling preference, and a two-line exemption plus five tests resolved it without conflicting with the planned connector work. The lesson: "a later stage rewrites this area" justifies avoiding a *redesign*, not tolerating a known deadlock.

### E06 — Simulation randomness made the world non-reproducible (fixed in S01.1)

Seeded terrain gave the impression of a deterministic game, but the simulation used `Math.random` directly: `Car.maxSpeed = 12 + Math.random() * 4` (assigned and never read), spawn colour, and lane choice. Graph IDs came from `uid()` (also `Math.random`), so every load produced different IDs. A seed therefore fixed geography only.

S01.1 replaces these with an injectable seeded RNG (`TrafficSim(net, {rng})`), a world-owned `createIdSource()`, and removal of the unused `maxSpeed` field. Verified by a browser probe: two runs of seed 1 with identical input produce identical node IDs (`n1,n2,n4`), edge IDs (`e10,e11`) and buildings. `makeRng` gained `getState`/`setState` without changing its output sequence, protected by a golden-value test.

### E07 — `traffic.time` advanced twice per frame (fixed in S01.1)

The old loop did `simTime += dt; traffic.time = simTime; traffic.update(dt)`, and `TrafficSim.update` increments `this.time` again. Simulation time therefore ran at roughly double the requested rate, and the renderer's traffic-light indicator used a different clock from the one the simulator consulted.

S01.1 makes `traffic.time` the single simulation clock, driven by the fixed-step accumulator; the renderer reads it directly. Verified in-browser: pause is frozen (0), and measured ratios are exactly 3.00x and 8.00x at the 3x and 8x settings, with 1x advancing about 1s per wall second. S01.4 removed the last duplicate `simTime` counter.

### E08 — Residual distance discarded at edge boundaries (fixed in S01.1)

The route-advance step did `car.step++; car.s = 0`, discarding any overshoot. Over a long trip this silently shortens every journey and desynchronises vehicles from the travel time the router promised.

S01.1 subtracts the completed edge length instead of zeroing, bounded by route length, with zero-length edges treated as invalid rather than looped. Verified: a car 5 wu before a boundary travelling 15 wu ends at s ~ 10 on the next edge, and path progress stays continuous across 12 transitions.

### E09 — Segments shorter than 18 wu cannot be built (partially fixed in S01.5; open)

`NODE_SNAP = 18`, and `_snapPoint` is applied to the final control point, so a segment shorter than 18 wu snaps its far endpoint back onto the existing node.

**Originally** `addRoad` returned `{nodeIds: [], edgeIds: []}` and created nothing — a silent no-op with no way for the caller to explain the failure.

**S01.5 closes the silent half:** `addRoad` now returns a `reason` string: *"the road is shorter than the snapping distance (18 wu), so its ends would land on the same node"*. A rejected path also rolls back completely, leaving the graph byte-identical.

**Still open:** short segments cannot be **built**, which S04.3 needs for slip lanes and auxiliary segments. That requires direction-aware snapping or an explicit override — a better error message is not enough. Owned by **S03.2** (snapping model), consumed by S04.3. Tracked as `GAP-min-segment-length`.

### E10 — Building IDs stayed random after S01.1 (fixed in S01.1 follow-up)

S01.1 made node and edge IDs deterministic by giving `RoadNetwork` a world ID source, but `Economy.place` still called `uid()` directly at `src/economy.js` — the economy never received the ID source. Building IDs therefore remained random (`1hh2d292` vs `3ibfvlaa` across two identical builds), while nodes and edges were stable.

Anything keyed by building ID was non-reproducible: save/load identity, pending-return targets (which S01.2 depends on), reachability caches, selection state, and fixture assertions.

**This was missed by the S01.1 verification probe**, which compared buildings as `type@x,y` strings instead of by ID. The probe passed while the underlying IDs were still random — a lesson in choosing comparison keys that can actually detect the defect. The follow-up probe compares `buildingIds` directly, and a permanent browser guard asserts ID *format* (`/^b\d+$/`), which fails immediately if `uid()` returns.

Fix: `Economy._newBuildingId()` reads `net.ids` **live** rather than caching it in the constructor, because the save/load path attaches the ID source to the network after the economy is deserialized. `main.js` also reserves loaded building IDs. Verified by mutation: reintroducing `uid()` fails the unit suite (2 failures) and the browser guard (1 failure).

### E11 — Building rotation used Math.random (fixed in S01.1 follow-up)

`main.js` assigned `b.rot = (Math.random() - 0.5) * 0.5` (±0.25 rad, ±14.3°), consumed only by `Renderer._drawBuilding` via `ctx.rotate(rot)`.

**Impact:** purely cosmetic. Nothing in simulation, routing, collision, driveway attachment or overlap checking reads `rot`. It is persisted per building (the serializer spreads the building record), so it round-trips correctly. The real cost was that rendered output differed between runs of the same seed, which would make golden-image visual regression checks — needed by S02 and S08 — flaky.

Fix: `rot` is drawn from a **separate cosmetic RNG stream** (`Economy.cosmeticRng = makeRng(seed ^ 0x9e3779b9)`), as CONTRACTS.md §2 requires. Drawing it from the simulation stream would shift every later `tripTimer` draw and silently retune demand pacing; that was observed during this fix (soak moved from 10 to 12 trips) before the stream was split. After splitting, the 90-second soak is byte-identical to the pre-change baseline (10 trips, XP 31.9201%, avg 35 s), proving the simulation stream is untouched.

### E13 — Pending returns are not persisted (open, tracked)

`Economy.toJSON()` serializes buildings, xp, level, batch and totalTrips, but not `_pendingReturns`, `cancelledReturns` or `cancellationReasons`. `fromJSON` builds a fresh instance, so the queue starts empty. Saving during the dwell therefore drops the queued return trip — no crash and no corruption, the trip is simply lost.

Owned by **S01.7**, which introduces the full snapshot including pending returns, clocks and RNG state. The plan explicitly defers this so S01.7 does not have to undo a partial implementation. Two characterization tests in `test/returnDispatch.test.js` pin today's behaviour, and `GAP-pending-returns-not-saved` tracks it in the ledger.

## Source findings still requiring regression reproduction

Status of each item from the original survey, updated as stages land.

- **OPEN** `main.js:finishRoad` validates only clicked control points; a straight segment over water with two land endpoints can pass. S01.5 added explicit `reason` reporting to `addRoad`, but segment-level terrain validation is still owned by S03.2.
- **FIXED in S01.5** `RoadNetwork.addRoad` reused `controls.slice(1, i)` per link, so later links revisited earlier control points (E12).
- **FIXED in S01.5** `splitEdge` recreated edges without copying one-way/ring properties; metadata is now preserved and the polyline sliced exactly.
- **OPEN** `attachDriveway` stores one `drivewayFor` on a possibly shared road node, so a second building can replace ownership. Owned by S01.6.
- **OPEN** `main.js:bulldoze` contains an always-house refund expression in its driveway branch; it must use the removed building's type. Owned by S01.6.
- **FIXED in S01.1** `Car.maxSpeed` was random but unused; lane choices and IDs also used `Math.random` (E06).
- **FIXED in S01.1/S01.4** `main.js:loop` preassigned `traffic.time` then `traffic.update` incremented it again; the duplicate `simTime` counter is gone (E07). Route advance no longer resets `s` to 0 and lose residual movement (E08).
- **OPEN** Live topology edits can remove current/next edges; cars become dead without economic cancellation accounting or rerouting. Owned by S01.6.
- **OPEN** `save.js` has a single v1 key; schema/version/reference checks are absent; active vehicles, pending returns and RNG state are omitted. Owned by S01.7.
- **OPEN** `Renderer.showCongestion/showPollution` are never changed by available controls; `exportGame` and `setAudioEnabled` are not wired to user controls. Owned by S02.2.
- **OPEN** DOM help is not a focus-trapped dialog; global shortcuts only exempt INPUT. Owned by S02.5.
- **OPEN** Near-global car scans in intersection/spawn logic and a linear A* frontier are scale risks, not measured performance failures yet. Owned by S04.5/S08.1.

## Status of `uid()` after S01.1 follow-up

`uid()` (Math.random-based) now has exactly one caller: the fallback in `RoadNetwork._newId`, used only when a `RoadNetwork` is constructed with no ID source. The game always supplies one (`new RoadNetwork({ ids })`), so node, edge and building IDs are deterministic in play. The fallback exists so the many existing tests and fixtures that construct a bare `new RoadNetwork()` keep working, and so legacy v1 IDs remain loadable. It is not dead code, but it is a legacy path — new world construction should always pass an ID source.

## Prior Art: reuse decision

| Existing component | Decision | Why |
|---|---|---|
| `core.js` interpolation, projection, RNG | Extend | Useful primitives; add reproducible state and continuous sampling tests |
| `RoadNetwork` Maps, version, serializer | Extend | Preserve identities and callers; add safe transactions, profiles, connectors and grade metadata incrementally |
| `findPath`, `pathToSteps` | Extend then adapt | Retain node-path compatibility initially; explicit edges/lane steps later avoid ambiguity |
| `TrafficSim`, following / yield tests | Extend | Existing behavior worth protecting; replace phase, lane and conflict logic in vertical slices |
| Canvas renderer / DOM UI | Extend | Suitable browser-first base; fix geometric truth before adding polish |
| Node test runner + Playwright | Adopt | Already installed; no new framework required for deterministic unit/integration/UI checks |
| Browser JSON/Blob/localStorage/IndexedDB | Compose only when needed | JSON + localStorage sufficient initially; use IndexedDB only if measured save sizes require it |
| Simulation engine or geometry package | Do not adopt now | No measured gap justifying migration; use a separately approved spike if robust offset polygons exceed local implementation confidence |

No new package registry dependency is recommended. Therefore no installation, registry migration or package API assumption is embedded in the execution tasks.
