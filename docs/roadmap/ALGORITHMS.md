# High-risk implementation recipes

Read only the recipe named by your active task. These are procedural algorithm specifications, not claims that corresponding code already exists. Keep algorithms pure before connecting UI. Production code still requires red/green tests and edge-case review.

## A. Fixed simulation clock — S01.1

Public interface:

```js
createSimulationClock(stepFn, {step = 1/60, maxTicks = 120} = {})
// returns {advance(wallSeconds,speed), reset(), get backlogSeconds(), get droppedSeconds()}
```

1. Reject nonfinite/negative wallSeconds and speed not in0,1,3,8.
2. If speed0, return0ticks without consuming paused wall time or running stepFn.
3. Add min(wallSeconds,.25)*speed to accumulator.
4. While accumulator+1e-10>=step and count<maxTicks: call stepFn(step), subtract step, incrementcount. Clamp tiny negative remainder to0.
5. If backlog>2s, add backlog-2 to droppedSeconds and cap to2s. Return tick count for diagnostics.
6. `reset` sets accumulator0; it does not reset world simulation time or RNG. Used on visibility resume/new/load.
7. Do not add an independent main simTime increment. Render receives traffic.time after ticks.

Test partition equivalence with wall chunks each <=.25s and below overload cap. Overload deliberately breaks wall-time catch-up; test recorded droppedSeconds rather than falsely asserting equivalence after dropped time.

## B. Continuous geometry and crossing work queue — S01.5/S03.2

Authority: committed centreline polyline plus cumulative arc length. Keep authoring controls as edit metadata; do not re-fit a new spline after a split.

1. Evaluate the full user control path once. Sample every segment, including two-point straight paths, to maximum4wu spacing for terrain checks. Curve geometry uses Catmull-Rom initially; detect self-intersection/too-tight radius and reject rather than silently fold.
2. For splitting arc `s`, binary search cum; interpolate exact split point; left samples=prefix+point, right=point+suffix; avoid duplicate adjacent points within1e-6. Assign controls clipped to new endpoints for later editor reconstruction, but preserve authoritative polyline.
3. When discovering intersections, broad phase uses segment AABBs; narrow phase uses independent 2D segment intersection, parameter values and grade at arc. Ignore shared endpoints within tolerance; distinguish collinear overlap (reject) from endpoint touch (connect).
4. Collect all crossings for new candidate path against existing graph before mutation where possible. Sort split positions along each edge; merge positions within.5wu; split once into ordered children. This avoids endless pairwise re-splitting and the current six-crossing truncation.
5. Build node identity map for merged crossing locations at compatible grade. Reuse existing nearby valid node, stable ID tie; do not merge unrelated parallel roads merely because snap distance is large.
6. Propagate profile/grade/ring/access metadata; map old→new arcs. Apply node/edge replacements to temporary world; validate all invariants; then publish single transaction.
7. If implementing incremental queue instead, queue item references an edge version. Drop stale items and enqueue changed children. Track progress signature of sorted geometry/topology IDs. Repeated signature or budget exhaustion fails entire transaction. Never break and accept partial intersections.
8. Building/access corridor and pavement-width terrain checks sample lateral points at centre±halfWidth plus interior offsets; curves require lateral-spacing<=3wu. Segment sample check plus dense footprint probe is first implementation, not an exact polygon boolean guarantee. For narrow forbidden slivers smaller than sample interval, use segment-versus-terrain-cell intersection or shrink interval; include an adversarial water-strip fixture. Do not call sparse point sampling rigorous geometry validation.

Test oracle samples original curve independently and compares split union. Test8crossings, endpoint touches, collinear overlap, duplicate points, nearly parallel road, curve self-intersection and grade exclusions.

## C. Lane routing without unsafe teleports — S04.2/S04.3

Use directed lane traversals as graph vertices, not only road nodes. Vertex key=`edgeId:dir:lane`; it represents traversing that lane from its entry to its exit.

1. Start candidates: legal outgoing lanes at origin access node, filtered by vehicle class. Goal candidates end at destination access node.
2. Each connector maps one incoming lane vertex to an outgoing lane vertex; traversal cost = incoming remaining edge time + connector time + nonnegative measured penalty.
3. Search records predecessor **edge/lane/connector tuple**, not only node ID. Reconstruct exact steps; `connectorId` belongs to end of each step. Static connector restriction filters adjacency; signal red adds estimated delay but does not remove the legal edge forever.
4. Before S04.3, only same-lane traversal/connector transitions are permitted. Do not silently change lane index between edge samples to invent a legal route.
5. S04.3 adds adjacent-lane transition opportunities within an edge. Plan required lane at next junction; simulation schedules lateral change when safe. Use conservative route connectivity: if a needed change requires more distance than1.5s*speed plus25wu junction buffer, that transition is unavailable. Multiple lane changes need sequential duration/cooldown; no direct lane0→lane2 jump.
6. If dynamic traffic prevents planned change, car keeps legal current lane, takes a legal fallback exit or waits before entry if possible, then reroutes at next safe node. It must not stop forever on a lane with no legal continuation without explaining noRoute. Avoid closed-cycle repeated reroutes using10s cooldown and15%improvement threshold.
7. Origin==destination is a served zero-distance need only in demand policy; `TrafficSim.spawn` still returns null for zero-step vehicle trip. Distinguish no vehicle required from failed dispatch in demand layer.

