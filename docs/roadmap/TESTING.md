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

`npm test` reports **280 passes** and `npm run test:browser` **46**, as of S02.2b. Those counts only ever grow: every task adds tests and none may be removed or weakened. Browser scripts spawn their own server on a free port and tear it down themselves, so no pre-running `localhost:8080` is required. Set `BASE_URL` to reuse an existing server instead; the harness then owns nothing and kills nothing.

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
| `npm run test:browser` | S02.2b | **Extended.** test/browser/ui.js gains layer declarations backed by simulated data, one-layer-at-a-time with its labelled legend, the traffic legend counting the same edges the overlay draws, real access reachability, the sound toggle with an AudioContext counter proving no audio before a user gesture, export download plus bad-import isolation, the depletion reason and progression link, and compact inspector scrolling |
| `node scripts/mutate-s022a.mjs` | S02.2a | Mutation harness for the S02.2a guards (10 mutations, 10 caught) |
| `node --test test/layers.test.js` | S02.2b | **Created.** Overlay model: layer declarations name a real data source, traffic bands and thresholds, per-edge traffic rows, building reachability, one-overlay-at-a-time. Pure, no browser |
| `node scripts/mutate-s022b.mjs` | S02.2b | Mutation harness for the S02.2b guards (12 mutations, 12 caught after one ineffective target was replaced) |
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
