# Verification plan and fixture catalogue

## 1. Current versus planned commands

**Available now (after S00.2):**

```text
npm test              # unit suite only, browser-free (fast)
npm run test:browser  # Playwright smoke with gameplay assertions
npm run test:soak     # assertive economy soak (SOAK_SECONDS to shorten)
npm run test:playtest # visual capture tour -> artifacts/<run-id>/
npm start             # static server
```

`npm test` reports 42 passes. Browser scripts now spawn their own server on a free port and tear it down themselves, so no pre-running `localhost:8080` is required. Set `BASE_URL` to reuse an existing server instead; the harness then owns nothing and kills nothing.

### Pitfall: verify a backup manifest from inside the backup

`sha256sum -c MANIFEST.sha256` resolves relative paths against the **current working directory**. Running it from the project root checks the live tree instead of the backup, so files edited after the backup was taken report as mismatches. That looks like corruption but is a measurement error — it happened once during S00.1 and produced a false "41 of 42" reading.

Use the path-independent verifier instead, which resolves every entry against the backup directory:

```text
node scripts/verify-backup.mjs C:/Users/patri/roadflow-backups/<checkpoint>
```

It exits 0 only when every manifest entry hashes correctly, 1 on any mismatch or missing file, 2 on usage error.

### Pitfall: browser runs must not reuse a stale artifact directory

`RF_RUN_ID` names the artifact directory. Reusing a name overwrites previous captures, so goldens cannot be compared across runs. Omit it for a timestamped directory, or use a fresh name per comparison.

**Created during execution:**

| Command | Owning task | Runs |
|---|---|---|
| `npm run test:browser` | S00.2 | **Created.** Node assert-based Playwright smoke; extend runner to include later browser files |
| `npm run test:soak` | S00.2 | **Created.** Assertive economy browser soak |
| `node --test test/simulationClock.test.js` | S01.1 | Targeted fixed-clock checks |
| `node --test test/save.test.js` | S01.7 | Snapshot validation/migration/resume |
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

### Tracked gap: eightCrossingsWorld

The builder declares `anchors.expectedJunctionCount === 8`, but the current crossing resolver produces **6**. This is a characterization test, not acceptance: `test/invariants.test.js` asserts today's 6 so that the S01.5 fix appears as a visible diff. When S01.5 lands, change the asserted value to `anchors.expectedJunctionCount` and delete the `GAP-E05-crossings` entry from `status.json`. Do not add a permanently skipped test instead.

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
