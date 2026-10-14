// Browser smoke test — asserts real gameplay state changes through the UI.
//
// Run: npm run test:browser
//
// This is deliberately NOT named *.test.js so the unit glob
// (`node --test "test/**/*.test.js"`) stays browser-free and fast.
//
// Every assertion below reads gameplay state (graph, economy, storage) rather
// than trusting that a click "looked" successful.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, launchGame, runDir, worldState, dismissHelp,
} from './harness.js';

// Viewport centre for 1280x800. Canvas is full-window at origin, so screen
// coordinates map 1:1 to canvas offset coordinates at zoom 1.
const CX = 640;
const CY = 450;

const EXPECTED_TOOLS = [
  'road', 'avenue', 'highway', 'roundabout', 'light',
  'house', 'shop', 'factory', 'bulldoze', 'select',
];
const EXPECTED_SPEEDS = ['0', '1', '3', '8'];

let server;
let game;
let shots;

before(async () => {
  shots = runDir();
  server = await startServer();
  game = await launchGame({ baseUrl: server.baseUrl });
});

after(async () => {
  await game?.close();
  await server?.stop();
});

test('boot: canvas, tools and speed controls are present', async () => {
  const { page } = game;

  await page.screenshot({ path: `${shots}/01-boot.png` });
  await dismissHelp(page);

  const canvas = await page.evaluate(() => {
    const c = document.getElementById('game');
    return { w: c.width, h: c.height };
  });
  assert.ok(canvas.w > 0 && canvas.h > 0, `canvas must have nonzero size, got ${canvas.w}x${canvas.h}`);

  const tools = await page.$$eval('[data-tool]', els => els.map(e => e.dataset.tool));
  assert.deepEqual(tools, EXPECTED_TOOLS, `toolbar tools were: ${tools.join(', ')}`);

  const speeds = await page.$$eval('[data-speed]', els => els.map(e => e.dataset.speed));
  assert.deepEqual(speeds, EXPECTED_SPEEDS, `speed controls were: ${speeds.join(', ')}`);

  assert.equal(game.dialogs.length, 0, `unexpected dialog(s) on boot: ${game.dialogs.join(' | ')}`);
});

test('road action creates graph edges', async () => {
  const { page } = game;
  const before = await worldState(page);

  await page.keyboard.press('1'); // road tool
  await page.mouse.click(CX - 150, CY);
  await page.mouse.click(CX + 100, CY - 40);
  await page.mouse.click(CX + 300, CY + 60);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  const after = await worldState(page);
  assert.ok(after.edges > before.edges,
    `road action must add edges: ${before.edges} -> ${after.edges}`);
  assert.ok(after.nodes >= before.nodes,
    `road action must not remove nodes: ${before.nodes} -> ${after.nodes}`);

  await page.screenshot({ path: `${shots}/02-road.png` });
});

test('placing a house consumes exactly one house and adds residents', async () => {
  const { page } = game;
  const before = await worldState(page);

  await page.keyboard.press('6'); // house tool
  await page.mouse.click(CX - 100, CY - 80);
  await page.waitForTimeout(300);

  const after = await worldState(page);
  assert.equal(after.batch.house, before.batch.house - 1,
    `placing a house must consume one from the batch: ${before.batch.house} -> ${after.batch.house}`);
  assert.equal(after.pop, before.pop + 4,
    `a house holds 4 residents: population ${before.pop} -> ${after.pop}`);
});

test('rejected placement does not consume stock', async () => {
  const { page } = game;
  const before = await worldState(page);

  await page.keyboard.press('7'); // shop tool
  // Same point as the house: overlap must be rejected by the placement rules.
  await page.mouse.click(CX - 100, CY - 80);
  await page.waitForTimeout(300);

  const after = await worldState(page);
  assert.equal(after.batch.shop, before.batch.shop,
    `rejected shop placement must not consume stock: ${before.batch.shop} -> ${after.batch.shop}`);
  assert.equal(after.pop, before.pop, 'rejected placement must not change population');
});

test('save writes a parseable v1 snapshot', async () => {
  const { page } = game;

  await page.click('#btnSave');
  await page.waitForTimeout(300);

  const save = await page.evaluate(() => {
    const raw = localStorage.getItem('roadflow.save');
    if (!raw) return null;
    try {
      const d = JSON.parse(raw);
      return { v: d.v, edges: d.net?.edges?.length ?? 0, buildings: d.eco?.buildings?.length ?? 0 };
    } catch (e) {
      return { parseError: String(e) };
    }
  });

  assert.ok(save, 'save key "roadflow.save" must exist after clicking Save');
  assert.ok(!save.parseError, `save payload must parse: ${save.parseError}`);
  assert.equal(save.v, 1, 'save schema version must be 1');
  assert.ok(save.edges > 0, `saved network must contain edges, got ${save.edges}`);
  assert.ok(save.buildings > 0, `saved economy must contain buildings, got ${save.buildings}`);

  await page.screenshot({ path: `${shots}/03-saved.png` });
});

