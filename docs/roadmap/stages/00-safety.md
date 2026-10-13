# Stage 00 — Safety, baseline and trustworthy tests

Read `../CONTRACTS.md`, `../TESTING.md`, `../EXECUTOR.md`. This stage creates verification infrastructure, not new gameplay. Existing 42 tests are valuable but insufficient. Never run Git write operations against the parent home repository.

## S00.1 — Establish a safe local checkpoint

**Depends:** none. **Read:** package.json, README.md, current directory listing; `git rev-parse --show-toplevel`. **Modify/create:** `.gitignore`, `docs/roadmap/status.json`; local backup outside repository. No source edits.

1. Print resolved cwd and Git root. If root is not exactly the game directory, stop all staging/committing.
2. Ask operator to choose a verified directory backup or a new project-local Git repository. Do not delete/move the parent `.git`; do not create a remote. Plan approval is not approval to push.
3. Create selected checkpoint of `src/`, `test/`, index.html, scripts, package files, README and docs. Exclude node_modules and transient captures; keep a path and SHA-256 manifest. Verify one file's byte equality and total manifest count.
4. If local Git is approved, `git init` only inside the resolved project directory, verify root again, add `.gitignore`: node_modules/, artifacts/, server.log, *.tmp. Ignore generated shots individually or entire shots only after confirming no authored assets live there. Stage explicit files, never parent-relative paths.
5. Record checkpoint path/commit, runtime versions and commands in status notes. Do not treat absent commits as lost code or make a release tag.

**Verify:** root equals intended location when using Git; backup contains all source and test hashes; `npm test` remains 42/42 baseline. **Rollback:** source unchanged; remove only newly created local metadata with approval, never parent `.git`. **Stop:** backup unreadable, unexpected Git root, uncommitted user files at risk.

## S00.2 — Turn browser scripts into assertions

**Depends:** S00.1. **Read:** playtest.js, soak.js, server.js, main.js boot/debug hook. **Modify:** playtest.js, soak.js, package.json. **Create:** `test/browser/harness.js`, `test/browser/smoke.js`, `artifacts/baseline/` captures.

1. Preserve existing screenshots as historical evidence. New runs write to `artifacts/<run-id>/`.
2. Build a small reusable harness with existing `playwright`: launch browser, collect console/page errors, validate target is Roadflow, and close browser/server in `finally`. Use a chosen free port and `BASE_URL` override; do not kill unrelated node processes. Harness owns only PIDs it spawned.
3. Add browser smoke that opens seed 1 with fresh storage, closes help, asserts canvas has nonzero dimensions and all ten existing tools are reachable. Use `[data-tool]`, `[data-speed]`, fixed IDs for controls.
4. Assert a road action increases `window.__rf.state.net.edges.size`, a building action decreases correct batch count, population matches residents, save key exists and parses. Assert a rejected placement does not consume stock.
5. Update soak to assert at least one successful outward trip and increased XP, no nonfinite positions and no errors. Do not assert a level-up unless fixture intentionally reaches threshold. Add a separate deterministic level-up test in S00.3.
6. Demonstrate the harness fails: temporarily use a wrong expected population in memory/test working copy, observe nonzero exit, restore it. Do not leave intentional failures committed.
7. Add npm scripts `test:browser` (smoke), `test:soak` (soak). Keep `npm test` for unit tests, no browser requirement added to default suite.

**Example assertion, not a screenshot substitute:**
```js
const before = await page.evaluate(() => window.__rf.state.net.edges.size);
// Perform the documented road gesture at fixture coordinates.
const after = await page.evaluate(() => window.__rf.state.net.edges.size);
assert.ok(after > before, 'road action must create graph edges');
assert.deepEqual(errors, []);
```

**Verify:** `npm test`; `npm run test:browser`; `npm run test:soak`. Script exits nonzero on assertion or timeout and includes artifact path. **Stop:** installed Playwright browser unavailable—report/install only the matching browser with operator permission; never mark browser tests passed from Node results.

## S00.3 — Add deterministic fixture and invariant vocabulary

**Depends:** S00.2. **Read:** five current test files, network serialization. **Create:** `test/fixtures/worlds.js`, `test/helpers/invariants.js`, `test/invariants.test.js`, `test/fixtures/legacy-v1.json`.

1. Export fixture builders: `straightWorld`, `crossWorld`, `eightCrossingsWorld`, `ringWorld`, `serviceWorld`. Builders return `{net,eco,traffic,terrain}` and named semantic anchors; do not assert random IDs.
2. Define `assertGraphConsistent(net)` for endpoints, reciprocal membership, finite geometry and positive length. `assertVehiclesFinite(traffic)` checks finite position/speed, nonnegative speed and valid current route references for active cars. Give failures IDs and coordinates.
3. Fixture sizes: straight 600 wu; cross arms 300 wu each; eight vertical roads x=0..700 spaced100, y=-150..150 plus horizontal (-100,0)→(800,0); service road (-600,0)→(600,0), home(-350,60), shop(0,80), factory(350,100).
4. Preserve an actual v1 snapshot with house/shop/factory, light and separate roundabout; include original map seed. Never hand-edit v1 into an idealized new-schema save.
5. Add passing tests for current valid simple fixtures. Store expected failures from EVIDENCE as named follow-up cases in this plan/ledger, not permanently skipped tests claiming coverage.
6. Add deterministic level-up fixture: set XP exactly one served-trip below threshold, complete one valid request, assert exactly one batch award and no second award on next tick.

**Verify:** `npm test`; each invariant helper catches a deliberately broken copy (missing endpoint/nonfinite car), then passes intact fixture. **Output:** reusable public fixture builders and captured v1 migration sample. **Rollback:** remove new harness files only; no gameplay changes.
