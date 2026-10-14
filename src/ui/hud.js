// The top status band.
//
// Simulation state is authoritative: this module only formats it into the band.
// It owns its own refresh throttle, which used to be a `lastHud` variable in
// main.js that the game loop had to remember to respect.
import { clamp } from '../core.js';
import { LEVEL_XP } from '../economy.js';
import { cityCongestion, formatCongestion } from '../metrics.js';

/** Milliseconds between automatic refreshes. Forced updates ignore it. */
export const HUD_REFRESH_MS = 250;

/**
 * @param {() => {eco: object, traffic: object, net: object}} getState
 */
export function createHud(getState) {
  let last = 0;

  return {
    update(force = false) {
      const now = performance.now();
      if (!force && now - last < HUD_REFRESH_MS) return;
      last = now;

      const { eco, traffic, net } = getState();
      document.getElementById('hLevel').textContent = eco.level;

      // Progress through the current level, from the same XP curve the economy uses.
      const prev = eco.level > 1 ? LEVEL_XP(eco.level - 1) : 0;
      const next = LEVEL_XP(eco.level);
      document.getElementById('xpfill').style.width =
        clamp((eco.xp - prev) / (next - prev) * 100, 0, 100) + '%';

      document.getElementById('hPop').textContent = eco.population();
      document.getElementById('hTrips').textContent = eco.totalTrips;

      const avg = traffic.stats.trips ? (traffic.stats.totalTripTime / traffic.stats.trips) : 0;
      document.getElementById('hAvg').textContent = traffic.stats.trips ? avg.toFixed(0) + 's' : '—';

      // Congestion is the share of present vehicles that are stopped, so it is
      // displayed directly. The v1 HUD divided by 0.6 to compensate for a broken
      // EMA (EVIDENCE E03); that fudge is gone and must not come back.
      document.getElementById('hCong').textContent = formatCongestion(cityCongestion(net));
    },
  };
}
