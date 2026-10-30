// Traffic simulation — cars with IDM-lite car following, intersection
// priorities (yield to the right), roundabouts and traffic lights.
import { lanesAvailable, profileFor } from './roadProfiles.js';
import { canChangeLane, planExitLane, changeProgress, LANE_CHANGE, VEHICLE_LENGTH } from './laneChanges.js';
import { pointAt, clamp, dist, makeRng } from './core.js';
import { findPath, findVehicleRoute, pathToSteps } from './pathfinding.js';
import { buildJunctionConnectors } from './junctions.js';
import { phaseForAxis, getSignalState } from './signals.js';

/**
 * Time constant of the per-edge congestion EMA, in simulation seconds.
 * `alpha = 1 - exp(-dt / tau)` makes the smoothing timestep independent: after
 * simulated time T the value is `1 - exp(-T / tau)` however T was subdivided.
 */
export const CONGESTION_TAU = 5;

export const CAR_COLORS = ['#d94f4f', '#4f7bd9', '#4fae59', '#d9a44f', '#8f5bd9', '#4fb8c9', '#d94f8a', '#8a9299', '#3c4148', '#c9d14f'];

const CAR_LEN = 7;
const CAR_W = 3.6;
const MIN_GAP = 2.2;

let carSeq = 1;

/**
 * Current value of the vehicle ID counter, for persistence.
 * `carSeq` is module-level, so without this a reload would reissue IDs that an
 * existing save already contains.
 */
export function getCarIdCounter() { return carSeq; }

/**
 * Restores the vehicle ID counter after a load.
 * Only ever moves it forward, so a stale snapshot cannot cause reissued IDs.
 */
export function setCarIdCounter(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`car id counter must be a positive integer, got ${value}`);
  }
  carSeq = Math.max(carSeq, value);
}

export class Car {
  constructor(route, colorIdx) {
    this.id = carSeq++;    this.route = route;             // {steps:[{edgeId,from,to,dir}], nodes}
    this.step = 0;                  // index into route.steps
    this.s = 0;                     // arc pos along current edge (in travel direction)
    this.speed = 0;
    this.color = CAR_COLORS[colorIdx % CAR_COLORS.length];
    this.waiting = 0;               // seconds spent stopped
    this.dead = false;
    this.x = 0; this.y = 0; this.dir = 0;
    // Deterministic baseline. Per-vehicle variation belongs to vehicle types
    // (S06.2), not to a random field that nothing reads.
    this.speedFactor = 1;
    this.tripTimer = 0;
    this._updatePos();
  }

  currentStep() { return this.route.steps[this.step]; }

  _updatePos() {
    const net = this.net;
    if (!net) return;
    const step = this.currentStep();
    if (!step) return;
    const edge = net.edges.get(step.edgeId);
    if (!edge) { this.dead = true; return; }
    const avail = lanesAvailable(profileFor(edge), step.dir);
    const lane = Math.min(step.lane ?? 0, Math.max(avail - 1, 0));
    // S04.3 lateral transition: interpolate lane centres so the visual
    // movement is smooth instead of a teleport.
    let p;
    if (this._changing) {
      const t = changeProgress(this._changing.elapsed);
      const a = net.lanePoint(edge, step.dir, lane, this.s);
      const b = net.lanePoint(edge, step.dir, this._changing.toLane, this.s);
      p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dir: a.dir };
    } else {
      p = net.lanePoint(edge, step.dir, lane, this.s);
    }
    this.x = p.x; this.y = p.y;
    this.dir = step.dir === 1 ? p.dir : p.dir + Math.PI;
  }
}

export class TrafficSim {
  // rng: optional seeded generator. Defaulting to a fixed seed keeps existing
  // callers working while making runs reproducible instead of Math.random.
  constructor(net, options = {}) {
    this.net = net;
    this.rng = options.rng ?? makeRng(options.seed ?? 1);
    this.cars = new Map();
    this.time = 0;
    this.bucket = 0;       // spawn bucket timer
    this.stats = { trips: 0, totalTripTime: 0, waiting: 0, cancelled: 0 };
    this.restrictions = null; // Set of blocked connector ids (inspector S04.2.6)
    this.reservations = new Map(); // connectorId -> carId (S04.2.5)
    this.waitReason = new Map(); // carId -> 'signal'|'connectorConflict'|...
  }

