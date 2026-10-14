// Camera projection, framing and starter placement — S02.4a.
//
// Why this is a separate pure module
// ----------------------------------
// The projection was DPR-broken and no test could see it. `worldToScreen`
// returned DEVICE pixels (it multiplied by dpr and offset by `canvas.width / 2`)
// while `screenToWorld` took CSS pixels (it multiplied its input by dpr first),
// so the two were not inverses of each other. At DPR 2 the round trip was off by
// 850-2963 wu, and `_drawToolPreviews` mixed a CSS-pixel mouse position with a
// device-pixel projection, so tool badges landed in the wrong place on any
// HiDPI display.
//
// It survived because every fixture ran at DPR 1, where the two coincide.
//
// There is now one projection with the unit stated in each function's name, and
// the maths is pure so it can be tested at any DPR and zoom without a canvas:
//
//   worldToDevice  world -> DEVICE pixels   (canvas drawing)
//   worldToCss     world -> CSS pixels      (DOM, pointer events, screenshots)
//   cssToWorld     CSS pixels -> world      (pointer input)
//   deviceToCss    DEVICE pixels -> CSS     (interop at the boundary)
//
// `worldToScreen` on the Renderer is kept as an alias of `worldToDevice`, because
// CONTRACTS section 1 lists it and every drawing call already expects device px.

/** Lowest supported zoom. Above zero, so the projection is never singular. */
export const MIN_ZOOM = 0.12;

/** Highest supported zoom. */
export const MAX_ZOOM = 5;

/**
 * Clamps a zoom into the supported range.
 *
 * A non-finite value falls back to 1 rather than propagating NaN through the
 * camera, which would blank the map with no error.
 */
