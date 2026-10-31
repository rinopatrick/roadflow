// Versioned world snapshots: serialize, validate, hydrate.
//
// Why this module exists
// ----------------------
// The v1 save was `localStorage.setItem('roadflow.save', JSON.stringify(...))`
// with no schema version, no validation, and no error handling around the read.
// Consequences (EVIDENCE E13, E18):
//
//  - active vehicles, pending return trips, clocks, RNG state and ID counters
//    were NOT saved, so a reload silently lost trips and could reissue IDs
//  - a corrupt or hand-edited payload produced a half-built world, or fell back
//    to a brand-new city behind a "City loaded." toast
//  - a failed load destroyed the player's current city with no warning
//
// This module separates three responsibilities so each can be tested alone:
//
//   serializeWorld(world)   -> plain JSON data (no functions, no Maps/Sets)
//   validateSnapshot(raw)   -> {ok:true, data, warnings} | {ok:false, errors}
//   hydrateWorld(data)      -> a live world, with callbacks REBOUND
//
// Hydration rebuilds behaviour that cannot be serialized: `onArrive`/`onCancel`
// closures, `car.net` back-references, and reachability caches. Those are
// derived state, so they are discarded on save and reconstructed on load.

import { Terrain } from './terrain.js';
import { RoadNetwork } from './roadNetwork.js';
import { Economy } from './economy.js';
import { TrafficSim, Car, getCarIdCounter, setCarIdCounter } from './traffic.js';
import { createIdSource, makeRng } from './core.js';

/** Current snapshot schema version. v5 adds building capacity (S06.1). */
export const SNAPSHOT_VERSION = 5;

/** Oldest version this build can migrate from. */
export const MIN_SUPPORTED_VERSION = 1;

/** Hard input caps. Safety limits, not performance promises. */
export const LIMITS = {
  bytes: 10 * 1024 * 1024,
  nodes: 20000,
  edges: 30000,
  buildings: 10000,
  cars: 5000,
  coordinate: 20000,
  zoomMin: 0.12,
  zoomMax: 5,
};

/** Vehicle fields that are data and therefore saved. */
const CAR_DATA_FIELDS = [
  'id', 'route', 'step', 's', 'speed', 'color', 'waiting',
  'speedFactor', 'tripTimer', 'purpose', 'homeId', 'destId', 'originTime',
  // S04.3 lane-change state: a save mid-transition resumes the transition.
  '_changing', '_cooldown', '_rerouted',
];

/** Settings fields that are saved. */
const SETTING_FIELDS = ['speed', 'audio'];

// ------------------------------------------------------------- serialize ---

/**
 * Converts a live world into a plain JSON-compatible snapshot.
 *
 * Deliberately contains no functions, Maps, Sets or transient caches. Anything
 * derived (reachability, terrain tiles, island data) is rebuilt on load.
 *
 * @param {{terrain:object, net:object, traffic:object, eco:object,
 *          ids:object, camera:object, settings:object}} world
 */
export function serializeWorld(world) {
  const { terrain, net, traffic, eco, ids, camera, settings } = world;

  const data = {
    v: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    map: {
      seed: terrain.seed,
      generatorVersion: 1, // terrain is fully derived from the seed
    },
    net: net.toJSON(),
    eco: {
      ...eco.toJSON(),
      // Lifecycle state the v1 serializer omitted entirely (EVIDENCE E13).
      pendingReturns: (eco._pendingReturns ?? []).map(r => ({
        at: r.at, retryIn: r.retryIn ?? 0, from: r.from, to: r.to,
      })),
      cancelledReturns: eco.cancelledReturns ?? 0,
      cancellationReasons: { ...(eco.cancellationReasons ?? {}) },
      rngState: eco.rng.getState(),
      cosmeticRngState: eco.cosmeticRng.getState(),
    },
    traffic: {
      time: traffic.time,
      stats: { ...traffic.stats },
      rngState: traffic.rng.getState(),
      nextCarId: getCarIdCounter(),
      cars: [...traffic.cars.values()].map(car => {
        const out = {};
        for (const f of CAR_DATA_FIELDS) out[f] = car[f];
        return out;
      }),
    },
    ids: { next: ids.getState() },
    camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
    settings: { speed: settings?.speed ?? 1, audio: settings?.audio ?? true },
    extensions: {},
  };

  return data;
}

