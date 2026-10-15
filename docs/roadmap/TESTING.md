# Verification plan and fixture catalogue

## 1. Current versus planned commands

**Available now (after S01.7):**

```text
npm test              # unit suite only, browser-free (fast)
npm run test:browser  # Playwright smoke with gameplay assertions
npm run test:soak     # assertive economy soak (SOAK_SECONDS to shorten)
npm run test:playtest # visual capture tour -> artifacts/<run-id>/
npm start             # static server
node scripts/diagnose-gridlock.mjs   # exits 1 if any vehicle deadlocks
node scripts/verify-backup.mjs <dir> # checkpoint manifest verification
```

`npm test` reports **418 passes** and `npm run test:browser` **59**, as of S02.5b. Those counts only ever grow: every task adds tests and none may be removed or weakened. Browser scripts spawn their own server on a free port and tear it down themselves, so no pre-running `localhost:8080` is required. Set `BASE_URL` to reuse an existing server instead; the harness then owns nothing and kills nothing.

`launchGame` accepts `deviceScaleFactor`, so a DPR 2 check is one option rather than a separate harness. The standing capture pass now includes desktop 1440x900 at DPR 2, compact 1024x768 at DPR 2 and wide 1920x1080 at DPR 1 (TESTING.md section 6), and asserts geometry rather than only producing images.

`node scripts/contact-sheet.mjs` is a review artifact, not a test: it builds the twelve DESIGN section 3 scenes through the real controls, freezes the clock, captures each to `artifacts/<run-id>/sheet/`, and asserts only that every scene built at least one road and produced no browser errors. Inspect the images; the assertion only prevents an empty capture from being mistaken for a pass.

### Pitfall: verify a backup manifest from inside the backup

`sha256sum -c MANIFEST.sha256` resolves relative paths against the **current working directory**. Running it from the project root checks the live tree instead of the backup, so files edited after the backup was taken report as mismatches. That looks like corruption but is a measurement error — it happened once during S00.1 and produced a false "41 of 42" reading.

Use the path-independent verifier instead, which resolves every entry against the backup directory:

```text
node scripts/verify-backup.mjs C:/Users/patri/roadflow-backups/<checkpoint>
```

It exits 0 only when every manifest entry hashes correctly, 1 on any mismatch or missing file, 2 on usage error.

### Pitfall: browser runs must not reuse a stale artifact directory

`RF_RUN_ID` names the artifact directory. Reusing a name overwrites previous captures, so goldens cannot be compared across runs. Omit it for a timestamped directory, or use a fresh name per comparison.

### Pitfall: mutation-check every non-trivial guard

A test that passes proves nothing until you have seen it fail for the right reason. The discipline used throughout stage 01:

1. write the fix and its tests
2. revert the fix in the working copy (a `// MUTATION:` marker makes it easy to spot)
3. confirm the expected tests fail
4. restore and confirm they pass again
5. verify no marker survives: `grep -rn MUTATION src/`

**An ineffective mutation is not proof.** Stage 01 produced three that had to be replaced rather than counted:

- *unreachable* — mutating `loadFromSave` did nothing because the menu handler's validation probe guards that path, so the mutated line never ran
- *incomplete* — defaulting a missing schema version left the real future-version guard intact, so the test still passed for an unrelated reason
- *wrong half* — reverting the lane *offset* formula reproduced nothing, because the actual defect was the pavement *width*; only the width mutation failed the containment tests

When a mutation passes, decide which of these applies before concluding the test is weak, and report the distinction rather than quietly dropping the check.

### Pitfall: a fixture click can silently land on interface chrome

`soak.js` used to place its buildings by clicking hardcoded screen pixels derived from the canvas centre. S02.2 made the bottom dock taller (about 48px to 124px), the factory click landed on a dock button, the factory was never placed, and trips fell from 11 to 6. **The soak still passed**, because it asserted the house and shop batches but never the factory.

Two rules follow, and both are now enforced in the code:

