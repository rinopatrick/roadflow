# Stage 01 — Correctness before new features

Read global contracts/testing, ALGORITHMS recipes A/B/E, REGRESSION-RECIPES R1–R5, and EVIDENCE E01–E05. No visual redesign here except rendering dimensions and signal truth. Keep each task independently testable; no broad rewrite.

## S01.1 — Single simulation clock and repeatable state

**Depends:** S00.3. **Read/modify:** src/main.js loop, src/core.js makeRng/uid, src/traffic.js constructors/spawn/update, src/economy.js RNG/rotation callers. **Create:** src/simulationClock.js, test/simulationClock.test.js; extend core/traffic tests.

1. Write failing tests for fixed tick counts at 1×/3×/8× across different wall-frame partitions; pause advances zero ticks; hidden-tab resume cannot advance hours; renderer reads same time as traffic.
2. Add callable RNG state access without changing existing output sequence. Test save state → draw values → restore state → identical values. Add world-owned ID source; retain v1 IDs, avoid collision on load.
3. Inject optional RNG/ID providers into constructors, defaulting compatibly for existing tests. Remove simulation Math.random; cosmetic choices use a separate stream. `uid` remains only for legacy callers until migrated.
4. Implement accumulator per CONTRACTS; main no longer increments or preassigns traffic.time. Tests use direct step counts.
5. Advance across short edges using residual distance; bound transitions by route length, detect zero-length routes rather than infinite loop. Two 10-wu edges travelled 15 wu finish at s=5 on second edge, not s=0.
6. Apply actual vehicle maxSpeed or remove unsupported random speed field; choose deterministic speed factor 1.0 initially. Add normalization of time/counters for snapshots.

```js
// Contract test for accumulator, with createSimulationClock introduced here.
const ticks = [];
const clock = createSimulationClock(dt => ticks.push(dt));
clock.advance(0.1, 3);
assert.equal(ticks.length, 18);
assert.ok(ticks.every(dt => dt === 1 / 60));
clock.advance(0.1, 0);
assert.equal(ticks.length, 18);
```

**Verify:** npm test; partition-equivalence test at 1, 3, 8 speeds; two runs same seed/commands produce same normalized state. **Stop:** unresolved nondeterministic callbacks or silently discarded ticks. Report overload policy explicitly.

## S01.2 — Correct return dispatch and lifecycle accounting

**Depends:** S01.1. **Modify:** economy.js `_completeTrip/processReturns`, traffic completion if needed; test/economy.test.js. **No new UI.**

1. Add regression below; confirm it fails against old implementation.
```js
const {net, eco} = serviceWorld();
const [home] = [...eco.buildings.values()].filter(b => b.type === 'house');
const [shop] = [...eco.buildings.values()].filter(b => b.type === 'shop');
eco._completeTrip({id: 'probe'}, shop.id, home.id);
let seen;
eco.processReturns(100, (from,to) => { seen = [from,to]; return {id:'return'}; });
assert.deepEqual(seen, [shop.drivewayNode, home.drivewayNode]);
assert.ok(seen.every(id => net.nodes.has(id)));
```
2. Resolve both building records at dispatch, not scheduling. Deleted origin/destination cancels with count/reason; blocked spawn retains queue and retries after 2 sim seconds. Remove no-op setTimeout.
3. Mark purpose `return` on spawned cars; return arrival must not grant a second outward-service XP reward.
4. Full integration: outbound arrival → dwell → return spawn → home arrival. Assert one service reward, two physical arrivals, pending queue empty. Separate blocked-spawn test retries once capacity clears; deleted-building test cancels once.
5. Add explicit pending-return data to economy serializer only when S01.7 introduces full snapshot; meanwhile keep existing serializer unchanged except documented new field if needed for regression.

**Verify:** npm test; no missing-node arguments; no negative/duplicate pending entries. **Rollback:** local task diff; no migration yet.

## S01.3 — Align road surface, lanes and vehicles

**Depends:** S01.2. **Modify:** roadNetwork.js ROAD_CLASS/laneOffset/lanePoint, render.js road passes/preview widths/markings, traffic dimensions callers, tests. **Create:** src/roadProfiles.js, test/roadProfiles.test.js.

1. Reproduce E02 numerically before changing widths. Test every lane for both directions, all three presets, plus one-way ring: abs(center)+vehicleHalfWidth <= pavementHalfWidth-shoulderAllowance.
2. Implement roadDimensions/laneCenterOffset using CONTRACTS dimensions. Use one-way zero median, correctly centered lane bundle. Keep `ROAD_CLASS` for preset speed/style but delegate width calculation.
3. Migrate renderer fills/casings/markings, hit width, draft preview and roundabout size callers in same task. Do not merely widen rendering while collision/picking remain old.
4. Test reversal symmetry and curve lane positions. Capture street/avenue/highway side by side at zoom .25,1,3 and DPR1/2; vehicles visibly on pavement.
5. Update tests that encoded wrong width values; preserve their intent with formula assertions. Do not loosen the containment test to accept existing overflow.

**Verify:** npm test; browser fixture screenshots; no road width lookup left outside profile model except documented legacy decoding. **Gate:** dimension correction visually approved before S02 polish.

## S01.4 — Correct phases and honest traffic metrics

**Depends:** S01.3. **Modify:** traffic.js `_mustYield/update`, render.js `_drawNode`, main.js HUD/inspect; traffic tests. **Create:** src/signals.js, test/signals.test.js.

