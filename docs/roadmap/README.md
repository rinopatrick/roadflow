# Roadflow: from prototype to a polished traffic sandbox

**Status:** proposed implementation plan; no implementation authorized by this document alone.  
**Audience:** a fresh coding session using an operator-selected model, including the user's suggested `glm-5.3-flash`, `gemini-3.8-flash`, or `deepseek-v4.1-flash`. These names are user-supplied execution preferences, not verified availability or capability claims. No task requires `gpt-6.1-sol`.  
**Scope approved during planning:** browser first; full ambitious roadmap; English execution files.  
**Reference:** Trafficity's public Steam listing and developer screenshots, inspected during this planning session.  
**Important:** GitHub publication remains on hold. The existing game is not to be rewritten wholesale.

## 1. Recommendation

Build **an original, readable traffic laboratory that is enjoyable as a city builder**. Match Trafficity's advertised road-building depth, then differentiate with explainable congestion, repeatable experiments, challenges, freight, transit, and pedestrian access.

Do not equate more features with a better game. A feature ships only when a player can discover it, understand its consequences, undo an edit, reload the city, and see the same rules that the simulation actually uses.

Three approaches were considered:

| Approach | Benefit | Cost / reason not selected |
|---|---|---|
| Cosmetic patch only | Quick improvement | Does not repair topology, traffic, demand or save weaknesses |
| **Incremental browser game, gated releases** | Preserves working code; bounded tasks; visual progress early | Requires disciplined migrations and regression fixtures; recommended |
| Engine/framework rewrite | Could eventually support a different rendering pipeline | Discards useful work, expands context, delays playability; not justified by current measurements |

Keep native ES modules, Canvas 2D, DOM UI, Node's built-in tests, and installed Playwright. No React, TypeScript migration, ECS framework, game engine, backend, database, multiplayer or new runtime dependency in the core roadmap. Reconsider rendering technology only after measured Canvas limits and a separately approved spike.

## 2. What exists, and what does not

There is a useful prototype: procedural terrain, three road classes, graph routing, roundabout rings, basic signals, three building types, trip XP, a renderer and 42 tests. It is **not established feature parity** with Trafficity.

The earlier conversation's implication that the UI was correct because it booted, or that zero TODO comments meant zero debt, was too strong. Fresh source inspection and behavioral probes found real gaps. See [EVIDENCE.md](EVIDENCE.md). Existing browser scripts also exit successfully without proving their stated gameplay goals.

Trafficity is the **publicly advertised target**, not an audited executable. Steam's app-details response said `coming_soon: true`, release `16 Nov, 2026` when inspected. No hands-on Trafficity session was performed. A trailer fetch failed because `yt-dlp` was unavailable. Screenshots were visually inspected; unseen mechanics are not asserted.

## 3. Product pillars

1. **Construction feels precise.** Preview equals committed geometry; snapping is predictable; invalid actions explain why; all construction is undoable.
2. **Traffic is physically and logically credible.** Vehicles stay on lanes, follow legal movements, respect conflicts, and do not silently disappear when editing.
3. **The city explains itself.** An unhappy home, empty shop or queue has an inspectable cause, not just a red icon.
4. **The map is the main UI.** Restrained panels, clear silhouettes, useful overlays, consistent scale; no decorative dashboard takeover.
5. **Experiments are safe.** Reliable saves, deterministic fixtures, compare-before/after tools and local scenario export.
6. **Depth is introduced gradually.** Sandbox remains forgiving; scenarios teach one concept at a time; optional management is explicit.

## 4. Release ladder and dependency order

The table is an execution sequence, not a promise of calendar dates. Each task below has one independently reviewable result. Execute one task per session by default; split a task before coding if it no longer fits a focused session.

| Stage | Task IDs | Deliverable | Gate |
|---|---|---|---|
| [00 — Safety and evidence](stages/00-safety.md) | S00.1–S00.3 | Safe checkpoint, assertive browser harness, reproducible fixtures | Baseline captured; no accidental home-directory Git operations |
| [01 — Correct foundation](stages/01-foundation.md) | S01.1–S01.7 | Fixed time, return trips, lane dimensions, graph integrity, safe persistence | Simulation and save invariants pass |
| [02 — Visual and interaction quality](stages/02-experience.md) | S02.1–S02.6 | Original coherent art/UI, accessible controls, discoverable overlays, guided start | **R1: polished playable core**; human visual approval |
| [03 — Construction workbench](stages/03-construction.md) | S03.1–S03.5 | Transactions, undo/redo, consistent road previews, grids and upgrades | Every edit reversible and atomic |
| [04 — Lanes and junctions](stages/04-traffic.md) | S04.1–S04.6 | Explicit lanes, legal connectors, lane changes, protected phases, diagnostics | No conflicting reservations or illegal routes |
| [05 — Grade separation](stages/05-elevation.md) | S05.1–S05.4 | Bridges, ramps, tunnels, usable interchange workflow | Grade-aware crossings, rendering, picking and saves agree |
| [06 — A meaningful growing city](stages/06-city.md) | S06.1–S06.6 | Demand, freight, environment, four map profiles, difficulties, progression | **R2: public-feature parity candidate**; feature matrix verified |
| [07 — Distinctive depth](stages/07-depth.md) | S07.1–S07.7 | Scenarios, experiments, incidents, optional budget, buses, walking, local editor | **R3: differentiated beta**; each new system affects outcomes |
| [08 — Scale and release candidate](stages/08-release.md) | S08.1–S08.4 | Benchmarked performance, accessibility polish, safe packaging, release evidence | **R4: browser release candidate**; human approval, no automatic publication |

