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

test('no console, page or request errors occurred', async () => {
  assert.deepEqual(game.errors, [], `browser errors:\n  ${game.errors.join('\n  ')}`);
  console.log(`browser artifacts: ${shots}`);
});
