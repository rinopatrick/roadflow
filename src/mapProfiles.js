// Map profiles — S06.4.
//
// generatorVersion 1 (`island`) is frozen for all old saves. Version 2 adds
// four profiles with named parameters living in this data file, not scattered
// through the generator: plains, river, coast, highlands.
//
// Deterministic: same seed+profile always yields the same terrain. Bounded
// internal retries (<=20) with different noise offsets; then an explicit
// generation failure that never clears the existing city.
export const PROFILE_DEFAULTS = {
  generatorVersion: 2,
  maxAttempts: 20,
};

export const PROFILES = ['plains', 'river', 'coast', 'highlands'];

/**
 * Named noise parameters per profile. Scales are world units per noise unit;
 * thresholds apply to elevation/biome decisions.
 */
export function profileParams(profile) {
  switch (profile) {
    case 'plains':
      return { elevScale: 1400, detailScale: 400, mountScale: 1600, waterLevel: 0.22, rockThreshold: 0.78, rockElev: 0.7, channel: null };
    case 'river':
      return { elevScale: 1100, detailScale: 300, mountScale: 1300, waterLevel: 0.28, rockThreshold: 0.70, rockElev: 0.6, channel: { x: 0, halfWidth: 60 } };
    case 'coast':
      return { elevScale: 1000, detailScale: 260, mountScale: 1200, waterLevel: 0.34, rockThreshold: 0.66, rockElev: 0.55, channel: null, coastTilt: 0.10 };
    case 'highlands':
      return { elevScale: 800, detailScale: 220, mountScale: 700, waterLevel: 0.24, rockThreshold: 0.52, rockElev: 0.45, channel: null };
    default:
      throw new RangeError(`unknown map profile: ${profile}`);
  }
}

/** Deterministic terrain hash: coarse elevation samples on a fixed grid. */
export function hashTerrain(terrain, seed) {
  let h = 2166136261;
  const mix = (n) => {
    h ^= (n * 1e6) | 0;
    h = Math.imul(h, 16777619);
  };
  mix(seed);
  for (let y = -1500; y <= 1500; y += 250) {
    for (let x = -1500; x <= 1500; x += 250) {
      mix(Math.round(terrain.elevation(x, y) * 1000));
    }
  }
  return (h >>> 0).toString(16);
}

/** Cache key: seed + profile + generator version. */
export function cacheKey(seed, profile, version) {
  return `terrain:${version}:${profile}:${seed}`;
}

/**
 * Diagnostics on a 100wu grid: buildable fraction, connected buildable
 * regions (flood fill), and crossing sites (water cells adjacent to two
 * buildable banks — bridge candidates).
 */
export function diagnostics(terrain) {
  const step = 100;
  const cells = [];
  let buildable = 0, total = 0;
  for (let y = -1500; y <= 1500; y += step) {
    for (let x = -1500; x <= 1500; x += step) {
      const b = terrain.isBuildable(x, y) ? 1 : 0;
      cells.push({ x, y, b });
      buildable += b;
      total++;
    }
  }
  // Connected regions via flood fill on the coarse grid.
  const idx = new Map(cells.map((c, i) => [`${c.x},${c.y}`, i]));
  const seen = new Set();
  let regions = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i].b || seen.has(i)) continue;
    regions++;
    const stack = [i];
    while (stack.length) {
      const j = stack.pop();
      if (seen.has(j)) continue;
      seen.add(j);
      const { x, y } = cells[j];
      for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const k = idx.get(`${x + dx},${y + dy}`);
        if (k !== undefined && cells[k].b && !seen.has(k)) stack.push(k);
      }
    }
  }
  // Crossing sites: water cells with buildable land on opposite sides.
  let crossingSites = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].b) continue;
    const { x, y } = cells[i];
    const l = idx.get(`${x - step},${y}`);
    const r = idx.get(`${x + step},${y}`);
    const u = idx.get(`${x},${y - step}`);
    const d = idx.get(`${x},${y + step}`);
    if ((l !== undefined && r !== undefined && cells[l].b && cells[r].b)
      || (u !== undefined && d !== undefined && cells[u].b && cells[d].b)) crossingSites++;
  }
  return { buildableFraction: total ? buildable / total : 0, regions, crossingSites, cells: total };
}

/**
 * Find a playable starter: 600x400wu rectangle, >=80% buildable, with a
 * crossing site when the profile has a channel. Deterministic scan order.
 */
export function findStarter(terrain, opts = {}) {
  const needW = opts.w ?? 600;
  const needH = opts.h ?? 400;
  const step = 200;
  let best = null;
  for (let y = -1400; y <= 1400 - needH; y += step) {
    for (let x = -1400; x <= 1400 - needW; x += step) {
      let ok = 0, n = 0;
      let cross = false;
      for (let yy = y; yy < y + needH; yy += 100) {
        for (let xx = x; xx < x + needW; xx += 100) {
          n++;
          if (terrain.isBuildable(xx, yy)) ok++;
        }
      }
      // River bisects the map by design: 60% suffices when a crossing
      // exists inside; other profiles keep the 80% bar.
      const bar = terrain.profile === 'river' ? 0.6 : 0.8;
      if (ok / n < bar) continue;
      // River: require a crossing site inside or adjacent.
      if (terrain.profile === 'river') {
        outer: for (let yy = y - 100; yy < y + needH + 100; yy += 100) {
          for (let xx = x - 100; xx < x + needW + 100; xx += 100) {
            if (!terrain.isBuildable(xx, yy)) {
              const l = terrain.isBuildable(xx - 100, yy);
              const r = terrain.isBuildable(xx + 100, yy);
              if (l && r) { cross = true; break outer; }
            }
          }
        }
        if (!cross) continue;
      }
      const score = Math.hypot(x + needW / 2, y + needH / 2);
      if (!best || score < best.score) best = { x, y, w: needW, h: needH, score, crossing: cross };
    }
  }
  return best;
}

/**
 * Generate with bounded deterministic retries. Different attempt offsets the
 * noise sampling; returns {ok, terrain, attempts} or {ok:false, reason}.
 * Never throws, never touches the live city.
 */
export function generateChecked(seed, profile, attemptSeed = 0, makeTerrain = null) {
  if (typeof makeTerrain !== 'function') {
    return { ok: false, reason: 'generateChecked needs a Terrain factory', attempts: 0 };
  }
  for (let a = 0; a < PROFILE_DEFAULTS.maxAttempts; a++) {
    try {
      const t = makeTerrain(seed + a * 7919 + attemptSeed, { profile });
      const s = findStarter(t);
      if (s) return { ok: true, terrain: t, starter: s, attempts: a + 1 };
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err), attempts: a + 1 };
    }
  }
  return { ok: false, reason: `no playable starter for ${profile} seed ${seed} after ${PROFILE_DEFAULTS.maxAttempts} attempts`, attempts: PROFILE_DEFAULTS.maxAttempts };
}
