// Terrain generation — seeded procedural map with water, beach, grass, rock.
// Pure logic here; rendering lives in render.js.
import { makeRng, makeNoise2D, fbm, clamp } from './core.js';
import { profileParams } from './mapProfiles.js';

export const BIOME = { GRASS: 0, SAND: 1, WATER: 2, ROCK: 3 };

export class Terrain {
  /**
   * @param {number} seed
   * @param {{profile?:string}} [opts] 'island' (default, generatorVersion 1,
   *   frozen for all old saves) or a v2 profile: plains/river/coast/highlands.
   */
  constructor(seed, opts = {}) {
    this.seed = seed;
    this.profile = opts.profile ?? 'island';
    this.generatorVersion = this.profile === 'island' ? 1 : 2;
    this.params = this.profile === 'island' ? null : profileParams(this.profile);
    const rng = makeRng(seed);
    this.nElev = makeNoise2D(rng);
    this.nMount = makeNoise2D(rng);
    this.nPatch = makeNoise2D(rng);
    this.nDetail = makeNoise2D(rng);
    // island falloff: world coords are in [-W/2, W/2]
    this.size = 6000;
  }

  // Raw elevation in [0,1] at world coords
  elevation(x, y) {
    const s = this.size;
    // radial island falloff so edges are water (v1 island behaviour;
    // v2 profiles keep the same edge falloff, only interior differs).
    const r = Math.hypot(x / (s * 0.5), y / (s * 0.5));
    const fall = clamp(1.15 - r * 1.15, 0, 1);
    const p = this.params;
    const elevScale = p?.elevScale ?? 900;
    const detailScale = p?.detailScale ?? 260;
    let e = fbm(this.nElev, x / elevScale + 31.7, y / elevScale + 11.3, 4) * 0.78
            + fbm(this.nDetail, x / detailScale + 7.1, y / detailScale + 3.3, 3) * 0.22;
    e = clamp(e * fall * 1.55 - 0.12, 0, 1);
    // River: carve a central north-south channel (deterministic in x).
    if (p?.channel) {
      const d = Math.abs(x - p.channel.x);
      if (d < p.channel.halfWidth) e = Math.min(e, 0.18);
    }
    // Coast: tilt the map so the east side floods (inlets/bottlenecks).
    if (p?.coastTilt) e = clamp(e - (x / s) * p.coastTilt * 4 - 0.02, 0, 1);
    return e;
  }

  // Biome id at world coords
  sample(x, y) {
    const e = this.elevation(x, y);
    const p = this.params;
    const waterLevel = p?.waterLevel ?? 0.30;
    if (e < waterLevel) return BIOME.WATER;
    if (e < waterLevel + 0.045) return BIOME.SAND;
    const mountScale = p?.mountScale ?? 1100;
    const m = fbm(this.nMount, x / mountScale + 91.2, y / mountScale + 45.8, 3);
    const rockThreshold = p?.rockThreshold ?? 0.62;
    const rockElev = p?.rockElev ?? 0.55;
    if (m > rockThreshold && e > rockElev) return BIOME.ROCK;
    // decorative patches (dark blobby woods/rocks) don't block, purely visual handled in render
    return BIOME.GRASS;
  }

  isBuildable(x, y) {
    const b = this.sample(x, y);
    return b === BIOME.GRASS || b === BIOME.SAND;
  }

  isRoadable(x, y) { return this.isBuildable(x, y); }

  // Serialize nothing — terrain is fully derived from seed.
}