  /**
   * Ends a trip early and records WHY.
   *
   * Used when a live edit destroys a route (EVIDENCE E16). Previously such cars
   * were marked dead and dropped from the map with no counter and no reason, so a
   * failed trip was indistinguishable from a completed one in the stats.
   *
   * Deliberately does NOT touch `stats.trips` or award XP: an edit must not be
   * able to farm progress by deleting the road under a car.
   */
  cancelCar(car, reason = 'cancelled') {
    if (!car || car.dead) return false;
    this._releaseConnector(car);
    car.dead = true;
    car.cancelled = true;
    car.cancelReason = reason;
    this.stats.cancelled++;
    this.cars.delete(car.id);
    if (car.onCancel) car.onCancel(car, reason);
    return true;
  }

  // Spawn a car from nodeId to nodeId. Returns Car or null.
  // S04.2: lane-level route with connectorIds; legacy node path as fallback.
  spawn(fromId, toId) {
    if (this.cars.size > 2600) return null;
    const laneRoute = findVehicleRoute(this.net, fromId, toId, {
      restrictions: this.restrictions ?? null,
    });
    let steps, nodes;
    if (laneRoute) {
      steps = laneRoute.steps;
      nodes = steps.map(s => s.from).concat(steps.length ? [steps[steps.length - 1].to] : []);
    } else {
      const path = findPath(this.net, fromId, toId);
      if (!path || path.nodes.length < 2) return null;
      steps = pathToSteps(this.net, path.nodes);
      if (!steps || steps.length === 0) return null;
      for (const st of steps) st.lane = 0;
      nodes = path.nodes;
    }
    const car = new Car({ nodes, steps }, Math.floor(this.rng() * CAR_COLORS.length));
    car.net = this.net;
    car.originTime = this.time;
    // don't spawn on top of an existing car
    if (this._blockedAtSpawn(car)) return null;
    this.cars.set(car.id, car);
    return car;
  }

  _blockedAtSpawn(car) {
    const step = car.currentStep();
    const edge = this.net.edges.get(step.edgeId);
    if (!edge) return true;
    for (const other of this.cars.values()) {
      if (other.step >= car.route.steps.length) continue;
      const os = other.currentStep();
      if (os && os.edgeId === step.edgeId && os.dir === step.dir && Math.abs(other.s - car.s) < CAR_LEN + MIN_GAP) return true;
    }
    return false;
  }

