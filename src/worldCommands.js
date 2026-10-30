// Atomic world commands and bounded undo/redo — S03.1.
//
// WHY THIS MODULE EXISTS
// ----------------------
// Every construction action used to mutate the live world directly, so a
// half-applied edit was possible and there was no way back. CONTRACTS section 4
// requires that "a failed construction does not change graph, inventory, money,
// selection, RNG or ID counters", and DESIGN asks for undo that rewinds the
// SIMULATION rather than pretending to undo geometry while time runs on.
//
// The central decision: a command never touches the world it was given. It runs
// against a hydrated COPY, and the original is returned untouched on failure.
// That makes contract 4.6 true BY CONSTRUCTION rather than by remembering to
// roll back each of a dozen mutations.
//
// Commands are plain JSON records with a `kind` and a payload, no functions, so
// they can be logged, compared and (later) replayed.
import { serializeWorld, hydrateWorld } from './worldSnapshot.js';
import { polylineLengths, projectOnPolyline } from './core.js';
import { profileFor as profileForEdge, roadDimensions } from './roadProfiles.js';
import {
  validateRoadUpgrade, validateRoundaboutRadius, validateBuildingMove,
  validateProfileEdit, remapCarsForProfile,
} from './constructionEdits.js';

/**
 * The command kinds S03.1 owns: the actions that already exist.
 *
 * `upgradeRoad` and `moveBuilding` are in the CONTRACTS list but belong to
 * S03.4, which owns the profile validation and relocation semantics. They are
 * added to this same dispatcher there rather than guessed at here.
 */
export const COMMAND_KIND = {
  ADD_ROAD: 'addRoad',
  PLACE_BUILDING: 'placeBuilding',
  REMOVE_BUILDING: 'removeBuilding',
  REMOVE_ROAD: 'removeRoad',
  REMOVE_NODE: 'removeNode',
  MAKE_ROUNDABOUT: 'makeRoundabout',
  REMOVE_ROUNDABOUT: 'removeRoundabout',
  SET_SIGNAL: 'setSignal',
  ADD_GRID: 'addGrid',
  UPGRADE_ROAD: 'upgradeRoad',
  EDIT_PROFILE: 'editProfile',
  SET_ONEWAY: 'setOneway',
  ADD_LANE: 'addLane',
  MOVE_BUILDING: 'moveBuilding',
  APPLY_TEMPLATE: 'applyTemplate',
};

/** Every kind the dispatcher recognises. */
export const COMMAND_KINDS = Object.freeze(Object.values(COMMAND_KIND));

/** Default history bounds (CONTRACTS/DESIGN: up to 50 snapshots or 32 MiB). */
export const HISTORY_DEFAULT_ENTRIES = 50;
export const HISTORY_DEFAULT_BYTES = 32 * 1024 * 1024;

/** The configured history bounds, for documentation and tests. */
export function historyLimits() {
  return { entries: HISTORY_DEFAULT_ENTRIES, bytes: HISTORY_DEFAULT_BYTES };
}

/** Signal bounds, shared with the inspector sliders so they cannot disagree. */
export const SIGNAL_LIMITS = {
  cycleMin: 8, cycleMax: 60,
  greenRatioMin: 0.25, greenRatioMax: 0.6,
};

/** How close a new edge's endpoint must be to an old edge to count as a split. */
const SPLIT_TOLERANCE_WU = 1.5;

const fail = (reason) => ({ ok: false, reason });

/** Swaps an edge's endpoints so one-way `reverse` flips travel direction. */
function reverseEdgeEndpoints(world, edge) {
  const { a, b } = edge;
  edge.a = b;
  edge.b = a;
  // Controls run a→b; reversing keeps geometry identical, order swapped.
  edge.controls = [...edge.controls].reverse();
  void world;
}

