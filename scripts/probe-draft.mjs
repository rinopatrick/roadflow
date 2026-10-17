// Temporary capture: the road draft preview with its length badge.
import { startServer, launchGame, runDir, dismissHelp } from '../test/browser/harness.js';

const shots = runDir(process.env.RF_RUN_ID || 's032-' + Date.now());
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
        if (state.terrain.isRoadable(x, y) && state.terrain.isRoadable(x + 200, y)
          && state.terrain.isRoadable(x + 100, y - 90)) return [x, y];
      }
    }
    return null;
  });
  const [ax, ay] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToCss(x, y), spot);
  const [bx, by] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToCss(x + 100, y - 90), spot);
  const [cx, cy] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToCss(x + 200, y), spot);

  await page.keyboard.press('2'); // avenue
  await page.mouse.click(ax, ay);
  await page.mouse.click(bx, by);
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(250);

  const rec = await page.evaluate(() => {
    const r = window.__rf.draftRecord;
    return r ? { ok: r.ok, length: Math.round(r.length), reason: r.reason, pts: r.polyline.length } : null;
  });
  console.log('draft record:', JSON.stringify(rec));
  await page.screenshot({ path: `${shots}/draft-valid.png` });

  // Now an invalid draft: into a point the terrain refuses.
  const bad = await page.evaluate(() => {
    const { renderer, state } = window.__rf;
    const t = state.terrain;
    for (let r = 200; r <= 1800; r += 40) {
      for (let a = 0; a < 360; a += 10) {
        const x = Math.round(renderer.cam.x + Math.cos(a * Math.PI / 180) * r);
        const y = Math.round(renderer.cam.y + Math.sin(a * Math.PI / 180) * r);
        if (!t.isRoadable(x, y)) return [x, y];
      }
    }
    return null;
  });
  if (bad) {
    await page.evaluate(([x, y]) => {
      const r = window.__rf.renderer;
      r.cam.x = x; r.cam.y = y; r.cam.zoom = 1;
    }, bad);
    await page.waitForTimeout(150);
    const [gx, gy] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToCss(x, y),
      [bad[0] - 180, bad[1]]);
    const [dx, dy] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToCss(x, y), bad);
    await page.keyboard.press('1');
    await page.mouse.click(gx, gy);
    await page.mouse.move(dx, dy);
    await page.waitForTimeout(250);
    const badRec = await page.evaluate(() => {
      const r = window.__rf.draftRecord;
      return r ? { ok: r.ok, reason: r.reason, failAt: r.failAt } : null;
    });
    console.log('invalid draft:', JSON.stringify(badRec));
    await page.screenshot({ path: `${shots}/draft-invalid.png` });
  }

  console.log('artifacts:', shots);
} finally {
  await game.close();
  await server.stop();
}
process.exit(0);
