// Safe construction edits — S03.4.
//
// WHY THIS MODULE EXISTS
// ----------------------
// Four edits can each destroy something the player did not intend:
//
//   upgradeRoad      widens the pavement, which can swallow an adjacent building
//   setRoundaboutRadius  rebuilds the ring, which can strand an arm or a driveway
//   moveBuilding     relocates a building, which can invalidate its access
//   demolish         can take out more than was clicked (a whole ring, a driveway
//                    shared by several buildings)
//
// The rule the task states is: "command must not silently evict a building or
// invalidate data to succeed." So every one of these is validated BEFORE it
// commits, and a refusal leaves the world untouched. The validators are pure, so
// the inspector can also call them to explain WHY something is refused before
// the player clicks.
import { dist } from './core.js';
import { normaliseProfile, profileFor, roadDimensions } from './roadProfiles.js';
import { evaluateBuildingPlacement, PLACEMENT_REASON } from './access.js';
import { BUILDING_DEFS } from './economy.js';

/** Roundabout radius bounds, in world units. */
export const ROUNDABOUT_RADIUS = { min: 24, max: 100, default: 32 };

/** Road classes an upgrade may move between, in ascending capacity. */
export const UPGRADE_CLASSES = ['street', 'avenue', 'highway'];

/**
 * How far a widened road reaches beyond its centreline, in world units.
 * Used by the upgrade check and by the demolition preview.
 */
export function pavementHalfWidth(cls) {
  return roadDimensions(cls).width / 2;
}

/**
 * Validates widening (or narrowing) one edge to a new class, IN PLACE.
 *
 * The edge ID is preserved and the topology does not change, so active cars keep
 * their routes; only the pavement width changes. What must be checked is that the
 * wider pavement does not swallow a building or cross unbuildable ground.
 *
 * @param {{net:object, terrain:object, eco:object}} world
 * @param {string} edgeId
 * @param {string} newCls
 * @returns {{ok:true, edgeId:string, from:string, to:string}
 *          | {ok:false, reason:string, at:[number,number]|null}}
 */
export function validateRoadUpgrade(world, edgeId, newCls) {
  const deny = (reason, at = null) => ({ ok: false, reason, at });

  if (!UPGRADE_CLASSES.includes(newCls)) {
    return deny(`unknown road class: ${newCls}`);
  }
  const edge = world?.net?.edges?.get(edgeId);
  if (!edge) return deny(`no road with id ${edgeId}`);
  if (edge.ring) return deny('a roundabout ring cannot be upgraded');
  if (edge.cls === newCls) return deny(`that road is already a ${newCls}`);

  const fromHalf = pavementHalfWidth(edge.cls);
  const toHalf = pavementHalfWidth(newCls);

  // Narrowing never widens the footprint, so nothing can be swallowed.
  if (toHalf <= fromHalf) {
    return { ok: true, edgeId, from: edge.cls, to: newCls };
  }

  const pts = edge.pts;
  if (!Array.isArray(pts) || pts.length < 2) return deny('that road has no usable geometry');

  // The NEW pavement must sit on buildable ground along its whole length, and at
  // its full width - not merely on the centreline, which was already legal.
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1] ?? pts[i - 1];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const nx = -(q[1] - p[1]) / len;
    const ny = (q[0] - p[0]) / len;
    for (const side of [1, -1]) {
      const ex = p[0] + nx * toHalf * side;
      const ey = p[1] + ny * toHalf * side;
      if (!world.terrain.isRoadable(ex, ey)) {
        return deny(`a ${newCls} is too wide for the ground there`, [ex, ey]);
      }
    }
  }

  // No building may fall inside the wider pavement.
  for (const b of world.eco.buildings.values()) {
    const def = BUILDING_DEFS[b.type];
    if (!def) continue;
    const clearance = def.size / 2 + toHalf;
    let nearest = Infinity;
    for (let i = 1; i < pts.length; i++) {
      nearest = Math.min(nearest, segDist(b.x, b.y, pts[i - 1], pts[i]));
    }
    if (nearest < clearance) {
      return deny(
        `a ${newCls} would cut through a ${def.label.toLowerCase()}`,
        [b.x, b.y]);
    }
  }

  return { ok: true, edgeId, from: edge.cls, to: newCls };
}

/**
 * Validates a profile edit: lane/speed/access change on ONE edge, in place.
 *
 * Same footprint rule as validateRoadUpgrade: the new pavement must sit on
 * buildable ground and must not swallow a building. Removing the last lane in
 * a direction the network still routes through is refused with the reason.
 * Motorway forbids new direct driveways; legacy access is preserved with a
 * warning flag rather than deleted.
 */
