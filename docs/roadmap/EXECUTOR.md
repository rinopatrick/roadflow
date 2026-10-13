# Cold-start execution and recovery guide

This plan is designed for small-context execution, not for a specific vendor. The operator selects an available model. Do not switch to `gpt-6.1-sol`, launch paid reviewers, spawn subagents, or create persistent autonomous goals without explicit operator authorization.

## 1. Copy-paste start prompt

```text
Work on Roadflow in C:/Users/patri/roadflow.

Read docs/roadmap/README.md, CONTRACTS.md, TESTING.md, status.json,
and ONLY the stage file containing the first pending task whose
predecessors are done. Read DESIGN.md too if the task affects visuals,
and the relevant recipe from ALGORITHMS.md for algorithm-heavy tasks.

Execute ONE task, not the entire roadmap. Before changing files:
1. State task ID, intended result and prerequisite evidence.
2. Inspect the actual listed source and all callers of changed functions.
3. Check that CWD is the game directory. Check Git root before any Git write.
4. List exact files to modify, contracts to preserve and focused tests.

Use existing JavaScript ES modules, Canvas2D, Node tests and installed
Playwright. No framework/engine rewrite or runtime dependency without approval.
All APIs named in the plan are proposed until their owning task creates them.
Follow one red-green-refactor slice at a time. Preserve existing tests.

For a behavior fix: reproduce with a failing regression, implement minimally,
then run targeted and full unit tests. Run browser checks for UI/input/render
changes, migration fixtures for schema changes, and inspect screenshots.
A screenshot or zero console errors alone is not proof of gameplay correctness.

Stop after the task. Update status.json with actual commands/results,
changed files, artifact paths and unresolved risks. A failed/missing required
check means blocked or in_progress, never done. Do not silently defer criteria.
Do not push, create a GitHub repo, deploy, or kill unrelated processes.
Ask before any unresolved product decision or change to public data contracts.
```

## 2. Focused task prompt

```text
Execute task S01.2 from docs/roadmap/stages/01-foundation.md only.
Required predecessors: S01.1 and its dependencies must be done in status.json.
Read CONTRACTS sections1,2,7; EVIDENCE E01; TESTING sections1–4.
Read economy.js, TrafficSim.spawn/arrival, and all callers of processReturns.

Deliver: return dispatch resolves building IDs into current driveway node IDs;
blocked spawn retries; deleted endpoints cancel exactly once; outward+return
integration completes without duplicate XP. Preserve save compatibility.

First show the failing test and its observed failure. Then implement the
smallest correction, run targeted/full tests, report proof and stop.
If prerequisites are not met, do not improvise a partial implementation.
```

For later tasks, replace ID/path/contract sections with those actually listed. Do not keep the example's return-trip instructions when working on bridges.

## 3. What to load into each session

- Global constraints and current status summary.
- One task's contract, files, procedure and verification.
- Existing definitions and direct callers of functions touched.
- Relevant fixture, failing test and last task's handoff.
- Only the nearby dependencies' output contracts, not their full conversation logs.

Suggested working limit: one task,3–6 edited production files, one main behavior change per test cycle. These are scope signals, not arbitrary hard line limits. If task legitimately needs more (e.g. schema migration), split into numbered subtasks with explicit dependency before editing, then update ledger and plan. Do not remove requirements to make a task fit.

## 4. Seven-step working loop

1. **Orient:** confirm path, active task, prerequisites, source drift, backup.
2. **Trace:** list current entry point→helper→storage/render/test consumers. Compare existing return shapes with proposed contract.
3. **Reproduce:** one minimal failing regression using a named fixture. Print observed versus expected, not only 'red'.
4. **Implement:** minimum vertical change that passes; keep validation/error handling. Use explicit IDs and units.
5. **Integrate:** update all callers, serializer/migration, UI states and documentation required by that task.
6. **Verify:** targeted tests, full suite, browser/save/geometry/performance gate as appropriate. Inspect artifacts. Capture exit codes and environment.
7. **Handoff:** write evidence, remaining concerns, next eligible task and a safe checkpoint. Stop for review.

