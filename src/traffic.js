// Traffic simulation — cars with IDM-lite car following, intersection
// priorities (yield to the right), roundabouts and traffic lights.
import { ROAD_CLASS } from './roadNetwork.js';
import { pointAt, clamp, dist } from './core.js';
import { findPath, pathToSteps } from './pathfinding.js';

export const CAR_COLORS = ['#d94f4f', '#4f7bd9', '#4fae59', '#d9a44f', '#8f5bd9', '#4fb8c9', '#d94f8a', '#8a9299', '#3c4148', '#c9d14f'];

const CAR_LEN = 7;
const CAR_W = 3.6;
const MIN_GAP = 2.2;

let carSeq = 1;

export class Car {
  constructor(route, colorIdx) {
    this.id = carSeq++;
    this.route = route;             // {steps:[{edgeId,from,to,dir}], nodes}
    this.step = 0;                  // index into route.steps
    this.s = 0;                     // arc pos along current edge (in travel direction)
    this.speed = 0;
    this.color = CAR_COLORS[colorIdx % CAR_COLORS.length];
    this.waiting = 0;               // seconds spent stopped
    this.dead = false;
    this.x = 0; this.y = 0; this.dir = 0;
    this.maxSpeed = 12 + Math.random() * 4;
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
    const lane = Math.min(step.lane ?? 0, ROAD_CLASS[edge.cls].lanesPerDir - 1);
    const p = net.lanePoint(edge, step.dir, lane, this.s);
    this.x = p.x; this.y = p.y;
    this.dir = step.dir === 1 ? p.dir : p.dir + Math.PI;
  }
}

export class TrafficSim {
  constructor(net) {
    this.net = net;
    this.cars = new Map();
    this.time = 0;
    this.bucket = 0;       // spawn bucket timer
    this.stats = { trips: 0, totalTripTime: 0, waiting: 0 };
  }

  // Spawn a car from nodeId to nodeId. Returns Car or null.
  spawn(fromId, toId) {
    if (this.cars.size > 2600) return null;
    const path = findPath(this.net, fromId, toId);
    if (!path || path.nodes.length < 2) return null;
    const steps = pathToSteps(this.net, path.nodes);
    if (!steps || steps.length === 0) return null;
    // assign lanes: prefer outer lanes on highways, any on streets
    for (const st of steps) {
      const edge = this.net.edges.get(st.edgeId);
      st.lane = edge && !edge.oneway ? Math.floor(Math.random() * ROAD_CLASS[edge.cls].lanesPerDir) : 0;
    }
    const car = new Car({ nodes: path.nodes, steps }, Math.floor(Math.random() * CAR_COLORS.length));
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

    // 2. car following per (edge, dir, lane)
    const lanes = new Map();
    for (const car of this.cars.values()) {
      const st = car.currentStep();
      if (!st) continue;
      const key = `${st.edgeId}:${st.dir}:${st.lane}`;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(car);
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

    // 3. advance route for cars that passed their edge end
    for (const car of this.cars.values()) {
      const st = car.currentStep();
      const edge = net.edges.get(st.edgeId);
      if (!edge) { car.dead = true; continue; }
      if (car.s >= edge.total) {
        car.step++;
        car.s = 0;
        if (car.step >= car.route.steps.length) {
          // arrived
          car.dead = true;
          car.arrived = true;
          this.stats.trips++;
          this.stats.totalTripTime += car.tripTimer;
          if (car.onArrive) car.onArrive(car);
        }
      }
      car._updatePos();
    }

    // 4. congestion per edge (exponential moving avg)
    for (const e of net.edges.values()) {
      const frac = e._cars ? (e._congAcc / e._cars) : 0;
      e._congestion = (e._congestion ?? 0) * 0.98 + frac * 0.02 * (dt * 60) * 0.05;
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
    const cls = ROAD_CLASS[edge.cls];
    const distToEnd = edge.total - car.s;
    const nextNode = net.nodes.get(st.to);
    if (!nextNode) return cls.speed;

    const nextStep = car.route.steps[car.step + 1] || null;

    // check if we must stop for this node
    const stopDist = this._mustYield(car, edge, nextNode, car.step === car.route.steps.length - 1, nextStep);
    if (stopDist !== null) {
      // decelerate to stop at the line
      const v = Math.sqrt(Math.max(0, 2 * 6 * Math.max(0, stopDist - 1.5)));
      return Math.min(cls.speed, v);
    }
    // curve speed limit near nodes
    if (distToEnd < 25 && nextNode.edges.size > 2) return Math.min(cls.speed, 8);
    return cls.speed;
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
      const L = node.light;
      const axisA = this._lightAxisGreen(node);
      const axisB = axisA === 'x' ? 'y' : 'x';
      const half = L.cycle / 2;
      const cyclePos = (this.time + L.offset) % L.cycle;
      const firstHalf = cyclePos < half;
      const greenAxis = firstHalf ? axisA : axisB;
      const greenLen = L.greenRatio * half;
      const timeInHalf = firstHalf ? cyclePos : cyclePos - half;
      const yellow = 2.5;
      const inYellow = timeInHalf >= greenLen - yellow && timeInHalf < greenLen;
      const axis = this._edgeAxis(edge, node);
      if (axis !== greenAxis) {
        return Math.min(distToEnd, 6);
      }
      // green for us, but stop at yellow unless we can't stop in time
      if (inYellow && distToEnd > 10) return Math.min(distToEnd, 6);
      return null;
    }

    // plain intersection: yield to the right & to occupied zone
    if (node.edges.size <= 1) return null;
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
    // dominant axis of the first edge = axis A (green first half of cycle)
    if (!node.light.axis) {
      const edges = [...node.edges].map(eid => this.net.edges.get(eid)).filter(Boolean);
      if (edges.length >= 1) node.light.axis = this._edgeAxis(edges[0], node);
      else node.light.axis = 'x';
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
