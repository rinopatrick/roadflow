// Temporary capture: the undo/redo buttons in the top band, disabled and enabled.
import { startServer, launchGame, runDir, dismissHelp } from '../test/browser/harness.js';

const shots = runDir(process.env.RF_RUN_ID || 's031-' + Date.now());
const server = await startServer();
const game = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });
try {
  const { page } = game;
  await dismissHelp(page);
  await page.click('[data-speed="0"]');

  const spot = await page.evaluate(() => {
    const { renderer, state } = window.__rf;
    for (let r = 100; r <= 1500; r += 50) {
      for (let a = 0; a < 360; a += 15) {
        const x = Math.round(renderer.cam.x + Math.cos(a * Math.PI / 180) * r);
        const y = Math.round(renderer.cam.y + Math.sin(a * Math.PI / 180) * r);
        if (state.terrain.isRoadable(x, y) && state.terrain.isRoadable(x + 240, y)) return [x, y];
      }
    }
    return null;
  });
  const [sx, sy] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToCss(x, y), spot);
  const [ex, ey] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToCss(x + 240, y), spot);

  // Disabled state: no history yet.
  const before = await page.evaluate(() => ({
    undo: document.getElementById('undobtn').disabled,
    redo: document.getElementById('redobtn').disabled,
    hasIcons: !!document.getElementById('undobtn').querySelector('svg')
      && !!document.getElementById('redobtn').querySelector('svg'),
    undoLabel: document.getElementById('undobtn').getAttribute('aria-label'),
  }));
  console.log('fresh city:', JSON.stringify(before));
  await page.screenshot({ path: `${shots}/undo-disabled.png` });

  // Build, then undo: both buttons enabled.
  await page.keyboard.press('1');
  await page.mouse.click(sx, sy);
  await page.mouse.click(ex, ey);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__rf.state.net.edges.size > 0, null, { timeout: 10000 });
  await page.click('#undobtn');
  await page.waitForFunction(() => window.__rf.state.net.edges.size === 0, null, { timeout: 10000 });

  const after = await page.evaluate(() => ({
    undo: document.getElementById('undobtn').disabled,
    redo: document.getElementById('redobtn').disabled,
    depth: window.__rf.history.depth,
    canRedo: window.__rf.history.canRedo,
    speed: window.__rf.world.settings.speed,
  }));
  console.log('after undo:', JSON.stringify(after));
  await page.screenshot({ path: `${shots}/undo-both-enabled.png` });

  // The top band with both controls visible.
  const box = await page.locator('#topband').boundingBox();
  await page.screenshot({
    path: `${shots}/topband-crop.png`,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
  console.log('artifacts:', shots);
} finally {
  await game.close();
  await server.stop();
}
process.exit(0);
