// Temporary capture: terrain presentation at three zooms, plus the stats that
// prove the chunking is actually working (tiles generated, cache bounded).
import { startServer, launchGame, runDir, dismissHelp } from '../test/browser/harness.js';

const shots = runDir(process.env.RF_RUN_ID || 'terrain-' + Date.now());
const server = await startServer();
const game = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });

try {
  const { page } = game;
  await dismissHelp(page);
  await page.click('[data-speed="0"]');

  const rows = [];
  for (const zoom of [0.4, 1, 3]) {
    await page.evaluate((z) => { window.__rf.renderer.cam.zoom = z; }, zoom);
    await page.waitForTimeout(350);
    const stats = await page.evaluate(() => window.__rf.terrainStats);
    await page.screenshot({ path: `${shots}/terrain-zoom${zoom}.png` });
    rows.push({ zoom, ...stats });
    console.log(`zoom ${String(zoom).padEnd(4)} tiles=${stats.tiles} generated=${stats.generated} `
      + `cache=${stats.cacheSize}/${stats.cacheMax} detail=${stats.detail} cost=${stats.ms.toFixed(1)}ms`);
  }

  // Pan across the map: the cache must stay bounded, not grow without limit.
  let worstCache = 0;
  for (let i = 0; i < 14; i++) {
    await page.evaluate((i) => {
      const r = window.__rf.renderer;
      const a = i * 0.9;
      r.cam.x = Math.cos(a) * 2000;
      r.cam.y = Math.sin(a) * 2000;
    }, i);
    await page.waitForTimeout(140);
    const s = await page.evaluate(() => window.__rf.terrainStats);
    worstCache = Math.max(worstCache, s.cacheSize);
    if (s.cacheSize > s.cacheMax) throw new Error(`cache exceeded bound: ${s.cacheSize}/${s.cacheMax}`);
  }
  console.log(`after a 14-step pan sweep: worst cache occupancy ${worstCache} (bound ${rows[0].cacheMax})`);

  // A zoom-out-in cycle must not re-generate tiles it already has.
  await page.evaluate(() => { window.__rf.renderer.cam.x = 0; window.__rf.renderer.cam.y = 0; });
  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 3; });
  await page.waitForTimeout(200);
  const first = await page.evaluate(() => window.__rf.terrainStats);
  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 1; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 3; });
  await page.waitForTimeout(200);
  const again = await page.evaluate(() => window.__rf.terrainStats);
  console.log(`zoom 3 -> 1 -> 3: generated first pass ${first.generated}, after returning ${again.generated} `
    + `(should be 0 on the second visit while cached)`);

  console.log('artifacts:', shots);
} finally {
  await game.close();
  await server.stop();
}
process.exit(0);