No whole-phase code generation. Never paste 'implement everything above' into a weak model and expect safe results.

## 5. Status ledger protocol

`status.json` is a local planning ledger, not a background execution engine.

Allowed state: pending → in_progress → done; a started task may become blocked. Only one task in_progress. A blocked task records a reason and unmet check; after resolution it returns in_progress. To reopen a done task, record why and which downstream tasks need revalidation.

Task record fields:

```json
{
  "id": "S01.2",
  "status": "pending",
  "dependsOn": ["S01.1"],
  "file": "stages/01-foundation.md",
  "evidence": [],
  "notes": []
}
```

When done, evidence entries should look like:

```json
{
  "command": "node --test test/economy.test.js",
  "exitCode": 0,
  "result": "Record actual observed counts here during execution",
  "artifact": "artifacts/run-id/economy-output.txt"
}
```

The sample result is a template, not proof of a passing run. Populate real values; never copy fabricated numbers. Store paths relative to project where possible. Don't put credentials or private unrelated home-directory details in artifacts.

## 6. Required handoff format

```text
TASK: Sxx.y — concise title
STATUS: done | blocked | in_progress
BASELINE: checkpoint/commit and observed initial tests
CHANGED: exact files, public contract changes, migration versions
PROOF: targeted/full command, exit code, actual pass/fail counts
BROWSER/VISUAL: fixture, viewport, DPR, screenshot paths, reviewed observations
SAVE/DATA: migration/resume checks, old-save retention
RISKS: unresolved behavior, missing environment checks, approved scope limits
NEXT: one eligible ID, exact read-first file
```

If a local repository was approved, commit only explicit task files after gates pass. If it was not, use approved verified backups. Never run git add from parent home or use a broad process-kill command.

## 7. Recovery when a model gets stuck

```text
Stop adding features. Keep current working files intact.
Read current task contract, diff, failing test and last known passing checkpoint.
List the smallest reproducible failure, expected result and actual result.
Trace only the direct callers involved. Form one falsifiable hypothesis.
Change one cause; rerun the reproducer, then full tests.
Do not weaken tests, remove validation, replace implementation wholesale,
rename APIs across the project or add dependencies to escape the failure.
After two unsuccessful hypotheses, mark the task blocked and report:
reproducer, relevant files, attempted changes, observations, proposed next probe.
Wait for operator review; do not silently switch models or tools.
```

If context is nearly full: write a handoff before continuing. A fresh session reads exact task and evidence. Do not rely on 'you remember what we did'.

## 8. Review prompt, for human or a separately authorized session

```text
Review Roadflow task Sxx.y. Do not modify code.
Read the task, CONTRACTS.md, relevant current files and connected callers,
not only the diff. Check:
- Every acceptance criterion has observable proof.
- APIs/units/schema match the plan and existing consumers.
- Geometry/route conflicts, lifecycle accounting and save rollback are correct.
- Invalid inputs and user cancellation preserve state.
- Tests would fail for the original bug; no assertion weakened to hide failure.
- UI controls exist, work, support keyboard, and match simulated state.
- No unrelated rewrite, unapproved dependency, secret or competitor asset.
Return concrete findings with file/symbol, reproduction and severity.
Say unverified when you cannot run a required check. Do not approve by style alone.
```

The review need not be a stronger model. High-risk tasks benefit from independent evidence and a second pass regardless of model identity. Model names alone do not establish competence.

## 9. Plan mutation and stop rules

Stop and request a decision when:
- Current source differs materially from evidence and invalidates task assumptions.
- Proposed API is impossible without breaking an unlisted caller/save invariant.
- New dependency, engine migration, backend or paid service becomes necessary.
- A task cannot satisfy tests without deleting user data or weakening safety.
- Required browser/hardware/platform validation is unavailable.
- A feature would expand scope (multiplayer, rail, cloud, Steam release).

Amendment entry states old assumption, evidence, new contract, affected IDs, new tests/migration and operator decision. Unimplemented features remain pending/blocked. A constrained prototype is not a completed full feature.
