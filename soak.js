// Economy soak test — runs a small city long enough to prove trips actually
// complete and XP actually accrues.
//
// Run: npm run test:soak            (90 simulated seconds at 3x)
//      SOAK_SECONDS=30 node soak.js (shorter run for a quick check)
//
// Unlike the original script, this exits nonzero when the city fails to move
// traffic. "No console errors" alone is not evidence that the game works.
import assert from 'node:assert/strict';
import {
  startServer, launchGame, runDir, worldState, hudState, vehicleState, dismissHelp,
} from './test/browser/harness.js';

const shots = runDir(process.env.RF_RUN_ID || `soak-${Date.now()}`);
const soakSeconds = Number(process.env.SOAK_SECONDS ?? 90);
const SAMPLE_MS = 15000;

// The fixture is expressed in WORLD units and converted through worldToScreen.
//
// It used to be raw screen pixels derived from the canvas centre, which made it
// silently depend on the height of the bottom dock: when S02.2 made the dock
// taller, the factory click landed on a dock button instead of the map, the
// factory was never placed, and the soak quietly produced half the trips. It
// still passed, because nothing asserted the factory existed.
const FIXTURE = {
  loop: [[-250, 30], [150, 30], [150, 150], [-250, 150], [-250, 30]],
  houses: [[-150, -30], [50, -30]],
  shop: [[250, 120]],
  factory: [[-150, 190]],
};

const server = await startServer();
const game = await launchGame({ baseUrl: server.baseUrl });

let failure = null;
try {
  const { page } = game;
  await dismissHelp(page);

  /**
   * Clicks a world point through the canvas.
   *
   * Refuses to click when the point is covered by interface chrome, so a layout
   * change can never again turn a fixture click into a no-op that still passes.
   */
  async function clickWorld(label, wx, wy) {
    const [sx, sy] = await page.evaluate(([x, y]) => window.__rf.renderer.worldToScreen(x, y), [wx, wy]);
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? (el.id || el.tagName.toLowerCase()) : 'none';
    }, [sx, sy]);
    assert.equal(hit, 'game',
      `${label}: fixture point ${JSON.stringify([wx, wy])} maps to screen (${Math.round(sx)}, ${Math.round(sy)}), `
      + `which is covered by "${hit}" instead of the map. Move the fixture point or the panel.`);
    await page.mouse.click(sx, sy);
  }

  // A closed loop gives cars a real return path.
  for (let i = 0; i < FIXTURE.loop.length - 1; i++) {
    await clickWorld(`loop point ${i + 1}`, ...FIXTURE.loop[i]);
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  await page.keyboard.press('6'); // houses
  for (const [i, p] of FIXTURE.houses.entries()) await clickWorld(`house ${i + 1}`, ...p);
  await page.keyboard.press('7'); // shop
  for (const [i, p] of FIXTURE.shop.entries()) await clickWorld(`shop ${i + 1}`, ...p);
  await page.keyboard.press('8'); // factory
  for (const [i, p] of FIXTURE.factory.entries()) await clickWorld(`factory ${i + 1}`, ...p);
  await page.waitForTimeout(300);

  const placed = await worldState(page);
  assert.ok(placed.batch.house < 4, `soak fixture must place houses, batch.house=${placed.batch.house}`);
  assert.ok(placed.batch.shop < 2, `soak fixture must place a shop, batch.shop=${placed.batch.shop}`);
  // Without the factory the houses have nowhere to work, the trip count halves,
  // and the soak still passes. Assert the whole fixture, not most of it.
  assert.ok(placed.batch.factory < 1,
    `soak fixture must place the factory, batch.factory=${placed.batch.factory} (a covered click would leave this at 1)`);
  assert.ok(placed.edges > 0, `soak fixture must build a loop, edges=${placed.edges}`);
  await page.screenshot({ path: `${shots}/01-built.png` });

  await page.click('[data-speed="3"]');

  let maxCars = 0;
  let samples = 0;
  for (let elapsed = 0; elapsed < soakSeconds * 1000; elapsed += SAMPLE_MS) {
    await page.waitForTimeout(SAMPLE_MS);
    samples++;

    const hud = await hudState(page);
    const world = await worldState(page);
    maxCars = Math.max(maxCars, world.cars);
    console.log(`t+${Math.round((elapsed + SAMPLE_MS) / 1000)}s:`, JSON.stringify({ ...hud, cars: world.cars }));

    const vehicles = await vehicleState(page);
    const bad = vehicles.filter(v => ![v.x, v.y, v.s, v.speed].every(Number.isFinite));
    assert.equal(bad.length, 0,
      `non-finite vehicle state at t+${(elapsed + SAMPLE_MS) / 1000}s: ${JSON.stringify(bad.slice(0, 3))}`);
    const backwards = vehicles.filter(v => v.speed < 0);
    assert.equal(backwards.length, 0,
      `negative vehicle speed at t+${(elapsed + SAMPLE_MS) / 1000}s: ${JSON.stringify(backwards.slice(0, 3))}`);
  }

  const finalHud = await hudState(page);
  const finalWorld = await worldState(page);
  await page.screenshot({ path: `${shots}/02-after.png` });

  assert.ok(samples > 0, 'soak must take at least one sample');
  assert.ok(maxCars > 0, 'soak city must actually spawn vehicles');
  assert.ok(finalWorld.trips >= 1, `soak city must complete at least one trip, got ${finalWorld.trips}`);
  assert.equal(Number(finalHud.trips), finalWorld.trips, 'HUD trip count must match economy state');
  assert.ok(finalHud.xpPercent > 0, `completed trips must grant XP, bar width=${finalHud.xpPercent}%`);
  assert.equal(game.dialogs.length, 0, `unexpected dialog(s): ${game.dialogs.join(' | ')}`);
  assert.deepEqual(game.errors, [], `browser errors:\n  ${game.errors.join('\n  ')}`);

  console.log(`FINAL: ${JSON.stringify({ ...finalHud, cars: finalWorld.cars, trips: finalWorld.trips })}`);
  console.log(`soak artifacts: ${shots}`);
} catch (err) {
  failure = err;
} finally {
  await game.close();
  await server.stop();
}

if (failure) {
  console.error(`\nSOAK FAILED: ${failure.message}\nartifacts: ${shots}`);
  process.exitCode = 1;
}