  update(dt) {
    this.time += dt;
    const net = this.net;

    // reset per-edge congestion accumulation
    for (const e of net.edges.values()) e._congAcc = 0;

    // 1. compute desired speeds / resolve intersections
    const intents = new Map(); // carId -> desired speed
    for (const car of this.cars.values()) {
      car.tripTimer += dt;
      const desired = this._desiredSpeed(car, dt);
      intents.set(car.id, desired);
    }

    // 1b. lane changes: mandatory exit-lane planning + voluntary cooldown.
    // A car in transition occupies BOTH lanes for collision checks.
    this._updateLaneChanges(dt);

    // 2. car following per (edge, dir, lane)
    const lanes = new Map();
    for (const car of this.cars.values()) {
      const st = car.currentStep();
      if (!st) continue;
      const key = `${st.edgeId}:${st.dir}:${st.lane}`;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(car);
      if (car._changing) {
        const other = `${st.edgeId}:${st.dir}:${car._changing.toLane}`;
        if (!lanes.has(other)) lanes.set(other, []);
        lanes.get(other).push(car);
      }
    }
    for (const list of lanes.values()) {
      list.sort((a, b) => a.s - b.s);
      for (let i = 0; i < list.length; i++) {
        const car = list[i];
        const next = list[i + 1]; // ahead in same lane
        let desired = intents.get(car.id);
        if (next) {
          const gap = next.s - car.s - CAR_LEN;
          desired = Math.min(desired, this._followSpeed(car.speed, Math.max(gap, 0), next.speed));
        }
        // move
        car.speed += clamp(desired - car.speed, -30 * dt, 8 * dt);
        car.speed = Math.max(0, car.speed);
        car.s += car.speed * dt;
        if (car.speed < 0.5) car.waiting += dt;
        const st = car.currentStep();
        const edge = net.edges.get(st.edgeId);
        if (edge) {
          edge._congAcc = (edge._congAcc || 0) + (car.speed < 2 ? 1 : 0);
          edge._cars = (edge._cars || 0) + 1;
        }
      }
    }

    // 3. advance route for cars that passed their edge end.
    // Overshoot is carried into the next edge instead of being zeroed, so a
    // vehicle's total travelled distance matches its speed. The loop is bounded
    // by the route length, and a zero-length edge is treated as invalid rather
    // than spinning forever.
    for (const car of this.cars.values()) {
      if (car.dead) continue;
      const maxTransitions = car.route.steps.length + 1;
      let transitions = 0;

      while (!car.dead && transitions++ <= maxTransitions) {
        const st = car.currentStep();
        const edge = net.edges.get(st.edgeId);
        if (!edge || !(edge.total > 0)) { car.dead = true; break; }
        if (car.s < edge.total) break;   // still on this edge

        car.s -= edge.total;             // carry the residual distance
        // S04.2.5: release the connector once the car leaves the edge — the
        // rear has cleared the conflict zone at the transition.
        this._releaseConnector(car);
        car.step++;

        if (car.step >= car.route.steps.length) {
          car.dead = true;
          car.arrived = true;
          this.stats.trips++;
          this.stats.totalTripTime += car.tripTimer;
          if (car.onArrive) car.onArrive(car);
          break;
        }
      }

      // A route that could not be advanced (corrupt or zero-length) is dead.
      if (!car.dead && transitions > maxTransitions) car.dead = true;
      if (!car.dead) car._updatePos();
    }

    // 4. congestion per edge: the share of present vehicles that are stopped,
    //    smoothed with a timestep-independent EMA. The previous formula scaled
    //    the input by 0.02 * 0.05, so a fully jammed edge settled at 0.05 rather
    //    than 1, and its `(dt * 60)` factor made the result depend on timestep.
    for (const e of net.edges.values()) {
      const frac = e._cars ? (e._congAcc / e._cars) : 0;
      const alpha = 1 - Math.exp(-dt / CONGESTION_TAU);
      const current = e._congestion ?? 0;
      e._congestion = clamp(current + (frac - current) * alpha, 0, 1);
      // Published for vehicle-weighted aggregation in metrics.js. `_cars` is the
      // per-tick accumulator and is reset below; `_carCount` persists.
      e._carCount = e._cars;
      e._cars = 0;
    }

    // cleanup dead
    for (const [id, car] of this.cars) if (car.dead) this.cars.delete(id);
  }

  // desired speed considering stop lines & intersection priority
  _desiredSpeed(car, dt) {
    const net = this.net;
    const st = car.currentStep();
    const edge = net.edges.get(st.edgeId);
    if (!edge) return 0;
    const { speed } = profileFor(edge);
    const distToEnd = edge.total - car.s;
    const nextNode = net.nodes.get(st.to);
    if (!nextNode) return speed;

    const nextStep = car.route.steps[car.step + 1] || null;

    // check if we must stop for this node
    const stopDist = this._mustYield(car, edge, nextNode, car.step === car.route.steps.length - 1, nextStep);
    if (stopDist !== null) {
      // decelerate to stop at the line
      const v = Math.sqrt(Math.max(0, 2 * 6 * Math.max(0, stopDist - 1.5)));
      return Math.min(speed, v);
    }
    // curve speed limit near nodes
    if (distToEnd < 25 && nextNode.edges.size > 2) return Math.min(speed, 8);
    return speed;
  }