**Total: 48 bounded tasks.** The optimistic size is one focused session each; difficult geometry and traffic tasks can need several sessions. Do not promise hours or dates without measuring S00–S02. S01/S04/S05 contain the highest reasoning risk.

Default dependency chain: `S00 → S01 → S02 → S03 → S04 → S05 → S06 → S07 → S08`. The order prioritizes visual quality well before the feature-rich milestone. If R1 still looks poor or building roads still feels wrong, stop and iterate there.

Limited parallel opportunities, only if the operator explicitly requests delegation: independent read-only reviews; S02.1 icon/token drafting alongside S02.4 terrain research; S06.4 map-profile fixtures alongside S06.1 economic fixtures. Integration remains serial. Never allow concurrent writers to `main.js`, `render.js`, `roadNetwork.js` or the same worktree.

## 5. Read this package in this order

1. [EVIDENCE.md](EVIDENCE.md): source-backed comparison, defects and limits of verification.
2. [CONTRACTS.md](CONTRACTS.md): names, invariants, persistence and compatibility rules.
3. [DESIGN.md](DESIGN.md): visual specifications and review rubric.
4. [TESTING.md](TESTING.md): commands, fixtures, quantitative gates and failure rules.
5. [ALGORITHMS.md](ALGORITHMS.md): exact recipes for fixed ticks, geometry, lanes, conflicts, saves, grades and conservation; read only the relevant recipe. [REGRESSION-RECIPES.md](REGRESSION-RECIPES.md) supplies five standalone test cases for the first reproduced defects.
6. The **one stage file containing your assigned task**.
7. [EXECUTOR.md](EXECUTOR.md): copy-paste execution and recovery prompts.
8. [status.json](status.json): task ledger. Every task is initially pending.

Do not paste all stage files into a small-model context. Read the global contracts plus the current task and its listed code. Retrieve other sections only if the task names a dependency.

## 6. Definition of done, per task

- Required predecessor IDs are done, not merely attempted.
- Existing behavior is preserved except for an explicit correction or migration.
- A regression test fails before a nontrivial fix; it passes afterward without weakening assertions.
- New APIs match CONTRACTS.md and their owning task. No shadow versions in sibling modules.
- Full `npm test` passes. UI-affecting tasks pass browser checks; save-affecting tasks run migration fixtures.
- Screenshots at specified seeds, cameras and viewport sizes are inspected, not just generated.
- No missing controls, inert buttons, silent data deletion, fake metrics, ignored errors or unbounded loops.
- Status is updated with commands, actual results, artifacts and remaining risks.
- A local commit is made only after the operator has approved a project-local repository/checkpoint policy. Never push or create a GitHub repository from this plan.

## 7. What “better than Trafficity” means here

It is a target to test with players, not a claim of superiority. Proposed differentiators:

- Explain a queue: downstream blockage, signal red, turn conflict, insufficient lane capacity, lack of a legal path.
- Compare changes against an identical demand trace; show throughput **and** waiting/cancelled demand, not a flattering single percentage.
- Teach real design trade-offs with solvable scenarios and reproducible seeds.
- Make freight and bus priority useful: reducing car demand must not magically remove journeys.
- Protect experimentation: undo, autosave recovery, versioned exports and non-destructive import previews.

User validation: five new players, no coaching. At least four should complete the first road + home/shop connection within five minutes, identify one bottleneck within two more minutes, and undo a mistaken edit unaided. Record observations; a small study guides iteration but does not establish statistical superiority.

## 8. Explicit exclusions and deferred decisions

- No copying Trafficity code, logos, assets, screenshots, marketing text or exact UI. References are analysis evidence only. Rewrite Roadflow's currently very similar marketing description in S08.4.
- No public accounts, leaderboards, Steam integration, paid economy, multiplayer, cloud saves or workshop service.
- No full demographic agent simulation, water/power/sewage systems or train simulation in the 48-task scope. Buses and pedestrian access are included; rail is a separately scoped expansion after R4.
- Road units are world units, not advertised real-world metres; do not relabel speeds km/h without a conversion model.
- Desktop wrapper is a post-R4 decision. Do not add Electron/Tauri or native toolchains now.
- Difficulty numbers and rendering budgets below are proposed test targets. Tune via the documented fixtures, not intuition or claims about model intelligence.

## 9. Plan review

This package receives a local consistency/self-review. No independent reviewer model was launched; the user requested a plan, not delegation. Before executing S04 or S05, obtain a focused review of the fixture results and data contracts. It can be human review or an operator-authorized independent session with any available model. A stronger model is not a hidden dependency.

Changes to plan: write the evidence, affected IDs, new dependency and migration/test consequences into `status.json` notes. Do not silently rename contracts or mark an incomplete high-risk feature as “done with limitations.”
