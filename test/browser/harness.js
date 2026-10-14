// Reusable Playwright harness for Roadflow browser checks.
//
// Owns the lifecycle of exactly two things: the static server it spawned and
// the browser it launched. It never kills unrelated node processes, and it
// always tears both down in `finally` at the call site.
//
// Target selection:
//   - BASE_URL set   -> reuse that server (harness owns nothing, kills nothing)
//   - BASE_URL unset -> spawn server.js on a free port and own that child
//
// Every entry point refuses to run against a page that does not look like
// Roadflow, so a stray process on the chosen port cannot silently pass tests.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

// Artifacts live outside version control (see .gitignore). RF_RUN_ID makes a
// run reproducible/named, e.g. RF_RUN_ID=baseline.
export function runDir(name = process.env.RF_RUN_ID || `run-${Date.now()}`) {
  const dir = path.join(ROOT, 'artifacts', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function fetchWhenReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`server not ready at ${url} after ${timeoutMs}ms: ${lastError?.message ?? 'timeout'}`);
}

export function assertLooksLikeRoadflow(html, where) {
  if (!/<canvas[^>]*id="game"/.test(html) || !/Roadflow/i.test(html)) {
    throw new Error(`refusing to test ${where}: response does not look like Roadflow`);
  }
}

/**
 * Returns { baseUrl, owned, stop }.
 * `owned` is true only when this call spawned the server; `stop` is a no-op
 * otherwise, so callers can always `await server.stop()` safely.
 */
export async function startServer({ timeoutMs = 20000 } = {}) {
  const external = process.env.BASE_URL;
  if (external) {
    const html = await fetchWhenReady(external, timeoutMs);
    assertLooksLikeRoadflow(html, external);
    return { baseUrl: external, owned: false, stop: async () => {} };
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  const stop = async () => {
    if (child.exitCode === null && !child.killed) {
      child.kill();
      await new Promise(r => setTimeout(r, 200));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  };

  try {
    const html = await fetchWhenReady(baseUrl, timeoutMs);
    assertLooksLikeRoadflow(html, baseUrl);
    return { baseUrl, owned: true, pid: child.pid, stop };
  } catch (err) {
    await stop();
    throw new Error(`${err.message}${stderr.trim() ? ` | server stderr: ${stderr.trim()}` : ''}`);
  }
}

/**
 * Opens the game with cleared storage so a previous save cannot change the
 * starting world. Collects console errors, page errors and failed requests
 * (favicon excluded: the dev server has no icon and a 404 there is not a bug).
 */
export async function launchGame({ baseUrl, viewport = DEFAULT_VIEWPORT, seed = 1, deviceScaleFactor = 1 } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await context.newPage();

  const errors = [];
  const dialogs = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', r => {
    if (!r.url().includes('favicon')) errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });

  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto(`${baseUrl}?seed=${seed}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__rf, null, { timeout: 20000 });

  return {
    browser, context, page, errors, dialogs, viewport, deviceScaleFactor,
    close: async () => { await browser.close(); },
  };
}

/** Snapshot of gameplay state that assertions can rely on. */
export async function worldState(page) {
  return page.evaluate(() => {
    const s = window.__rf.state;
    return {
      nodes: s.net.nodes.size,
      edges: s.net.edges.size,
      pop: s.eco.population(),
      batch: { ...s.eco.batch },
      level: s.eco.level,
      cars: s.traffic.cars.size,
      trips: s.eco.totalTrips,
    };
  });
}

/** HUD text as the player sees it. */
export async function hudState(page) {
  return page.evaluate(() => ({
    pop: document.getElementById('hPop').textContent,
    trips: document.getElementById('hTrips').textContent,
    avg: document.getElementById('hAvg').textContent,
    cong: document.getElementById('hCong').textContent,
    level: document.getElementById('hLevel').textContent,
    xpPercent: parseFloat(document.getElementById('xpfill').style.width) || 0,
  }));
}

/** Vehicle kinematics, for finite-value and non-negative-speed checks. */
export async function vehicleState(page) {
  return page.evaluate(() => [...window.__rf.state.traffic.cars.values()]
    .map(c => ({ id: c.id, x: c.x, y: c.y, s: c.s, speed: c.speed, dead: !!c.dead })));
}

/** Closes the boot help overlay without changing the selected tool. */
export async function dismissHelp(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

/**
 * Opens a tool category in the dock.
 *
 * S02.2 groups the dock into categories whose subtools are only visible while
 * the category is open, so a click on a hidden tool button would never become
 * actionable. Tests that want to exercise a real click go through this.
 */
export async function openCategory(page, category) {
  const open = await page.$eval(`[data-category="${category}"]`, el => el.getAttribute('aria-expanded') === 'true');
  if (open) return;
  await page.click(`[data-category="${category}"]`);
  await page.waitForFunction(
    c => document.querySelector(`[data-category="${c}"]`)?.getAttribute('aria-expanded') === 'true',
    category, { timeout: 5000 });
}

/**
 * Selects a tool through the real controls: open the owning category, then
 * click the tool button. The owning category is read from the button itself
 * rather than duplicated here, so the test cannot drift from the app.
 */
export async function selectTool(page, tool) {
  const category = await page.$eval(`[data-tool="${tool}"]`, el => el.dataset.toolCategory);
  await openCategory(page, category);
  await page.click(`[data-tool="${tool}"]`);
}

/** The category that owns each tool, as the dock declares it. */
export async function toolCategories(page) {
  return page.$$eval('[data-tool]', els => Object.fromEntries(els.map(e => [e.dataset.tool, e.dataset.toolCategory])));
}

/**
 * Opens the menu popover and clicks one of its actions.
 *
 * S02.2 moved Save/Load/Recover/New map/Help behind the menu button (DESIGN
 * section 1: "Menu groups Save/Load/Import/Export/Settings/New city"), so a
 * direct click on the action is no longer possible without opening it first.
 */
export async function menuAction(page, id) {
  await page.click('#menubtn');
  await page.waitForFunction(
    () => document.getElementById('menupop').offsetParent !== null, null, { timeout: 5000 });
  await page.click(`#${id}`);
}