  // S04.2.5 connector reservation: gather requests on pre-tick state, admit in
  // stable order (signal permission, existing holder, waiting-age, arrival,
  // vehicle id). A car may only enter when its connector and every conflicting
  // connector are free AND downstream has room. Release after the rear clears.
  _connectorGate(car, edge, node, nextStep) {
    const st = car.currentStep();
    const cid = st?.connectorId;
    if (!cid || !nextStep || nextStep.edgeId === undefined) return null;
    if (node.isRing || node.type === 'driveway') return null;
    const distToEnd = edge.total - car.s;
    if (distToEnd > 10) return null; // not yet requesting: only the car at the
    // stop line may hold a reservation, so a queue behind it never deadlocks
    // by holding conflicts for connectors it cannot yet enter (S04.2.5).
    const holder = this.reservations.get(cid);
    if (holder !== undefined && holder !== car.id) {
      this.waitReason.set(car.id, 'connectorConflict');
      return Math.min(distToEnd, 6);
    }
    const conns = buildJunctionConnectors(this.net, node.id, {
      restrictions: this.restrictions ?? null,
    });
    const me = conns.find(c => c.id === cid);
    if (!me) {
      this.waitReason.set(car.id, 'noRoute');
      return Math.min(distToEnd, 6);
    }
    for (const o of me.conflicts) {
      const h = this.reservations.get(o);
      if (h !== undefined && h !== car.id) {
        this.waitReason.set(car.id, 'connectorConflict');
        return Math.min(distToEnd, 6);
      }
    }
    // Downstream room: vehicle length + gap must fit at the exit lane start.
    const nEdge = this.net.edges.get(nextStep.edgeId);
    if (nEdge) {
      for (const other of this.cars.values()) {
        if (other === car || other.dead) continue;
        const os = other.currentStep();
        if (!os || os.edgeId !== nEdge.id || os.dir !== nextStep.dir || os.lane !== nextStep.lane) continue;
        if (other.s < CAR_LEN + MIN_GAP + 3 && other.speed < 1) {
          this.waitReason.set(car.id, 'downstreamBlocked');
          return Math.min(distToEnd, 6);
        }
      }
    }
    // Admit: hold the connector and its conflicts until the rear clears.
    this.reservations.set(cid, car.id);
    car._heldConnector = cid;
    car._heldConflicts = [...me.conflicts];
    for (const o of me.conflicts) {
      if (!this.reservations.has(o)) this.reservations.set(o, car.id);
    }
    this.waitReason.delete(car.id);
    return null;
  }

  _releaseConnector(car) {
    const cid = car._heldConnector;
    if (!cid) return;
    if (this.reservations.get(cid) === car.id) this.reservations.delete(cid);
    for (const o of car._heldConflicts ?? []) {
      if (this.reservations.get(o) === car.id) this.reservations.delete(o);
    }
    car._heldConnector = null;
    car._heldConflicts = null;
  }

  /**
   * S04.3 lane-change planner, run once per tick before car following.
   *
   * Mandatory: the next connector needs a specific exit lane. Planning starts
   * at max(60wu, speed*5s); if missed, the car continues legally and reroutes
   * at the next safe node instead of cutting across. Voluntary changes
   * (speed advantage) need cooldown + room and never happen near a stop line.
   */
  _updateLaneChanges(dt) {
    for (const car of this.cars.values()) {
      if (car.dead) continue;
      const st = car.currentStep();
      if (!st) continue;
      const edge = this.net.edges.get(st.edgeId);
      if (!edge || edge.ring) continue;
      // Advance an in-progress transition.
      if (car._changing) {
        car._changing.elapsed += dt;
        if (car._changing.elapsed >= LANE_CHANGE.duration) {
          st.lane = car._changing.toLane;
          car._changing = null;
          car._cooldown = LANE_CHANGE.cooldown;
        }
        continue;
      }
      if (car._cooldown > 0) car._cooldown -= dt;
      const nextStep = car.route.steps[car.step + 1];
      const needLane = nextStep?.connectorLane ?? st.lane;
      if (needLane === st.lane) continue;
      // Mandatory exit-lane change only: voluntary speed changes arrive S04.5+.
      const plan = planExitLane(
        { lane: st.lane, s: car.s },
        { toLane: needLane, edgeTotal: edge.total, speed: Math.max(car.speed, 8) },
      );
      if (plan.missed) {
        this._rerouteFromNextNode(car);
        continue;
      }
      if (car.s < plan.startS) continue; // too early: hold lane
      const idx = this._laneIndex(edge, st.dir, car);
      const ok = canChangeLane(
        { s: car.s, speed: car.speed, lane: st.lane },
        needLane, idx, { edgeTotal: edge.total },
      );
      if (!ok.ok) {
        if (edge.total - car.s < LANE_CHANGE.noChangeNearJunction + 10) {
          this._rerouteFromNextNode(car);
        } else {
          this.waitReason.set(car.id, 'laneChangeWait');
        }
        continue;
      }
      car._changing = {
        fromLane: st.lane, toLane: needLane, startS: car.s,
        duration: LANE_CHANGE.duration, elapsed: 0,
      };
      this.waitReason.delete(car.id);
    }
  }

