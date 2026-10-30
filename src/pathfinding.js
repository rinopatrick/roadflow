// A* pathfinding over the road network node graph.
// Edge cost = length / speed (travel time), plus congestion penalty.
import { lanesAvailable, profileFor } from './roadProfiles.js';
import { buildJunctionConnectors } from './junctions.js';

export function findPath(net, fromId, toId) {
  if (fromId === toId) return { nodes: [fromId], time: 0 };
  const open = new Map();     // id -> {f}
  const gScore = new Map();   // id -> g
  const cameFrom = new Map();
  const closed = new Set();

  const goal = net.nodes.get(toId);
  if (!goal || !net.nodes.get(fromId)) return null;

  const h = (id) => {
    const n = net.nodes.get(id);
    return Math.hypot(goal.x - n.x, goal.y - n.y) / 30; // optimistic (highway speed)
  };

  gScore.set(fromId, 0);
  open.set(fromId, { f: h(fromId) });

  // simple binary-heap-lite: use array + sort (network sizes are modest)
  const openList = [fromId];

  while (openList.length) {
    // pick lowest f
    let bi = 0;
    for (let i = 1; i < openList.length; i++) {
      if (open.get(openList[i]).f < open.get(openList[bi]).f) bi = i;
    }
    const current = openList.splice(bi, 1)[0];
    if (current === toId) {
      // reconstruct
      const path = [toId];
      let c = toId;
      while (cameFrom.has(c)) { c = cameFrom.get(c); path.push(c); }
      path.reverse();
      return { nodes: path, time: gScore.get(toId) };
    }
    closed.add(current);

    const node = net.nodes.get(current);
    for (const eid of node.edges) {
      const edge = net.edges.get(eid);
      if (!edge) continue;
      if (edge.oneway && edge.a !== current) continue; // one-way (roundabout ring)
      const next = edge.a === current ? edge.b : edge.a;
      if (closed.has(next)) continue;
      const prof = profileFor(edge);
      // A direction with zero lanes cannot be routed (S04.1).
      if (lanesAvailable(prof, edge.a === current ? 1 : -1) <= 0) continue;
      const speed = prof.speed;
      const congestion = edge._congestion || 0; // 0..1
      const cost = edge.total / speed * (1 + congestion * 1.5);
      const tentative = gScore.get(current) + cost;
      if (tentative < (gScore.get(next) ?? Infinity)) {
        gScore.set(next, tentative);
        cameFrom.set(next, current);
        if (!open.has(next)) openList.push(next);
        open.set(next, { f: tentative + h(next) });
      }
    }
  }
  return null;
}

// Convert node path to list of steps: [{nodeId, edgeId, dir}] to drive.
export function pathToSteps(net, nodePath) {
  const steps = [];
  for (let i = 0; i < nodePath.length - 1; i++) {
    const edge = net.edgeBetween(nodePath[i], nodePath[i + 1]);
    if (!edge) return null; // graph changed mid-trip
    steps.push({
      edgeId: edge.id,
      from: nodePath[i],
      to: nodePath[i + 1],
      dir: edge.a === nodePath[i] ? 1 : -1,
    });
  }
  return steps;
}

/**
 * Lane-aware route: search the lane/connector graph (CONTRACTS section 5,
 * S04.2). Vertices are directed lane traversals `edgeId:dir:lane`;
 * connectors join an incoming vertex to an outgoing vertex at a node.
 *
 * Returns `{steps:[{edgeId,from,to,dir,lane,connectorId|null}], time,
 * version}` or null. `connectorId` belongs to the movement AFTER that edge;
 * the last step has null. Same-lane traversal only (no S04.3 lane changes
 * yet): a route needing a mid-edge lane change is rejected rather than
 * teleporting lanes at a node. User `restrictions` (Set, or '*' for all)
 * omit blocked connectors.
 */