/**
 * A deep copy of snapshot data.
 *
 * `hydrateWorld` does NOT copy its input: `Economy.fromJSON` stores the very
 * building objects from `data.buildings`, and the live `eco.batch` aliases
 * `data.batch`. Handing a stored snapshot straight to `hydrateWorld` therefore
 * makes the live world SHARE memory with the recorded history, so a command that
 * spends inventory silently rewrites the snapshot it is supposed to be able to
 * return to. Every hydration here gets its own copy.
 */
function copyData(data) {
  return typeof structuredClone === 'function'
    ? structuredClone(data)
    : JSON.parse(JSON.stringify(data));
}

// --------------------------------------------------------------- invariants ---

/**
 * Validates the structural invariants of CONTRACTS section 4.
 *
 * Returns null when the world is sound, or a human-readable reason string. This
 * runs on every command's result BEFORE publication, so a command that produced
 * a broken graph is refused rather than published.
 *
 * @param {{net:object, eco:object}} world
 * @returns {string|null}
 */
export function checkWorldInvariants(world) {
  const net = world?.net;
  const eco = world?.eco;
  if (!net || !eco) return 'world is missing a network or economy';

  // 4.1 / 4.2: every edge endpoint exists, is listed by that node, and the
  // geometry is finite with positive length.
  for (const e of net.edges.values()) {
    if (!net.nodes.has(e.a)) return `edge ${e.id} has a missing endpoint ${e.a}`;
    if (!net.nodes.has(e.b)) return `edge ${e.id} has a missing endpoint ${e.b}`;
    if (!Array.isArray(e.pts) || e.pts.length < 2) return `edge ${e.id} has no usable geometry`;
    for (const p of e.pts) {
      if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) {
        return `edge ${e.id} has non-finite geometry`;
      }
    }
    const total = e.cum?.[e.cum.length - 1];
    if (!(Number.isFinite(total) && total > 0)) return `edge ${e.id} has zero length`;

    const na = net.nodes.get(e.a);
    const nb = net.nodes.get(e.b);
    if (!na.edges.has(e.id)) return `node ${na.id} does not list edge ${e.id}`;
    if (!nb.edges.has(e.id)) return `node ${nb.id} does not list edge ${e.id}`;
  }

  // A node must not reference an edge that does not exist.
  for (const n of net.nodes.values()) {
    for (const eid of n.edges) {
      if (!net.edges.has(eid)) return `node ${n.id} lists a missing edge ${eid}`;
    }
  }

  // 4.5: a building's access reference must exist; never a dangling reference.
  for (const b of eco.buildings.values()) {
    if (!b.drivewayNode) return `building ${b.id} has no access node`;
    if (!net.nodes.has(b.drivewayNode)) {
      return `building ${b.id} points at a missing access node ${b.drivewayNode}`;
    }
  }

  return null;
}

// ------------------------------------------------------------ change record ---

/** Edge and building id sets, for the diff. */
function idSets(data) {
  return {
    edges: new Set((data.net?.edges ?? []).map(e => e.id)),
    buildings: new Set((data.eco?.buildings ?? []).map(b => b.id)),
  };
}

/**
 * The `change` record for a completed command.
 *
 * Computed by DIFFING the before and after snapshots rather than by asking each
 * handler to report its own edits. A handler that forgets to report a split
 * would silently break live-traffic reconciliation; a diff cannot forget.
 */
function computeChange(beforeData, afterData) {
  const b = idSets(beforeData);
  const a = idSets(afterData);

  const removedEdgeIds = [...b.edges].filter(id => !a.edges.has(id));
  const addedEdgeIds = [...a.edges].filter(id => !b.edges.has(id));
  const removedBuildingIds = [...b.buildings].filter(id => !a.buildings.has(id));
  const addedBuildingIds = [...a.buildings].filter(id => !b.buildings.has(id));

  return {
    removedEdgeIds,
    addedEdgeIds,
    removedBuildingIds,
    addedBuildingIds,
    replacedEdges: computeReplacedEdges(beforeData, afterData, removedEdgeIds, addedEdgeIds),
    topologyChanged: removedEdgeIds.length > 0 || addedEdgeIds.length > 0,
  };
}

