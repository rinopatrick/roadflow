// Long soak: verify trips complete, XP accrues, level-ups fire.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('shots', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:8080/?seed=1', { waitUntil: 'networkidle' });
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// build a loop road network
const cx = 640, cy = 430;
await page.mouse.click(cx - 250, cy);
await page.mouse.click(cx + 150, cy);
await page.mouse.click(cx + 150, cy + 180);
await page.mouse.click(cx - 250, cy + 180);
await page.mouse.click(cx - 250, cy); // closes the loop
await page.keyboard.press('Enter');
await page.waitForTimeout(300);

// buildings: 2 houses, 1 shop, 1 factory
await page.keyboard.press('6');
await page.mouse.click(cx - 150, cy - 60);
await page.mouse.click(cx + 50, cy - 60);
await page.keyboard.press('7');
await page.mouse.click(cx + 250, cy + 90);
await page.keyboard.press('8');
await page.mouse.click(cx - 150, cy + 240);
await page.waitForTimeout(300);
await page.screenshot({ path: 'shots/soak-1-built.png' });

// 3x speed for 90 real seconds = 270 game-seconds
await page.click('[data-speed="3"]');
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(15000);
  const hud = await page.evaluate(() => ({
    pop: document.getElementById('hPop').textContent,
    trips: document.getElementById('hTrips').textContent,
    avg: document.getElementById('hAvg').textContent,
    cong: document.getElementById('hCong').textContent,
    lvl: document.getElementById('hLevel').textContent,
    xpw: document.getElementById('xpfill').style.width,
  }));
  console.log(`t+${(i + 1) * 15}s:`, JSON.stringify(hud));
}
await page.screenshot({ path: 'shots/soak-2-after.png' });

// roundabout test: replace one junction
await page.keyboard.press('4');
await page.mouse.click(cx - 250, cy); // corner of the loop
await page.waitForTimeout(200);
await page.screenshot({ path: 'shots/soak-3-roundabout.png' });

// traffic light test
await page.keyboard.press('5');
await page.mouse.click(cx + 150, cy);
await page.waitForTimeout(200);
await page.screenshot({ path: 'shots/soak-4-light.png' });

const final = await page.evaluate(() => ({
  trips: document.getElementById('hTrips').textContent,
  pop: document.getElementById('hPop').textContent,
}));
console.log('FINAL:', JSON.stringify(final), 'errors:', errors.length ? errors.join(' | ') : 'NONE');
await browser.close();
if (errors.length) process.exit(1);
