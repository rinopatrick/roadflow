# Stage 04 — Lane-aware traffic and real junction controls

Highest-risk stage. Read CONTRACTS sections3/5/6, ALGORITHMS recipes C/D, and TESTING. Do not combine these six tasks into one 'improve traffic' change. Preserve R1/Road workbench behavior. Every new traffic permission must have a failing test and a visual diagnostic.

## S04.1 — Explicit directional road profiles and lane additions

**Depends:** S03.5. **Modify:** roadProfiles.js, network serialization/split/merge, traffic route lane assignment, renderer/inspector. **Create:** test/lane-profiles.test.js; v3 snapshot migration fixtures.

1. Add edge.profile per CONTRACTS. Convert presets to equivalent profiles; ring becomes forward1/backward0. Read legacy cls/oneway once during migration, not on every frame.
2. Replace all class-based lane counts and speed reads with profile functions. Ensure reverse direction with zero lanes cannot route. Old findPath obeys directional availability while awaiting lane route replacement.
3. Implement upgrade command that adds/removes a lane on a chosen direction, speed numeric control and local/arterial/motorway classification. Lane count0..4 each direction, total1..8; zero-both invalid. Display direction arrows relative to edge endpoints.
4. Width changes use same footprint validator and history. Reject occupied lane removal initially unless paused and a safe remap into an adjacent lane exists; do not overlap cars. Existing active routes invalidate and reroute at safe boundary.
5. Add one-way road tool and convert direction action. Motorway forbids new direct driveways; old saves retain access with warning. Side-added lane initially follows entire selected segment; S04.3 adds transition/merge behavior for short auxiliary segments.
6. v3 migration stores profiles, empty user movement restrictions and connector settings defaults; v1→v2→v3 supported. Profile metadata survives split, template export and undo.

**Verify:** unit/browser; every preset/direction combination; v1 fixture loads unchanged topology; build one-way loop and verify no reverse travel. **Stop:** random lane assignment still gives a forbidden lane or width code diverges.

## S04.2 — Junction connectors and legal route graph

**Depends:** S04.1. **Create:** src/junctions.js, test/junctions.test.js, test/lane-routing.test.js. **Modify:** pathfinding.js, traffic.js route traversal, road inspector and render connector overlay.

1. Pure `buildJunctionConnectors(net,nodeId)` uses incoming/outgoing tangents and profiles to enumerate legal movements. Reject same-edge U-turn by default, impossible direction and out-of-range lanes. Sort movements by stable tuple ID.
2. Generate short swept connector curves between trimmed lane endpoints; same input generates same geometry. Through paths stay smooth, turn curves bounded by junction footprint. Determine conservative conflicts by swept-path intersection including vehicle width; opposing non-crossing right turns may run together.
3. Add findVehicleRoute contract. Search lane/connector graph, cost travel seconds plus nonnegative congestion/turn penalties; admissible heuristic uses maximum configured speed or zero. Never derive edge path afterward with ambiguous edgeBetween when multiple directed paths exist.
4. Initial lane planning picks a legal lane sequence for entire route; no physical lane-change needed yet. It may reject a route that would require a not-yet-implemented lane change. UI should explain this limitation; do not teleport between lanes at nodes.
5. Add connector traversal/reservations to TrafficSim. Check downstream space before entering, reserve conflicting region, release after vehicle rear clears. Retain residual movement through edge→connector→edge. Vehicles cannot disappear while in connector on edit; command reconciles or waits until safe.
6. Add inspector turn restrictions and lane-connection editing: select incoming lane then allowed outgoing lane, preview conflicts, validate before committing. Default movement generator and stored override are distinct; no duplicate connectors after edits.
7. Tests: T/X/Y, skewed arms, protected geometry, blocked exit, no-U-turn, asymmetric lanes, disconnected legal lane path, conflicting vehicles approaching same tick. At most one owner per conflict group; no vehicle outside valid swept corridor.

**Verify:** unit/browser; 1000 seeded arrivals at four-way fixture, zero illegal connector entries/conflicting reservations; reachable simple paths complete. **Review gate:** inspect connector overlay and fixture trace before S04.3. **Rollback:** keep v2 backup; v3 records remain valid even when restriction list empty.

## S04.3 — Safe lane changes, merges and useful slip lanes

**Depends:** S04.2. **Create:** src/laneChanges.js, test/laneChanges.test.js. **Modify:** traffic.js lane occupancy/index, routing, renderer arrows and command profile edits.

1. Replace random per-edge lane choices with planned required exit lane plus optional speed advantage. Lane change record `{fromLane,toLane,startS,duration,elapsed}`; during transition occupies both lanes for collision checks.
2. Pure `canChangeLane(vehicle,targetLane,index,dt)` checks front and rear gaps and available remaining edge length. Minimum longitudinal gap = vehicleLength +2.2wu plus time headway1.2s; target rear vehicle must not need braking stronger than7wu/s². Test equality boundaries.
3. Lane change duration1.5s, cooldown3s, no voluntary change within25wu of a stop line or on a connector/ring. Required lane choice starts at max(60wu, speed*5s) before junction. If missed, continue legally and reroute; never cut across multiple lanes at the last instant.
4. Add merge policy for auxiliary lane ending: yield to existing target-lane traffic, deterministic zipper under low-speed queues. Reserve same-gap decisions in stable order to prevent two cars selecting identical space.
5. Slip lane is a user-built one-way road with diverge/merge connectors, not a cosmetic arrow. Allow short auxiliary profile segments, validation for taper length >=30wu; connect through normal connector logic and yield rules.
6. Tests: front/rear occupied target lane rejects, simultaneous opposing lane changes cannot swap through each other, mandatory turn lane reached, missed turn reroutes, short merge no deadlock, blocked exit still respected. Compare lane additions with baseline on fixture: throughput may improve but no fabricated guaranteed gain for every geometry.