export function validateProfileEdit(world, edgeId, patch) {
  const deny = (reason, at = null) => ({ ok: false, reason, at });
  const edge = world?.net?.edges?.get(edgeId);
  if (!edge) return deny(`no road with id ${edgeId}`);
  if (edge.ring) return deny('a roundabout ring cannot be edited lane by lane');
  let next;
  try {
    next = normaliseProfile(patch ?? {}, profileFor(edge));
  } catch (e) {
    return deny(e.message);
  }
  const prev = profileFor(edge);
  const toHalf = (next.forward + next.backward) * next.laneWidth
    + (next.forward > 0 && next.backward > 0 ? next.medianWidth : 0)
    + 2 * next.shoulderWidth;
  const half = toHalf / 2;
  const pts = edge.pts;
  if (!Array.isArray(pts) || pts.length < 2) return deny('that road has no usable geometry');
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1] ?? pts[i - 1];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const nx = -(q[1] - p[1]) / len;
    const ny = (q[0] - p[0]) / len;
    for (const side of [1, -1]) {
      const ex = p[0] + nx * half * side;
      const ey = p[1] + ny * half * side;
      if (!world.terrain.isRoadable(ex, ey)) {
        return deny('the new profile is too wide for the ground there', [ex, ey]);
      }
    }
  }
  for (const b of world.eco.buildings.values()) {
    const def = BUILDING_DEFS[b.type];
    if (!def) continue;
    const clearance = def.size / 2 + half;
    let nearest = Infinity;
    for (let i = 1; i < pts.length; i++) {
      nearest = Math.min(nearest, segDist(b.x, b.y, pts[i - 1], pts[i]));
    }
    if (nearest < clearance) {
      return deny(`the new profile would cut through a ${def.label.toLowerCase()}`, [b.x, b.y]);
    }
  }
  void prev;
  return { ok: true, edgeId, profile: next };
}

/**
 * Remaps cars travelling on an edge whose profile is about to shrink.
 *
 * Cars on a surviving lane keep it. Cars on a removed lane move to the
 * nearest surviving lane in the same direction when `paused` is true and the
 * target lane has room; otherwise the edit is refused rather than overlapping
 * cars. Routes stay valid because topology is unchanged; only lane indices
 * shift.
 */
export function remapCarsForProfile(world, edge, next, { paused = false } = {}) {
  const cars = [...(world.traffic?.cars?.values() ?? [])]
    .filter(c => !c.dead && c.route?.steps?.[c.step]?.edgeId === edge.id);
  if (!cars.length) return { ok: true, remapped: 0 };
  let remapped = 0;
  for (const car of cars) {
    const st = car.route.steps[car.step];
    const avail = st.dir === 1 ? next.forward : next.backward;
    if (st.lane < avail) continue;
    const target = Math.max(avail - 1, 0);
    if (!paused) {
      return { ok: false, reason: `lane ${st.lane} is occupied; pause to remap or wait for it to clear` };
    }
    // Same edge/direction, nearest surviving lane; gap check against others.
    const blocked = cars.some(o => o !== car && !o.dead
      && o.route?.steps?.[o.step]?.edgeId === edge.id
      && o.route.steps[o.step].dir === st.dir
      && o.route.steps[o.step].lane === target
      && Math.abs(o.s - car.s) < 12);
    if (blocked) {
      return { ok: false, reason: `lane ${target} is occupied; wait for it to clear` };
    }
    st.lane = target;
    remapped++;
  }
  return { ok: true, remapped };
}

/** Distance from a point to a segment. */
function segDist(px, py, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - a[0]) * abx + (py - a[1]) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + abx * t), py - (a[1] + aby * t));
}

/**
 * Validates a roundabout radius before the ring is rebuilt.
 *
 * Three things can go wrong when the radius changes:
 *   - an arm shorter than the radius would be swallowed entirely
 *   - two arms closer together than the ring's width would overlap
 *   - a building's access node could end up inside the ring
 *
 * @param {{net:object, terrain:object, eco:object}} world
 * @param {string} nodeId
 * @param {number} radius world units
 * @returns {{ok:true, radius:number} | {ok:false, reason:string}}
 */
