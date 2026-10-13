// Automated playtest — drives the game in headless Chromium and captures
// screenshots + console errors. Run: node playtest.js
import { chromium } from 'playwright';

const shots = 'shots';
import { mkdirSync } from 'node:fs';
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:8080/?seed=1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${shots}/01-boot.png` });

// close help
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/02-map.png` });

// draw a road: click points, then Enter
const cx = 640, cy = 450;
await page.mouse.move(cx - 150, cy);
await page.waitForTimeout(100);
await page.mouse.click(cx - 150, cy);
await page.waitForTimeout(150);
await page.mouse.move(cx + 100, cy - 40);
await page.waitForTimeout(150);
await page.screenshot({ path: `${shots}/03-draft1.png` });
await page.mouse.click(cx + 100, cy - 40);
await page.waitForTimeout(150);
await page.mouse.move(cx + 300, cy + 60);
await page.waitForTimeout(150);
await page.screenshot({ path: `${shots}/04-draft2.png` });
await page.mouse.click(cx + 300, cy + 60);
await page.waitForTimeout(150);
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.screenshot({ path: `${shots}/05-road-built.png` });

// test roundabout hover preview (tool 4)
await page.keyboard.press('4');
await page.mouse.move(cx + 100, cy - 40);
await page.waitForTimeout(200);
await page.screenshot({ path: `${shots}/05b-roundabout-hover.png` });

// crossing road to test junction creation
await page.keyboard.press('1');
await page.mouse.click(cx - 100, cy + 200);
await page.mouse.click(cx + 50, cy - 20); // crosses the first road
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.screenshot({ path: `${shots}/06-crossing.png` });

// place a house near the road (tool 6)
await page.keyboard.press('6');
await page.mouse.move(cx - 100, cy - 80);
await page.waitForTimeout(150);
await page.screenshot({ path: `${shots}/06b-house-hover.png` });
await page.mouse.click(cx - 100, cy - 80);
await page.waitForTimeout(200);
await page.screenshot({ path: `${shots}/07-house.png` });

// place a shop (tool 7)
await page.keyboard.press('7');
await page.mouse.click(cx + 250, cy + 120);
await page.waitForTimeout(200);

// place a factory (tool 8)
await page.keyboard.press('8');
await page.mouse.click(cx - 250, cy + 150);
await page.waitForTimeout(200);
await page.screenshot({ path: `${shots}/08-buildings.png` });

// let traffic run 10 game-seconds, then screenshot cars
await page.keyboard.press('1'); // back to road tool
await page.waitForTimeout(10000);
await page.screenshot({ path: `${shots}/09-traffic.png` });

// select tool: click a house to inspect
await page.keyboard.press('0');
await page.mouse.click(cx - 100, cy - 80);
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/10-inspect.png` });

// zoom out with wheel
await page.mouse.move(cx, cy);
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(80); }
await page.waitForTimeout(500);
await page.screenshot({ path: `${shots}/11-zoomed-out.png` });

// run 20 more seconds at 3x speed for level up / traffic
await page.click('[data-speed="3"]');
await page.waitForTimeout(8000);
await page.screenshot({ path: `${shots}/12-later.png` });

// save
await page.click('#btnSave');
await page.waitForTimeout(400);

const hud = await page.evaluate(() => ({
  pop: document.getElementById('hPop').textContent,
  trips: document.getElementById('hTrips').textContent,
  level: document.getElementById('hLevel').textContent,
  cong: document.getElementById('hCong').textContent,
}));
console.log('HUD:', JSON.stringify(hud));
console.log('Console errors:', errors.length ? errors.join('\n') : 'NONE');
await browser.close();
if (errors.length) process.exit(1);
