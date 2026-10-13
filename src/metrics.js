// Traffic metrics: congestion aggregation and simulation counters.
//
// Why this module exists
// ----------------------
// The congestion figure was misleading (EVIDENCE E03). The per-edge EMA settled
// at 0.05 with every vehicle stopped, and the HUD then multiplied by 100 and
// divided by 0.6, so a fully jammed road displayed as roughly 8%. The figure was
// also a plain mean over ALL edges, so a jammed road was diluted by every empty
// one.
//
// The per-edge smoothing itself lives in `TrafficSim.update`, where the vehicle
// counts are available. This module owns the aggregation and the display rules,
// and is pure so it can be tested without a browser.
//
// The city figure is weighted by the vehicles actually present on each edge,
// because "share of vehicles that are stopped" is the question a player is
// asking. A network with nothing driving reports 0.
//
// S04.5 will extend this with queue counts, travel-time percentiles and
// per-reason wait attribution.

import { clamp } from './core.js';

/** Clamps a congestion value into 0..1, treating non-numeric input as 0. */
export function clamp01(value) {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

/**
 * Congestion for a whole network, in 0..1.
 *
 * Weighted by the number of vehicles on each edge (`edge._carCount`, published
 * by `TrafficSim.update`). Returns 0 when nothing is driving, which is the
 * honest answer rather than an undefined ratio.
 *
 * @param {import('./roadNetwork.js').RoadNetwork} net
 * @returns {number} share of present vehicles that are stopped, 0..1
 */
export function cityCongestion(net) {
  let weighted = 0;
  let vehicles = 0;

  for (const edge of net.edges.values()) {
    const weight = Number.isFinite(edge._carCount) ? edge._carCount : 0;
    if (weight <= 0) continue;
    weighted += clamp01(edge._congestion) * weight;
    vehicles += weight;
  }

  return vehicles > 0 ? clamp01(weighted / vehicles) : 0;
}

/**
 * Formats a congestion share for display.
 *
 * The value is already a share in 0..1, so it is shown directly. The previous
 * HUD divided by 0.6 to compensate for the broken EMA; that fudge is gone.
 */
export function formatCongestion(share) {
  return `${Math.round(clamp01(share) * 100)}%`;
}

/**
 * Simulation counters, each mapping to a real existing counter.
 *
 * Deliberately contains no invented demand accounting: `pending` is the queued
 * return-trip count and `cancelled` is the cancelled return count, both of which
 * exist today. S06.1 replaces these with full journey accounting.
 *
 * @param {import('./traffic.js').TrafficSim|null} traffic
 * @param {object|null} eco economy instance (may be absent in tests)
 */
export function simulationStats(traffic, eco) {
  return {
    active: traffic?.cars?.size ?? 0,
    completed: traffic?.stats?.trips ?? 0,
    pending: eco?.pendingReturnCount ?? 0,
    cancelled: eco?.cancelledReturns ?? 0,
  };
}
