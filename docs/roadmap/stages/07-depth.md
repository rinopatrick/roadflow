# Stage 07 — Distinctive, feature-rich gameplay

Read CONTRACTS8 and TESTING. These features are Roadflow proposals, not assertions about what Trafficity lacks. Each is independently usable and may be postponed by an explicit scope decision; if postponed, do not mark its task complete or R3 fully delivered.

## S07.1 — Reproducible scenarios and objectives

**Depends:** S06.6. **Create:** src/scenarios.js, src/content/scenarios.js, test/scenarios.test.js, test/browser/scenarios.js. **Modify:** start menu, HUD objective panel, snapshots v6.

1. Implement data-only scenario schema from CONTRACTS. Objective records `{metric,op,target,windowSeconds}` use an allowlist of metrics and comparisons; no evaluated code. Events `{at,kind,payload}` use simulation time, stable IDs and idempotent applied-event ledger.
2. Author six original fixtures: first connection, congested T-junction, freight bottleneck, two riverbanks, signal corridor, noisy residential shortcut. Each has a validated starting snapshot, restrictions, success/failure criteria and hint steps tied to measured state.
3. Each scenario includes a deterministic reference solution command list tested in Node. Example: riverbanks require20served journeys within600s and no unmet freight at completion; initial disconnected state must not meet the objective. Tune exact thresholds from runnable solution, then lock fixtures.
4. Difficulty comes from constraints/demand, not hidden traffic physics. Sandbox remains unrestricted. Restart confirmation protects unsaved work; replay same seed reproduces event times.
5. Objective rewards/stars optional cosmetic only: persist once, no duplicate building/XP injection when reopening result panel. Show partial progress and precise failure cause.
6. Tests reference solution passes, intentional do-nothing fails where expected, save halfway resumes event ledger, replay doesn't duplicate event, unknown metric rejected.

**Verify:** full unit/browser; all six scenarios solvable by stored solution, no tutorial dead-end. **Output:** local replayable challenge mode with honest objectives.

## S07.2 — Bottleneck lab and fair before/after comparison

**Depends:** S07.1. **Create:** src/experiments.js, test/experiments.test.js. **Modify:** diagnostics UI, snapshot/demand trace exports.

1. Add 'Run comparison' workflow: save baseline snapshot and admitted-demand trace, create editable alternative copy, simulate both for same600sim seconds with same seed/rules and requested demand. Current city not overwritten.
2. Demand trace records requests at origin/destination semantic IDs. If alternative deletes a referenced building, mark those requests cancelled/unserved; never remove them from denominator to improve score. Include warm-up60s separately.
3. Report requested/served/cancelled journeys, throughput, p50/p95 wait/trip time, max queue, freight delivered, environmental exposure. Compare paired metrics; no single opaque 'better city' score.
4. Keep experiment deterministic/headless through existing simulation step. Browser chunks runs so UI remains responsive; cancel leaves current city unchanged. At most2snapshots and1trace per experiment, size cap10MiB each with clear failure.
5. Explain top bottlenecks using collected wait reasons and queue duration. Suggest only rule-based actions with evidence, e.g. '67% waiting at this junction is downstream blockage; extra green alone will not clear it.' Do not claim an optimal plan.
6. Export report JSON and compact HTML generated locally from trusted templates/escaped text; no server/API. Import comparison data only as validated data, not HTML execution.
7. Tests exact repeatability, changed road that reduces admitted demand cannot game score, no-op alternative equal within tolerance, legitimate bottleneck improvement on fixed trace, cancellation no side effects.

**Verify:** unit/browser; comparison results reproducible after reload and original city unchanged. **Differentiator:** explainable causal evidence, not AI buzzwords or paid-model dependency.

## S07.3 — Rush hours, incidents and service vehicles

**Depends:** S07.2. **Create:** src/events.js, test/events.test.js. **Modify:** demand, routing permissions, vehicle types, incident overlay, scenario content.