// -------------------------------------------------------------- validate ---

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validates a raw snapshot without mutating anything.
 *
 * Returns a structured result rather than throwing, so the caller can show the
 * player what was wrong and keep the current world intact.
 *
 * @returns {{ok:true, data:object, warnings:string[]} | {ok:false, errors:string[]}}
 */
export function validateSnapshot(raw) {
  const errors = [];
  const warnings = [];
  const fail = (msg) => { errors.push(msg); return { ok: false, errors }; };

  // Accept either a parsed object or raw JSON text.
  let data = raw;
  if (typeof raw === 'string') {
    if (raw.length > LIMITS.bytes) return fail(`save is too large (${raw.length} bytes)`);
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return fail(`save is not valid JSON: ${e.message}`);
    }
  }
  if (!isObject(data)) return fail('save is not an object');

  const version = data.v;
  if (!Number.isInteger(version)) return fail('save has no version number');
  if (version > SNAPSHOT_VERSION) {
    return fail(`save was made by a newer version (v${version}); this build reads up to v${SNAPSHOT_VERSION}`);
  }
  if (version < MIN_SUPPORTED_VERSION) {
    return fail(`save version v${version} is not supported`);
  }
  if (version < SNAPSHOT_VERSION) warnings.push(`migrated from v${version}`);

  // --- map / terrain ---
  const seed = version === 1 ? data.seed : data.map?.seed;
  if (!Number.isFinite(seed)) return fail('save has no usable map seed');

  // --- network ---
  const net = data.net;
  if (!isObject(net)) return fail('save has no network');
  if (!Array.isArray(net.nodes)) return fail('network has no node list');
  if (!Array.isArray(net.edges)) return fail('network has no edge list');
  if (net.nodes.length > LIMITS.nodes) return fail(`too many nodes (${net.nodes.length})`);
  if (net.edges.length > LIMITS.edges) return fail(`too many edges (${net.edges.length})`);

  const nodeIds = new Set();
  for (const n of net.nodes) {
    if (!isObject(n) || typeof n.id !== 'string' || n.id.length === 0) {
      return fail('a node is missing its id');
    }
    if (nodeIds.has(n.id)) return fail(`duplicate node id ${n.id}`);
    nodeIds.add(n.id);
    if (!isFiniteNumber(n.x) || !isFiniteNumber(n.y)) {
      return fail(`node ${n.id} has non-finite coordinates`);
    }
    if (Math.abs(n.x) > LIMITS.coordinate || Math.abs(n.y) > LIMITS.coordinate) {
      return fail(`node ${n.id} is outside the supported map area`);
    }
  }

  const edgeIds = new Set();
  for (const e of net.edges) {
    if (!isObject(e) || typeof e.id !== 'string' || e.id.length === 0) {
      return fail('an edge is missing its id');
    }
    if (edgeIds.has(e.id)) return fail(`duplicate edge id ${e.id}`);
    edgeIds.add(e.id);
    if (!nodeIds.has(e.a)) return fail(`edge ${e.id} references missing node ${e.a}`);
    if (!nodeIds.has(e.b)) return fail(`edge ${e.id} references missing node ${e.b}`);
    if (!Array.isArray(e.controls) || e.controls.length < 2) {
      return fail(`edge ${e.id} has no usable geometry`);
    }
    if (e.pts !== undefined && (!Array.isArray(e.pts) || e.pts.length < 2)) {
      return fail(`edge ${e.id} has malformed sampled geometry`);
    }
  }

  // --- economy ---
  const eco = data.eco;
  if (!isObject(eco)) return fail('save has no economy');
  if (!Array.isArray(eco.buildings)) return fail('economy has no building list');
  if (eco.buildings.length > LIMITS.buildings) {
    return fail(`too many buildings (${eco.buildings.length})`);
  }
  const buildingIds = new Set();
  for (const b of eco.buildings) {
    if (!isObject(b) || typeof b.id !== 'string' || b.id.length === 0) {
      return fail('a building is missing its id');
    }
    if (buildingIds.has(b.id)) return fail(`duplicate building id ${b.id}`);
    buildingIds.add(b.id);
    if (!isFiniteNumber(b.x) || !isFiniteNumber(b.y)) {
      return fail(`building ${b.id} has non-finite coordinates`);
    }
    if (typeof b.drivewayNode !== 'string' || !nodeIds.has(b.drivewayNode)) {
      // Not fatal: the building is loaded but flagged as disconnected, so the
      // player can see and fix it instead of losing the whole city.
      warnings.push(`building ${b.id} lost its road access`);
    }
  }
  if (eco.xp !== undefined && !isFiniteNumber(eco.xp)) return fail('economy XP is not a number');
  if (eco.batch !== undefined && !isObject(eco.batch)) return fail('economy batch is malformed');

  // --- traffic ---
  const traffic = data.traffic ?? {};
  if (traffic.cars !== undefined) {
    if (!Array.isArray(traffic.cars)) return fail('traffic car list is malformed');
    if (traffic.cars.length > LIMITS.cars) return fail(`too many vehicles (${traffic.cars.length})`);
  }
  if (traffic.time !== undefined && !isFiniteNumber(traffic.time)) {
    return fail('traffic clock is not a number');
  }
  for (const car of traffic.cars ?? []) {
    if (!isObject(car) || !Array.isArray(car.route?.steps)) {
      return fail('a vehicle has no usable route');
    }
    if (!isFiniteNumber(car.s) || !isFiniteNumber(car.speed)) {
      return fail('a vehicle has non-finite state');
    }
    // A route referencing a deleted edge cannot be resumed; drop it with a
    // warning rather than refusing the whole save.
    if (car.route.steps.some(st => !edgeIds.has(st.edgeId))) {
      warnings.push('a vehicle route referenced a missing road and was dropped');
    }
  }

  // --- camera ---
  if (data.camera !== undefined) {
    const c = data.camera;
    if (!isObject(c) || !isFiniteNumber(c.x) || !isFiniteNumber(c.y) || !isFiniteNumber(c.zoom)) {
      return fail('camera state is malformed');
    }
    if (c.zoom < LIMITS.zoomMin || c.zoom > LIMITS.zoomMax) {
      return fail(`camera zoom ${c.zoom} is out of range`);
    }
  }

  return { ok: true, data: normalise(data, version, seed, warnings), warnings };
}

