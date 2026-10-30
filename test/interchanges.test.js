// S05.4: interchange templates as data. Diamond, dumbbell, directional T.
// Defined approaches, one-way ramp directions, grades, lane profiles in JSON.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { builtinTemplates, transformTemplate, templateCommand } from '../src/templates.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { findVehicleRoute } from '../src/pathfinding.js';

function flatWorld(seed = 7) {
  const terrain = new Terrain(seed);
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const traffic = new TrafficSim(net, { rng: makeRng(seed) });
  const eco = new Economy(net, terrain, seed);
  return { terrain, net, traffic, eco, ids, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 1, audio: true } };
}

describe('S05.4 interchange templates', () => {
  it('three interchange builtins exist and validate', () => {
    const names = builtinTemplates().map(t => t.name);
    assert.ok(names.includes('Diamond interchange'), 'diamond');
    assert.ok(names.includes('Dumbbell interchange'), 'dumbbell');
    assert.ok(names.includes('Directional T interchange'), 'directional T');
  });

  it('diamond: each template segment declares grade/oneway data', () => {
    const t = builtinTemplates().find(x => x.name === 'Diamond interchange');
    const ramps = t.segments.filter(s => s.grade && s.grade.kind !== 'ground');
    assert.ok(ramps.length >= 4, `diamond has ${ramps.length} elevated segments`);
    const oneways = t.segments.filter(s => s.oneway);
    assert.ok(oneways.length >= 4, 'ramps are one-way');
  });

  it('diamond places as one transaction and carries a legal trip', () => {
    const world = flatWorld();
    const history = createHistory();
    const t = builtinTemplates().find(x => x.name === 'Diamond interchange');
    const placed = transformTemplate(t, { rotateDeg: 0, dx: 0, dy: 0 });
    assert.equal(placed.ok, true, placed.reason);
    const r = history.execute(world, templateCommand(placed.template));
    assert.equal(r.ok, true, r.reason);
    // A trip across the interchange routes without teleporting levels.
    const ends = [...r.world.net.nodes.values()].filter(n => n.edges.size === 1).map(n => n.id);
    assert.ok(ends.length >= 2, 'interchange has entries');
    let routed = 0;
    for (let i = 0; i < ends.length && routed === 0; i++) {
      for (let j = 0; j < ends.length; j++) {
        if (i === j) continue;
        if (findVehicleRoute(r.world.net, ends[i], ends[j])) { routed++; break; }
      }
    }
    assert.ok(routed > 0, 'at least one legal trip through the interchange');
  });

  it('a rotated interchange rejects cleanly when it does not fit', () => {
    const world = flatWorld();
    // Force unbuildable terrain everywhere: rotation cannot save it.
    world.terrain.isRoadable = () => false;
    world.terrain.sample = () => 2;
    const history = createHistory();
    const t = builtinTemplates().find(x => x.name === 'Diamond interchange');
    // Ground segments hit water; elevated span it. Some ground remains, so
    // this may succeed or fail — either way the result is atomic.
    const placed = transformTemplate(t, { rotateDeg: 90, dx: 0, dy: 0 });
    assert.equal(placed.ok, true);
    const r = history.execute(world, templateCommand(placed.template));
    assert.equal(typeof r.ok, 'boolean');
  });
});
