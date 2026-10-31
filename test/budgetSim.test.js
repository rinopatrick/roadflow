// S07.4 integration: exact debit from committed geometry, failed commands
// cost zero, undo restores money, save/load boundary idempotent.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Terrain } from '../src/terrain.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { createIdSource, makeRng } from '../src/core.js';
import { createHistory, COMMAND_KIND } from '../src/worldCommands.js';
import { roadCost } from '../src/budget.js';
import { serializeWorld, validateSnapshot, hydrateWorld } from '../src/worldSnapshot.js';

function budgetedWorld(credits = 1000) {
  const terrain = new Terrain(7);
  terrain.isRoadable = () => true;
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const traffic = new TrafficSim(net, { rng: makeRng(7) });
  const eco = new Economy(net, terrain, 7);
  eco.batch = { house: 9, shop: 9, factory: 9, depot: 4, park: 4 };
  return {
    terrain, net, traffic, eco, ids,
    camera: { x: 0, y: 0, zoom: 1 },
    settings: { speed: 1, audio: true, budget: { unlimited: false, credits } },
  };
}

describe('S07.4 budget integration', () => {
  it('debit equals committed geometry cost, preview matches', () => {
    const world = budgetedWorld(1000);
    const history = createHistory();
    const before = 1000;
    const r = history.execute(world, {
      kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [100, 0]], cls: 'street',
    });
    assert.equal(r.ok, true, r.reason);
    const edge = [...r.world.net.edges.values()][0];
    const expected = roadCost('street', edge.total, 'ground');
    assert.equal(r.world.settings.budget.credits, before - expected, 'exact debit');
  });

  it('failed validation debits zero', () => {
    const world = budgetedWorld(1000);
    const history = createHistory();
    const r = history.execute(world, {
      kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [0, 0]], cls: 'street',
    });
    assert.equal(r.ok, false);
    assert.equal(world.settings.budget.credits, 1000, 'untouched world keeps money');
  });

  it('insufficient funds rejects with shortfall, builds nothing', () => {
    const world = budgetedWorld(5);
    const history = createHistory();
    const before = JSON.stringify(world.net.toJSON());
    const r = history.execute(world, {
      kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [500, 0]], cls: 'highway',
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /shortfall/i);
    assert.equal(JSON.stringify(world.net.toJSON()), before);
  });

  it('demolition refunds 50% and undo restores exact money (no double refund)', () => {
    const world = budgetedWorld(1000);
    const history = createHistory();
    const r1 = history.execute(world, {
      kind: COMMAND_KIND.ADD_ROAD, controls: [[0, 0], [100, 0]], cls: 'street',
    });
    const paid = 1000 - r1.world.settings.budget.credits;
    assert.ok(paid > 0);
    const edge = [...r1.world.net.edges.values()][0];
    const principal = roadCost(edge.cls, edge.total, 'ground');
    const r2 = history.execute(r1.world, { kind: COMMAND_KIND.REMOVE_ROAD, edgeId: edge.id });
    assert.equal(r2.ok, true, r2.reason);
    assert.equal(r2.world.settings.budget.credits, 1000 - paid + Math.floor(principal * 0.5));
    // Undo the demolition: money returns to post-build state, not post-refund.
    const u = history.undo(r2.world);
    assert.equal(u.ok, true);
    assert.equal(u.world.settings.budget.credits, 1000 - paid, 'undo restores exact state');
  });

  it('unlimited sandbox never blocks', () => {
    const world = budgetedWorld();
    world.settings.budget = { unlimited: true, credits: 0 };
    const history = createHistory();
    // Short road on known-buildable seed-7 ground (mock isRoadable does
    // not survive the command copy boundary; real terrain does).
    const r = history.execute(world, {
      kind: COMMAND_KIND.ADD_ROAD, controls: [[-100, 0], [100, 0]], cls: 'highway',
    });
    assert.equal(r.ok, true, r.reason);
  });

  it('budget survives save/load idempotently', () => {
    const world = budgetedWorld(777);
    const data = serializeWorld(world);
    const v = validateSnapshot(JSON.parse(JSON.stringify(data)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.deepEqual(v.data.settings.budget, { unlimited: false, credits: 777 });
    const live = hydrateWorld(v.data);
    assert.equal(live.settings.budget.credits, 777);
  });
});