/**
 * Fills in defaults for anything a v1 save lacks, so hydration only ever sees
 * one shape.
 */
function normalise(data, version, seed, warnings) {
  // v3 migration: edges gain a profile. v1/v2 saves carry cls (+ring/oneway)
  // only; the profile is derived deterministically so old cities load with
  // unchanged topology and widths. Unknown legacy classes fall back to street.
  // v4 migration: nodes gain z (default 0), edges gain grade (default
  // ground). All older saves are flat, so topology and widths are unchanged.
  const nodeZ = new Map(data.net.nodes.map((n) => [n.id, Number.isFinite(n.z) ? n.z : 0]));
  const net = {
    nodes: data.net.nodes.map((n) => ({ ...n, z: Number.isFinite(n.z) ? n.z : 0 })),
    edges: data.net.edges.map((e) => migrateEdgeV3(e, nodeZ)),
  };
  if (version < 3) warnings.push('migrated road profiles to v3');
  if (version < 4) warnings.push('migrated grades to v4 (all ground)');
  // v5 migration: buildings gain assignedWorkers/serviceSlots. Old saves get
  // defaults (0/0, shops get 4 slots); warn only when a capacity was inferred.
  const ecoBuildings = (data.eco.buildings ?? []).map((b) => ({
    ...b,
    assignedWorkers: Number.isInteger(b.assignedWorkers) ? b.assignedWorkers : 0,
    serviceSlots: Number.isInteger(b.serviceSlots)
      ? b.serviceSlots
      : b.type === 'shop' ? 4 : 0,
    // S06.2 stock: depot starts full, others empty. Validated shape only;
    // negative or non-finite stock is clamped to 0, never trusted.
    stock: {
      raw: Math.max(0, Number.isFinite(b.stock?.raw) ? b.stock.raw
        : b.type === 'depot' ? 40 : 0),
      goods: Math.max(0, Number.isFinite(b.stock?.goods) ? b.stock.goods : 0),
    },
  }));
  if (version < 5) warnings.push('migrated building capacity to v5 (defaults)');
  const out = {
    v: SNAPSHOT_VERSION,
    savedAt: data.savedAt ?? Date.now(),
    map: { seed, generatorVersion: data.map?.generatorVersion ?? 1 },
    net,
    eco: {
      buildings: ecoBuildings,
      xp: isFiniteNumber(data.eco.xp) ? data.eco.xp : 0,
      level: Number.isInteger(data.eco.level) ? data.eco.level : 1,
      // S06.2 migrated cities get one available depot plus a notice, so old
      // saves never deadlock waiting for freight that cannot be built.
      batch: (() => {
        const b = isObject(data.eco.batch) ? { ...data.eco.batch } : { house: 4, shop: 2, factory: 1 };
        if (version < 5 && !(b.depot >= 1)) {
          b.depot = (b.depot ?? 0) + 1;
          warnings.push('granted one depot: freight needs a raw source');
        }
        return b;
      })(),
      totalTrips: Number.isInteger(data.eco.totalTrips) ? data.eco.totalTrips : 0,
      pendingReturns: Array.isArray(data.eco.pendingReturns) ? data.eco.pendingReturns : [],
      cancelledReturns: Number.isInteger(data.eco.cancelledReturns) ? data.eco.cancelledReturns : 0,
      cancellationReasons: isObject(data.eco.cancellationReasons) ? data.eco.cancellationReasons : {},
      rngState: Number.isInteger(data.eco.rngState) ? data.eco.rngState : undefined,
      cosmeticRngState: Number.isInteger(data.eco.cosmeticRngState) ? data.eco.cosmeticRngState : undefined,
    },
    traffic: {
      time: isFiniteNumber(data.traffic?.time) ? data.traffic.time : (isFiniteNumber(data.simTime) ? data.simTime : 0),
      stats: isObject(data.traffic?.stats) ? data.traffic.stats : { trips: 0, totalTripTime: 0, waiting: 0, cancelled: 0 },
      rngState: Number.isInteger(data.traffic?.rngState) ? data.traffic.rngState : undefined,
      nextCarId: Number.isInteger(data.traffic?.nextCarId) ? data.traffic.nextCarId : 1,
      cars: (data.traffic?.cars ?? []).filter(
        car => car.route.steps.every(st => data.net.edges.some(e => e.id === st.edgeId))),
    },
    ids: { next: Number.isInteger(data.ids?.next) ? data.ids.next : 1 },
    camera: data.camera ? { x: data.camera.x, y: data.camera.y, zoom: data.camera.zoom } : { x: 0, y: 0, zoom: 1 },
    settings: {
      speed: SETTING_FIELDS.includes('speed') && isFiniteNumber(data.settings?.speed) ? data.settings.speed : 1,
      audio: typeof data.settings?.audio === 'boolean' ? data.settings.audio : true,
    },
    extensions: isObject(data.extensions) ? data.extensions : {},
  };
  return out;
}

