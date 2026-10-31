// Freight supply chain — S06.2.
//
// Depot (external source, finite rate) → factory (raw + workers → goods) →
// shop (goods consumed per served shopping request). All values are initial
// tuning defaults, not final economy claims.
//
// Mass conservation: dispatch reserves source cargo immediately; delivery
// commits the transfer; cancellation returns the reservation (or records an
// explicit loss with a reason). Inventory never goes negative or duplicates.
export const LOGISTICS_DEFAULTS = {
  depotRate: 2,       // raw units produced...
  depotPeriod: 10,    // ...per this many sim-seconds
  depotStorage: 40,
  factoryRate: 2,     // goods produced...
  factoryPeriod: 20,  // ...per this many sim-seconds, consuming 2 raw
  factoryRawStorage: 20,
  factoryGoodsStorage: 20,
  shopGoodsStorage: 20,
  dispatchThreshold: 0.25, // dispatch when destination stock below 25%
};

export const TRUCK = {
  capacity: 8,
  length: 12,
  width: 3.8,
  speedFactor: 0.8,
};

let shipmentSeq = 1;
export function resetShipmentSeq() { shipmentSeq = 1; }

export class Logistics {
  /** @param {Object<string,{id,type,stock,workers?}>} buildings */
  constructor(buildings) {
    this.buildings = new Map(Object.entries(buildings));
    this.shipments = new Map(); // id -> {id,item,amount,sourceId,destId,state}
    this.cancelled = 0;
    this.lost = 0;
    this.lostReasons = {};
    this.delivered = 0;
  }

  _stock(id) { return this.buildings.get(id)?.stock; }

  stallReason(factoryId) {
    const f = this.buildings.get(factoryId);
    if (!f || f.type !== 'factory') return null;
    if ((f.workers ?? 0) < 1) return 'stalled: no assigned workers';
    if ((f.stock?.raw ?? 0) < LOGISTICS_DEFAULTS.factoryRate) return 'stalled: no raw material';
    return null;
  }

  update(dt) {
    // Depot production.
    for (const b of this.buildings.values()) {
      if (b.type !== 'depot') continue;
      b.stock.raw = Math.min(
        LOGISTICS_DEFAULTS.depotStorage,
        (b.stock.raw ?? 0) + LOGISTICS_DEFAULTS.depotRate * (dt / LOGISTICS_DEFAULTS.depotPeriod),
      );
      // Keep integers: production ticks are whole units per period.
      b.stock.raw = Math.floor(b.stock.raw);
    }
    // Factory production.
    for (const b of this.buildings.values()) {
      if (b.type !== 'factory') continue;
      b._prodAcc = (b._prodAcc ?? 0) + dt;
      while (b._prodAcc >= LOGISTICS_DEFAULTS.factoryPeriod) {
        b._prodAcc -= LOGISTICS_DEFAULTS.factoryPeriod;
        if ((b.workers ?? 0) < 1) continue;
        if ((b.stock.raw ?? 0) < LOGISTICS_DEFAULTS.factoryRate) continue;
        if ((b.stock.goods ?? 0) + LOGISTICS_DEFAULTS.factoryRate > LOGISTICS_DEFAULTS.factoryGoodsStorage) continue;
        b.stock.raw -= LOGISTICS_DEFAULTS.factoryRate;
        b.stock.goods = (b.stock.goods ?? 0) + LOGISTICS_DEFAULTS.factoryRate;
      }
    }
  }

  /** Amount the destination wants (to fill up), capped by truck capacity. */
  _want(dest, item) {
    const cap = item === 'raw' ? LOGISTICS_DEFAULTS.factoryRawStorage : LOGISTICS_DEFAULTS.shopGoodsStorage;
    const have = dest.stock?.[item] ?? 0;
    if (have >= cap * LOGISTICS_DEFAULTS.dispatchThreshold) return 0;
    return Math.min(cap - have, TRUCK.capacity);
  }

  _outstanding(sourceId, destId, item) {
    for (const s of this.shipments.values()) {
      if (s.state === 'active' && s.sourceId === sourceId && s.destId === destId && s.item === item) return true;
    }
    return false;
  }

  /** Dispatch one shipment if any lane needs it. Returns shipment or null. */
  dispatch() {
    const depot = [...this.buildings.values()].find(b => b.type === 'depot');
    const factories = [...this.buildings.values()].filter(b => b.type === 'factory');
    const shops = [...this.buildings.values()].filter(b => b.type === 'shop');
    // Lane 1: depot raw -> factory.
    if (depot) {
      for (const f of factories.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (this._outstanding(depot.id, f.id, 'raw')) continue;
        const amount = Math.min(this._want(f, 'raw'), Math.floor(depot.stock.raw ?? 0));
        if (amount <= 0) continue;
        return this._launch(depot.id, f.id, 'raw', amount);
      }
      // Lane 2: factory goods -> shop.
      for (const f of factories.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        for (const s of shops.sort((a, b) => (a.id < b.id ? -1 : 1))) {
          if (this._outstanding(f.id, s.id, 'goods')) continue;
          const amount = Math.min(this._want(s, 'goods'), Math.floor(f.stock.goods ?? 0));
          if (amount <= 0) continue;
          return this._launch(f.id, s.id, 'goods', amount);
        }
      }
    }
    return null;
  }

  _launch(sourceId, destId, item, amount) {
    const src = this.buildings.get(sourceId);
    src.stock[item] -= amount; // reserve immediately
    const id = `sh${shipmentSeq++}`;
    const s = { id, item, amount, sourceId, destId, state: 'active' };
    this.shipments.set(id, s);
    return s;
  }

  deliver(shipmentId) {
    const s = this.shipments.get(shipmentId);
    if (!s || s.state !== 'active') return false;
    const dest = this.buildings.get(s.destId);
    if (!dest) { this.cancel(shipmentId, 'destroyedDestination'); return false; }
    dest.stock[s.item] = (dest.stock[s.item] ?? 0) + s.amount;
    s.state = 'delivered';
    this.delivered++;
    return true;
  }

  cancel(shipmentId, reason = 'cancelled') {
    const s = this.shipments.get(shipmentId);
    if (!s || s.state !== 'active') return false;
    const src = this.buildings.get(s.sourceId);
    if (src) {
      src.stock[s.item] = (src.stock[s.item] ?? 0) + s.amount; // reservation returns
    } else {
      this.lost += s.amount;
      this.lostReasons[reason] = (this.lostReasons[reason] || 0) + s.amount;
    }
    s.state = 'cancelled';
    s.cancelReason = reason;
    this.cancelled++;
    return true;
  }

  /** Shop serves one customer: consumes 1 good. Returns false when empty. */
  serveShop(shopId) {
    const s = this.buildings.get(shopId);
    if (!s || s.type !== 'shop') return false;
    if ((s.stock.goods ?? 0) < 1) return false;
    s.stock.goods -= 1;
    return true;
  }

  totalUnits() {
    let n = 0;
    for (const b of this.buildings.values()) n += (b.stock.raw ?? 0) + (b.stock.goods ?? 0);
    for (const s of this.shipments.values()) if (s.state === 'active') n += s.amount;
    return n;
  }

  stats() {
    return { delivered: this.delivered, cancelled: this.cancelled, lost: this.lost, reasons: { ...this.lostReasons } };
  }
}
