// Temporary capture: building silhouettes, close up, at the three types.
import { startServer, launchGame, runDir, dismissHelp } from '../test/browser/harness.js';

const shots = runDir(process.env.RF_RUN_ID || 'buildings-' + Date.now());
const server = await startServer();
const game = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 }, seed: 7 });

try {
  const { page } = game;
  await dismissHelp(page);
  await page.click('[data-speed="0"]');

  // Build a road and place one of each type beside it, then frame them.
  await page.keyboard.press('2');
  for (const [x, y] of [[-300, 0], [300, 0]]) {
    const [sx, sy] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToScreen(x, y), [x, y]);
    await page.mouse.click(sx, sy);
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  const spots = [['house', -260, -110], ['shop', -60, -110], ['factory', 160, -110]];
  let placed = 0;
  for (const [type, x, y] of spots) {
    await page.keyboard.press(type === 'house' ? '6' : type === 'shop' ? '7' : '8');
    const [sx, sy] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToScreen(x, y), [x, y]);
    await page.mouse.click(sx, sy);
    await page.waitForTimeout(150);
    placed++;
  }

  const n = await page.evaluate(() => window.__rf.state.eco.buildings.size);
  console.log('placed:', n, 'of', placed);

  // Place a SECOND set to get more variants visible (variant comes from the id).
  for (const [type, x, y] of [['house', 240, -110], ['shop', 240, 130], ['house', -60, 130]]) {
    await page.keyboard.press(type === 'house' ? '6' : type === 'shop' ? '7' : '8');
    const [sx, sy] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToScreen(x, y), [x, y]);
    await page.mouse.click(sx, sy);
    await page.waitForTimeout(150);
  }
  console.log('placed total:', await page.evaluate(() => window.__rf.state.eco.buildings.size));

  await page.evaluate(() => {
    const r = window.__rf.renderer;
    r.cam.x = 0; r.cam.y = 20; r.cam.zoom = 2.2;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/buildings-close-zoom2.2.png` });

  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 0.7; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/buildings-zoom0.7.png` });

  const variants = await page.evaluate(() => window.__rf.buildingVariant);
  const list = await page.evaluate(() =>
    [...window.__rf.state.eco.buildings.values()].map(b => ({ id: b.id, type: b.type, v: window.__rf.buildingVariant(b.id) })));
  console.log('variants:', JSON.stringify(list));
  console.log('artifacts:', shots);
} finally {
  await game.close();
  await server.stop();
}
process.exit(0);
