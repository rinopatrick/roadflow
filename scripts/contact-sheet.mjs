// S02.3b contact sheet: the twelve scenes DESIGN section 3 asks a renderer
// change to be checked against.
//
//   node scripts/contact-sheet.mjs
//
// DESIGN's list is: three road classes, the T/X/Y/acute junction, roundabout,
// dense grid, curved road, car queue and invalid road draft. That is
// 3 + 4 + 5 = 12, so the road classes are captured separately rather than as one
// comparison frame.
//
// Every scene is built through the real controls, the clock is frozen, and the
// camera is set to frame it. Output goes to artifacts/<run-id>/sheet/.
//
// This is a REVIEW artifact, not a test: it asserts only that each scene was
// actually constructed, so an empty capture cannot be mistaken for a pass.
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { startServer, launchGame, runDir, dismissHelp } from '../test/browser/harness.js';

const shots = runDir(process.env.RF_RUN_ID || `sheet-${Date.now()}`);
const sheet = `${shots}/sheet`;
mkdirSync(sheet, { recursive: true });

const W = 1440;
const H = 900;

const server = await startServer();
const game = await launchGame({ baseUrl: server.baseUrl, viewport: { width: W, height: H } });

const rows = [];

/** World point -> CSS point, so fixtures never depend on screen constants. */
async function css(page, wx, wy) {
  return page.evaluate(([x, y]) => window.__rf.renderer.worldToScreen(x, y), [wx, wy]);
}

/**
 * Clicks a world point through the canvas.
 *
 * Refuses to click when the point is covered by interface chrome, so a layout
 * change can never turn a fixture click into a silent no-op.
 */
async function clickWorld(page, wx, wy, { button = 'left' } = {}) {
  const [sx, sy] = await css(page, wx, wy);
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? (el.id || el.tagName.toLowerCase()) : 'none';
  }, [sx, sy]);
  assert.equal(hit, 'game',
    `fixture point ${JSON.stringify([wx, wy])} maps to (${Math.round(sx)},${Math.round(sy)}), covered by "${hit}"`);
  await page.mouse.click(sx, sy, { button });
}

async function draw(page, tool, points) {
  await page.keyboard.press(tool);
  for (const [x, y] of points) await clickWorld(page, x, y);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
}

async function shoot(page, name, note) {
  const state = await page.evaluate(() => ({
    nodes: window.__rf.state.net.nodes.size,
    edges: window.__rf.state.net.edges.size,
    buildings: window.__rf.state.eco.buildings.size,
    cars: window.__rf.state.traffic.cars.size,
    tick: Math.round(window.__rf.state.traffic.time),
  }));
  await page.screenshot({ path: `${sheet}/${name}.png` });
  rows.push({ name, note, ...state });
  console.log(`${name.padEnd(22)} nodes=${String(state.nodes).padStart(3)} edges=${String(state.edges).padStart(3)} `
    + `buildings=${state.buildings} cars=${state.cars}`);
}