1. Express fixture positions in **world units** and convert with `renderer.worldToScreen`, so a layout change cannot move the target. This is the same rule as "do not use screen coordinates as permanent graph IDs" above.
2. **Assert every fixture element exists**, not most of them. A fixture that half-builds a city can still satisfy a weak assertion.

`soak.js` now calls `elementFromPoint` before each click and fails with the covered element named:

```text
factory 1: fixture point [-150,270] maps to screen (490, 670), which is covered by
"subtools" instead of the map. Move the fixture point or the panel.
```

Verify that guard in the red direction whenever a panel changes size.

### Pitfall: a DPR 1 fixture cannot see a unit mismatch

`worldToScreen` returned DEVICE pixels while `screenToWorld` took CSS pixels, so they were not inverses. At DPR 1 the two coincide, so every test passed. At DPR 2 the round trip was off by **850-2963 wu**, and `_drawToolPreviews` mixed a CSS-pixel `mouseScreen` (from `e.offsetX`) with a device-pixel projection, so tool badges were misplaced on every HiDPI display.

Two rules follow:

1. Name the unit in the function: `worldToDevice`, `worldToCss`, `cssToWorld`, `deviceToCss`. A bare `worldToScreen` invites exactly this confusion.
2. Run the check at **DPR 2** as well as DPR 1. `launchGame({ deviceScaleFactor: 2 })` is one option.

`node scripts/diagnose-projection.mjs` re-measures the round trip at both DPRs and prints the worst error; it should be 0 wu.

### Pitfall: one silhouette rule per assertion

Three separate S02.4c rules each caught a different defect, and none of them would have caught the others:

- 'the three variants of a type differ' caught a variant reusing another's geometry
- 'every variant carries a filled shape' caught factory variants drawn as bare strokes
- 'entry details sit on the +x side' caught the factory chimney facing away from the road

Write the rule as its own assertion, and make it fail on the specific thing it names.

### Pitfall: an axis-aligned fixture hides the other axis

The terrain contour originally checked only the neighbour to the RIGHT in x. A horizontal shoreline — water above, grass below — drew no line at all while a vertical one did, and no test noticed, because every fixture boundary was vertical. The same blind spot appeared in S02.3b, where a straight-edge fixture could not detect a direction sign error because the two ends produced the same polygon.

When a function behaves differently along x and y, the fixture must exercise BOTH axes. One vertical boundary and one horizontal boundary is the minimum.

### Pitfall: an even offset cannot tell centre sampling from corner sampling

A raster sampled at pixel CENTRES classifies a boundary at 256 wu one pixel earlier than one sampled at CORNERS. But that difference is only observable when the boundary sits at an ODD world offset: with a step of 2 wu, centres land on odd wu and corners on even, so at an even boundary the two classify identically and a test asserting the mapping is vacuous.

Place boundary fixtures at odd offsets when the assertion is about exactly which pixel a transition lands on.

### Pitfall: the identity tile hides an origin bug

Tile (0,0) starts at world x=0, so a mutation that clamps the tile origin to zero is invisible against it — the clamp is the identity. Any assertion about per-tile addressing needs a tile whose origin is NOT zero; a negative tile is the clearest case.

### Pitfall: an incomplete mutation looks like a weak test

Mutation N of S02.4a removed the minimum-span clamp from `fitBounds`'s X axis and came back NO FAILURE. The clamp is enforced **per axis** and the fit takes the smaller of the two axis ratios, so:

- in **landscape** (width >= height) the Y axis decides the zoom, and removing X's clamp changes nothing — a genuine no-op
- in **portrait** (width < height) the X axis decides, and removing its clamp changes the zoom

Every viewport we tested was landscape, so the X-axis clamp was unobservable. It is **not** dead code: DESIGN section 1 names 768x1024, and portrait is the only orientation where it is load-bearing. The fix was to add a portrait fixture, after which the X-only mutation fails as required.

So before concluding a test is weak, ask **which input makes the mutated line observable**. If the answer is "none of our fixtures", the suite has a coverage gap rather than a weak assertion. The harness supports multi-part mutations via a `parts` array when several lines must change together.

