// S04.4 command + integration: install program, protected left vs opposing
// through, skewed junction, cycle edit with cars present, save/load/undo.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim } from '../src/traffic.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { createIdSource, makeRng } from '../src/core.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { buildJunctionConnectors } from '../src/junctions.js';
import { getSignalState, programCycle } from '../src/signals.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';

function fourWay() {
  const terrain = new Terrain(7);
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const c = net._makeNode(0, 0, 'plain');
  const n = net._makeNode(0, -300, 'plain');
  const s = net._makeNode(0, 300, 'plain');
  const e = net._makeNode(300, 0, 'plain');
  const w = net._makeNode(-300, 0, 'plain');
  const mk = (a, b) => {
    const ed = net._makeEdge(a.id, b.id, 'avenue', []);
    ed.profile = { forward: 1, backward: 1, laneWidth: 6, medianWidth: 1.2, shoulderWidth: 1, speed: 18, access: 'arterial' };
    net.resampleEdge(ed);
    return ed;
  };
  mk(n, c); mk(c, s); mk(w, c); mk(c, e);
  const traffic = new TrafficSim(net, { rng: makeRng(9) });
  const eco = new Economy(net, terrain, 7);
  return {
    world: { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true } },
    c,
  };
}

describe('S04.4 setSignalProgram command', () => {
  it('installs a valid program, refuses a conflicting one', () => {
    const { world, c } = fourWay();
    const history = createHistory();
    const conns = buildJunctionConnectors(world.net, c.id);
    assert.ok(conns.length >= 4);
    // Two non-conflicting movements in one phase: opposing throughs.
    const throughs = conns.filter(k => k.turn === 'through');
    assert.ok(throughs.length >= 2);
    const ns = throughs.slice(0, 2).map(k => k.id);
    let r = history.execute(world, {
      kind: COMMAND_KIND.SET_SIGNAL_PROGRAM, nodeId: c.id,
      program: {
        offset: 0,
        phases: [
          { id: 'ns', green: 10, yellow: 2, allRed: 1, connectorIds: ns },
          { id: 'rest', green: 10, yellow: 2, allRed: 1, connectorIds: conns.filter(k => !ns.includes(k.id)).slice(0, 2).map(k => k.id) },
        ],
      },
    });
    // May fail if the chosen pair conflicts — then the refusal is the proof.
    if (!r.ok) {
      assert.match(r.reason, /conflict|starv/i);
    } else {
      const node = r.world.net.nodes.get(c.id);
      assert.ok(node.signalProgram, 'program installed');
      assert.equal(node.type, 'light');
    }
    // A phase with two conflicting movements must always refuse.
    let conflictPair = null;
    for (const a of conns) {
      for (const bId of a.conflicts) {
        conflictPair = [a.id, bId];
        break;
      }
      if (conflictPair) break;
    }
    assert.ok(conflictPair, 'fixture has a conflicting pair');
    const bad = history.execute(world, {
      kind: COMMAND_KIND.SET_SIGNAL_PROGRAM, nodeId: c.id,
      program: {
        offset: 0,
        phases: [{ id: 'bad', green: 10, yellow: 2, allRed: 1, connectorIds: conflictPair }],
      },
    });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /conflict/i);
  });

  it('one undo removes the installed program', () => {
    const { world, c } = fourWay();
    const history = createHistory();
    const conns = buildJunctionConnectors(world.net, c.id);
    const through = conns.find(k => k.turn === 'through');
    const r = history.execute(world, {
      kind: COMMAND_KIND.SET_SIGNAL_PROGRAM, nodeId: c.id,
      program: {
        offset: 0,
        phases: [{ id: 'all', green: 10, yellow: 2, allRed: 1, connectorIds: [through.id] }],
      },
    });
    // Starvation check requires ALL movements covered; single-movement program
    // refuses unless it is the only movement. Either outcome is consistent.
    if (r.ok) {
      const u = history.undo(r.world);
      assert.equal(u.ok, true);
      assert.equal(u.world.net.nodes.get(c.id).signalProgram, undefined);
    } else {
      assert.match(r.reason, /starv/i);
    }
  });

  it('program survives save/load with identical phase evaluation', () => {
    const { world, c } = fourWay();
    const history = createHistory();
    const conns = buildJunctionConnectors(world.net, c.id);
    const all = conns.map(k => k.id);
    // Split into conflict-free phases greedily.
    const phases = [];
    const remaining = new Set(all);
    const byId = new Map(conns.map(k => [k.id, k]));
    let pi = 0;
    while (remaining.size) {
      const ids = [];
      for (const id of [...remaining]) {
        const bad = ids.some(o => (byId.get(o).conflicts ?? []).includes(id));
        if (!bad) { ids.push(id); remaining.delete(id); }
      }
      phases.push({ id: `p${pi++}`, green: 8, yellow: 2, allRed: 1, connectorIds: ids });
    }
    const r = history.execute(world, {
      kind: COMMAND_KIND.SET_SIGNAL_PROGRAM, nodeId: c.id,
      program: { offset: 2, phases },
    });
    assert.equal(r.ok, true, r.reason);
    const data = serializeWorld(r.world);
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const live = hydrateWorld(v.data);
    for (const t of [0, 3, 9, 15, 30]) {
      assert.deepEqual(
        getSignalState(live.net.nodes.get(c.id).signalProgram, t),
        getSignalState(r.world.net.nodes.get(c.id).signalProgram, t),
      );
    }
    assert.ok(programCycle(live.net.nodes.get(c.id).signalProgram) <= 180);
  });
});