/**
 * Migrates one serialised edge to v3: attaches an explicit profile derived
 * from cls + ring/oneway flags. Edges that already carry a profile keep it;
 * motorway edges with legacy driveways keep access with a warning upstream.
 */
function migrateEdgeV3(e, nodeZ = null) {
  // v4 grade alongside the v3 profile: explicit grade wins, otherwise infer
  // from endpoint z (flat legacy data infers ground).
  const za = nodeZ?.get(e.a) ?? 0;
  const zb = nodeZ?.get(e.b) ?? 0;
  const grade = e.grade ? { ...e.grade }
    : za === 0 && zb === 0 ? { kind: 'ground', za: 0, zb: 0 }
    : za === zb ? { kind: za > 0 ? 'bridge' : 'tunnel', za, zb }
    : { kind: 'ramp', za, zb };
  const cls = ['street', 'avenue', 'highway'].includes(e.cls) ? e.cls : 'street';
  const PRESETS = {
    street: { forward: 1, backward: 1, laneWidth: 6.5, medianWidth: 1.2, shoulderWidth: 1, speed: 14, access: 'local' },
    avenue: { forward: 2, backward: 2, laneWidth: 6, medianWidth: 1.2, shoulderWidth: 1, speed: 18, access: 'arterial' },
    highway: { forward: 3, backward: 3, laneWidth: 6, medianWidth: 1.2, shoulderWidth: 1, speed: 30, access: 'motorway' },
  };
  const preset = PRESETS[cls];
  const oneWay = !!(e.oneway || e.ring);
  if (e.profile) return { ...e, cls, profile: { ...e.profile }, grade };
  return {
    ...e,
    cls,
    profile: oneWay
      ? { ...preset, forward: Math.max(preset.forward, 1), backward: 0, medianWidth: 0 }
      : { ...preset },
    grade,
  };
}