export function findVehicleRoute(net, fromId, toId, options = {}) {
  if (fromId === toId) return null; // no vehicle for a zero-distance need
  if (!net.nodes.get(fromId) || !net.nodes.get(toId)) return null;
  const restrictions = options.restrictions ?? null;
  const startVerts = outgoingLaneVerts(net, fromId);
  if (!startVerts.length) return null;
  const goal = net.nodes.get(toId);
  const hVert = (v) => {
    const edge = net.edges.get(v.edgeId);
    const end = v.dir === 1 ? edge.b : edge.a;
    const n = net.nodes.get(end);
    return Math.hypot(goal.x - n.x, goal.y - n.y) / 40; // optimistic max speed
  };
  // A*: state = lane vertex. g = travel time so far. predecessor = edge/lane/
  // connector tuple, never just the node id (ALGORITHMS C).
  const g = new Map();
  const prev = new Map(); // vkey -> {fromVkey, connectorId}
  const open = [];
  const openSet = new Map();
  const closed = new Set();
  const vertOf = new Map(); // vkey -> vertex
  for (const v of startVerts) {
    const k = vkey(v);
    vertOf.set(k, v);
    g.set(k, edgeTime(net, v));
    open.push(k);
    openSet.set(k, hVert(v) + g.get(k));
  }
  const rkey = restrictions === '*' ? '*' : restrictions instanceof Set ? [...restrictions].sort().join(',') : '';
  const connCache = new Map();
  const connectorsAt = (nodeId) => {
    const ck = `${nodeId}|${rkey}`;
    if (!connCache.has(ck)) {
      connCache.set(ck, buildJunctionConnectors(net, nodeId, { restrictions }));
    }
    return connCache.get(ck);
  };
  const byFrom = (nodeId) => {
    const m = new Map();
    for (const c of connectorsAt(nodeId)) {
      const fk = vkey(c.from);
      if (!m.has(fk)) m.set(fk, []);
      m.get(fk).push(c);
    }
    return m;
  };
  const byFromCache = new Map();
  const at = (nodeId) => {
    if (!byFromCache.has(nodeId)) byFromCache.set(nodeId, byFrom(nodeId));
    return byFromCache.get(nodeId);
  };
  let goalKey = null;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      if (openSet.get(open[i]) < openSet.get(open[bi])) bi = i;
    }
    const cur = open.splice(bi, 1)[0];
    if (closed.has(cur)) continue;
    closed.add(cur);
    const v = vertOf.get(cur);
    const endNode = v.dir === 1 ? net.edges.get(v.edgeId).b : net.edges.get(v.edgeId).a;
    if (endNode === toId) { goalKey = cur; break; }
    for (const c of at(endNode).get(cur) ?? []) {
      const nk = vkey(c.to);
      if (closed.has(nk)) continue;
      if (!vertOf.has(nk)) vertOf.set(nk, { ...c.to });
      const turnPenalty = c.turn === 'through' ? 0 : c.turn === 'right' ? 2 : 5;
      const edge = net.edges.get(c.to.edgeId);
      const tentative = g.get(cur) + connectorTime(c) + turnPenalty + edgeTime(net, c.to, edge);
      if (tentative < (g.get(nk) ?? Infinity)) {
        g.set(nk, tentative);
        prev.set(nk, { fromVkey: cur, connectorId: c.id });
        if (!open.includes(nk)) open.push(nk);
        openSet.set(nk, tentative + hVert(vertOf.get(nk)));
      }
    }
  }
  if (!goalKey) return null;
  // Reconstruct exact edge/lane/connector tuples.
  const chain = [goalKey];
  let k = goalKey;
  while (prev.has(k)) { k = prev.get(k).fromVkey; chain.push(k); }
  chain.reverse();
  const steps = chain.map((vk, i) => {
    const v = vertOf.get(vk);
    const edge = net.edges.get(v.edgeId);
    const nextV = i < chain.length - 1 ? vertOf.get(chain[i + 1]) : null;
    return {
      edgeId: v.edgeId,
      from: v.dir === 1 ? edge.a : edge.b,
      to: v.dir === 1 ? edge.b : edge.a,
      dir: v.dir,
      lane: v.lane,
      connectorId: i < chain.length - 1 ? prev.get(chain[i + 1]).connectorId : null,
      // S04.3: the lane the NEXT edge's connector starts from — the exit
      // lane this edge must hold at the junction. Undefined on last step.
      connectorLane: nextV?.lane,
    };
  });
  return { steps, time: g.get(goalKey), version: net.version };
}

function vkey(v) {
  return `${v.edgeId}:${v.dir}:${v.lane}`;
}

function edgeTime(net, v, edge = null) {
  const e = edge ?? net.edges.get(v.edgeId);
  const speed = profileFor(e).speed;
  const congestion = e._congestion || 0;
  return e.total / speed * (1 + congestion * 1.5);
}

function connectorTime(c) {
  return (c.length || 1) / 8; // slow junction traversal
}

function outgoingLaneVerts(net, nodeId) {
  const out = [];
  const node = net.nodes.get(nodeId);
  if (!node) return out;
  for (const eid of node.edges) {
    const edge = net.edges.get(eid);
    if (!edge || edge.ring) continue;
    const prof = profileFor(edge);
    if (edge.a === nodeId && lanesAvailable(prof, 1) > 0) {
      for (let l = 0; l < lanesAvailable(prof, 1); l++) out.push({ edgeId: eid, dir: 1, lane: l });
    }
    if (edge.b === nodeId && lanesAvailable(prof, -1) > 0) {
      for (let l = 0; l < lanesAvailable(prof, -1); l++) out.push({ edgeId: eid, dir: -1, lane: l });
    }
  }
  return out;
}