/**
 * Maps each removed edge onto the new edges that now carry its geometry, with
 * arc ranges, per the CONTRACTS `replacedEdges` shape:
 *   {oldEdgeId, newEdgeId, oldStart, oldEnd, newStart, newEnd, orientation}
 *
 * `oldStart`/`oldEnd` are measured a->b along the OLD edge and `newStart`/
 * `newEnd` a->b along the NEW edge, so a reverse-travelling car can convert its
 * travel arc to an old geometric arc and back.
 *
 * shortcut: this detects the split/merge cases by projecting the new edge's
 * endpoints onto the old polyline. A new edge that lies on the old one but whose
 * endpoints are both off it (a partial rebuild) is not matched. S04.1 consumes
 * this for lane remapping and should extend it if it needs that case.
 */
function computeReplacedEdges(beforeData, afterData, removedEdgeIds, addedEdgeIds) {
  const out = [];
  if (!removedEdgeIds.length || !addedEdgeIds.length) return out;

  const oldEdges = beforeData.net?.edges ?? [];
  const newEdges = afterData.net?.edges ?? [];

  for (const oldId of removedEdgeIds) {
    const oldEdge = oldEdges.find(e => e.id === oldId);
    if (!oldEdge?.pts || oldEdge.pts.length < 2) continue;
    const { cum: oldCum } = polylineLengths(oldEdge.pts);

    for (const newId of addedEdgeIds) {
      const ne = newEdges.find(e => e.id === newId);
      if (!ne?.pts || ne.pts.length < 2) continue;

      const head = ne.pts[0];
      const tail = ne.pts[ne.pts.length - 1];
      const headOn = projectOnPolyline(oldEdge.pts, oldCum, head[0], head[1]);
      const tailOn = projectOnPolyline(oldEdge.pts, oldCum, tail[0], tail[1]);
      if (headOn.d > SPLIT_TOLERANCE_WU || tailOn.d > SPLIT_TOLERANCE_WU) continue;

      const forward = headOn.s <= tailOn.s;
      const { total: newTotal } = polylineLengths(ne.pts);
      out.push({
        oldEdgeId: oldId,
        newEdgeId: newId,
        oldStart: forward ? headOn.s : tailOn.s,
        oldEnd: forward ? tailOn.s : headOn.s,
        newStart: 0,
        newEnd: newTotal,
        orientation: forward ? 1 : -1,
      });
    }
  }

  // Ordered along each old edge, so a consumer can walk the chain.
  out.sort((p, q) => p.oldEdgeId.localeCompare(q.oldEdgeId) || p.oldStart - q.oldStart);
  return out;
}

// ----------------------------------------------------------------- handlers ---

/**
 * Each handler receives the WORKING COPY and the command, and returns
 * `{ok:true}` or `{ok:false, reason}`. Handlers dispatch to the existing
 * validated methods rather than reimplementing their algorithms, so there is
 * one copy of each construction rule in the codebase.
 */