test('simulation clock honours pause and speed multipliers', async () => {
  const { page } = game;
  const readTime = () => page.evaluate(() => window.__rf.state.traffic.time);

  // Pause must freeze simulation time completely.
  await page.click('[data-speed="0"]');
  await page.waitForTimeout(200);
  const pausedAt = await readTime();
  await page.waitForTimeout(600);
  assert.equal(await readTime(), pausedAt, 'pause must freeze simulation time');

  // 1x advances at roughly wall-clock rate. Previously the loop incremented
  // traffic.time twice per frame, so it ran at about 2x.
  await page.click('[data-speed="1"]');
  const oneStart = await readTime();
  await page.waitForTimeout(1000);
  const oneDelta = (await readTime()) - oneStart;
  assert.ok(oneDelta > 0.5 && oneDelta < 1.6,
    `1x should advance about 1s per wall second, advanced ${oneDelta.toFixed(3)}`);

  // 8x must be substantially faster than 1x.
  await page.click('[data-speed="8"]');
  const fastStart = await readTime();
  await page.waitForTimeout(1000);
  const fastDelta = (await readTime()) - fastStart;
  assert.ok(fastDelta > oneDelta * 3,
    `8x must outpace 1x: ${fastDelta.toFixed(3)} vs ${oneDelta.toFixed(3)}`);

  // Restore normal speed for any later checks.
  await page.click('[data-speed="1"]');
});

test('graph and building IDs are deterministic, not random', async () => {
  // Regression guard for S01.1 follow-up: Economy.place() used uid()
  // (Math.random), so building IDs changed every run. Asserting the ID FORMAT
  // catches that path cheaply, without launching a second browser.
  const { page } = game;
  const ids = await page.evaluate(() => {
    const s = window.__rf.state;
    return {
      nodes: [...s.net.nodes.keys()],
      edges: [...s.net.edges.keys()],
      buildings: [...s.eco.buildings.keys()],
    };
  });

  assert.ok(ids.nodes.length > 0 && ids.edges.length > 0, 'world has a graph');
  assert.ok(ids.buildings.length > 0, 'world has buildings from earlier tests');

  assert.ok(ids.nodes.every(id => /^n\d+$/.test(id)),
    `node IDs must be sequential, got ${ids.nodes.slice(0, 4).join(', ')}`);
  assert.ok(ids.edges.every(id => /^e\d+$/.test(id)),
    `edge IDs must be sequential, got ${ids.edges.slice(0, 4).join(', ')}`);
  assert.ok(ids.buildings.every(id => /^b\d+$/.test(id)),
    `building IDs must be sequential, got ${ids.buildings.join(', ')}`);
});

test('HUD congestion agrees with the shared metric, with no rescaling fudge', async () => {
  const { page } = game;
  const report = await page.evaluate(async () => {
    const m = await import('/src/metrics.js');
    const s = window.__rf.state;
    const share = m.cityCongestion(s.net);
    return {
      hud: document.getElementById('hCong').textContent,
      expected: m.formatCongestion(share),
      share,
    };
  });
  assert.ok(report.share >= 0 && report.share <= 1,
    `city congestion must be a share in 0..1, got ${report.share}`);
  assert.equal(report.hud, report.expected,
    `HUD shows ${report.hud} but the metric says ${report.expected} `
    + '(the old HUD divided by 0.6 to hide a broken EMA)');
});

test('the drawn signal colour matches the phase the simulator obeys', async () => {
  const { page } = game;

  // Build a cross junction, install a light, and centre the camera on it so the
  // dot is not obscured by HUD panels.
  const setup = await page.evaluate(async () => {
    const s = window.__rf.state;
    const net = s.net;
    const r = window.__rf.renderer;
    net.addRoad([[-400, 0], [400, 0]], 'street');
    net.addRoad([[0, -400], [0, 400]], 'street');
    const junction = [...net.nodes.values()].find(n => n.edges.size === 4);
    junction.type = 'light';
    junction.light = { cycle: 20, offset: 0, greenRatio: 0.4, axis: 'x' };
    r.cam.x = junction.x;
    r.cam.y = junction.y;
    r.cam.zoom = 2;
    return { id: junction.id, x: junction.x, y: junction.y };
  });

  // Freeze time so the drawn frame and the expected phase are computed from the
  // same clock value.
  await page.click('[data-speed="0"]');

  const PHASE_COLOURS = {
    green: [0x3f, 0xae, 0x5a],
    yellow: [0xe8, 0xb9, 0x3f],
    allRed: [0xe2, 0x57, 0x4c],
  };

  /** Samples the pixel at the junction centre and classifies it. */
  const sampleAt = (t) => page.evaluate(([simTime, colours, nodeId]) => {
    const s = window.__rf.state;
    const r = window.__rf.renderer;
    s.traffic.time = simTime;
    const node = s.net.nodes.get(nodeId);
    const [sx, sy] = r.worldToScreen(node.x, node.y);
    const px = r.ctx.getImageData(Math.round(sx), Math.round(sy), 1, 1).data;
    return { rgb: [px[0], px[1], px[2]], colours };
  }, [t, PHASE_COLOURS, setup.id]);

  const classify = (rgb) => {
    let best = null;
    for (const [name, c] of Object.entries(PHASE_COLOURS)) {
      const d = Math.hypot(rgb[0] - c[0], rgb[1] - c[1], rgb[2] - c[2]);
      if (!best || d < best.d) best = { name, d };
    }
    return best;
  };

  // Cycle 20 / ratio 0.4 => green 0-4, yellow 4-6, allRed 6-10 on axis x.
  const cases = [
    { t: 1.0, expect: 'green' },
    { t: 5.0, expect: 'yellow' },
    { t: 8.0, expect: 'allRed' },
    { t: 11.0, expect: 'allRed' }, // axis y is green, so the x dot is red
  ];

  for (const { t, expect } of cases) {
    const { rgb } = await sampleAt(t);
    await page.waitForTimeout(120); // let the rAF loop repaint
    const fresh = await sampleAt(t);
    const verdict = classify(fresh.rgb);
    assert.ok(verdict.d < 40,
      `t=${t}: sampled rgb ${rgb.join(',')} is not a signal colour`);
    assert.equal(verdict.name, expect,
      `t=${t}: expected the dot to be ${expect}, sampled ${verdict.name} (rgb ${fresh.rgb.join(',')})`);
  }

  await page.click('[data-speed="1"]');
});