  /** Cars on the same edge+direction for gap checks (includes changers). */
  _laneIndex(edge, dir, self) {
    const cars = [];
    for (const o of this.cars.values()) {
      if (o === self || o.dead) continue;
      const os = o.currentStep();
      if (!os || os.edgeId !== edge.id || os.dir !== dir) continue;
      cars.push({ lane: os.lane, s: o.s, speed: o.speed, _changing: o._changing });
    }
    return { cars };
  }

  /**
   * Missed the required exit lane: continue legally on the current lane and
   * replan from the next safe node. Never cut across at the last instant.
   */
  _rerouteFromNextNode(car) {
    const st = car.currentStep();
    if (!st || car._rerouted) return;
    const edge = this.net.edges.get(st.edgeId);
    if (!edge) return;
    const nextNode = st.dir === 1 ? edge.b : edge.a;
    const dest = car.route.steps[car.route.steps.length - 1]?.to;
    if (!dest || nextNode === dest) return;
    const fresh = findVehicleRoute(this.net, nextNode, dest, {
      restrictions: this.restrictions ?? null,
    });
    if (!fresh || !fresh.steps.length) return;
    // Splice: keep the current edge traversal, continue fresh from next node.
    car.route.steps = [st, ...fresh.steps];
    car.route.nodes = car.route.nodes.slice(0, car.step + 1).concat(fresh.steps.map(s => s.to));
    car._rerouted = true;
    this.waitReason.delete(car.id);
  }

