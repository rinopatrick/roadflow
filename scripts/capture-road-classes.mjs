// Captures the three road classes side by side with vehicles on them.
//
// Usage: RF_RUN_ID=before node scripts/capture-road-classes.mjs
//
// Why this exists
// ---------------
// S01.3 changes how pavement width and lane centre offsets are derived. The
// defect being fixed (EVIDENCE E02) is geometric: on avenue and highway the
// outermost lane centre plus half a car sat OUTSIDE the rendered pavement, so
// vehicles and lane dashes floated off the road surface.
//
// Numbers prove the containment rule; only a picture shows whether the result
// still reads as a road. This script produces that picture at three zoom levels
// and two device pixel ratios.
//
// Clicking strategy
// -----------------
// Roads are drawn by clicking, not by calling the API, so the capture exercises
// the real input path. That means every click must land on the canvas and NOT
// on a HUD element: the HUD card occupies roughly x<230, y<190, and the bottom
// dock occupies y>730. The camera is therefore positioned so the whole 1000 wu
// road span maps to screen x 150..1130 at y 400, which is clear of both.
import {
  startServer, launchGame, runDir, dismissHelp, worldState,
} from '../test/browser/harness.js';

const label = process.argv[2] || 'road-classes';
const shots = runDir(process.env.RF_RUN_ID || `${label}-${Date.now()}`);

// Screen geometry for the capture. Derived from the HUD/dock layout above.
const ROAD_SCREEN_Y = 400;
const ROAD_SCREEN_X0 = 150;
const ROAD_SCREEN_X1 = 1130;
const ROAD_WORLD_HALF = 500;                 // road spans world x -500..500
const CAPTURE_ZOOM = (ROAD_SCREEN_X1 - ROAD_SCREEN_X0) / (ROAD_WORLD_HALF * 2);

// Three parallel roads plus a north-south spine that connects them, so a route
// can cross all three classes. Spaced far enough apart that pavements cannot
// overlap even after S01.3 widens them (highway pavement becomes ~39 wu wide).
const ROADS = [
  { cls: 'street', y: -300, key: '1' },
  { cls: 'avenue', y: 0, key: '2' },
  { cls: 'highway', y: 300, key: '3' },
];
const SPINE_X = 0;

// Building plan. Shops sit on the highway while houses sit on street and
// avenue, so every trip must cross street/avenue -> spine -> highway. That
// guarantees all three classes carry vehicles rather than only the nearest one.
// Within the default batch of 4 houses / 2 shops.
const BUILDINGS = [
  { type: 'house', x: -350, y: -430 },
  { type: 'house', x: -180, y: -430 },
  { type: 'house', x: -350, y: -130 },
  { type: 'house', x: -180, y: -130 },
  { type: 'shop', x: 320, y: 170 },
  { type: 'shop', x: 430, y: 170 },
];

const server = await startServer();
const game = await launchGame({ baseUrl: server.baseUrl, seed: 1 });

try {
  const { page } = game;
  await dismissHelp(page);

  /** Points the camera at a road so clicks land in the safe band. */
  const frameRoad = async (roadY) => {
    await page.evaluate(([y, z]) => {
      const r = window.__rf.renderer;
      r.cam.x = 0; r.cam.y = y; r.cam.zoom = z;
    }, [roadY, CAPTURE_ZOOM]);
    await page.waitForTimeout(80);
  };

  /** World point -> CSS pixel, using the renderer's own transform. */
  const toScreen = async (wx, wy) => page.evaluate(([x, y]) => {
    const r = window.__rf.renderer;
    const dpr = r._dpr;
    return [
      ((x - r.cam.x) * r.cam.zoom * dpr + r.canvas.width / 2) / dpr,
      ((y - r.cam.y) * r.cam.zoom * dpr + r.canvas.height / 2) / dpr,
    ];
  }, [wx, wy]);

  const clickWorld = async (wx, wy) => {
    const [sx, sy] = await toScreen(wx, wy);
    await page.mouse.click(sx, sy);
  };

  // --- draw the three roads through the real road tool ---
  for (const road of ROADS) {
    await frameRoad(road.y);
    await page.keyboard.press(road.key);
    await clickWorld(-ROAD_WORLD_HALF, road.y);
    await clickWorld(ROAD_WORLD_HALF, road.y);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
  }

  // --- spine connecting all three, so trips cross every class ---
  await page.evaluate(() => {
    const r = window.__rf.renderer;
    r.cam.x = 0; r.cam.y = 0; r.cam.zoom = 0.4;
  });
  await page.keyboard.press('2'); // avenue spine
  await clickWorld(SPINE_X, -430);
  await clickWorld(SPINE_X, 430);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  // --- buildings, placed in world space ---
  for (const b of BUILDINGS) {
    await page.evaluate(([x, y]) => {
      const r = window.__rf.renderer;
      r.cam.x = x; r.cam.y = y; r.cam.zoom = 0.5;
    }, [b.x, b.y]);
    await page.waitForTimeout(80);
    await page.keyboard.press(b.type === 'house' ? '6' : '7');
    await clickWorld(b.x, b.y);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(300);

  const placed = await worldState(page);
  console.log('placed:', JSON.stringify(placed));

  // --- run traffic so vehicles occupy lanes ---
  await page.click('[data-speed="3"]');
  await page.waitForTimeout(25000);
  await page.click('[data-speed="0"]'); // freeze for a stable capture

  const carReport = await page.evaluate(() => {
    const s = window.__rf.state;
    const byClass = {};
    let maxLane = {};
    for (const c of s.traffic.cars.values()) {
      const st = c.currentStep();
      const e = st && s.net.edges.get(st.edgeId);
      if (!e) continue;
      byClass[e.cls] = (byClass[e.cls] || 0) + 1;
      maxLane[e.cls] = Math.max(maxLane[e.cls] ?? -1, st.lane ?? 0);
    }
    return { byClass, maxLane, trips: s.eco.totalTrips };
  });
  console.log('cars by class:', JSON.stringify(carReport));

  // --- capture each zoom level, framed on the middle (avenue) road ---
  for (const dpr of [1, 2]) {
    await page.evaluate((d) => {
      // Emulate a higher device pixel ratio for the renderer's own scaling.
      Object.defineProperty(window, 'devicePixelRatio', { value: d, configurable: true });
      window.__rf.renderer.resize();
    }, dpr);

    for (const zoom of [0.25, 1, 3]) {
      await page.evaluate(([z]) => {
        const r = window.__rf.renderer;
        r.cam.x = 0; r.cam.y = 0; r.cam.zoom = z;
      }, [zoom]);
      await page.waitForTimeout(300);
      const file = `${shots}/dpr${dpr}-zoom${String(zoom).replace('.', 'p')}.png`;
      await page.screenshot({ path: file });
      console.log('captured', file);
    }
  }

  console.log(`artifacts: ${shots}`);
  if (game.errors.length) {
    console.error('Browser errors:\n' + game.errors.join('\n'));
    process.exitCode = 1;
  }
} finally {
  await game.close();
  await server.stop();
}
