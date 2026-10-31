// Walking paths, crossings and multimodal access — S07.6.
//
// Sidewalks derived from road profiles: local/arterial only. No motorway
// sidewalks, no ring sidewalks, tunnels prohibit pedestrians with a visible
// rule, bridges only when explicitly enabled. Crosswalk links exist only at
// marked compatible junctions and join the same reservation/signal safety.
// Speed 1.4wu/s. Walk-only radius 800wu; transit access 400wu.
export const WALK = { speed: 1.4 };

export const WALK_LIMITS = {
  walkOnly: 800,
  transitAccess: 400,
};

/** Sidewalk exists on this edge? Pure from profile + grade flags. */
export function sidewalkFor(edge) {
  const access = edge?.access ?? edge?.profile?.access ?? 'local';
  if (access === 'motorway') return false;
  if (edge?.ring) return false;
  const kind = edge?.grade?.kind ?? 'ground';
  if (kind === 'tunnel') return false; // visible rule: no tunnel pedestrians
  if (kind === 'bridge') return edge?.bridgeWalk === true;
  return access === 'local' || access === 'arterial';
}

/** Crosswalk allowed only when marked AND the pedestrian signal walks. */
export function crosswalkAllowed(junction) {
  if (!junction?.marked) return { ok: false, reason: 'no marked crosswalk' };
  if (junction.signal !== 'walk') return { ok: false, reason: 'pedestrian signal is red' };
  return { ok: true };
}

/**
 * Multimodal plan. All legs must be valid; reasons exposed when not.
 * {dist, transitDist, crossing, barrier} -> {mode, reason}
 */
export function planWalk({ dist, transitDist, crossing, barrier }) {
  if (barrier) return { mode: 'car', reason: `barrier: ${barrier}` };
  if (!crossing) return { mode: 'car', reason: 'no-crossing: opposite side unreachable' };
  if (dist <= WALK_LIMITS.walkOnly) return { mode: 'walk', reason: null };
  if (transitDist <= WALK_LIMITS.transitAccess) return { mode: 'walk-transit-walk', reason: null };
  return { mode: 'car', reason: 'too-far: beyond walk and transit access' };
}