export function clampZoom(zoom) {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The device pixel ratio of a view description, defaulting to 1. */
function dprOf(view) {
  const dpr = view?.dpr;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/**
 * World -> CSS pixels. This is the projection a pointer event shares.
 * @param {{x:number,y:number,zoom:number}} cam
 * @param {{width:number,height:number,dpr:number}} view CSS size plus DPR
 */
export function worldToCss(cam, view, x, y) {
  return [
    (x - cam.x) * cam.zoom + view.width / 2,
    (y - cam.y) * cam.zoom + view.height / 2,
  ];
}

/** World -> device (backing-store) pixels. Exactly `worldToCss * dpr`. */
export function worldToDevice(cam, view, x, y) {
  const [sx, sy] = worldToCss(cam, view, x, y);
  const dpr = dprOf(view);
  return [sx * dpr, sy * dpr];
}

/** CSS pixels -> world. The inverse of `worldToCss`. */
export function cssToWorld(cam, view, sx, sy) {
  return [
    (sx - view.width / 2) / cam.zoom + cam.x,
    (sy - view.height / 2) / cam.zoom + cam.y,
  ];
}

/** Device pixels -> CSS pixels. */
export function deviceToCss(view, dx, dy) {
  const dpr = dprOf(view);
  return [dx / dpr, dy / dpr];
}

/**
 * Zooms while keeping the world point under `(px, py)` exactly where it is.
 *
 * DESIGN section 4: "Zoom at pointer keeps world anchor stable". Solved directly
 * rather than incrementally, so repeated zooming cannot accumulate drift.
 *
 * @returns {{x:number,y:number,zoom:number}} the new camera (the input is not modified)
 */
export function zoomAtPointer(cam, view, px, py, zoom) {
  const next = clampZoom(zoom);
  if (next === cam.zoom) return { ...cam };

  const [wx, wy] = cssToWorld(cam, view, px, py);
  return {
    x: wx - (px - view.width / 2) / next,
    y: wy - (py - view.height / 2) / next,
    zoom: next,
  };
}

/**
 * World-space bounds of everything the player has built: every road polyline
 * point and every building. Returns null for an empty world so the caller can
 * fall back to a starter view instead of framing nothing.
 */
export function boundsOfWorld(world) {
  const net = world?.net;
  const eco = world?.eco;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;

  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    any = true;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const edge of net?.edges?.values?.() ?? []) {
    for (const p of edge?.pts ?? []) add(p[0], p[1]);
  }
  for (const b of eco?.buildings?.values?.() ?? []) add(b.x, b.y);

  return any ? { minX, minY, maxX, maxY } : null;
}

/**
 * Fit-city framing defaults.
 *
 * `margin` is a fraction of the content span applied on EACH side, so the framed
 * extent is `span * (1 + 2 * margin)`. `minSpanWu` stops a single building being
 * zoomed until the pavement fills the screen.
 */
export const DEFAULT_FIT = { margin: 0.12, minSpanWu: 200 };

/**
 * A camera that frames `bounds` with margin, centred on the content.
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds
 * @param {{width:number,height:number,dpr:number}} view
 * @param {{margin?:number,minSpanWu?:number}} [opts]
 */
export function fitBounds(bounds, view, { margin = DEFAULT_FIT.margin, minSpanWu = DEFAULT_FIT.minSpanWu } = {}) {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  // The minimum span is applied BEFORE the margin, so the margin is a true
  // proportion of what is actually framed.
  const spanX = Math.max(bounds.maxX - bounds.minX, minSpanWu);
  const spanY = Math.max(bounds.maxY - bounds.minY, minSpanWu);
  const paddedX = spanX * (1 + 2 * margin);
  const paddedY = spanY * (1 + 2 * margin);

  const zoom = clampZoom(Math.min(view.width / paddedX, view.height / paddedY));
  return { x: cx, y: cy, zoom };
}

/**
 * Starter placement defaults.
 *
 * DESIGN section 4: "Search deterministically for a buildable rectangle and show
 * a bounded fallback." The rectangle is larger than the initial view so the
 * player starts with room to build rather than on a single buildable tile.
 */
export const STARTER_DEFAULTS = {
  gridStep: 200,      // wu between candidate cell centres
  rectW: 600,         // wu of the buildable rectangle each cell is scored on
  rectH: 400,
  minBuildable: 0.8,  // fraction of the rectangle that must be buildable
  radius: 2400,       // wu searched around the origin
  samplesX: 6,
  samplesY: 4,
};

/** Fraction of a rectangle centred on (cx, cy) that is buildable, 0..1. */
function buildableFraction(terrain, cx, cy, o) {
  let hits = 0;
  let total = 0;
  const stepX = o.rectW / o.samplesX;
  const stepY = o.rectH / o.samplesY;
  for (let i = 0; i < o.samplesX; i++) {
    const x = cx - o.rectW / 2 + (i + 0.5) * stepX;
    for (let j = 0; j < o.samplesY; j++) {
      const y = cy - o.rectH / 2 + (j + 0.5) * stepY;
      total++;
      if (terrain.isBuildable(x, y)) hits++;
    }
  }
  return total ? hits / total : 0;
}

/**
 * A deterministic buildable starter region, nearest the origin.
 *
 * The grid is scanned in full and then ordered explicitly (distance from the
 * origin, then x, then y) rather than taking the first qualifying cell, so the
 * result does not depend on scan order or on any container's iteration order.
 *
 * When no cell reaches `minBuildable`, the most buildable cell is returned with
 * `fallback: true` and a `reason` naming the shortfall, because DESIGN requires
 * restricted terrain to be explained rather than silently framed.
 *
 * @param {{isBuildable:(x:number,y:number)=>boolean}} terrain
 * @returns {{x:number,y:number,buildable:number,fallback:boolean,
 *            reason:string|null,rect:{w:number,h:number}}}
 */
export function starterRegion(terrain, opts = {}) {
  const o = { ...STARTER_DEFAULTS, ...opts };
  const steps = Math.max(1, Math.floor(o.radius / o.gridStep));

  const cells = [];
  for (let gx = -steps; gx <= steps; gx++) {
    for (let gy = -steps; gy <= steps; gy++) {
      const x = gx * o.gridStep;
      const y = gy * o.gridStep;
      cells.push({
        x,
        y,
        buildable: buildableFraction(terrain, x, y, o),
        dist: Math.hypot(x, y),
      });
    }
  }

  // Deterministic total order: nearest the origin wins, then coordinates.
  cells.sort((a, b) => a.dist - b.dist || a.x - b.x || a.y - b.y);

  const best = cells.find(c => c.buildable >= o.minBuildable);
  if (best) {
    return {
      x: best.x,
      y: best.y,
      buildable: best.buildable,
      fallback: false,
      reason: null,
      rect: { w: o.rectW, h: o.rectH },
    };
  }

  // Bounded fallback: the most buildable cell found, ties broken as above.
  const ranked = [...cells].sort((a, b) =>
    b.buildable - a.buildable || a.dist - b.dist || a.x - b.x || a.y - b.y);
  const chosen = ranked[0];
  const pct = Math.round(chosen.buildable * 100);
  return {
    x: chosen.x,
    y: chosen.y,
    buildable: chosen.buildable,
    fallback: true,
    reason: `no ${o.rectW}x${o.rectH} wu area reached ${Math.round(o.minBuildable * 100)}% buildable `
      + `within ${o.radius} wu; framing the most buildable area found (${pct}%)`,
    rect: { w: o.rectW, h: o.rectH },
  };
}