1. Test shared legacy phase boundaries at every green/yellow/all-red transition, negative/large offsets normalized, invalid zero cycle rejected. At cycle14 ratio.42, t4 is yellow and t6 is all-red, not unrestricted green.
2. Implement phase function per CONTRACTS. Replace duplicated renderer and simulator phase logic with one result. Tie yellow behavior to stopping distance; already committed crossing clears.
3. Test congestion EMA after a fixed simulated duration with dt partitions 1/60 and 1/30; values within 1e-6. All stopped tends toward1; empty tends0. Use fixed clock in actual gameplay.
4. Show accurate label and direct percentage; add unit-tested stats `{active,pending,completed,cancelled}` without inventing unimplemented demand counts. Pending initially means return queue.
5. Add regression: two conflicting approaches never get green simultaneously; UI phase output matches simulation at identical time. Avoid claiming protected turns until S04.

**Verify:** npm test; browser change ratio and cycle, observe visible phase and car behavior; all metrics finite and percentage 0..100. **Rollback:** preserve v1 stored values; only interpretation fixed and documented.

## S01.5 — Repair road construction, crossing and split invariants

**Depends:** S01.4. **Modify:** roadNetwork.js addRoad/splitEdge/resolveCrossings/roundabout helpers; core geometry if necessary; roadNetwork tests. **Create:** test/geometry-regressions.test.js.

1. Add focused regressions: three-point L must not revisit first intermediate point; intermediate snap reuses node; eight crossing fixture creates eight junctions; split ring/oneway retains direction; split curve endpoints/shape preserved.
2. Define addRoad semantics: clicked control sequence defines one continuous path; graph segmentation occurs at actual junctions/endpoints, not arbitrary duplicated control prefixes. Keep serialized controls plus authoritative sampled path if necessary; splitting slices the sampled polyline at exact arc position instead of re-splining a different shape.
3. Replace six-pass silent limit with work queue and progress signature. Use a safety budget derived from segment-pair count; budget exhaustion returns explicit failed command and restores pre-operation graph. Collinear overlap rejected, near-tangent duplicate intersections deduplicated within0.5 wu.
4. Correct split metadata propagation. Ensure controls/pts start/end match node positions. Correct from-B distance conversion before split.
5. Roundabout conversion captures arm classes before removing them, updates endpoint geometry when moving nodes, and tracks created edge IDs for crossing scans. Reject insufficient room before mutation. No infinite ring-crossing rescan.
6. Test roundabout add/remove with asymmetric arms, short arms and an existing driveway. After failure, normalized topology exactly unchanged. Run graph invariant after every fixture operation.

**Verify:** npm test; eight junction regression; shape distance tolerance <=0.5 wu; no dangling IDs, unchanged failure snapshot. **Stop:** geometry policy ambiguity or invalid graph. Split task into independent geometry subtask if necessary; do not patch screenshots instead.

## S01.6 — Shared access and safe live edits

**Depends:** S01.5. **Modify:** economy.place/remove, network driveway functions/serializer, main bulldoze, traffic route reconciliation. **Create:** src/access.js, test/access.test.js, test/live-edit.test.js.

1. Reproduce two buildings sharing an endpoint; delete one, ensure other retains access. Reproduce shop/factory driveway demolition refund; correct type once.
2. Introduce buildingIds ownership per CONTRACTS; derive it from building records on legacy load. Separate access-node lifetime from building lifetime.
3. Centralize new placement evaluation `evaluateBuildingPlacement(world,{type,x,y})` → `{ok,reason,drivewayTarget}`. Check stock, finite coordinates, terrain footprint, building overlap, road/building overlap, driveway corridor and <=120wu access. Legacy buildings keep existing position; not auto-deleted. Preview uses this in S02.
4. Introduce `reconcileTrafficAfterEdit(world,change)`: remap a current edge split by arc distance where provided; reroute at next safe existing node for downstream changes; if impossible, cancel trip once with reason. Never call success/XP on deletion.
5. Test moving/removing roads during an active trip, deleting destination before arrival, demolition while paused; preserve cars on unaffected edges. Do not teleport a car onto a remote road merely to preserve counts.
6. Adopt clear `{ok,reason}` internal validation while keeping legacy `place` null return wrapper for existing tests until UI callers migrate.

**Verify:** npm test + browser stock counts on building/driveway demolition; valid graph after live edits; cancellations accounted. **Migration:** ownership rebuild documented for S01.7.

## S01.7 — Validated saves, restore fidelity and recovery

**Depends:** S01.6. **Modify:** save.js, main load/new/boot, economy and traffic state serializers. **Create:** src/worldSnapshot.js, test/save.test.js; extend browser smoke.

1. Write tests for v1 fixture migration, duplicate IDs, missing endpoints, NaN/Infinity, unknown enum/future version, truncated JSON, oversize import and blocked/quota storage.
2. Implement v2 contract and pure validation. `serializeWorld` includes cars, trip purposes, pending returns, clocks, RNG/IDs, camera and settings. Rebind callbacks during hydration rather than JSON-serializing closures.
3. Add serialize→hydrate→step equality test against uninterrupted world: same future commands/ticks produce equal normalized traffic/economy state. Test pending return and nearly-arrived car; reward exactly once.
4. Return structured load result `{ok:true,world,warnings}|{ok:false,error}`; migrate every caller. Failed load leaves current world and manual save untouched, no false success toast/newGame fallback.
5. Add last-good backup and separate autosave key; wrap every storage read/write including hasSave. Recovery UI action appears only if a valid backup exists. User confirmation before replacing a dirty world.
6. Wire JSON export/import with validation and warning preview. Native file input acceptable; expose actual controls in S02.2, while browser tests can call storage adapter directly now.

**Verify:** npm test; browser save/reload with active trip, corrupt import retains world, storage-error message. No functions/Map/Set or transient caches in serialized payload. **Rollback:** keep v1 source fixture and manual save backup; never overwrite original save during migration until validation passes.
