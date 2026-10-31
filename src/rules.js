// Difficulty rules and milestone progression — S06.5.
//
// Difficulties change demand pacing, deadlines, environmental weight and
// starting stock. They never alter vehicle physics or hide facts.
// XP milestones are data (cumulative thresholds); the first meaningful
// level-up targets 3-5 min for a competent normal tutorial city.
export const DIFFICULTIES = {
  easy: {
    name: 'easy', demandRate: 0.7, serviceDeadline: 450, envWeight: 0.7,
    startBatch: { house: 6, shop: 3, factory: 2, depot: 1, park: 1 },
  },
  normal: {
    name: 'normal', demandRate: 1.0, serviceDeadline: 300, envWeight: 1.0,
    startBatch: { house: 4, shop: 2, factory: 1, depot: 1, park: 0 },
  },
  hard: {
    name: 'hard', demandRate: 1.3, serviceDeadline: 240, envWeight: 1.2,
    startBatch: { house: 4, shop: 2, factory: 1, depot: 1, park: 0 },
  },
};

/** Cumulative XP thresholds per level-up (level N reached at MILESTONES[N-2]). */
export const MILESTONES = [100, 250, 500, 900, 1400, 2100, 3000, 4200, 5700, 7500];

export function rulesFor(name) {
  return DIFFICULTIES[name] ?? DIFFICULTIES.normal;
}

/** Level for a cumulative XP total. Level 1 below the first milestone. */
export function levelForXp(xp) {
  let level = 1;
  for (const m of MILESTONES) {
    if (xp >= m) level++;
    else break;
  }
  return level;
}

/**
 * One milestone grant per crossing. `seen` persists across save/load.
 * Returns the crossed threshold or null.
 */
export function milestoneFor(fromLevel, xp, seen) {
  const target = levelForXp(xp);
  if (target <= fromLevel) return null;
  // The threshold that took us past fromLevel.
  const threshold = MILESTONES[fromLevel - 1];
  if (threshold === undefined || seen.has(threshold)) return null;
  seen.add(threshold);
  return threshold;
}

/**
 * Migrate old-formula XP (300*lvl^2 cumulative) to milestones by fraction
 * into the old level. Never regresses the level, never duplicates awards.
 */
export function migrateXp(xp, level) {
  const OLD = (lvl) => 300 * lvl * lvl;
  const lo = OLD(level - 1);
  const hi = OLD(level);
  const frac = hi > lo ? Math.max(0, Math.min(1, (xp - lo) / (hi - lo))) : 0;
  // Map fraction into the equivalent milestone band.
  const base = MILESTONES[level - 2] ?? 0;
  const next = MILESTONES[level - 1] ?? base + 400;
  return { xp: Math.round(base + frac * (next - base)), level, migrated: true };
}

/** Exact counters granted at a level-up (must match what inventory awards). */
export function previewRewards(level) {
  return {
    house: Math.min(2 + Math.floor(level / 2), 8),
    shop: 1 + (level % 3 === 0 ? 1 : 0),
    factory: level % 4 === 0 ? 1 : 0,
    depot: 0,
    park: level % 2 === 0 ? 1 : 0,
  };
}

/** Grant object actually applied (single source of truth with preview). */
export function grantFor(level) {
  return previewRewards(level);
}