const HANDLERS = {
  [COMMAND_KIND.ADD_ROAD](world, cmd) {
    const { controls, cls = 'street', pts = null } = cmd;
    if (!Array.isArray(controls) || controls.length < 2) {
      return fail('a road needs at least two control points');
    }
    // Validate the class BEFORE dispatching: addRoad itself does not check it,
    // so an unknown class would otherwise be accepted and only fail at render.
    try {
      roadDimensions(cls);
    } catch {
      return fail(`unknown road class: ${cls}`);
    }
    for (const p of controls) {
      if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) {
        return fail('road control points must be finite numbers');
      }
      if (!world.terrain.isRoadable(p[0], p[1])) {
        return fail('roads cannot cross water or rock');
      }
    }
    // `pts` is the geometry the draft evaluator produced. Passing it through
    // means the committed road IS the previewed road, rather than a second
    // spline that happens to be similar.
    const res = world.net.addRoad(controls, cls, pts ? { pts } : {});
    if (!res.edgeIds.length) return fail(res.reason ?? 'the road could not be built');
    return { ok: true };
  },

  [COMMAND_KIND.PLACE_BUILDING](world, cmd) {
    const { type, x, y } = cmd;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('position must be finite numbers');
    if (!world.eco.canPlace(type)) return fail(world.eco.lastPlacementReason ?? 'no stock of that type');
    const b = world.eco.place(type, x, y);
    if (!b) return fail(world.eco.lastPlacementReason ?? 'cannot place here');
    return { ok: true };
  },

  [COMMAND_KIND.REMOVE_BUILDING](world, cmd) {
    const b = world.eco.buildings.get(cmd.id);
    if (!b) return fail(`no building with id ${cmd.id}`);
    // Read the type BEFORE removal so the refund matches what was destroyed.
    const refundType = b.type;
    world.eco.remove(cmd.id);
    world.eco.batch[refundType] = (world.eco.batch[refundType] || 0) + 1;
    return { ok: true };
  },

  [COMMAND_KIND.REMOVE_ROAD](world, cmd) {
    const e = world.net.edges.get(cmd.edgeId);
    if (!e) return fail(`no road with id ${cmd.edgeId}`);
    if (e.ring) world.net.removeRoundabout(e.a);
    else world.net.removeEdge(cmd.edgeId);
    return { ok: true };
  },

  [COMMAND_KIND.REMOVE_NODE](world, cmd) {
    const n = world.net.nodes.get(cmd.nodeId);
    if (!n) return fail(`no junction with id ${cmd.nodeId}`);
    // Guard the cases that have their own kind, so a plain junction removal
    // cannot silently destroy a roundabout or a building's access.
    if (n.isRing) return fail('that junction is a roundabout; use removeRoundabout');
    if (n.type === 'driveway' && n.buildingIds?.length) {
      return fail('that junction serves a building; remove the building instead');
    }
    if (n.edges.size === 0) return fail('that junction has no roads');
    world.net.removeNode(cmd.nodeId);
    return { ok: true };
  },

  [COMMAND_KIND.MAKE_ROUNDABOUT](world, cmd) {
    const n = world.net.nodes.get(cmd.nodeId);
    if (!n) return fail(`no junction with id ${cmd.nodeId}`);
    if (n.isRing) return fail('that junction is already a roundabout');
    if (n.edges.size < 3) return fail('a roundabout needs at least three road connections');

    // A radius change rebuilds the whole ring, so it is validated first: a
    // radius that would swallow an arm or a building driveway is refused
    // BEFORE anything is destroyed.
    const radius = cmd.radius;
    if (radius !== undefined) {
      const check = validateRoundaboutRadius(world, cmd.nodeId, radius);
      if (!check.ok) return fail(check.reason);
    }

    const res = world.net.makeRoundabout(cmd.nodeId, radius);
    if (!res) return fail('that junction cannot take a roundabout');
    return { ok: true };
  },

  /**
   * Widens or narrows ONE road in place.
   *
   * The edge ID and its topology are preserved, so active cars keep their
   * routes; only the pavement width changes. The wider footprint is validated
   * first, so an upgrade can never swallow an adjacent building.
   */
  [COMMAND_KIND.UPGRADE_ROAD](world, cmd) {
    const check = validateRoadUpgrade(world, cmd.edgeId, cmd.cls);
    if (!check.ok) return fail(check.reason);
    const edge = world.net.edges.get(cmd.edgeId);
    if (!edge) return fail(`no road with id ${cmd.edgeId}`);
    edge.cls = cmd.cls;
    // The pavement width changed, so anything cached against it must be
    // invalidated. Topology did NOT change, so cars keep their routes.
    world.net.version++;
    return { ok: true };
  },

  /**
   * Relocates a building, preserving its ID, type, trips and job ownership.
   *
   * The destination is validated with the SAME placement validator as a fresh
   * placement, excluding the moved building from the overlap test. A move
   * neither spends nor refunds stock.
   */
  [COMMAND_KIND.MOVE_BUILDING](world, cmd) {
    const check = validateBuildingMove(world, cmd.id, cmd.x, cmd.y);
    if (!check.ok) return fail(check.reason);

    const b = world.eco.buildings.get(cmd.id);
    if (!b) return fail(`no building with id ${cmd.id}`);
    const oldNodeId = b.drivewayNode;

    // Release the OLD access claim first: a shared driveway must lose only this
    // building's claim, not the whole node.
    world.net.detachDriveway(oldNodeId, b.id);

    const target = check.drivewayTarget;
    const driveway = world.net.attachDriveway(b.id, target.x, target.y, 400);
    if (!driveway) {
      // Reattach the old claim so a failed move leaves the building reachable.
      world.net.attachDriveway(b.id, target.x, target.y, 400);
      return fail('could not attach a driveway at the destination');
    }
    // No explicit claimDriveway here: attachDriveway already claims the building,
    // and claiming is idempotent, so a second call would be dead code.

    b.x = cmd.x;
    b.y = cmd.y;
    b.drivewayNode = driveway.id;
    // The cached reachability is against the old position.
    b.reach = null;
    world.net.version++;
    return { ok: true };
  },

  [COMMAND_KIND.REMOVE_ROUNDABOUT](world, cmd) {
    const n = world.net.nodes.get(cmd.nodeId);
    if (!n) return fail(`no junction with id ${cmd.nodeId}`);
    const isRing = n.isRing || [...n.edges].some(eid => world.net.edges.get(eid)?.ring);
    if (!isRing) return fail('that junction is not a roundabout');
    world.net.removeRoundabout(cmd.nodeId);
    return { ok: true };
  },

  /**
   * A whole road grid as ONE atomic command, so one undo removes it.
   *
   * Segments are committed in the evaluator's order (perpendicular lines first,
   * then parallel ones), so each later segment sees the junctions the earlier
   * ones created. Any failing segment aborts the whole grid: a half-built grid
   * is worse than no grid, and the working copy is discarded by the dispatcher.
   */
  /**
   * Edits ONE road's lane/speed/access profile in place.
   *
   * Edge ID and topology preserved; only the profile changes. Footprint is
   * validated like an upgrade. Cars on removed lanes remap to an adjacent lane
   * on the same edge/direction when paused; otherwise removal of an occupied
   * lane is refused rather than overlapping cars.
   */
  [COMMAND_KIND.EDIT_PROFILE](world, cmd) {
    const check = validateProfileEdit(world, cmd.edgeId, cmd.profile ?? {});
    if (!check.ok) return fail(check.reason);
    const edge = world.net.edges.get(cmd.edgeId);
    const remap = remapCarsForProfile(world, edge, check.profile, { paused: cmd.paused === true });
    if (!remap.ok) return fail(remap.reason);
    edge.profile = { ...check.profile };
    edge.oneway = check.profile.backward === 0;
    world.net.version++;
    return { ok: true };
  },

  /**
   * Converts a road to one-way (or back to two-way). Direction follows edge
   * a→b unless `reverse` swaps the endpoints. Motorway driveways: new direct
   * attachment refused at placement time; legacy access preserved on load with
   * a warning (see normalise snapshot path), never silently deleted.
   */
  [COMMAND_KIND.SET_ONEWAY](world, cmd) {
    const edge = world.net.edges.get(cmd.edgeId);
    if (!edge) return fail(`no road with id ${cmd.edgeId}`);
    if (edge.ring) return fail('a roundabout ring is already one-way');
    const cur = profileForEdge(edge);
    let patch;
    if (cmd.oneway) {
      patch = cmd.reverse
        ? { forward: cur.backward > 0 ? cur.backward : cur.forward, backward: 0, medianWidth: 0 }
        : { forward: cur.forward, backward: 0, medianWidth: 0 };
      if (patch.forward < 1) patch.forward = 1;
    } else {
      patch = { forward: cur.forward, backward: Math.max(cur.forward, 1) };
    }
    const check = validateProfileEdit(world, cmd.edgeId, patch);
    if (!check.ok) return fail(check.reason);
    edge.profile = { ...check.profile };
    edge.oneway = !!cmd.oneway;
    if (cmd.oneway && cmd.reverse) reverseEdgeEndpoints(world, edge);
    world.net.version++;
    return { ok: true };
  },

  [COMMAND_KIND.ADD_GRID](world, cmd) {
    const { segments, cls = 'street' } = cmd;
    if (!Array.isArray(segments) || segments.length === 0) {
      return fail('a grid needs at least one road segment');
    }
    try {
      roadDimensions(cls);
    } catch {
      return fail(`unknown road class: ${cls}`);
    }
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const pts = Array.isArray(seg) ? seg : seg?.polyline;
      if (!Array.isArray(pts) || pts.length < 2) {
        return fail(`grid segment ${i + 1} has no usable geometry`);
      }
      for (const p of pts) {
        if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) {
          return fail(`grid segment ${i + 1} has non-finite geometry`);
        }
      }
      const res = world.net.addRoad(pts, cls, { pts });
      // A segment that is already fully paved is not a failure: committing the
      // same grid twice is idempotent rather than an error.
      if (!res.edgeIds.length && !/already runs along/.test(res.reason ?? '')) {
        return fail(`grid segment ${i + 1} could not be built: ${res.reason ?? 'unknown reason'}`);
      }
    }
    return { ok: true };
  },

  /**
   * Applies a whole template as ONE atomic command.
   *
   * Segments are built first and the roundabouts after, because a roundabout
   * needs the junction its arms create. Any failing segment aborts the whole
   * template: a partially placed template would leave the player with a shape
   * they did not ask for and cannot easily remove.
   */
  [COMMAND_KIND.APPLY_TEMPLATE](world, cmd) {
    const { segments, roundabouts = [] } = cmd;
    if (!Array.isArray(segments) || segments.length === 0) {
      return fail('a template needs at least one segment');
    }
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const cls = s.cls ?? 'street';
      try {
        roadDimensions(cls);
      } catch {
        return fail(`template segment ${i + 1} has unknown road class: ${cls}`);
      }
      const pts = [s.from, s.to];
      for (const p of pts) {
        if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) {
          return fail(`template segment ${i + 1} has non-finite geometry`);
        }
        if (!world.terrain.isRoadable(p[0], p[1])) {
          return fail(`template segment ${i + 1} would cross water or rock`);
        }
      }
      const res = world.net.addRoad(pts, cls, { pts });
      if (!res.edgeIds.length && !/already runs along/.test(res.reason ?? '')) {
        return fail(`template segment ${i + 1} could not be built: `
          + `${res.reason ?? 'unknown reason'}`);
      }
    }

    for (let i = 0; i < roundabouts.length; i++) {
      const r = roundabouts[i];
      // The junction is whatever node the arms created nearest the marker.
      let best = null;
      let bd = Infinity;
      for (const node of world.net.nodes.values()) {
        const d = Math.hypot(node.x - r.at[0], node.y - r.at[1]);
        if (d < bd) { bd = d; best = node; }
      }
      if (!best || bd > 40) {
        return fail(`template roundabout ${i + 1} found no junction to convert`);
      }
      const check = validateRoundaboutRadius(world, best.id, r.radius);
      if (!check.ok) return fail(`template roundabout ${i + 1}: ${check.reason}`);
      const made = world.net.makeRoundabout(best.id, r.radius);
      if (!made) return fail(`template roundabout ${i + 1} could not be built`);
    }

    return { ok: true };
  },

  [COMMAND_KIND.SET_SIGNAL](world, cmd) {
    const n = world.net.nodes.get(cmd.nodeId);
    if (!n) return fail(`no junction with id ${cmd.nodeId}`);
    if (n.isRing) return fail('a roundabout has no signal');
    if (n.edges.size < 2) return fail('a signal needs at least two road connections');

    const L = cmd.light ?? {};
    const cycle = L.cycle ?? 14;
    const greenRatio = L.greenRatio ?? 0.42;
    const offset = L.offset ?? 0;

    // Range-checked here so the command layer and the inspector cannot disagree
    // about what a legal signal is.
    if (!(Number.isFinite(cycle) && cycle >= SIGNAL_LIMITS.cycleMin && cycle <= SIGNAL_LIMITS.cycleMax)) {
      return fail(`cycle must be between ${SIGNAL_LIMITS.cycleMin} and ${SIGNAL_LIMITS.cycleMax} seconds`);
    }
    if (!(Number.isFinite(greenRatio)
      && greenRatio >= SIGNAL_LIMITS.greenRatioMin && greenRatio <= SIGNAL_LIMITS.greenRatioMax)) {
      return fail(`green ratio must be between ${SIGNAL_LIMITS.greenRatioMin} and ${SIGNAL_LIMITS.greenRatioMax}`);
    }
    if (!(Number.isFinite(offset) && offset >= 0 && offset <= cycle)) {
      return fail('offset must be within one cycle');
    }

    n.type = 'light';
    n.light = { cycle, greenRatio, offset };
    return { ok: true };
  },
};