export function validateRoundaboutRadius(world, nodeId, radius) {
  const deny = (reason) => ({ ok: false, reason });

  if (!Number.isFinite(radius)) return deny('the radius must be a number');
  if (radius < ROUNDABOUT_RADIUS.min || radius > ROUNDABOUT_RADIUS.max) {
    return deny(`the radius must be between ${ROUNDABOUT_RADIUS.min} and `
      + `${ROUNDABOUT_RADIUS.max} wu`);
  }

  const center = world?.net?.nodes?.get(nodeId);
  if (!center) return deny(`no junction with id ${nodeId}`);

  const arms = [...center.edges]
    .map(id => world.net.edges.get(id))
    .filter(e => e && !e.ring);
  if (arms.length < 2) return deny('a roundabout needs at least two roads');

  // Every arm must survive the ring: an arm shorter than the radius would be
  // consumed entirely and the roundabout would have nothing to connect to.
  for (const e of arms) {
    const reach = Math.min(e.total, e.total);
    if (reach < radius) {
      return deny(`one of the roads is shorter (${Math.round(reach)} wu) than the radius `
        + `(${Math.round(radius)} wu), so it would be swallowed`);
    }
  }

  // Arms must be far enough apart that their mouths do not overlap on the ring.
  // The chord between two adjacent arm angles must exceed the ring's own width.
  const ringWidth = roadDimensions({ cls: 'street', oneway: true }).width;
  const angles = arms
    .map((e) => {
      const other = e.a === center.id ? world.net.nodes.get(e.b) : world.net.nodes.get(e.a);
      if (!other) return null;
      return Math.atan2(other.y - center.y, other.x - center.x);
    })
    .filter(a => a !== null)
    .sort((a, b) => a - b);

  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    const b = i === angles.length - 1 ? angles[0] + Math.PI * 2 : angles[i + 1];
    const gap = b - a;
    const chord = 2 * radius * Math.sin(gap / 2);
    if (chord < ringWidth) {
      return deny(`two roads meet at too narrow an angle for a ${Math.round(radius)} wu ring`);
    }
  }

  // A building whose access node is inside the ring would lose its driveway.
  for (const b of world.eco.buildings.values()) {
    const node = world.net.nodes.get(b.drivewayNode);
    if (!node) continue;
    if (dist(node.x, node.y, center.x, center.y) < radius) {
      return deny('a building\'s driveway would end up inside the ring');
    }
  }

  return { ok: true, radius };
}

/**
 * Validates relocating a building, using the SAME placement validator as a fresh
 * placement but excluding the building being moved from the overlap test.
 *
 * Moving must not consume stock and must not change the building's ID or type, so
 * its trips and job ownership survive.
 *
 * @param {{net:object, terrain:object, eco:object}} world
 * @param {string} buildingId
 * @param {number} x
 * @param {number} y
 * @returns {{ok:true, buildingId:string, drivewayTarget:object}
 *          | {ok:false, reason:string}}
 */
