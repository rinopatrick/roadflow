// Economy — buildings, trips, city XP/levels, pollution.
// Design mirrors the genre brief: houses need shops & workplaces; factories
// need workers; shops need customers; completed trips grant XP; level-ups
// grant a batch of buildings to place.
import { dist, uid, clamp, makeRng } from './core.js';
import { findPath } from './pathfinding.js';

export const BUILDING_DEFS = {
  house:   { residents: 4, jobs: 0, size: 22, label: 'House',   icon: '🏠' },
  shop:    { residents: 0, jobs: 2, size: 26, label: 'Shop',    icon: '🏪' },
  factory: { residents: 0, jobs: 6, size: 34, label: 'Factory', icon: '🏭' },
};

export const LEVEL_XP = (lvl) => 300 * lvl * lvl; // cumulative XP for level `lvl`

export class Economy {
  constructor(net, terrain, seed = 12345) {
    this.net = net;
    this.terrain = terrain;
    this.rng = makeRng(seed);
    // Separate stream for cosmetic values (building orientation, future
    // variants/shading). Drawing appearance from the simulation stream would
    // shift every later tripTimer draw, silently retuning demand pacing.
    // CONTRACTS.md section 2 requires split simulation/cosmetic streams.
    this.cosmeticRng = makeRng((seed ^ 0x9e3779b9) >>> 0);
    this.buildings = new Map();
    this.xp = 0;
    this.level = 1;
    this.batch = { house: 4, shop: 2, factory: 1 }; // buildings available to place
    this.onLevelUp = null;
    this.onToast = null;
    this._tripTimer = 0;
    this.totalTrips = 0;
  }

  canPlace(type) { return (this.batch[type] || 0) > 0; }

  /**
   * Building ID from the world ID source.
   *
   * Read live from `net.ids` rather than cached in the constructor: a world's
   * ID source is often attached to the network AFTER the economy is built
   * (notably in the save/load path), so caching here would silently fall back
   * to random IDs. Falls back to the legacy uid() only when a caller builds a
   * bare RoadNetwork with no ID source, which existing tests rely on.
   */
  _newBuildingId() {
    return this.net?.ids ? this.net.ids.next('b') : uid();
  }

  // Place a building; attaches driveway to nearest road. Returns building or null.
  place(type, x, y) {
    if (!this.canPlace(type)) return null;
    if (this.terrain && !this.terrain.isBuildable(x, y)) return null;
    // overlap check
    for (const b of this.buildings.values()) {
      if (dist(x, y, b.x, b.y) < BUILDING_DEFS[b.type].size + BUILDING_DEFS[type].size) return null;
    }
    const driveway = this.net.attachDriveway(null, x, y);
    if (!driveway) return null;
    const b = {
      id: this._newBuildingId(), type, x, y,
      drivewayNode: driveway.id,
      residents: BUILDING_DEFS[type].residents,
      jobs: BUILDING_DEFS[type].jobs,
      tripTimer: 8 + this.rng() * 30,
      // Cosmetic orientation from the separate cosmetic stream, so the
      // simulation draw sequence is completely unaffected. Drawn from a seeded
      // generator instead of Math.random so rendered output is reproducible
      // for a given seed, which golden-image checks depend on.
      rot: (this.cosmeticRng() - 0.5) * 0.5,
      reach: null,      // cached reachability {version, shopId, workId}
      happy: 1,
    };
    driveway.drivewayFor = b.id;
    this.buildings.set(b.id, b);
    this.batch[type]--;
    this.net.version++;
    return b;
  }

  remove(id) {
    const b = this.buildings.get(id);
    if (!b) return;
    this.net.detachDriveway(b.drivewayNode);
    this.buildings.delete(id);
    this.net.version++;
  }

  // Find a reachable destination building of a type from building b (cached).
  findDestination(b, type) {
    const v = this.net.version;
    if (b.reach && b.reach.v === v && b.reach[type] !== undefined) return b.reach[type];
    if (!b.reach || b.reach.v !== v) b.reach = { v };
    let found = null;
    for (const o of this.buildings.values()) {
      if (o.type !== type || o.id === b.id) continue;
      if (findPath(this.net, b.drivewayNode, o.drivewayNode)) { found = o.id; break; }
    }
    b.reach[type] = found;
    return found;
  }

