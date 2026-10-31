// Environment — S06.3.
//
// Air (factory production-rate emissions, 260wu radius) + noise (traffic
// flow × vehicle class/speed, 64wu grid, 2s sampling, exp(-d/120)) feed home
// satisfaction: 0.45*work + 0.35*shop + 0.20*(1-penalty), EMA tau 30s.
// Parks contribute at most 0.1 within 120wu. No fake sustainability score:
// every number traces to simulated state.
export const ENV_LIMITS = {
  gridCell: 64,
  samplePeriod: 2,
  noiseFalloff: 120,
  pollutionRadius: 260,
  parkRadius: 120,
  parkMaxBonus: 0.1,
  satisfactionTau: 30,
};

export function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/** exp(-d/120) falloff for noise. */
export function noiseFalloff(d) {
  return Math.exp(-d / ENV_LIMITS.noiseFalloff);
}

export class Environment {
  /**
   * @param {function} sources fn returning {factories:[{x,y,rate}], vehicles:[{x,y,speed,kind}], parks:[{x,y}], homes:[{id,x,y,work,shop}]}
   */
  constructor(sources) {
    this.sources = sources;
    this.noiseGrid = new Map(); // "gx,gy" -> 0..1
    this._acc = 0;
    this._satisfaction = new Map(); // homeId -> EMA value
  }

  _cellKey(x, y) {
    return `${Math.floor(x / ENV_LIMITS.gridCell)},${Math.floor(y / ENV_LIMITS.gridCell)}`;
  }

  /** Sample the noise grid. Call with dt; resamples every 2 sim-seconds. */
  update(dt) {
    this._acc += dt;
    if (this._acc < ENV_LIMITS.samplePeriod) return;
    this._acc = 0;
    this.noiseGrid.clear();
    const { vehicles = [] } = this.sources();
    for (const v of vehicles) {
      if (v.speed < 0.5) continue; // parked traffic emits no noise
      const weight = (v.kind === 'truck' ? 2 : 1) * Math.min(1, v.speed / 18);
      const r = ENV_LIMITS.noiseFalloff * 3;
      const gx0 = Math.floor((v.x - r) / ENV_LIMITS.gridCell);
      const gx1 = Math.floor((v.x + r) / ENV_LIMITS.gridCell);
      const gy0 = Math.floor((v.y - r) / ENV_LIMITS.gridCell);
      const gy1 = Math.floor((v.y + r) / ENV_LIMITS.gridCell);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const cx = (gx + 0.5) * ENV_LIMITS.gridCell;
          const cy = (gy + 0.5) * ENV_LIMITS.gridCell;
          const d = Math.hypot(cx - v.x, cy - v.y);
          if (d > r) continue;
          const key = `${gx},${gy}`;
          this.noiseGrid.set(key, clamp01((this.noiseGrid.get(key) ?? 0) + weight * noiseFalloff(d)));
        }
      }
    }
  }

  noiseAt(x, y) {
    return this.noiseGrid.get(this._cellKey(x, y)) ?? 0;
  }

  /** Air pollution at a point from active production rates (0..1-ish). */
  airAt(x, y) {
    const { factories = [] } = this.sources();
    let p = 0;
    for (const f of factories) {
      const rate = f.rate ?? 1; // 0 = stopped, 1 = full production
      if (rate <= 0) continue;
      const d = Math.hypot(x - f.x, y - f.y);
      if (d > ENV_LIMITS.pollutionRadius) continue;
      p += Math.exp(-d / 260) * rate;
    }
    return p;
  }

  parkBonusAt(x, y) {
    const { parks = [] } = this.sources();
    let bonus = 0;
    for (const p of parks) {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d <= ENV_LIMITS.parkRadius) bonus += ENV_LIMITS.parkMaxBonus;
    }
    return Math.min(ENV_LIMITS.parkMaxBonus, bonus);
  }

  /** One satisfaction evaluation (no EMA): {value, work, shop, env, air, noise}. */
  evaluate(home) {
    const air = this.airAt(home.x, home.y);
    const noise = this.noiseAt(home.x, home.y);
    const penalty = clamp01(0.6 * air + 0.4 * noise);
    const park = this.parkBonusAt(home.x, home.y);
    const value = clamp01(0.45 * (home.work ?? 0) + 0.35 * (home.shop ?? 0) + 0.20 * (1 - penalty) + park);
    return { value, work: home.work ?? 0, shop: home.shop ?? 0, env: 1 - penalty, air, noise, park };
  }

  /** EMA-smoothed satisfaction with tau 30s. Returns same shape as evaluate. */
  satisfaction(home, dt) {
    const now = this.evaluate(home);
    const prev = this._satisfaction.get(home.id) ?? now.value;
    const alpha = 1 - Math.exp(-dt / ENV_LIMITS.satisfactionTau);
    const value = prev + (now.value - prev) * alpha;
    this._satisfaction.set(home.id, value);
    return { ...now, value };
  }
}