**Verify:** unit/browser; 10-minute simulated merge stress, finite state and no swept overlap; visibly smooth lateral transition. **Stop:** solving deadlock by teleport/despawn or globally reducing collision gaps.

## S04.4 — Movement phases and protected turns

**Depends:** S04.3. **Modify:** signals.js, junctions conflict permissions, traffic yielding, node rendering, inspector. **Create:** test/signal-programs.test.js, browser signal editor scenario.

1. Implement signal program/getSignalState contract with explicit green/yellow/allRed phases. Pure phase evaluation tested at every boundary and offset wrap; renderer and sim use exact same result.
2. Migrate legacy axis lights into conservative protected movement phases. Conflict validation splits incompatible connector sets; show migration warning if cycle duration changes. No old save loses signal entirely.
3. Editor lists incoming movement arrows and phase timeline; select connectors, duration numeric/slider, add/remove/reorder phase, offset. Validate live preview but commit as one undoable command. Invalid phase never installed.
4. Presets: conservative all-movement sequence, opposing compatible through/right phases, separate protected lefts. Unsignalized and yield controls remain alternatives. No freeform program can allow conflicting protected movements.
5. Existing committed car clears on yellow; new entry follows stopping-distance rule; all-red lasts enough for configured clearance minimum. If large truck still occupies conflict zone, reservation prevents conflict even after green begins elsewhere.
6. Green-wave assistant for a selected corridor: given consistent cycle, calculate offset = cumulative free-flow travel time modulo cycle. Label as an estimate, not guaranteed optimal timing. Show before/after queue metrics using same demand fixture later S07.2.
7. Tests protected left versus opposing through, skewed intersection, invalid conflicting phase, no phase starvation (every enabled movement has a green in cycle), cycle edit while cars present, save/load/undo program fidelity.

**Verify:** npm test + browser timeline/vehicle trace. No simultaneous conflicting permission/reservation. **Gate:** independent human or operator-authorized review of phase fixtures recommended before complex city demand.

## S04.5 — Explainable congestion, routes and rerouting

**Depends:** S04.4. **Create:** src/trafficMetrics.js, test/trafficMetrics.test.js. **Modify:** traffic/pather, road/junction/vehicle inspectors, overlays.

1. Add bounded rolling60s windows, sample each sim second. Store throughput, active/queued/cancelled counts, trip-time samples, per-edge queue and travel-time EMA. Keep at most600 aggregated samples and1000 trip samples; no ever-growing history array.
2. Every stopped vehicle exposes one actual reason: signal, downstreamBlocked, following, connectorConflict, laneChangeWait, noRoute. Set reason from the controlling branch, not guessed from speed.
3. Route overlay highlights vehicle path and estimated versus actual time; inspector explains current wait and destination. Road overlay offers queue/travel-time/flow modes with legend and units.
4. Reroute no more often than every10sim seconds per car, at a safe node, only if new route improves estimated remaining cost by >=15% or current route becomes invalid. Keep deterministic tie-breaks; never reroute while inside connector/lane change. Track route revision to prevent oscillation.
5. Use one per-tick lane/approach index consumed by following, spawn, conflicts and metrics. No metrics routine re-scans every car inside every other car loop.
6. Tests a deliberately blocked corridor plus bypass, reroute hysteresis, noRoute recovery after new connection, vehicle count conservation and metrics window expiry. Percentiles tested from known [1,2,3,4,5] sample set with documented nearest-rank convention.

**Verify:** unit/browser; inspect each wait reason in fixture; opening overlays does not change simulation outcome. **Differentiaton:** explanations are deterministic simulation facts, no LLM/API service.

## S04.6 — Roundabout and lane-system acceptance

**Depends:** S04.5. **Modify:** ring construction/connector generation/traffic/renderer; existing roundabout tests. **Create:** test/traffic-stress.test.js, bounded browser traffic showcase.

1. Preserve basic single-lane ring by default. Add optional two-lane ring only if valid geometry and lane-path policy can be tested; this task's required result includes it, so split into a subtask rather than silently omit if difficult.
2. Two-lane ring policy: choose exit lane before entry, explicit connector paths, no voluntary lane changes inside ring; outer lane serves near exits, inner route transitions only via designated legal connectors. Reject impossible connection patterns; do not assume arbitrary lane swapping is safe.
3. Entry yield checks circulating conflict occupancy and downstream clearance. Busy entry starvation addressed by bounded metering only when player installs entry signals, not invisible priority inversion.
4. Add release matrix: street/avenue/highway, two-way/one-way, T/X/Y, signal/plain/yield, merge/slip/ring; every supported combination has fixture coverage or explicit UI rejection.
5. Stress 1000vehicles with repeated edits, signals, exports/reloads. Assert active+completed+cancelled matches admitted journeys; never create extra arrivals. Target zero permanent deadlock in fixtures designed with a valid free exit; legitimately saturated networks may queue and must explain it.
6. Capture readable normal-speed showcase of lanes, queues, phases, roundabout and bypass. Run all prior gates including keyboard/tutorial so feature UI did not break onboarding.

**Verify:** full unit/browser/soak and traffic stress; all save versions load; review fixture statistics. **Stop:** unresolved collisions, route corruption, hidden vehicle removal. Do not call this realistic microscopic traffic until these checks pass.