Independent route test enumerates a tiny lane graph by brute force, compares optimal cost to A*, and validates every reconstructed transition against legal connector IDs. If heuristic cannot be proven optimistic, set it0 first; correctness beats fast wrong paths.

## D. Connector conflicts and deterministic reservations — S04.2/S04.4

1. Trim lane centreline endpoints at junction boundary; connector curves join these points with tangents. Limit controls so curve stays inside junction/turn footprint; reject impossible movement, never draw it through a building.
2. Sample connector arc <=1wu. Build swept corridor using maximum permitted vehicle half-width plus.5wu margin. Conflict if corridors intersect, share merge exit lane, or opposing entry occupies same narrow corridor. Identity movement can support following headway, but first implementation may serialize it for safety.
3. Derive symmetric conflict sets: if B conflicts A, A conflicts B. Unit test symmetry and expected compatible opposing through movements separately. Conservative overblocking must be measured and reduced with evidence, not guessed.
4. At each tick, first gather all requests using **pre-tick state**, then resolve stable order: valid signal permission, reservation already held, waiting-age descending, arrival time, stable vehicle ID. Never let Map mutation order create double admission.
5. Admission also reserves enough downstream lane space for vehicle length+gap. A request denied gets explicit waitReason. Reservation remains while rear lies inside corridor; no release merely because front reached next edge.
6. Advance accepted cars; update occupancy; release exited reservations. If a car is deleted by an approved world edit, release its reservations and cancel journey once. Snapshot includes active reservations or reconstructs them deterministically from connector-mode vehicles.
7. Signal phases only permit a subset of non-conflicting requested movements. All-red still allows already admitted cars to clear. Preemption requests wait for clearance; no instant green conflict override.

Stress tests must exercise equal-arrival opposing cars, long truck, red→green boundary, blocked downstream, simultaneous edit, saved connector occupancy and bus/pedestrian conflicts added later.

## E. Snapshot migration and commands — S01.7/S03.1

1. Raw bytes size check → JSON parse → version type check → version-specific schema validation → migration chain one version at a time → final validation → temporary hydration → graph/vehicle/economy invariants.
2. Do not use defaults to conceal missing required arrays or IDs. Only explicitly optional legacy fields get documented defaults.
3. Rebuild caches (adjacency, reachability, terrain tiles, connectors); preserve authoritative state (geometry, ownership, inventories, clocks, RNG, jobs, reservations, routes).
4. Restore callback behavior by job ID/purpose, not by serializing closures. Every completion has an idempotent settled flag/event record, so restored near-arrival vehicles cannot award twice.
5. Apply command on a temporary world with cloned snapshots. Validation failure returns original world and reason. On success reconcile changes, validate invariants, publish through replaceWorld, and record history.
6. Exactly one UI binding references current world via getter; do not leave handlers closed over obsolete net/eco after load/undo.
7. Autosave/manual/export share same serializer. Storage adapter owns keys/backup policy. Import does not mutate current state during validation; user confirms replacement only after preview is valid.
8. Derived cache version changes after replacement even if serialized net.version matches old world, so renderer/path caches cannot use an obsolete object with coincident version number. Use world identity/revision as part of cache key.

## F. Grade-aware rendering and picking — S05

The renderer must no longer draw all road shadows, all road casings and all cars globally irrespective of grade.

1. Divide draw items into terrain, underground (only when selected), ground road surfaces/markings, ground buildings/vehicles, bridge shadows and elevated decks/vehicles. Ramps span grades; split their draw path into monotonically ordered height samples when necessary.
2. Occlusion at crossings depends on local interpolated height, not only edge.kind. A ramp crossing a ground road at2wu is invalid geometry, not a rendering choice.
3. Draw elevated deck over lower vehicles, not just lower pavement. Render upper deck vehicles after deck. Keep debug overlay able to reveal lower path explicitly.
4. Picking gathers candidates in screen radius, filters active layer first, sorts visible height then geometric distance/stable ID. A modifier cycles candidates with a visible name/elevation label. Delete acts on highlighted candidate only.
5. Tile/Path2D caches keyed by world revision, geometry revision, grade and style version. Camera zoom invalidates only caches needing pixel-dependent detail.

## G. Freight/passenger conservation — S06/S07

1. Separate a requested journey from physical vehicle and cargo. Request state machine owns completion/cancel counts; vehicle merely transports it.
2. Reserving capacity is not delivering stock. Track `available = onHand - reservedOutbound`, `free = capacity - onHand - reservedInbound`.
3. Dispatch transfers reserved outbound into vehicle cargo only after spawn succeeds; blocked spawn retains reservation with bounded retry. Arrival reduces inbound reservation and adds onHand. Cancellation has explicit return/loss policy and adjusts both reservation sides exactly once.
4. Passengers are in exactly one place: pending origin, walking leg, stop queue, vehicle manifest, completed/cancelled. Transfer removes old ownership before adding new within a transaction; assert totals after each tick.
5. A deleted bus/stop/building must move passengers into rerouting or cancel with reason; cannot just delete the container Map. Save/resume preserves ownership and retry/dwell timers.
6. For before/after experiments, requested demand trace is fixed. Changing infrastructure cannot improve score by suppressing unsuccessful requests.

These recipes reduce ambiguity. They do not replace measured tests or justify skipping review when geometry or conservation fails.