test('bulldozing a building via its driveway refunds the correct type', async () => {
  const { page } = game;

  // Place a shop through the real UI, then bulldoze its ACCESS NODE (not the
  // building itself). That is the branch that used to hard-code 'house':
  //   eco.batch[eco.buildings.get ? 'house' : 'house']++
  // which always evaluated to 'house', so demolishing a shop or factory
  // refunded a house.
  await page.evaluate(() => {
    const s = window.__rf.state;
    s.net.addRoad([[-400, 0], [400, 0]], 'street');
    s.eco.batch.shop = 3;
    s.eco.batch.house = 5;
  });

  await page.keyboard.press('7'); // shop tool
  const target = await page.evaluate(() => {
    const r = window.__rf.renderer;
    const dpr = r._dpr;
    const toCss = (x, y) => [
      ((x - r.cam.x) * r.cam.zoom * dpr + r.canvas.width / 2) / dpr,
      ((y - r.cam.y) * r.cam.zoom * dpr + r.canvas.height / 2) / dpr,
    ];
    const [sx, sy] = toCss(120, 70);
    return { sx, sy };
  });
  await page.mouse.click(target.sx, target.sy);
  await page.waitForTimeout(250);

  const afterPlace = await page.evaluate(() => {
    const s = window.__rf.state;
    const shop = [...s.eco.buildings.values()].find(b => b.type === 'shop');
    if (!shop) return null;
    const node = s.net.nodes.get(shop.drivewayNode);
    return {
      shopId: shop.id,
      batch: { ...s.eco.batch },
      nodeWorld: node ? { x: node.x, y: node.y } : null,
    };
  });
  assert.ok(afterPlace, 'the shop was placed');
  assert.ok(afterPlace.nodeWorld, 'the shop has an access node');
  assert.equal(afterPlace.batch.shop, 2, 'placing consumed one shop');

  // Now bulldoze the access node.
  await page.keyboard.press('9'); // bulldoze tool
  const nodeScreen = await page.evaluate(([wx, wy]) => {
    const r = window.__rf.renderer;
    const dpr = r._dpr;
    return [
      ((wx - r.cam.x) * r.cam.zoom * dpr + r.canvas.width / 2) / dpr,
      ((wy - r.cam.y) * r.cam.zoom * dpr + r.canvas.height / 2) / dpr,
    ];
  }, [afterPlace.nodeWorld.x, afterPlace.nodeWorld.y]);
  await page.mouse.click(nodeScreen[0], nodeScreen[1]);
  await page.waitForTimeout(250);

  const afterBulldoze = await page.evaluate((shopId) => {
    const s = window.__rf.state;
    return {
      batch: { ...s.eco.batch },
      shopGone: !s.eco.buildings.has(shopId),
      buildings: [...s.eco.buildings.values()].map(b => b.type),
    };
  }, afterPlace.shopId);

  assert.equal(afterBulldoze.shopGone, true, 'the shop was demolished');
  assert.equal(afterBulldoze.buildings.includes('shop'), false,
    'no shop remains in the economy');
  assert.equal(afterBulldoze.batch.shop, 3,
    `demolishing a shop must refund a SHOP, got batch.shop=${afterBulldoze.batch.shop}`);
  assert.equal(afterBulldoze.batch.house, 5,
    `demolishing a shop must not refund a house, got batch.house=${afterBulldoze.batch.house}`);
});

test('no console, page or request errors occurred', async () => {
  assert.deepEqual(game.errors, [], `browser errors:\n  ${game.errors.join('\n  ')}`);
  console.log(`browser artifacts: ${shots}`);
});