1. Rush-hour profile is deterministic multiplier by sim-time phase, default1outside window and1.6during work peaks. Display upcoming demand curve; scenario chooses schedule. Sandbox can disable without corrupting existing journeys.
2. Incident record `{id,edgeId,lane,startsAt,endsAt,kind}`; kinds laneClosure, stalledVehicle, demandSurge. Validate lane exists; closures block new admission, existing vehicles clear or stop at a known point. Edits reconcile events targeting removed edges.
3. Add service depot and response vehicle for stalled-vehicle incidents. It routes to reachable incident access point; clears incident only on arrival after service timer10s. Priority can request signal preemption but never violate conflict reservation/all-red safety.
4. Player can opt for maintenance roadwork event with announced duration and detour planning. No random unavoidable failure immediately after tutorial. Preview affected access before manual closure.
5. Event log records applied/expired/cancelled once. Serialize schedules, current incidents and service task ownership. Unreachable service path remains visible with reason, not instant repair.
6. Tests deterministic rush schedule, closure reroutes and restores, incident during bridge edit, failed service path, preemption clearance safety, save/reload mid-repair. Add one incident scenario with verified solution.

**Verify:** unit/browser; traffic slowdown is physically caused by closure, response vehicle not cosmetic. **Stop:** emergency priority ignores collision/connector safety.

## S07.4 — Optional construction budgets and maintenance

**Depends:** S07.3. **Create:** src/budget.js, test/budget.test.js. **Modify:** worldCommands transaction costs/refunds, scenario/rules, HUD and preview.

1. Budget mode opt-in per new city/scenario; default sandbox remains unlimited. Currency uses integer credits only. Initial costs per10wu rounded up: street2, avenue4, highway7, bridge×3,tunnel×4; signals50, roundabout80, depot100; tuning data, not real currency.
2. Cost calculated from actual committed geometry/profile, never raw unsnapped preview points. Preview cost must equal transaction debit. Composite grids/templates charge once; failed validation debits0. Insufficient funds rejects atomically with shortfall.
3. Refund demolition50% of recorded construction principal; moving/upgrading charges documented difference/relocation fee. Undo restores exact money state, not a second refund. Save original paid cost to prevent upgrade/demolition exploits.
4. Income tied to successful unique served requests (2credits work,1shopping,3freight delivery); return legs0. Maintenance per minute based on lane-wu and active service vehicles, charged once per tick boundary. Idempotent on save/load.
5. Prevent impossible starts: validate scenario budget against reference solution plus10%margin. Bankruptcy pauses optional challenge with recovery choices; never deletes city or quietly sells roads.
6. Tests exact debit/refund/undo, zero-cost failed bridge, save/reload near income/maintenance boundary, composite transaction, integer bounds and negative balance rejection. Test unlimited mode never blocks construction.

**Verify:** unit/browser; economic decisions enrich traffic problem without requiring finance micromanagement. **No:** premium currency, payments, online services.

## S07.5 — Buses, stops and capacity-aware passengers

**Depends:** S07.4. **Create:** src/transit.js, test/transit.test.js. **Modify:** demand journey mode ownership, road access restrictions, traffic/render vehicle types, line editor, snapshots.

1. Start with buses only: length18wu,width4,speedFactor.8, capacity20, dwell6s+0.3s per boarding/alighting passenger capped20s. Update all vehicle dimension/conflict/following assumptions; don't squeeze bus into car-sized collision envelope.
2. Stop anchors to valid local/arterial lane with access path; no motorway/ramp/ring/bridge stop initially. Direction and stop order explicit. Line minimum2stops, headway30..300s, max8buses; cyclic service must have a legal route between every pair including last→first or configured terminal turn loop.
3. Before pedestrian network exists, catchment is conservative: only buildings attached to same connected local access segment within120wu and no barrier; label this initial access rule. S07.6 replaces catchment with true walking routes.
4. Passenger journey transitions pending→wait→ride→completed; capacity real, excess queue bounded64/stop, request stays unserved if queue full. A transit-selected journey must not also spawn a car. Board only bus serving desired downstream stop; alight then complete or return demand with same accounting.
5. Mode choice uses estimated walk/access + half-headway wait + ride versus car time; choose transit if <=1.15×car estimate and route valid. Deterministic, settings allow player incentive but no random deletion of car demand.
6. Add line editor selecting stops, legal path preview, fleet/headway controls, on-time/load/queue metrics. Bus lane restriction optional on a selected existing lane with alternative general-traffic route validation; bus priority at signals uses safe request queue.
7. Tests capacity overflow, missed bus, disconnected route, stop deletion, full fleet cap, bus lane legality, saved riders/queues ownership, equivalent journey count between car/transit modes. City fixture shows reduced car volume while total served people remains visible.