This is distinct from S02.3a, where two mutations really were redundant for every input and were proven so by deleting the branches.

### Pitfall: a round stroke cap at a junction IS the circular disk

DESIGN forbids painting "a circular disk over every junction at every scale". It is easy to think you are not doing that when no code draws a circle. But every edge was stroked with `lineCap = 'round'`, and all edges at a node share that node's centre — so the union of round caps at a junction is exactly a disk of radius = the widest connected pavement. A wide avenue meeting a narrow street painted a blob wider than the street.

The fix is `capForNode(degree)`: round for a degree-2 BEND (where the pavement genuinely curves), square for 3+ (where the junction's own footprint supplies the fill).

Same trap for shadows: an offset applied inside `ctx.rotate(rot)` rotates with the object. Use `offsetInRotatedFrame` to keep one fixed screen direction.

### Pitfall: a missing pointer-cancel handler is invisible until someone alt-tabs

The pointer handlers had **no** `pointercancel`, `lostpointercapture` or window-blur listener, so a pan interrupted by an alt-tab left the pan state set and the map dragged with no button held. No test noticed, because a browser test that never alt-tabs never cancels a pointer.

Dispatch the events explicitly:

```js
document.getElementById('game').dispatchEvent(new PointerEvent('pointercancel'));
window.dispatchEvent(new Event('blur'));
```

And release Playwright's held buttons afterwards (`page.mouse.up`), or the later clicks are swallowed by Playwright's button-state tracking rather than by the game.

### Pitfall: a tautological assertion moves both sides together

A mutation that sets a constant to 0 will not fail a test written as `assert.equal(f(x), base + CONSTANT)`, because both sides become `base`. Assert the property POSITIVELY instead:

```js
assert.ok(CONSTANT > 0, 'the margin must be a positive clearance');
assert.ok(trim > widest, 'the trim must exceed the widest pavement');
```

Three of the twelve S02.3b mutations came back ineffective for reasons like this. All three were gaps in the tests, not redundant code — two others in S02.3a were genuinely redundant and were proven so by deleting them. Distinguish the two cases before dropping a mutation.

A related trap: a mutation may satisfy the CONTRACT too. 'The variant uses a different deterministic hash of the id' is untestable, because the contract is only that the variant is deterministic in the id — no test can tell two conforming hash functions apart. Drop such mutations rather than counting them. One of the ten S02.4c mutations fell into this category.

A third trap: an assertion about WHICH PIXEL a transition lands on needs the boundary at an ODD offset, and an assertion about per-tile addressing needs a tile whose origin is not zero. See the two pitfalls below.

### Pitfall: a symmetric fixture cannot detect a sign error

`edgeDirectionAt` reads the polyline from whichever end touches the node. A straight edge is symmetric, so reading the wrong end produces the same direction and every test still passes. Detecting it needs a fixture whose edge BENDS just after the junction.

When a function has a branch on "which end am I at", the fixture must be asymmetric.

### Pitfall: a screenshot is not evidence that something was drawn

The avenue centreline was **never drawn on a straight road**, and survived many sessions of screenshots. `_pathPolylineTrimmed` kept only existing vertices that fell inside the trim, so on a two-point road (`cum = [0, 450]`) both endpoints were outside the range and nothing was stroked at all. It only worked on curved or multi-point roads, which is what every earlier screenshot happened to show.

No test asserted that a marking exists, only that its geometry was consistent, so a missing marking was invisible to the suite.

When a change is about whether something is *drawn*, sample the canvas rather than looking at a PNG:

```js
const d = ctx.getImageData(x, y, 1, 1).data;   // rgb(248,231,166) = the centreline
```

A pixel probe caught in one run what visual inspection had missed for several sessions.

### Pitfall: an overlay must name the field it reads

`src/render.js` carried a `_drawPollution` method that painted a fixed 620wu radial gradient around every factory, with hardcoded colours and **no simulated pollution field anywhere in the codebase**. Nothing ever set its flag, so it was unreachable as well as invented. Wiring the S02.2 Pollution toggle to it would have shown a player fabricated values, which DESIGN section 5 forbids.

Every layer in `src/layers.js` now declares a `dataSource`, and two tests fail if a layer claims a field the simulation does not compute:

- `test/layers.test.js` — no layer may name a pollution, noise, environment or emissions source
- `test/browser/ui.js` — the renderer must not expose `_drawPollution` or `showPollution`

When a layer is requested and no data exists, defer it to the task that owns the data. Do not draw a plausible-looking stand-in.

### Pitfall: browser tests share one page and leak state

`test/browser/smoke.js` runs its cases against a single page in declaration order, so an earlier case can pollute a later one. Two real leaks occurred during S01.7:

- a shop placed by one test made a later "no shop remains" assertion fail — scope assertions to the specific entity (by id), not to global counts
- toast assertions picked up messages left by earlier cases — clear `#toasts` before acting when the assertion is about what the UI just said

Also freeze the clock (`[data-speed="0"]`) before any assertion that compares positions across a save/load, or the running simulation races the comparison.

### Pitfall: `ctx_batch_execute` and `ctx_execute` run shell through PowerShell here

`&&`, `||`, backticks and `$(...)` fail or mangle output there. Use the `bash` tool for pipelines, greps and anything containing quotes or backticks. A PowerShell parse error is not a failing test.

**Created during execution:**

| Command | Owning task | Runs |
|---|---|---|
| `npm run test:browser` | S00.2 | **Created.** Node assert-based Playwright smoke; extend the runner to include later browser files |
| `npm run test:browser` | S02.1 | **Extended.** test/browser/ui.js: ui.css tokens vs uiTokens.js, measured contrast ratios, icon-map shape, emoji-free controls, real inventory badges, focus ring and reduced motion, depleted stock, inspector title, plus 60 tool-state captures at 1440x900 and 1024x768 |
| `node scripts/mutate-s021.mjs` | S02.1 | Mutation harness for the S02.1 guards; applies each mutation, runs test/browser/ui.js, restores the file and prints which tests failed |
| `npm run test:browser` | S02.4a | **Extended.** test/browser/ui.js gains the DPR1/DPR2 projection check, starter-region framing, Fit via button and shortcut, pointer-anchored zoom, and the HiDPI/wide capture matrix |
| `npm run test:browser` | S02.5b | **Extended.** test/browser/ui.js gains a dialog-semantics test (help role=dialog aria-modal, menu role=menu, toasts role=status aria-live=polite) and a light-inspector test (every slider has a for= label association and an aria-label, with three distinct names) |
| `node scripts/mutate-s022a.mjs` | S02.2a | Mutation harness for the S02.2a guards (10 mutations, 10 caught) |
| `node --test test/layers.test.js` | S02.2b | **Created.** Overlay model: layer declarations name a real data source, traffic bands and thresholds, per-edge traffic rows, building reachability, one-overlay-at-a-time. Pure, no browser |
| `node scripts/mutate-s022b.mjs` | S02.2b | Mutation harness for the S02.2b guards (12 mutations, 12 caught after one ineffective target was replaced) |
| `node --test test/renderMarkings.test.js` | S02.3a | **Created.** Lane marking geometry: low-zoom dash gate, divider offsets and pavement containment, centreline visibility, trim growth and clamping, polyline trimming with interpolation, lane offsetting perpendicularity, degenerate input. Pure, no canvas |
| `node scripts/mutate-s023a.mjs` | S02.3a | Mutation harness for the S02.3a guards (10 mutations, 10 caught; two further targets were proven redundant and removed rather than counted) |
| `node --test test/junctions.test.js` | S02.3b | **Created.** Junction cap style, footprint quads at each own width, the inset, per-end mouth trim from the widest connected pavement, edge direction at a node, shadow direction and counter-rotation. Pure, no canvas |
| `node scripts/contact-sheet.mjs` | S02.3b | **Created.** Review artifact: the twelve DESIGN section 3 scenes at 1440x900, frozen clock, each asserted non-empty. Inspect the images |
| `node scripts/mutate-s023b.mjs` | S02.3b | Mutation harness for the S02.3b guards (12 mutations, 12 caught after three ineffective targets exposed test gaps that were then fixed) |
| `node --test test/camera.test.js` | S02.4a | **Created.** Projection round trip at five view descriptions and five zooms, device/CSS relationship, zoom clamping, pointer-anchored zoom, world bounds, fit framing with margin and minimum span, starter-region determinism/buildability/ordering/fallback. Pure, no canvas |
| `node scripts/mutate-s024a.mjs` | S02.4a | Mutation harness for the S02.4a guards (22 mutations, 22 caught; supports multi-part mutations) |
| `node --test test/terrain-view.test.js` | S02.4b | **Created.** Chunked terrain: tiling bounds, visible rect and tile counts at every viewport and zoom, per-tile raster mapping and opacity, contour on both axes, determinism and the no-unseeded-randomness rule, the bounded LRU cache, seeded decoration. Pure, no canvas |
| `node scripts/mutate-s024b.mjs` | S02.4b | Mutation harness for the S02.4b guards (17 mutations, 17 caught after three genuinely unobservable targets were made observable) |
| `node --test test/buildings-view.test.js` | S02.4c | **Created.** Building silhouettes: variant determinism and range from the id, entry angle toward the driveway and its null cases, geometry for every (type, variant) with distinct shapes, footprint containment, entry-side placement of door details, determinism and the no-unseeded-randomness rule. Pure, no canvas |
| `node scripts/mutate-s024c.mjs` | S02.4c | Mutation harness for the S02.4c guards (10 mutations, 9 caught; one proven untestable and dropped) |
| `node --test test/input.test.js` | S02.5a | **Created.** Pointer intent, pan camera, draft-point dedup, the PointerTracker state machine, input-mode derivation, form-control detection, keyboard scoping (form controls, dialogs, panels, Space on a focused button, Enter with and without a draft, known keys). Pure, no canvas |
| `node scripts/mutate-s025a.mjs` | S02.5a | Mutation harness for the S02.5a guards (14 mutations, 14 caught) |
| `node --test test/preview.test.js` | S02.5b | **Created.** Preview placement validity: valid, no-stock, terrain, overlap (the bug), road-reach (the bug), just-inside-reach, and preview-agrees-with-commit for every failure mode. Pure, no canvas |
| `node scripts/mutate-s025b.mjs` | S02.5b | Mutation harness for the S02.5b guards (7 mutations, 7 caught) |
| `node scripts/probe-buildings.mjs` | S02.4c | **Created.** Captures the building silhouettes close up and reports the variant each building wears |
| `node scripts/probe-terrain.mjs` | S02.4b | **Created.** Measures chunking in the real renderer: tiles drawn vs generated, cache occupancy across a pan sweep, regeneration on revisit. Steady state should be 0 generated |
| `node scripts/diagnose-projection.mjs` | S02.4a | **Created.** Measures the world<->screen round trip at DPR 1 and DPR 2 across zooms and prints the worst error. Should be 0 wu |
| `npm run test:soak` | S00.2 | **Created.** Assertive economy browser soak |
| `node --test test/simulationClock.test.js` | S01.1 | **Created.** Fixed-step clock, pause, stall dropping |
| `node --test test/coreState.test.js` | S01.1 | **Created.** RNG state, ID source, deterministic graph IDs |
| `node --test test/trafficAdvance.test.js` | S01.1 | **Created.** Residual distance, seeded spawns |
| `node --test test/buildingIdentity.test.js` | S01.1b | **Created.** Deterministic building IDs, cosmetic RNG stream |
| `node --test test/returnDispatch.test.js` | S01.2 | **Created.** Return-trip dispatch and lifecycle |
| `node --test test/roadDimensions.test.js` | S01.3 | **Created.** Profile-derived pavement and lane containment |
| `node --test test/signals.test.js` | S01.4 | **Created.** Phase schedule and clearance intervals |
| `node --test test/congestion.test.js` | S01.4 | **Created.** Timestep-independent congestion metric |
| `node --test test/construction.test.js` | S01.5 | **Created.** Road paths, crossings, splits, failure rollback |
| `node --test test/bendYielding.test.js` | S01.5b | **Created.** Degree-2 bends vs real junctions |
| `node --test test/access.test.js` | S01.6 | **Created.** Shared driveway ownership, placement evaluation |
| `node --test test/live-edit.test.js` | S01.6 | **Created.** Reroute/cancel reconciliation |
| `node --test test/save.test.js` | S01.7 | **Created.** Snapshot validation, migration, restore fidelity |
| `node --test test/worldCommands.test.js` | S03.1 | Atomic commands/history |
| `node --test test/lane-routing.test.js test/junctions.test.js` | S04.2 | Legal connector paths/reservations |
| `node --test test/grades.test.js` | S05.1 | Grade-aware topology |
| `node --test test/demand.test.js test/logistics.test.js` | S06.2 | Demand and goods conservation |
| `node --test test/scenarios.test.js` | S07.1 | Scenario/reference solutions |
| `node test/performance/benchmark.js` | S08.1 | Performance reports, not default unit suite |
| `node scripts/package-browser.js` | S08.3 | Local distribution only |

Do not run a future command and then interpret 'file not found' as a baseline failure. Its owning task must create it first. Default unit glob excludes browser/performance scripts by using `.test.js` only for Node-only tests. Browser runner explicitly imports its suites; adding a browser file without registering it is not coverage.

Windows shell note: Bash tool supports Bash; context-mode shell may use Windows PowerShell. Avoid `&&`, `tail`, `head`, `cat`, heredocs in PowerShell scripts. Use Node child_process with explicit cwd, or separate commands. Check runner before execution. Do not use `taskkill /IM node.exe`; only terminate server/browser processes launched by the current harness, in finally.

## 2. Test layers

1. **Pure unit tests:** geometry, dimensions, RNG, phase timing, route costs, validation, inventory and objectives. Seeded inputs, no timers/DOM/network.
2. **Headless world integration:** complete jobs from generated demand through vehicles/connectors and arrivals, topology edits, saves, replay. Tick exact STEP; normal completion is measured, not invoked directly.
3. **Browser interaction:** player input causes real graph/economy/UI state changes. Debug hook is read-only observation/fixture loading, not the only way a feature works.
4. **Visual checks:** fixed scene/camera/time/viewport/DPR; compare artifact then human rubric. Pixel difference alone cannot approve style.
5. **Stress/performance:** deterministic command/demand trace plus conservation and latency metrics; passing FPS with fewer admitted journeys is a failure.
6. **Human play:** discovery, readability and pacing. Test reports never substitute for people when claiming fun or better usability.

## 3. Regression rules

- Fixes start with failing tests proving the specific bug. A failed import is not proof of the behavior bug; create new API scaffold only as needed, then exercise behavior.
- New complicated algorithm receives simple, boundary, adversarial and roundtrip cases.
- Existing assertions may change only when documenting intentional corrected behavior (e.g. lane width). Do not delete tests because a rewrite does not fit them.
- No sleep-based unit tests, nonseeded Math.random, unbounded while-until-arrival loop, or forcing XP to test the whole economic pacing loop. Forced XP is acceptable only for a narrowly named threshold-unit test.
- Time limits: unit test<=2s normally; integration fixture<=20s CPU; browser suite<=120s unless designated soak. If exceeded, report and profile, not arbitrarily raise timeout.
- Prevent tests that assert nothing: count assertions where useful, validate fixture setup before behavior. `assert.ok(house && shop)` before route checks.
- Error collection includes uncaught browser exceptions, console errors and failed required runtime resources; expected failure UX tests explicitly scope/suppress only the expected error.

## 4. Core assertions and acceptance oracles

### Topology

`assertGraphConsistent` checks reciprocal adjacency, endpoints, finite samples, positive lengths, metadata and access ownership. For grade stage it also checks endpoint heights and same-grade connector references. Snapshot serialization must not convert invalid references into an apparently valid empty graph.

### Geometry

Use an independent distance calculation/test oracle, not the exact production helper under test. Sample parent and split-child paths at1wu intervals; maximum distance<=0.5wu and total-length error<=1% for split operation. Lane envelope checks both car sides, all lanes/directions and tight but permitted curves. Negative result rejects construction before mutation.

### Traffic conservation

Per admitted simulation trace:

```text
admitted = active + completed + cancelled
requested = pending + active + completed + cancelled + refused
```

Define counting unit: physical vehicle trips until S06.1; Journey records after S06.1. Do not mix completed return vehicle legs with served person requests. Transit passengers use Journey accounting independent of bus vehicles. A counted cancelled trip has exactly one reason; deleted cars without an event fail conservation.

### Spacing and conflict

- On same lane, next.s-current.s >=0.5*(current.length+next.length)+MIN_GAP minus integration tolerance0.25wu.
- Lane changing occupies both lanes and has front/rear checks.
- Junction/grade crossing checks swept vehicle corridors and exclusive conflicting reservations.
- `speed>=0`, position/time finite, route refs legal, no opposite-direction travel on zero-lane side.
- A gridlocked designed demand case may queue; a fixture with free downstream space cannot leave the same eligible movement blocked forever. Bound fixture completion window explicitly.

### Persistence

Uninterrupted run A versus save/hydrate run B at tick1200; both receive same future1000ticks and command trace. Compare normalized state: IDs, timers, route/lane positions, inventory, RNG/counters, pending jobs, signal phases. Float tolerance1e-6; wall timestamp/camera animation excluded. Every schema migration has input fixture and expected normalized fields.

### Signal boundary test pattern

```js
// getLegacyPhase introduced in S01.4.
const L = { cycle: 14, greenRatio: 0.42, offset: 0, axis: 'x' };
assert.equal(getLegacyPhase(L, 0).state, 'green');
assert.equal(getLegacyPhase(L, 3).state, 'yellow');
assert.equal(getLegacyPhase(L, 6).state, 'allRed');
assert.equal(getLegacyPhase(L, 7).axis, 'y');
```

Note: green2.94s, yellow2s, so time4 is **yellow**, not all-red. The old E04 probe only established that the implementation allowed unrestricted go after green ended. Tests must follow the newly chosen contract, not mislabel the observed phase. This explicit boundary example takes precedence over any colloquial 'after green' description.

### Browser save-failure pattern

```js
const before = await page.evaluate(() => ({
  count: window.__rf.state.net.edges.size,
  pop: window.__rf.state.eco.population(),
}));
// Use Import file control with invalid fixture, then wait for error status.
const after = await page.evaluate(() => ({
  count: window.__rf.state.net.edges.size,
  pop: window.__rf.state.eco.population(),
}));
assert.deepEqual(after, before, 'failed import must not replace city');
```

Tests additionally compare full normalized world through the test adapter so equal counts cannot hide changed IDs/topology.

## 5. Named fixture matrix

Implemented in `test/fixtures/worlds.js` (builders) and `test/helpers/invariants.js` (validators) by S00.3. Import them instead of inventing coordinates:

```js
import { serviceWorld, crossWorld, loadLegacyV1 } from './fixtures/worlds.js';
import { assertGraphConsistent, assertVehiclesFinite, assertEconomyConsistent } from './helpers/invariants.js';
```

Every builder returns the canonical world shape `{net, eco, traffic, terrain}` plus `anchors` with semantic references (a junction node, a house building, an edge). Assertions must use anchors, never generated IDs — v1 IDs are random and become counter-based in S01.1.

| Fixture | Exact intent | Introduced |
|---|---|---|
| straightWorld | 600wu road, both directions, orderly following | S00.3 |
| crossWorld | Four300wu arms, rotated variants0/30/45degrees | S00.3/S04.2 |
| eightCrossingsWorld | Eight verticals100wu apart and one transverse road;8junctions | S00.3/S01.5 |
| ringWorld | Four asymmetric arms, radius36wu, compare direction legality | S00.3/S03.4 |
| serviceWorld | 1200wu road, home(-350,60), shop(0,80), factory(350,100) | S00.3 |
| blockedExit | Full downstream lane; no vehicle occupies junction until space exists | S01.4/S04.2 |
| waterStrip | Land endpoints, water strip between; ground build fails, later bridge succeeds | S03.2/S05.2 |
| twoOwners | Two buildings share access endpoint; delete one preserves other | S01.6 |
| legalTurns | Skewed T/X/Y with disallowed turns and conflicting movement pairs | S04.2 |
| mergeQueue | Auxiliary lane ends; front/rear reservations; deterministic zipper | S04.3 |
| gradeCross | Same XY at z0/z12; no connection, insufficient clearance rejected | S05.1 |
| freightChain | Depot→factory→shop, workforce and stock restrictions | S06.2 |
| transitCorridor |3stops, limited buses/capacity, full queues, legal walking access | S07.5/S07.6 |
| mixedCity | Freight, bridge, signal, bus, crosswalk, incident, budget in one scene | S07.7 |

### Resolved gap: eightCrossingsWorld (closed by S01.5)

The builder declares `anchors.expectedJunctionCount === 8`, but the crossing resolver used to produce only **6**. That was pinned as a characterization test so the fix would appear as a visible diff. S01.5 replaced the bounded loop with an edge-frontier walk, the test now asserts the **target** (8), and `GAP-E05-crossings` is closed. The same fixture also caught a second defect in S01.5: a multi-point road between two already-connected junctions used to build nothing at all.

### Validator negative controls

Each invariant helper has explicit `assert.throws` controls proving it rejects corrupted input (missing endpoint, non-reciprocal membership, zero-length edge, non-finite geometry, NaN car position, negative speed, car on a deleted edge, negative XP/batch, building with a missing access node). A validator that cannot fail is worse than no validator — keep those controls when editing the helpers.

Maintain stable semantic anchors in fixtures. Do not use screen coordinates as permanent graph IDs. Browser drawing uses camera transforms derived from fixture world points; after layout change compute CSS point via worldToCss rather than tweaking arbitrary click constants until green.

## 6. Browser and visual matrix

Mandatory scenes: fresh start, tutorial valid/invalid action, small serviced city, dense intersection, signal editor, road grid preview, roundabout, saved city reload, grade crossing, freight, transit, editor.

Viewport matrix:1440×900 and1024×768 always;1280×800 regression legacy;1920×1080 for wide layout. DPR1/2 on camera/road/input tasks. Zoom.25/1/3 on geometry/render tasks; min/max.12/5 for numerical roundtrip. Required panels open in compact layout to expose overlap, not just empty map.

Capture file names include scene, schema version, seed, sim tick, viewport and DPR. Save before/after pairs; never overwrite golden reference without operator review. HTML report may link captures; do not embed entire competitor art in game assets.

## 7. Quality gates by release

- **R1:**42legacy tests plus regression suite; no UI/geometry/save critical defect; visual rubric>=16/20; tutorial/keyboard playable; human approval.
- **R2:** advertised-target matrix evidence;45min real mixed session; every allowed road/signal/grade/economy combination tested; old saves retained.
- **R3:**8scenarios with validated solutions; multimodal journey/goods conservation; editor imports cannot execute code; mixed-city scenario survives undo/load.
- **R4:** clean install/package smoke,60min soak, performance matrix, browser/accessibility report, provenance/credits and explicit publication approval.

Failures remain failures. Mark task blocked with exact reproducer if environment prevents a required check. 'No console errors', 'all TODO removed', 'tests42pass' and a screenshot of the start screen do not establish overall product readiness.
