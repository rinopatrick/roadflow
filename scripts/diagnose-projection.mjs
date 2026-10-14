// Temporary probe: verify the projection is DPR-correct through the renderer's
// PUBLIC surface, using matched units on each side of the round trip.
//
//   worldToCss  -> screenToWorld   both CSS pixels
//   worldToScreen -> deviceToCss -> screenToWorld   device, converted at the edge
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const probe = createServer();
const port = await new Promise(res => probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); }));
const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(base)).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 200));
}

const browser = await chromium.launch();
let worst = 0;
for (const dpr of [1, 2]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto(`${base}?seed=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__rf, null, { timeout: 20000 });
  await page.keyboard.press('Escape');

  const r = await page.evaluate(() => {
    const R = window.__rf.renderer;
    const v = R.view();
    const points = [[0, 0], [123.4, -567.8], [-1000, 2500]];
    const zooms = [0.12, 1, 5];
    const rows = [];
    for (const zoom of zooms) {
      R.cam.x = 37.5; R.cam.y = -120.25; R.cam.zoom = zoom;
      for (const [x, y] of points) {
        const css = R.worldToCss(x, y);
        const backCss = R.screenToWorld(css[0], css[1]);
        const dev = R.worldToScreen(x, y);
        const backDev = R.screenToWorld(dev[0] / v.dpr, dev[1] / v.dpr);
        rows.push({
          zoom, world: [x, y],
          cssError: +Math.hypot(backCss[0] - x, backCss[1] - y).toFixed(9),
          devError: +Math.hypot(backDev[0] - x, backDev[1] - y).toFixed(9),
          deviceIsCssTimesDpr: Math.abs(dev[0] - css[0] * v.dpr) < 1e-9
            && Math.abs(dev[1] - css[1] * v.dpr) < 1e-9,
        });
      }
    }
    return { dpr: window.devicePixelRatio, view: v, rows };
  });

  const worstHere = Math.max(...r.rows.flatMap(row => [row.cssError, row.devError]));
  worst = Math.max(worst, worstHere);
  const allScaled = r.rows.every(row => row.deviceIsCssTimesDpr);
  console.log(`\n=== DPR ${dpr} (view ${JSON.stringify(r.view)}) ===`);
  console.log(`  worst round-trip error: ${worstHere} wu   device == css * dpr: ${allScaled}`);
  for (const row of r.rows.slice(0, 3)) {
    console.log(`  zoom ${String(row.zoom).padEnd(5)} world ${JSON.stringify(row.world).padEnd(18)} `
      + `cssErr=${row.cssError} devErr=${row.devError}`);
  }
  await context.close();
}

await browser.close();
child.kill();
console.log(`\nworst error across all DPRs and zooms: ${worst} wu (target < 1e-6)`);
process.exit(0);