// ----------------------------------------------------------- the dispatcher ---

/**
 * Applies one command atomically.
 *
 * The world is never mutated. A working copy is hydrated, the handler runs
 * against that copy, the result is validated, and only then is it returned for
 * publication. On any failure the ORIGINAL world is returned unchanged, which is
 * what makes contract 4.6 hold for every command without per-handler care.
 *
 * @param {object} world the live world (never modified)
 * @param {{kind:string}} command a JSON record
 * @param {{beforeData?:object}} [options] `beforeData` lets a caller that has
 *   already serialized the world (the history) avoid serializing it twice.
 * @returns {{ok:true, world:object, change:object, warnings:string[]}
 *          | {ok:false, reason:string, world:object}}
 */
export function applyWorldCommand(world, command, { beforeData } = {}) {
  const kind = command?.kind;
  const handler = HANDLERS[kind];
  if (!handler) {
    return { ok: false, reason: `unknown command kind: ${kind}`, world };
  }

  const before = beforeData ?? serializeWorld(world);

  // Work on a copy: a throw or a refusal cannot leave partial state behind.
  let working;
  try {
    working = hydrateWorld(copyData(before), {});
  } catch (err) {
    return { ok: false, reason: `could not copy the world: ${err.message}`, world };
  }

  let result;
  try {
    result = handler(working, command);
  } catch (err) {
    // An exception is a refusal, not a crash: the caller keeps its world.
    return { ok: false, reason: `command refused: ${err.message}`, world };
  }
  if (!result.ok) return { ok: false, reason: result.reason, world };

  // Validate before publication, so a command that produced a broken graph is
  // refused rather than published and saved. This is a SAFETY NET: every handler
  // validates its own inputs, so no current command can produce an invalid world
  // and the check cannot be observed failing from the dispatch path alone. It is
  // the gate the contract asks for, and test/worldCommands.test.js exercises
  // checkWorldInvariants directly against deliberately corrupted worlds.
  const problem = checkWorldInvariants(working);
  if (problem) return { ok: false, reason: `command produced an invalid world: ${problem}`, world };

  const afterData = serializeWorld(working);
  return {
    ok: true,
    world: working,
    change: computeChange(before, afterData),
    warnings: result.warnings ?? [],
  };
}

