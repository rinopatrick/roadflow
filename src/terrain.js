// Terrain generation — seeded procedural map with water, beach, grass, rock.
// Pure logic here; rendering lives in render.js.
import { makeRng, makeNoise2D, fbm, clamp } from './core.js';

export const BIOME = { GRASS: 0, SAND: 1, WATER: 2, ROCK: 3 };

export class Terrain {
  constructor(seed) {
    this.seed = seed;
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
    // radial island falloff so edges are water
    const r = Math.hypot(x / (s * 0.5), y / (s * 0.5));
    const fall = clamp(1.15 - r * 1.15, 0, 1);
    const e = fbm(this.nElev, x / 900 + 31.7, y / 900 + 11.3, 4) * 0.78
            + fbm(this.nDetail, x / 260 + 7.1, y / 260 + 3.3, 3) * 0.22;
    return clamp(e * fall * 1.55 - 0.12, 0, 1);
  }

  // Biome id at world coords
  sample(x, y) {
    const e = this.elevation(x, y);
    if (e < 0.30) return BIOME.WATER;
    if (e < 0.345) return BIOME.SAND;
    const m = fbm(this.nMount, x / 1100 + 91.2, y / 1100 + 45.8, 3);
    if (m > 0.62 && e > 0.55) return BIOME.ROCK;
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
