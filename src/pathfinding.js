// A* pathfinding over the road network node graph.
// Edge cost = length / speed (travel time), plus congestion penalty.
import { ROAD_CLASS } from './roadNetwork.js';

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
      const speed = ROAD_CLASS[edge.cls].speed;
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
