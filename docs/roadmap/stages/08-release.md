# Stage 08 — Measured scale and browser release candidate

Optimization targets are proposed budgets, not measurements already achieved. Capture hardware, browser/version, viewport and DPR with each result. No GitHub push/deploy/store publication without a new explicit operator instruction.

## S08.1 — Profile and remove measured bottlenecks

**Depends:** S07.7. **Create:** test/performance/benchmark.js, artifacts/performance reports. **Modify:** only hot modules identified by profiles; unit tests protecting changed paths.

1. Benchmarks: small100vehicles/200edges/100buildings; medium1000/1000/500; large2500/3000/1500, with representative cars/trucks/buses and1000pedestrian journeys. Density distributed to permit some flow, not every vehicle jammed at one spawn. Exact initial fixture hash and warm-up recorded.
2. Measure60s after10s warm-up: simulation tick median/p95/p99, render p95, route query p95, input-to-preview latency, memory, active/served/cancelled counts. Run3times, report median and spread. Run CPU-bound benchmarks separately from visual browser tests.
3. Targets on recorded desktop: medium1× p95 total frame<=16.7ms, tick<=8ms; large1× p95 frame<=33ms; command/preview p95<100ms; memory<300MiB and no >10% monotonic growth over30min after GC opportunity. These may require revision based on actual machine; record waiver rather than fabricate pass.
4. First fixes: reuse per-tick lane/approach indexes, heap for A* open queue if measured, viewport culling, bounded Path2D/terrain caches, dirty HUD updates4Hz, sample metrics1Hz. Add exact behavior-equivalence tests before optimizing.
5. Only if above insufficient, propose worker/offscreen or renderer spike with measured bottleneck. Worker boundary uses immutable snapshots/commands and deterministic ticks; do not rewrite engine on speculation. Require operator approval for new dependency/runtime architecture.
6. Make overload visible: speed multiplier reduces effective progress under budget rather than giant unstable dt. Display effective simulation speed if <90% requested for5s. Never despawn to meet FPS.

**Verify:** all tests; normalized simulation unchanged by optimization; reports include raw timing samples and actual environment. **Stop:** performance wins caused by dropping journeys, weakening conflict safety or skipping rendering required controls.

## S08.2 — Accessibility, input and compatibility completion

**Depends:** S08.1. **Modify:** UI/input/audio/style only as defects demand; test/browser compatibility matrix.

1. Test Chromium and Firefox at1280×800/1440×900, DPR1/2 where supported; Edge/manual on Windows. Safari/WebKit is a test target when environment exists, not a pass claim from Chromium. State unsupported browsers honestly.
2. Full keyboard walkthrough: new city, road/building, inspect/edit signal, undo, save/import, scenario start, transit line edit. No focus traps, invisible focus, shortcut hijacking or pointercancel stuck states.
3. Measure contrast, zoom UI to200%, use reduced motion and high contrast options, verify non-colour legends and accessible names. Provide textual selected-object and objective state adjacent to Canvas.
4. Settings: separate master/SFX volume, mute, UI scale90–150%, reduced effects, colour-vision-safe overlay palette, remappable shortcuts with conflicts detected. Persist settings separately; reset-to-defaults never clears saves.
5. Localization readiness: extract visible UI strings into one English message map with parameter formatting, no dynamic HTML interpolation. Do not translate or add languages without review; test long pseudo-localized strings for clipping.
6. Honest accessibility statement lists Canvas navigation limitations and supported keyboard paths; do not claim WCAG conformance solely from automated audit.

**Verify:** unit/browser/manual matrix and screenshots; no P1 input/accessibility defect. Missing platform check remains unverified with explicit waiver, not complete coverage.

## S08.3 — Safe local/offline distribution and save recovery

**Depends:** S08.2. **Modify:** server.js if local serving hardening needed, package scripts, static asset packaging, save/recovery UI. **Create:** scripts/package-browser.js, test/package.test.js, optional service worker only after packaging baseline.

1. Produce a browser distribution directory from explicit allowlist: index.html, runtime src/assets, license/credits/help. Exclude tests, docs/roadmap, benchmark artifacts, Steam reference captures, logs, node_modules, credentials and unrelated home files.
2. Local dev server binds127.0.0.1 by default; optional external binding explicit. Validate canonical path containment and block traversal/sibling-prefix tricks/encoded traversal. Serve only intended public assets, not repository .git, docs or arbitrary files. Test malformed URL returns controlled400/404, no process crash.
3. Add portable local launch instructions and static-host compatibility; no runtime CDN dependency. Browser module imports tested in packaged directory, not source cwd.
4. Optional offline PWA cache must version assets, avoid caching saves/import blobs, provide clear update prompt, and retain old version until active session saved. If omitted by scope change, mark offline mode not shipped, do not call local server support PWA.
5. Test storage quota/disabled storage, corrupt current save + valid backup recovery, export independent of storage, future-version rejection, v1-v6 migration. A new app version cannot overwrite unknown newer saves.
6. Package reproducibility manifest and artifact size. Do not upload anywhere; do not create remote or deploy. Any desktop wrapper remains separately scoped after R4.

**Verify:** unit + packaged browser smoke without external network, asset allowlist assertions, traversal cases, recovery fixtures. **Security:** user-generated scenario text escaped, no eval/imported JS.

## S08.4 — Release evidence and operator handoff

**Depends:** S08.3. **Modify:** README.md (only now during execution), player help, changelog/credits; task ledger. **Create:** RELEASE-CHECKLIST.md, KNOWN-LIMITATIONS.md, artifacts/R4 report.

1. Rewrite marketing in original Roadflow voice; remove near-verbatim competitor phrases and Trafficity-specific comments implying copied UI as product identity. Verify art/font/audio licenses and record provenance; do not ship public reference screenshots.
2. Run clean-environment install from lockfile, unit suite, browser suite, eight scenarios, save migrations,60min soak and performance matrix. Log exact commands, versions and failures. Clean install permission/dependency availability must be checked; don't delete user's node_modules as a shortcut.
3. Test minimum new-user loop, dense-city editing,100save/load cycles,50undo/redo cycles, corrupt import, early and late game, all map profiles/difficulties. Release fixture must not rely on debug hook commands unavailable in normal UI.
4. Open-defect rule: no crash/data-loss/security/collision bug; no primary action broken; lower-severity visual issues documented with reproduction and workaround. User study and visual rubric need operator sign-off.
5. Summarize feature evidence against Trafficity public brief, distinguish additional Roadflow systems and unverified competitor behavior. Do not claim better commercially without player evidence.
6. Ask operator for next action: keep local, package preview, or separately authorize publication. Never infer GitHub push from 'plan complete'.

**R4:** a tested browser release candidate and reproducible evidence, not a published product. **Rollback:** distribution artifact is separate; old manual saves and last-good version retained. **Final risk report:** disclose untested browsers/hardware, remaining capacity limits and any approved waivers.
