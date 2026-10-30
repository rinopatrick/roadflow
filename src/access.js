// Building access and safe live edits.
//
// Why this module exists
// ----------------------
// Two problems are solved here (EVIDENCE E15, E16):
//
//  1. PLACEMENT VALIDATION was scattered inside `Economy.place`, so the UI could
//     not ask "would this work here?" without mutating the world, and could not
//     tell the player WHY a placement failed. `evaluateBuildingPlacement` is pure
//     and returns a machine-readable reason.
//
//  2. LIVE EDITS silently destroyed trips. Removing a road deleted every vehicle
//     whose route referenced it, with no accounting and no attempt to reroute.
//     `reconcileTrafficAfterEdit` reroutes where a legal path still exists and
//     otherwise cancels the trip exactly once, with a reason.
//
// Both functions are pure with respect to world state they are not asked to
// change: evaluation never mutates, and reconciliation only touches the traffic
// simulation it is handed.

import { dist } from './core.js';
import { BUILDING_DEFS } from './economy.js';
import { findPath, pathToSteps } from './pathfinding.js';

/**
 * Maximum distance from a road at which a NEW building may attach, in wu.
 *
 * This is a design limit for new placements, not a validation of existing ones:
 * buildings already placed are never auto-deleted or invalidated by it, because
 * a save must keep working even if this number changes later.
 */
export const ACCESS_MAX_DISTANCE = 120;

/** Reasons a placement can be refused. Stable strings, safe to test against. */
export const PLACEMENT_REASON = {
  UNKNOWN_TYPE: 'unknown building type',
  NOT_FINITE: 'position must be finite numbers',
  NO_STOCK: 'no buildings of this type left — level up to earn more',
  TERRAIN: 'cannot build on water or rock',
  OVERLAP: 'too close to an existing building',
  NO_ROAD: `no road within ${ACCESS_MAX_DISTANCE} wu`,
  // S05.2: buildings attach at grade. A bridge deck or ramp is not a street
  // frontage — the message says why, not just "invalid terrain".
  ELEVATED: 'buildings need a ground road — bridges and ramps have no driveways',
};

/**
 * Would placing `type` at `(x, y)` succeed? Pure — never mutates.
 *
 * @param {{net:object, terrain:object, eco:object}} world
 * @param {{type:string, x:number, y:number}} request
 * @returns {{ok:boolean, reason:string|null, drivewayTarget:{x:number,y:number}|null}}
 */
export function evaluateBuildingPlacement(world, { type, x, y } = {}) {
  const deny = (reason) => ({ ok: false, reason, drivewayTarget: null });

  const def = BUILDING_DEFS[type];
  if (!def) return deny(PLACEMENT_REASON.UNKNOWN_TYPE);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return deny(PLACEMENT_REASON.NOT_FINITE);

  const { net, terrain, eco } = world;
  if (!net || !eco) return deny('world is missing a network or economy');

  if ((eco.batch?.[type] ?? 0) <= 0) return deny(PLACEMENT_REASON.NO_STOCK);

  if (terrain && !terrain.isBuildable(x, y)) return deny(PLACEMENT_REASON.TERRAIN);

  for (const b of eco.buildings.values()) {
    const other = BUILDING_DEFS[b.type];
    if (!other) continue;
    if (dist(x, y, b.x, b.y) < other.size + def.size) return deny(PLACEMENT_REASON.OVERLAP);
  }

  // S05.2: at grade only. If the only nearby road is elevated, the player is
  // told the real reason instead of getting a generic "no road".
  const target = net.nearestRoadPoint(x, y, ACCESS_MAX_DISTANCE, { groundOnly: true });
  if (!target) {
    const anyRoad = net.nearestRoadPoint(x, y, ACCESS_MAX_DISTANCE);
    if (anyRoad) return deny(PLACEMENT_REASON.ELEVATED);
    return deny(PLACEMENT_REASON.NO_ROAD);
  }

  return { ok: true, reason: null, drivewayTarget: { x: target.x, y: target.y } };
}

/**
 * Repairs the world after a topology or building edit so no trip is silently
 * lost.
 *
 * For every vehicle:
 *  - if its current edge still exists, leave it alone
 *  - if its current edge is gone, try to reroute from the node it is standing on
 *    to its original destination
 *  - if no legal route remains, cancel the trip exactly once with a reason
 *
 * Never awards XP or counts a completed trip: an edit must not be able to farm
 * progress by deleting the road under a car.
 *
 * @param {import('./traffic.js').TrafficSim} traffic
 * @param {{removedEdgeIds?:string[], removedBuildingIds?:string[]}} change
 * @returns {{kept:number, rerouted:number, cancelled:{carId:string,reason:string}[]}}
 */
export function reconcileTrafficAfterEdit(traffic, change = {}) {
  const report = { kept: 0, rerouted: 0, cancelled: [] };
  if (!traffic || !traffic.net) return report;

  const net = traffic.net;
  const removedEdges = new Set(change.removedEdgeIds ?? []);
  const removedBuildings = new Set(change.removedBuildingIds ?? []);

  // A trip whose endpoint building was demolished cannot be completed.
  for (const car of [...traffic.cars.values()]) {
    if (removedBuildings.size
      && (removedBuildings.has(car.destId) || removedBuildings.has(car.homeId))) {
      traffic.cancelCar(car, 'endpointRemoved');
      report.cancelled.push({ carId: car.id, reason: 'endpointRemoved' });
    }
  }

  for (const car of [...traffic.cars.values()]) {
    const step = car.currentStep();
    if (!step) {
      traffic.cancelCar(car, 'noRoute');
      report.cancelled.push({ carId: car.id, reason: 'noRoute' });
      continue;
    }

    const edgeGone = removedEdges.has(step.edgeId) || !net.edges.has(step.edgeId);
    if (!edgeGone) { report.kept++; continue; }

    // Try to resume from the node the car is standing on.
    const origin = net.nodes.has(step.from) ? step.from : null;
    const lastStep = car.route.steps[car.route.steps.length - 1];
    const destination = lastStep && net.nodes.has(lastStep.to) ? lastStep.to : null;

    let rerouted = false;
    if (origin && destination && origin !== destination) {
      const path = findPath(net, origin, destination);
      const steps = path && path.nodes.length >= 2 ? pathToSteps(net, path.nodes) : null;
      if (steps && steps.length) {
        car.route = { nodes: path.nodes, steps };
        car.step = 0;
        car.s = 0;
        car.speed = 0;
        for (const st of steps) {
          const e = net.edges.get(st.edgeId);
          st.lane = Math.min(st.lane ?? 0,
            e ? Math.max(0, (e.oneway ? 1 : 2) - 1) : 0);
        }
        car._updatePos();
        report.rerouted++;
        rerouted = true;
      }
    }

    if (!rerouted) {
      traffic.cancelCar(car, 'routeRemoved');
      report.cancelled.push({ carId: car.id, reason: 'routeRemoved' });
    }
  }

  return report;
}
