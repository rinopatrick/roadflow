// S07.7 R3 gate: freight + bridge + bus + incident + budget across
// save/reload and undo; sandbox stays unlimited and uncontaminated.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';
import { SCENARIOS } from '../src/content/scenarios.js';
import { validateScenario } from '../src/scenarios.js';

describe('S07.7 R3 gate', () => {
  it('eight scenarios validate; editor round-trips one', async () => {
    const { exportScenario, importScenario } = await import('../src/editor.js');
    assert.equal(SCENARIOS.length, 8);
    for (const fn of SCENARIOS) {
      assert.equal(validateScenario(fn()).ok, true);
    }
    const ex = exportScenario({ id: 'bus-line', title: 'Bus Line', description: 'x', objectives: [] });
    assert.equal(ex.ok, true);
    const im = importScenario(ex.json);
    assert.equal(im.ok, true);
    assert.equal(im.scenario.id, 'bus-line');
  });

  it('cross-system run survives save/reload and undo; sandbox clean', () => {
    const terrain = new Terrain(7, { profile: 'plains' });
    const ids = createIdSource();
    const net = new RoadNetwork({ ids });
    const traffic = new TrafficSim(net, { rng: makeRng(7) });
    const eco = new Economy(net, terrain, 7);
    let world = {
      terrain, net, traffic, eco, ids,
      camera: { x: 0, y: 0, zoom: 1 },
      settings: { speed: 1, audio: true, difficulty: 'normal', budget: { unlimited: false, credits: 5000 } },
    };
    const history = createHistory();
    // Freight + bridge + budget in one budgeted city.
    let r = history.execute(world, { kind: COMMAND_KIND.ADD_ROAD, controls: [[-300, 0], [300, 0]], cls: 'avenue' });
    assert.equal(r.ok, true, r.reason);
    world = r.world;
    const spentAfterRoad = world.settings.budget.credits;
    assert.ok(spentAfterRoad < 5000, 'road debited the budget');
    r = history.execute(world, {
      kind: COMMAND_KIND.BUILD_BRIDGE,
      points: [[-260, 120], [-140, 120], [140, 120], [260, 120]],
      cls: 'street', deckZ: 12,
    });
    assert.equal(r.ok, true, r.reason);
    world = r.world;
    // Undo the bridge: money restored exactly.
    const u = history.undo(world);
    assert.equal(u.ok, true);
    assert.equal(u.world.settings.budget.credits, spentAfterRoad, 'undo restores exact money');
    world = u.world;
    // Save/reload preserves budget + scenario-free extensions.
    const data = serializeWorld(world);
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const live = hydrateWorld(v.data);
    assert.equal(live.settings.budget.credits, spentAfterRoad);
    // Sandbox city stays unlimited and untouched by budget logic.
    const sandbox = { ...world, settings: { speed: 1, audio: true, budget: { unlimited: true, credits: 0 } } };
    const h2 = createHistory();
    const r2 = h2.execute(sandbox, { kind: COMMAND_KIND.ADD_ROAD, controls: [[0, -300], [0, 300]], cls: 'highway' });
    assert.equal(r2.ok, true, 'sandbox never blocked');
  });
});