**Verify:** unit/browser; buses visibly stop/board/alight, queues and loads match records; no instant off-network transport. **Stop:** passengers disappear or appear as both vehicle and queue entries.

## S07.6 — Walking paths, crossings and multimodal access

**Depends:** S07.5. **Create:** src/walking.js, test/walking.test.js. **Modify:** road profile sidewalk flags, connectors/signals crossing conflicts, building/stop access, transit mode selection/render.

1. Derived walking graph along local/arterial sidewalks, connecting building entrances and bus stops. Motorways have no sidewalks. Bridge sidewalk only when explicitly enabled; tunnels initially pedestrians prohibited with visible rule.
2. Generate crosswalk links only at marked compatible junctions; crossing conflicts participate in same reservation/signal safety system as vehicles. Pedestrians cannot walk through water/rock/building footprints or across arbitrary motorway lanes.
3. Pedestrian speed1.4wu/s, visual small silhouettes at useful zoom. Group simulation for very dense pedestrian demand permitted only if each journey's ownership/count remains exact and conservation tests pass; no decorative crowd replacing actual service.
4. Route selection: walk-only for viable nearby destinations; otherwise walk→wait→bus→walk, or car. Bound search radius800wu walk-only,400wu access to transit; expose too-far/no-crossing reasons. All route legs must be valid.
5. UI tool toggles sidewalks/crosswalks through atomic commands, shows footprint/cost in budget mode. Removing crossing reroutes/waits/cancels explicitly and cannot strand invisible pending owners.
6. Tests missing crosswalk separates opposite sides, legal light phases prevent car/ped conflict, accessible bridge versus motorway barrier, saved mid-crossing pedestrian, transit access replacing old catchment without duplicate journey.

**Verify:** unit/browser; overlay exposes actual walking graph and trip legs; all people conserved, no car collision introduced by crossing permissions. **Scope:** no bicycles/rail in current plan; separate later expansion.

## S07.7 — Local map/challenge editor and R3 gate

**Depends:** S07.6. **Create:** src/editor.js, test/editor.test.js, browser editor flow. **Modify:** start/menu, scenario serializer, template library.

1. Editor opens a separate draft world, pauses simulation, and edits starting roads/buildings, map seed/profile, initial budget/rules, objectives/events and transit setup. It does not mutate current playable save until explicit 'Play copy'.
2. Use same commands/validators, not privileged bypasses. Place scenario fixtures with explicit inventory editor only inside authoring mode; runtime scenario cannot gain free inventory via editor shortcuts.
3. Validate scenario: legal graph, valid origins/destinations, objective metric allowlist, bounded event schedule, nonnegative budgets, at least one playable start. Optional reference-solution record runs headlessly; label unsolved authorship honestly rather than claiming auto-solvable.
4. Export data-only JSON with schema/content versions and title/author text limits. Import <=10MiB; use snapshot validators and escaped text; no arbitrary scripts, remote URLs or HTML assets. No public upload service.
5. Include eight polished shipped scenarios total (six initial plus incident and transit), each with a recorded passing solution and fail-state test. Local challenges can be shared as files.
6. R3 acceptance runs cross-system scenario freight+river+bus+crosswalk+incident+budget through save/reload and undo; confirms optional management never contaminates unlimited sandbox. Run novice study again for new start menu.

**Verify:** full test suite/browser/soak, all8reference solutions pass, import rejection leaves city untouched, no high-severity open defects. **R3 result:** feature-rich local beta, not online workshop or commercial release.
