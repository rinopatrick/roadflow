// Visual capture tour — drives the game through its main screens and saves
// screenshots for human review.
//
// Run: node playtest.js
//      RF_RUN_ID=baseline node playtest.js   (named, reproducible artifact dir)
//
// Assertions live in test/browser/smoke.js. This script's job is the picture
// tour, but it still exits nonzero on browser errors so a broken build cannot
// masquerade as a successful capture run.
import {
  startServer, launchGame, runDir, hudState, dismissHelp,
} from './test/browser/harness.js';

const shots = runDir(process.env.RF_RUN_ID || `playtest-${Date.now()}`);
const CX = 640, CY = 450;

const server = await startServer();
const game = await launchGame({ baseUrl: server.baseUrl });

try {
  const { page } = game;

  await page.screenshot({ path: `${shots}/01-boot.png` });
  await dismissHelp(page);
  await page.screenshot({ path: `${shots}/02-map.png` });

  // Road draft: click points, then Enter to finish.
  await page.keyboard.press('1');
  await page.mouse.move(CX - 150, CY);
  await page.mouse.click(CX - 150, CY);
  await page.mouse.move(CX + 100, CY - 40);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${shots}/03-draft1.png` });
  await page.mouse.click(CX + 100, CY - 40);
  await page.mouse.move(CX + 300, CY + 60);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${shots}/04-draft2.png` });
  await page.mouse.click(CX + 300, CY + 60);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/05-road-built.png` });

  // Roundabout hover preview.
  await page.keyboard.press('4');
  await page.mouse.move(CX + 100, CY - 40);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${shots}/06-roundabout-hover.png` });

  // Crossing road, to show automatic junction creation.
  await page.keyboard.press('1');
  await page.mouse.click(CX - 100, CY + 200);
  await page.mouse.click(CX + 50, CY - 20);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/07-crossing.png` });

  // Buildings.
  await page.keyboard.press('6');
  await page.mouse.move(CX - 100, CY - 80);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${shots}/08-house-hover.png` });
  await page.mouse.click(CX - 100, CY - 80);
  await page.waitForTimeout(200);
  await page.keyboard.press('7');
  await page.mouse.click(CX + 250, CY + 120);
  await page.waitForTimeout(200);
  await page.keyboard.press('8');
  await page.mouse.click(CX - 250, CY + 150);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${shots}/09-buildings.png` });

  // Let traffic run, then capture moving vehicles.
  await page.keyboard.press('1');
  await page.waitForTimeout(10000);
  await page.screenshot({ path: `${shots}/10-traffic.png` });

  // Inspect a building.
  await page.keyboard.press('0');
  await page.mouse.click(CX - 100, CY - 80);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/11-inspect.png` });

  // Zoom OUT: positive wheel delta reduces zoom (see main.js wheel handler).
  await page.mouse.move(CX, CY);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(80); }
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/12-zoomed-out.png` });

  // Faster speed for a busier frame.
  await page.click('[data-speed="3"]');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${shots}/13-later.png` });

  await page.click('#btnSave');
  await page.waitForTimeout(400);

  console.log('HUD:', JSON.stringify(await hudState(page)));
  console.log(`playtest artifacts: ${shots}`);

  if (game.errors.length) {
    console.error('Browser errors:\n' + game.errors.join('\n'));
    process.exitCode = 1;
  }
} finally {
  await game.close();
  await server.stop();
}