  // Returns null if free (no stop needed), or stop distance.
  _mustYield(car, edge, node, isLastStep, nextStep) {
    const net = this.net;
    const distToEnd = edge.total - car.s;
    const lookahead = 60;

    // don't enter an intersection we can't exit (anti-gridlock): if the road
    // beyond the node is jammed at its start in our lane, hold at the line.
    // Applies on the ring too, so cars hold before a jammed exit instead of
    // parking inside the roundabout.
    if (nextStep && node.edges.size > 1 && distToEnd < 50) {
      const nEdge = net.edges.get(nextStep.edgeId);
      if (nEdge) {
        for (const other of this.cars.values()) {
          if (other === car || other.dead) continue;
          const os = other.currentStep();
          if (!os || os.edgeId !== nEdge.id || os.dir !== nextStep.dir || os.lane !== nextStep.lane) continue;
          if (other.s < CAR_LEN + MIN_GAP + 3 && other.speed < 1) return Math.min(distToEnd, 6);
        }
      }
    }

    // approaching a roundabout ring: yield to circulating traffic on the
    // segment we'd merge into, and to cars about to enter that segment
    if (node.isRing && nextStep) {
      if (edge.ring) return null; // circulating: ring traffic has priority
      const ringEdge = net.edges.get(nextStep.edgeId);
      if (ringEdge?.ring) {
        for (const other of this.cars.values()) {
          if (other === car || other.dead) continue;
          const os = other.currentStep();
          if (!os) continue;
          const oe = net.edges.get(os.edgeId);
          if (!oe?.ring) continue;
          if (os.edgeId === ringEdge.id) {
            // circulating toward/past our merge point (start of ring edge)
            if (other.s < 34 && other.speed > 0.3) return Math.min(distToEnd, 6);
          } else if (oe.b === node.id && os.to === node.id) {
            // one segment upstream, about to flow into our merge segment
            if (oe.total - other.s < 22 && other.speed > 0.3) return Math.min(distToEnd, 6);
          }
        }
      }
      return null;
    }

    if (node.type === 'light') {
      // Movement-based program wins when installed; legacy axis otherwise.
      // Renderer calls the same function, so the map cannot disagree.
      if (node.signalProgram) {
        const cid = car.currentStep()?.connectorId;
        const st = getSignalState(node.signalProgram, this.time);
        if (cid && st.allowedConnectorIds.includes(cid)) return null;
        // Committed car clears on yellow: a reservation holder keeps going.
        if (st.state === 'yellow' && (car._heldConnector || distToEnd <= 10)) return null;
        if (st.state === 'yellow' && distToEnd > 10) {
          this.waitReason.set(car.id, 'signal');
          return Math.min(distToEnd, 6);
        }
        this.waitReason.set(car.id, 'signal');
        return Math.min(distToEnd, 6);
      }
      // Shared phase authority (signals.js). The renderer calls the same
      // function, so the indicator on the map cannot disagree with this.
      this._lightAxisGreen(node); // resolve axis A once, before first use
      const phase = phaseForAxis(node.light, this.time, this._edgeAxis(edge, node));
      if (phase.go) return null;
      // Yellow: hold if there is still room to stop, otherwise clear.
      if (phase.yellow && distToEnd > 10) return Math.min(distToEnd, 6);
      if (phase.yellow) return null;
      // Red or all-red: hold at the line.
      return Math.min(distToEnd, 6);
    }

    // S04.2 connector gate runs before the legacy yield logic. A car already
    // holding its connector reservation skips legacy yield: the reservation
    // IS the protection, and double-holding (reservation + yield-to-right)
    // deadlocks two admitted cars against each other forever.
    if (nextStep?.connectorId !== undefined && car.currentStep()?.connectorId) {
      const gate = this._connectorGate(car, edge, node, nextStep);
      if (gate !== null) return gate;
      if (car._heldConnector) return null;
    }

    // plain intersection: yield to the right & to occupied zone.
    // A degree-2 node is a BEND, not an intersection: there is no cross traffic
    // to yield to. Applying the occupied-zone check there makes two opposing
    // cars on a two-way road wait for each other forever, because at a corner
    // the two edges have different axes so _crosses() is always true.
    if (node.edges.size <= 2) return null;
    // occupied intersection zone check
    for (const other of this.cars.values()) {
      if (other === car || other.dead) continue;
      const os = other.currentStep();
      if (!os) continue;
      if (os.to === node.id) {
        const oe = net.edges.get(os.edgeId);
        if (oe && oe.total - other.s < 10) {
          // other is crossing; yield unless we have priority (coming from its right)
          const theirAxis = this._edgeAxis(net.edges.get(os.edgeId), node);
          const ourAxis = this._edgeAxis(edge, node);
          if (this._crosses(ourAxis, theirAxis)) return Math.min(distToEnd, 6);
        }
      }
    }
    // yield to the right: any car approaching on a edge to our right within lookahead
    const myDirIn = this._incomingAngle(edge, node);
    for (const eid of node.edges) {
      if (eid === edge.id) continue;
      const e2 = net.edges.get(eid);
      if (!e2) continue;
      const theirDirIn = this._incomingAngle(e2, node);
      const rel = ((theirDirIn - myDirIn) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      // a car coming from our right has rel ≈ 3π/2 (i.e., -π/2)
      const fromRight = Math.abs(rel - Math.PI * 1.5) < 0.5;
      if (!fromRight) continue;
      for (const other of this.cars.values()) {
        if (other === car || other.dead) continue;
        const os = other.currentStep();
        if (!os || os.edgeId !== eid || os.to !== node.id) continue;
        const od = e2.total - other.s;
        if (od < lookahead && other.speed < 3) return Math.min(distToEnd, 6);
        if (od < 10) return Math.min(distToEnd, 6);
      }
    }
    return null;
  }

  _incomingAngle(edge, node) {
    const p = node;
    const other = net_node(this.net, edge.a === node.id ? edge.b : edge.a);
    if (!other) return 0;
    return Math.atan2(other.y - p.y, other.x - p.x);
  }

  _edgeAxis(edge, node) {
    const other = net_node(this.net, edge.a === node.id ? edge.b : edge.a);
    if (!other) return 'x';
    const dx = Math.abs(other.x - node.x), dy = Math.abs(other.y - node.y);
    return dx >= dy ? 'x' : 'y';
  }

  _lightAxisGreen(node) {
    // Axis A is the dominant axis of the first connected edge; it is green in
    // the first half of the cycle. Resolved once and stored on the light so the
    // renderer and the simulator read the same value.
    if (!node.light.axis) {
      const edges = [...node.edges].map(eid => this.net.edges.get(eid)).filter(Boolean);
      node.light.axis = edges.length >= 1 ? this._edgeAxis(edges[0], node) : 'x';
    }
    return node.light.axis;
  }

  _crosses(a, b) { return a !== b; }

  _followSpeed(v, gap, vLead) {
    // Safe following: speed that lets us brake to vLead within the gap.
    const b = 7; // comfortable braking m/s^2
    return Math.min(40, Math.sqrt(vLead * vLead + 2 * b * Math.max(gap - 1, 0)));
  }
}

function net_node(net, id) { return net.nodes.get(id); }