// --------------------------------------------------------------- hydrate ---

/**
 * Rebuilds a live world from a validated snapshot.
 *
 * @param {object} data result of `validateSnapshot(...).data`
 * @param {{onArrival?:Function, onToast?:Function, onLevelUp?:Function}} [hooks]
 * @returns {{terrain, net, traffic, eco, ids, camera, settings}}
 */
export function hydrateWorld(data, hooks = {}) {
  const terrain = new Terrain(data.map.seed);

  // Reserve every loaded ID so new construction cannot reissue one.
  const ids = createIdSource(data.ids.next);
  for (const n of data.net.nodes) ids.reserve(n.id);
  for (const e of data.net.edges) ids.reserve(e.id);
  for (const b of data.eco.buildings) ids.reserve(b.id);

  const net = RoadNetwork.fromJSON(data.net, { ids });

  const eco = Economy.fromJSON(net, terrain, data.eco);
  // Lifecycle state the v1 serializer never stored.
  eco._pendingReturns = data.eco.pendingReturns.map(r => ({ ...r }));
  eco.cancelledReturns = data.eco.cancelledReturns;
  eco.cancellationReasons = { ...data.eco.cancellationReasons };
  if (data.eco.rngState !== undefined) eco.rng.setState(data.eco.rngState);
  if (data.eco.cosmeticRngState !== undefined) eco.cosmeticRng.setState(data.eco.cosmeticRngState);

  const traffic = new TrafficSim(net, { rng: makeRng(1) });
  if (data.traffic.rngState !== undefined) traffic.rng.setState(data.traffic.rngState);
  traffic.time = data.traffic.time;
  traffic.stats = { ...data.traffic.stats };

  // Rebuild vehicles. Closures are NOT serialized: arrival behaviour is rebound
  // here, exactly once per car.
  for (const carData of data.traffic.cars) {
    const live = makeCarFromData(carData);
    live.net = net;
    live._updatePos();
    if (hooks.onArrival) live.onArrive = (c) => hooks.onArrival(c);
    traffic.cars.set(live.id, live);
  }
  setCarIdCounter(data.traffic.nextCarId);

  return {
    terrain,
    net,
    traffic,
    eco,
    ids,
    camera: { ...data.camera },
    settings: { ...data.settings },
  };
}

/**
 * Reconstructs a Car instance from serialized data without going through
 * `TrafficSim.spawn` (which would re-plan the route from scratch and lose the
 * car's exact position and progress).
 */
function makeCarFromData(carData) {
  const car = Object.create(Car.prototype);
  Object.assign(car, carData);
  car.route = {
    nodes: Array.isArray(carData.route.nodes) ? [...carData.route.nodes] : [],
    steps: carData.route.steps.map(st => ({ ...st })),
  };
  car.dead = false;
  car.arrived = false;
  return car;
}