  // Called by main loop. spawnCar: fn(fromNodeId, toNodeId) -> Car
  update(dt, traffic, spawnCar) {
    // tick houses' trip timers (cheap)
    for (const b of this.buildings.values()) {
      if (b.type !== 'house') continue;
      b.tripTimer -= dt;
      if (b.tripTimer <= 0) {
        b.tripTimer = 25 + this.rng() * 45;
        // choose destination: shop or factory
        const wantShop = this.rng() < 0.45;
        const destType = wantShop ? 'shop' : 'factory';
        const destId = this.findDestination(b, destType);
        if (!destId) {
          this._failTimer = (this._failTimer || 0) + dt;
          if (this._failTimer > 5) {
            this._failTimer = 0;
            this.onToast?.('Some homes can\'t reach a ' + (wantShop ? 'shop' : 'workplace') + '!', 'warn');
          }
          continue;
        }
        const destB = this.buildings.get(destId);
        const car = spawnCar(b.drivewayNode, destB.drivewayNode);
        if (car) {
          car.onArrive = (c) => {
            this._completeTrip(c, destId, b.id);
          };
          car.homeId = b.id;
          car.destId = destId;
        }
      }
    }
  }

  _completeTrip(car, destId, homeId) {
    const dest = this.buildings.get(destId);
    const home = this.buildings.get(homeId);
    if (!dest || !home) return;
    const pollutionPenalty = 1 - clamp(this.pollutionAt(home.x, home.y) * 0.15, 0, 0.6);
    const gain = 10 * pollutionPenalty;
    this.xp += gain;
    this.totalTrips++;
    // schedule return trip: car drives back home after a stay
    setTimeout(() => {}, 0); // (return trips handled via _pendingReturns in game loop)
    this._pendingReturns = this._pendingReturns || [];
    this._pendingReturns.push({ at: 8 + this.rng() * 15, from: destId, to: homeId });
  }

  // Process pending return trips. spawnCar: fn(from,to)
  processReturns(dt, spawnCar) {
    if (!this._pendingReturns) return;
    for (let i = this._pendingReturns.length - 1; i >= 0; i--) {
      const r = this._pendingReturns[i];
      r.at -= dt;
      if (r.at <= 0) {
        spawnCar(r.from, r.to);
        this._pendingReturns.splice(i, 1);
      }
    }
  }

  checkLevelUp() {
    while (this.level < 50 && this.xp >= LEVEL_XP(this.level)) {
      this.level++;
      // grant batch
      const lvl = this.level;
      this.batch.house += Math.min(2 + Math.floor(lvl / 2), 8);
      this.batch.shop += 1 + (lvl % 3 === 0 ? 1 : 0);
      this.batch.factory += lvl % 4 === 0 ? 1 : 0;
      this.onLevelUp?.(this.level);
    }
  }

  // Pollution field: factories emit; decays with distance.
  pollutionAt(x, y) {
    let p = 0;
    for (const b of this.buildings.values()) {
      if (b.type !== 'factory') continue;
      const d = dist(x, y, b.x, b.y);
      p += Math.exp(-d / 260);
    }
    return p;
  }

  population() {
    let pop = 0;
    for (const b of this.buildings.values()) if (b.type === 'house') pop += b.residents;
    return pop;
  }

  stats() {
    let houses = 0, shops = 0, factories = 0, unhappy = 0;
    for (const b of this.buildings.values()) {
      if (b.type === 'house') houses++;
      else if (b.type === 'shop') shops++;
      else factories++;
    }
    return { houses, shops, factories };
  }

  toJSON() {
    return {
      buildings: [...this.buildings.values()],
      xp: this.xp,
      level: this.level,
      batch: this.batch,
      totalTrips: this.totalTrips,
    };
  }

  static fromJSON(net, terrain, data) {
    const eco = new Economy(net, terrain);
    for (const b of data.buildings) eco.buildings.set(b.id, b);
    // Reserve loaded IDs so a later placement cannot reuse one.
    if (net?.ids) for (const b of data.buildings) net.ids.reserve(b.id);
    eco.xp = data.xp || 0;
    eco.level = data.level || 1;
    eco.batch = data.batch || { house: 4, shop: 2, factory: 1 };
    eco.totalTrips = data.totalTrips || 0;
    return eco;
  }
}