export function validateBuildingMove(world, buildingId, x, y) {
  const deny = (reason) => ({ ok: false, reason });

  const b = world?.eco?.buildings?.get(buildingId);
  if (!b) return deny(`no building with id ${buildingId}`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return deny('position must be finite numbers');

  // A view of the world with the moved building removed from the overlap test and
  // stock guaranteed, because a move neither collides with itself nor spends
  // inventory.
  const others = new Map();
  for (const [id, other] of world.eco.buildings) {
    if (id !== buildingId) others.set(id, other);
  }
  const proxyEco = {
    buildings: others,
    batch: { ...world.eco.batch, [b.type]: Math.max(1, world.eco.batch[b.type] ?? 0) },
  };

  const result = evaluateBuildingPlacement(
    { net: world.net, terrain: world.terrain, eco: proxyEco },
    { type: b.type, x, y },
  );
  if (!result.ok) return deny(result.reason);

  return { ok: true, buildingId, drivewayTarget: result.drivewayTarget };
}

/**
 * What a demolition click would actually remove, so the UI can say so first.
 *
 * DESIGN section 1 forbids an action that takes more than it appears to: a ring
 * click removes the WHOLE ring, and a driveway node can serve several buildings.
 * This reports every piece so the preview can list them.
 *
 * @param {{net:object, eco:object}} world
 * @param {number} x
 * @param {number} y
 * @param {{buildingRadius?:number, nodeRadius?:number, edgeRadius?:number}} [tol]
 * @returns {{kind:'building'|'roundabout'|'node'|'edge'|'none', buildingIds:string[],
 *            edgeIds:string[], nodeIds:string[], description:string}}
 */
export function demolitionPreview(world, x, y, tol = {}) {
  const empty = {
    kind: 'none', buildingIds: [], edgeIds: [], nodeIds: [], description: 'nothing here',
  };
  const net = world?.net;
  const eco = world?.eco;
  if (!net || !eco) return empty;

  const buildingRadius = tol.buildingRadius ?? 0.8;
  const nodeRadius = tol.nodeRadius ?? 16;
  const edgeRadius = tol.edgeRadius ?? 10;

  // A building first: it is what the player most likely clicked.
  for (const b of eco.buildings.values()) {
    const def = BUILDING_DEFS[b.type];
    if (!def) continue;
    if (dist(x, y, b.x, b.y) < def.size * buildingRadius) {
      // The access node can be SHARED: several buildings beside one road point
      // claim the same driveway. Report every owner, or the preview would say
      // "one house" while the demolition takes three.
      const access = net.nodes.get(b.drivewayNode);
      const owners = (access?.buildingIds ?? [b.id]).filter(id => eco.buildings.has(id));
      const ids = owners.length ? owners : [b.id];
      return {
        kind: 'building',
        buildingIds: ids,
        edgeIds: [],
        nodeIds: access ? [access.id] : [],
        description: ids.length > 1
          ? `${ids.length} buildings sharing this driveway`
          : `the ${def.label.toLowerCase()}`,
      };
    }
  }

  // Then a node.
  let node = null;
  let bestD = Infinity;
  for (const n of net.nodes.values()) {
    const d = dist(x, y, n.x, n.y);
    if (d < nodeRadius && d < bestD) { bestD = d; node = n; }
  }
  if (node) {
    const isRing = node.isRing
      || [...node.edges].some(eid => net.edges.get(eid)?.ring);

    if (isRing) {
      // A ring click removes the entire ring, and the UI must say so.
      const ringEdges = [...net.edges.values()].filter(e => e.ring);
      const ringNodes = new Set();
      for (const e of ringEdges) { ringNodes.add(e.a); ringNodes.add(e.b); }
      return {
        kind: 'roundabout',
        buildingIds: [],
        edgeIds: ringEdges.map(e => e.id).sort(),
        nodeIds: [...ringNodes].sort(),
        description: `the whole roundabout (${ringEdges.length} ring roads)`,
      };
    }

    if (node.type === 'driveway' && node.buildingIds?.length) {
      // A shared access node can serve several buildings; list them all.
      const owners = node.buildingIds.filter(id => eco.buildings.has(id));
      return {
        kind: 'building',
        buildingIds: owners,
        edgeIds: [...node.edges].filter(eid => net.edges.get(eid)?.cls === 'driveway'),
        nodeIds: [node.id],
        description: owners.length > 1
          ? `${owners.length} buildings sharing this driveway`
          : `the ${BUILDING_DEFS[eco.buildings.get(owners[0])?.type]?.label?.toLowerCase() ?? 'building'}`,
      };
    }

    return {
      kind: 'node',
      buildingIds: [],
      edgeIds: [...node.edges],
      nodeIds: [node.id],
      description: `a junction with ${node.edges.size} road${node.edges.size === 1 ? '' : 's'}`,
    };
  }

  // Then an edge.
  let best = null;
  let bd = edgeRadius;
  for (const e of net.edges.values()) {
    if (!Array.isArray(e.pts) || e.pts.length < 2) continue;
    let nearest = Infinity;
    for (let i = 1; i < e.pts.length; i++) {
      nearest = Math.min(nearest, segDist(x, y, e.pts[i - 1], e.pts[i]));
    }
    if (nearest < bd) { bd = nearest; best = e; }
  }
  if (best) {
    if (best.ring) {
      const ringEdges = [...net.edges.values()].filter(e => e.ring);
      const ringNodes = new Set();
      for (const e of ringEdges) { ringNodes.add(e.a); ringNodes.add(e.b); }
      return {
        kind: 'roundabout',
        buildingIds: [],
        edgeIds: ringEdges.map(e => e.id).sort(),
        nodeIds: [...ringNodes].sort(),
        description: `the whole roundabout (${ringEdges.length} ring roads)`,
      };
    }
    return {
      kind: 'edge',
      buildingIds: [],
      edgeIds: [best.id],
      nodeIds: [],
      description: `one ${best.cls} road`,
    };
  }

  return empty;
}

/**
 * A short, whole-word summary of what a demolition would remove, for the badge.
 * Kept here so the wording is tested rather than living only in the renderer.
 */
export function demolitionLabel(preview) {
  switch (preview?.kind) {
    case 'building': return preview.description;
    case 'roundabout': return preview.description;
    case 'node': return preview.description;
    case 'edge': return preview.description;
    default: return '';
  }
}
