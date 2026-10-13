# Executable regression recipes for the first fixes

These tests use the **current** module APIs observed during planning. They are proposed test source, not installed tests. During the owning task, add the relevant test to the named existing/new test file and run it before modifying production code. Do not add all five as unexplained failing tests to a normal development branch.

For each recipe, imports assume the file is directly under `test/`. Each block is standalone. Expected old behavior below comes from observed probes or source-derived formula, not claimed future test results.

## R1 — Return dispatch uses access-node IDs (S01.2)

Add to `test/economy.test.js`, reuse imports there instead of duplicating them.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';

test('pending return dispatch resolves current building access nodes', () => {
  const net = new RoadNetwork();
  net.addRoad([[0, 0], [600, 0]]);
  const eco = new Economy(net, { isBuildable: () => true }, 7);
  const home = eco.place('house', 100, 60);
  const shop = eco.place('shop', 400, 60);
  assert.ok(home && shop);
  eco._completeTrip({ id: 'outbound-probe' }, shop.id, home.id);
  const calls = [];
  eco.processReturns(100, (from, to) => {
    calls.push([from, to]);
    return { id: 'return-probe' };
  });
  assert.deepEqual(calls, [[shop.drivewayNode, home.drivewayNode]]);
  assert.ok(calls[0].every(id => net.nodes.has(id)));
  assert.equal(eco.totalTrips, 1, 'return dispatch must not add service XP');
});
```

Run `node --test test/economy.test.js`. Before fix: expected/actual IDs differ; callback receives IDs absent from net.nodes. Also add real outward→dwell→return integration; this callback test alone does not prove arrivals.

## R2 — Every lane fits the pavement (S01.3)

Initially add to `test/roadNetwork.test.js`. Once roadDimensions owns dimensions, replace only the legacy halfWidth lookup with its return value; retain assertion.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork, ROAD_CLASS } from '../src/roadNetwork.js';

test('vehicle envelope stays inside every preset road surface', () => {
  const net = new RoadNetwork();
  const halfCarWidth = 1.8;
  for (const [cls, profile] of Object.entries(ROAD_CLASS)) {
    for (let lane = 0; lane < profile.lanesPerDir; lane++) {
      const outer = net.laneOffset({ cls }, lane) + halfCarWidth;
      assert.ok(outer <= profile.width / 2,
        `${cls} lane ${lane}: vehicle outer ${outer}, pavement ${profile.width / 2}`);
    }
  }
});
```

Run `node --test test/roadNetwork.test.js`. Before fix: street already fails5.65>5.5; avenue/highway have larger errors. After migration expand for asymmetric/one-way profiles and signed offsets; do not retain obsolete ROAD_CLASS width merely to satisfy this test.

## R3 — Stopped traffic approaches full congestion (S01.4)

Add `test/congestion.test.js`. This isolates metrics by holding desired speed at zero; car-following and signal behavior are tested elsewhere.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim } from '../src/traffic.js';

function stoppedCongestion(dt) {
  const net = new RoadNetwork();
  const built = net.addRoad([[0, 0], [600, 0]]);
  const edge = net.edges.get(built.edgeIds[0]);
  const sim = new TrafficSim(net);
  const car = sim.spawn(edge.a, edge.b);
  assert.ok(car);
  sim._desiredSpeed = () => 0;
  for (let i = 0; i < Math.round(60 / dt); i++) sim.update(dt);
  assert.equal(sim.cars.size, 1, 'stopped fixture must retain car');
  return edge._congestion;
}

test('stopped share converges to one independently of timestep', () => {
  const a = stoppedCongestion(1 / 60);
  const b = stoppedCongestion(1 / 30);
  assert.ok(a > 0.99 && a <= 1, `60Hz result ${a}`);
  assert.ok(b > 0.99 && b <= 1, `30Hz result ${b}`);
  assert.ok(Math.abs(a - b) < 1e-6, `${a} versus ${b}`);
});
```

Before fix formula tends.05 at60Hz and.10 at30Hz. After fix retain same simulated duration and tau5s, not number-of-frames smoothing.

## R4 — End of half-cycle is not unrestricted green (S01.4)

Add to `test/traffic.test.js`. New contract assigns t6 all-red for cycle14/ratio.42; old code returns free passage.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { TrafficSim } from '../src/traffic.js';

test('legacy signal holds a car in the all-red clearance interval', () => {
  const net = new RoadNetwork();
  net.addRoad([[-100, 0], [100, 0]]);
  net.addRoad([[0, -100], [0, 100]]);
  const node = [...net.nodes.values()].find(n => n.edges.size === 4);
  assert.ok(node);
  node.type = 'light';
  node.light = { cycle: 14, greenRatio: 0.42, offset: 0, axis: 'x' };
  const edge = [...node.edges].map(id => net.edges.get(id)).find(e => {
    const outer = net.nodes.get(e.a === node.id ? e.b : e.a);
    return outer.x < -50;
  });
  assert.ok(edge);
  const from = edge.a === node.id ? edge.b : edge.a;
  const step = { edgeId: edge.id, from, to: node.id, dir: edge.a === from ? 1 : -1, lane: 0 };
  const car = { s: 0, currentStep: () => step };
  const sim = new TrafficSim(net);
  sim.time = 6;
  assert.notEqual(sim._mustYield(car, edge, node, false, null), null);
});
```

Once movement phases replace legacy signal logic, keep the legacy migration test and replace private-method check with shared phase API plus full vehicle crossing test. Don't test renderer's independent formula; it must use the shared function.

## R5 — Eight crossings do not silently truncate to six (S01.5)

Add to `test/roadNetwork.test.js`.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';

test('one road across eight existing roads creates eight junctions', () => {
  const net = new RoadNetwork();
  for (let i = 0; i < 8; i++) {
    net.addRoad([[i * 100, -100], [i * 100, 100]]);
  }
  net.addRoad([[-100, 0], [800, 0]]);
  const junctions = [...net.nodes.values()].filter(n => n.edges.size === 4);
  assert.equal(junctions.length, 8);
  assert.deepEqual(junctions.map(n => Math.round(n.x)).sort((a, b) => a - b),
    [0, 100, 200, 300, 400, 500, 600, 700]);
  for (const edge of net.edges.values()) {
    assert.ok(net.nodes.get(edge.a)?.edges.has(edge.id));
    assert.ok(net.nodes.get(edge.b)?.edges.has(edge.id));
  }
});
```

Before fix observed6junctions. After fix also assert failed collinear/degenerate construction leaves a full snapshot unchanged. Raising hard limit from6to100 without termination/atomicity reasoning is not the planned correction.

## Usage discipline

The recipes target current symbols, some private. Public behavioral integration is still required before marking a task done. If preceding tasks legitimately changed a symbol, adapt the fixture to the approved contract and preserve the same bug-triggering behavior; do not copy tests blindly until they pass on a different condition.