try {
  const { page } = game;
  await dismissHelp(page);
  await page.click('[data-speed="0"]');

  /** Reloads to an empty city with a frozen clock. */
  async function fresh() {
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__rf, null, { timeout: 20000 });
    await dismissHelp(page);
    await page.click('[data-speed="0"]');
  }

  // 01-03: the three road classes, one scene each.
  const classes = [['01-street', '1', 'street'], ['02-avenue', '2', 'avenue'], ['03-highway', '3', 'highway']];
  for (const [name, tool, cls] of classes) {
    await fresh();
    await draw(page, tool, [[-400, 0], [400, 0]]);
    await page.evaluate(() => { window.__rf.renderer.cam.zoom = 1.6; });
    await page.waitForTimeout(200);
    await shoot(page, name, `${cls}: pavement, casing and markings at close zoom`);
  }

  // 04: T junction, highway with a narrow street joining. The scene that shows
  // whether the footprint follows the connected pavements or is a disk.
  await fresh();
  await draw(page, '3', [[-420, 0], [420, 0]]);
  await draw(page, '1', [[0, 0], [0, 180]]);
  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 1.6; });
  await page.waitForTimeout(200);
  await shoot(page, '04-junction-t', 'street mouth must not bulge to the highway width');

  // 05: X junction.
  await fresh();
  await draw(page, '2', [[-420, 0], [420, 0]]);
  await draw(page, '2', [[0, -280], [0, 180]]);
  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 1.5; });
  await page.waitForTimeout(200);
  await shoot(page, '05-junction-x', 'four approaches, no internal casing seams');

  // 06: Y junction.
  await fresh();
  await draw(page, '1', [[-380, 150], [0, 0], [380, 150]]);
  await draw(page, '1', [[0, 0], [0, -260]]);
  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 1.4; });
  await page.waitForTimeout(200);
  await shoot(page, '06-junction-y', 'three-way merge');

  // 07: acute junction, a shallow-angle approach.
  await fresh();
  await draw(page, '2', [[-420, 0], [420, 0]]);
  await draw(page, '2', [[0, 0], [340, 70]]);
  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 1.4; });
  await page.waitForTimeout(200);
  await shoot(page, '07-junction-acute', 'shallow approach, footprint must still merge');

  // 08: roundabout.
  await fresh();
  await draw(page, '2', [[-420, 0], [420, 0]]);
  await draw(page, '2', [[0, -280], [0, 0]]);
  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 1.4; });
  await page.keyboard.press('4');
  await clickWorld(page, 0, 0);
  await page.waitForTimeout(250);
  await shoot(page, '08-roundabout', 'ring edges are one-way and show no centreline');

  // 09: dense grid, zoomed out. The scene that reveals junction seams.
  await fresh();
  const rowsY = [-240, -40, 160];
  for (const y of rowsY) await draw(page, '2', [[-400, y], [400, y]]);
  for (let i = 0; i < 5; i++) {
    await draw(page, '1', [[-400 + i * 200, rowsY[0]], [-400 + i * 200, rowsY[rowsY.length - 1]]]);
  }
  await page.evaluate(() => {
    const r = window.__rf.renderer;
    r.cam.x = 0; r.cam.y = 0; r.cam.zoom = 0.6;
  });
  await page.waitForTimeout(250);
  await shoot(page, '09-dense-grid', 'low zoom: dashes hidden, footprints merged');

  // 10: curved road. Round joins must survive the squared junction caps.
  await fresh();
  await draw(page, '2', [[-380, 160], [-180, -140], [140, -140], [340, 160]]);
  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 1.0; });
  await page.waitForTimeout(200);
  await shoot(page, '10-curved', 'bends keep round joins; markings follow the curve');

  // 11: car queue.
  await fresh();
  await draw(page, '2', [[-420, 0], [420, 0]]);
  // Buildings sit 80wu from the avenue: inside ACCESS_MAX_DISTANCE (120), so
  // placement succeeds rather than being refused at the boundary.
  await page.keyboard.press('6');
  await clickWorld(page, -300, -80);
  await clickWorld(page, -150, -80);
  await clickWorld(page, 150, -80);
  await page.keyboard.press('7');
  await clickWorld(page, 300, -80);
  const built = await page.evaluate(() => window.__rf.state.eco.buildings.size);
  assert.equal(built, 4, `scene 11 needs all four buildings placed, got ${built}`);
  await page.click('[data-speed="8"]');
  await page.waitForFunction(() => window.__rf.state.traffic.cars.size > 0, null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.click('[data-speed="0"]');
  await page.evaluate(() => { window.__rf.renderer.cam.zoom = 1.2; });
  await page.waitForTimeout(200);
  await shoot(page, '11-queue', 'cars: one shadow direction regardless of heading');

  // 12: invalid road draft over water or rock.
  //
  // The camera is panned to the offending point FIRST, then the click is
  // computed from it, so the draft lands on screen instead of off-map.
  await fresh();
  await draw(page, '2', [[-400, 0], [400, 0]]);
  const invalid = await page.evaluate(() => {
    const t = window.__rf.state.terrain;
    let best = null;
    for (let r = 300; r <= 1200 && !best; r += 60) {
      for (let a = 0; a < 360; a += 12) {
        const x = Math.round(Math.cos(a * Math.PI / 180) * r);
        const y = Math.round(Math.sin(a * Math.PI / 180) * r);
        if (!t.isRoadable(x, y)) { best = [x, y]; break; }
      }
    }
    return best;
  });
  assert.ok(invalid, 'fixture must find a non-roadable point to draft over');

  await page.evaluate(([x, y]) => {
    const r = window.__rf.renderer;
    r.cam.x = x; r.cam.y = y; r.cam.zoom = 1.4;
  }, invalid);
  await page.waitForTimeout(200);

  await page.keyboard.press('2');
  const [ax, ay] = await css(page, invalid[0] - 150, invalid[1]);
  await page.mouse.click(ax, ay);
  const [mx, my] = await css(page, invalid[0], invalid[1]);
  await page.mouse.move(mx, my);
  await page.waitForTimeout(250);
  await shoot(page, '12-invalid-draft', 'red preview, badge names the reason');
  await page.keyboard.press('Escape');

  writeFileSync(`${sheet}/scenes.txt`, [
    `S02.3b contact sheet — seed 1, viewport ${W}x${H}, DPR 1, clock frozen at speed 0`,
    `generated: ${new Date().toISOString()}`,
    '',
    'scene                  nodes edges buildings cars tick  note',
    ...rows.map(r => `${r.name.padEnd(22)} ${String(r.nodes).padStart(5)} ${String(r.edges).padStart(5)} `
      + `${String(r.buildings).padStart(9)} ${String(r.cars).padStart(4)} ${String(r.tick).padStart(4)}  ${r.note}`),
  ].join('\n'));

  assert.equal(rows.length, 12, `the sheet must contain all twelve scenes, got ${rows.length}`);
  assert.ok(rows.every(r => r.edges > 0), 'every scene must have built at least one road');
  assert.deepEqual(game.errors.filter(e => !/favicon/.test(e)), [],
    `browser errors during the sheet:\n  ${game.errors.join('\n  ')}`);

  console.log(`\ncontact sheet: ${sheet}`);
  console.log('twelve scenes captured, each asserted non-empty, no browser errors');
} finally {
  await game.close();
  await server.stop();
}