// ---------------------------------------------------------------- history ---

/** A snapshot's size estimate, in characters. Portable across browser and Node. */
function sizeOf(data) {
  return JSON.stringify(data).length;
}

/**
 * Bounded undo/redo over full world snapshots.
 *
 * Full snapshots rather than inverse operations, deliberately: CONTRACTS says
 * "full bounded snapshots are acceptable first; optimize only after
 * measurement", and an inverse-operation undo has to be correct for every
 * command kind, which is where undo bugs live.
 *
 * @param {number} [limit] maximum entries
 * @param {number} [byteLimit] maximum total snapshot size, in characters
 */
export function createHistory(limit = HISTORY_DEFAULT_ENTRIES, byteLimit = HISTORY_DEFAULT_BYTES) {
  const undoStack = [];
  const redoStack = [];
  let undoBytes = 0;
  let redoBytes = 0;
  let truncated = false;

  /** Drops the oldest entries until both bounds are satisfied. */
  function trim() {
    while (undoStack.length > 0
      && (undoStack.length > limit || (undoBytes > byteLimit && undoStack.length > 1))) {
      undoBytes -= undoStack.shift().bytes;
      truncated = true;
    }
  }

  return {
    /** Entries available to undo. */
    get depth() { return undoStack.length; },
    /** Total snapshot size held, in characters. */
    get bytes() { return undoBytes + redoBytes; },
    /** True when something is available to redo. */
    get canRedo() { return redoStack.length > 0; },
    /** True when a bound has evicted history. Documented, not silent. */
    get truncated() { return truncated; },

    /**
     * Applies a command and records the pre-edit snapshot.
     * A refused command records nothing, so a failure is never undoable.
     */
    execute(world, command) {
      // Serialize once and share it with the dispatcher.
      const before = serializeWorld(world);
      const result = applyWorldCommand(world, command, { beforeData: before });
      if (!result.ok) return result;

      undoStack.push({ data: before, bytes: sizeOf(before), label: command?.kind ?? 'edit' });
      undoBytes += undoStack[undoStack.length - 1].bytes;
      // A new action invalidates the redo branch.
      redoStack.length = 0;
      redoBytes = 0;
      trim();
      return result;
    },

    /**
     * Rewinds to the snapshot taken before the most recent edit.
     *
     * The entry is only consumed once the restored world has been validated, so
     * a corrupt snapshot cannot destroy the history.
     */
    undo(world) {
      if (!undoStack.length) return { ok: false, reason: 'nothing to undo', world };
      const entry = undoStack[undoStack.length - 1];

      // DEFENCE IN DEPTH, not a currently-observable guard. This entry is popped
      // and discarded a few lines below, so today the restored world cannot alias
      // anything the history still holds and the copy is redundant. It is kept
      // because `hydrateWorld` does NOT copy its input (see the pitfall in
      // TESTING.md), so the day undo is changed to peek instead of pop - or to
      // retain the entry for a redo path - dropping this line would silently make
      // the live world share memory with the history. A copy is far cheaper than
      // rediscovering that bug.
      const restored = hydrateWorld(copyData(entry.data), {});
      const problem = checkWorldInvariants(restored);
      if (problem) return { ok: false, reason: `cannot undo: ${problem}`, world };

      undoStack.pop();
      undoBytes -= entry.bytes;

      const current = serializeWorld(world);
      redoStack.push({ data: current, bytes: sizeOf(current), label: entry.label });
      redoBytes += redoStack[redoStack.length - 1].bytes;

      return { ok: true, world: restored, label: entry.label };
    },

    /** Restores the state that the most recent undo moved away from. */
    redo(world) {
      if (!redoStack.length) return { ok: false, reason: 'nothing to redo', world };
      const entry = redoStack[redoStack.length - 1];

      // As in undo: defence in depth against hydrateWorld aliasing its input.
      const restored = hydrateWorld(copyData(entry.data), {});
      const problem = checkWorldInvariants(restored);
      if (problem) return { ok: false, reason: `cannot redo: ${problem}`, world };

      redoStack.pop();
      redoBytes -= entry.bytes;

      const current = serializeWorld(world);
      undoStack.push({ data: current, bytes: sizeOf(current), label: entry.label });
      undoBytes += undoStack[undoStack.length - 1].bytes;

      return { ok: true, world: restored, label: entry.label };
    },

    /** Forgets all history. Used by New map and Load, which must not be undoable. */
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      undoBytes = 0;
      redoBytes = 0;
      truncated = false;
    },
  };
}
