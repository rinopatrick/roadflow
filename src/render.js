// Canvas renderer — flat top-down "living map" style: soft terrain, white
// roads with yellow centerlines, extruded pastel buildings, colored cars.
import { BIOME } from './terrain.js';
import { pointAt, clamp, dist, makeRng, splinePoints } from './core.js';
import { ROAD_CLASS } from './roadNetwork.js';
import { roadDimensions } from './roadProfiles.js';
import { getLegacyPhase } from './signals.js';
import { BUILDING_DEFS } from './economy.js';
import { UI_TOKENS, alpha } from './uiTokens.js';
import { trafficOverlay, ACCESS_STATE } from './layers.js';
import { laneMarkings, trimPolyline, trimPolylineEnds, offsetPolyline } from './render/markings.js';
import { worldToCss, worldToDevice, cssToWorld, zoomAtPointer } from './camera.js';
import {
  tileWu, tileDetail, tilePx, visibleTiles, rasterizeTile,
  decorativePatches, TileCache,
} from './render/terrain.js';
import { buildingVariant, entryAngle, variantGeometry } from './render/buildings.js';
import { previewPlacement } from './render/preview.js';
import { demolitionPreview, demolitionLabel } from './constructionEdits.js';
import {
  capForNode, junctionFootprint, edgeEndTrims, shadowOffset, offsetInRotatedFrame,
} from './render/junctions.js';

const UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/**
 * Overlay palettes. Kept here rather than in uiTokens.js because these are
 * map-only analytic tints judged against terrain, not against a UI surface.
 *
 * Severity rises in BOTH hue and lightness, so the bands stay distinguishable
 * in greyscale; the line thickness and the count chip carry the same signal
 * again, which is what DESIGN section 1 means by "not red/green alone".
 */
const TRAFFIC_OVERLAY_STYLE = {
  calm: { stroke: alpha(UI_TOKENS.accent, 0.45), chip: '#2c6b68' },
  busy: { stroke: 'rgba(138, 81, 8, 0.55)', chip: '#8a5108' },
  heavy: { stroke: 'rgba(190, 94, 18, 0.66)', chip: '#be5e12' },
  jammed: { stroke: alpha(UI_TOKENS.danger, 0.72), chip: '#8f2b30' },
};

const ACCESS_OVERLAY_STYLE = {
  reachable: { fill: 'rgba(20, 107, 104, 0.22)', stroke: alpha(UI_TOKENS.accent, 0.9) },
  unreachable: { fill: 'rgba(163, 48, 54, 0.35)', stroke: UI_TOKENS.danger },
};

const PALETTE = {
  grass: '#efece3',
  grass2: '#e6e2d4',
  sand: '#f2e3bd',
  water: '#a8c4e8',
  water2: '#9ab9e2',
  rock: '#a3a19a',
  rock2: '#6f6d68',
  patch: '#8e8e8a',     // decorative dark blobs (like the grey woods/rocks)
  patch2: '#b9bd8f',    // olive-green patch
  forest: '#7d9b62',
  forestDark: '#647f4d',
  road: '#ffffff',
  roadOutline: '#b9b6ac',
  roadShadow: 'rgba(60, 58, 50, 0.18)',
  laneDash: '#d8d5ca',
  centerline: '#f2cf4e',
  highwayOutline: '#2e2e2e',
  island: '#dcd7c6',
  islandGrass: '#cfd3ac',
  tree: '#7d9b62',
  treeDark: '#5f7a49',
};

function mixHex(a, b, t) {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: 0, zoom: 1 };
    // Which analytic overlay is showing is interface state and lives in
    // src/ui/controller.js. It arrives with each draw call as `state.overlay`.
    this._terrainSeed = null;
    this._dpr = 1;
    // Chunked terrain replaces the single 1024px texture (DESIGN section 4):
    // 512 wu tiles at 256 px base resolution, 2x above DETAIL_ZOOM, bounded
    // at MAX_TILES with LRU eviction. Only visible tiles are generated.
    this._tiles = new TileCache();
  }

  /** CSS size plus DPR: the description the pure projection takes. */
  view() {
    return {
      width: this.canvas.clientWidth || window.innerWidth,
      height: this.canvas.clientHeight || window.innerHeight,
      dpr: this._dpr,
    };
  }

  /**
   * Drops every cache keyed on something that a world replacement can preserve.
   *
   * `_islandVersion` compares against `net.version`, and a REPLACED network can
   * have the same version NUMBER as the one it replaced (both 1, for instance),
   * so the cache would serve islands from a network that no longer exists. The
   * same reasoning applies to the terrain caches. Called from the one place that
   * adopts a new world, so a stale cache cannot outlive its world.
   */
  resetCaches() {
    this._terrainSeed = null;
    this._islandVersion = -1;
    this._islands = null;
    this._blobs = null;
    this._tiles.clear();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
  }

  /** World -> DEVICE pixels. The drawing-space name kept from CONTRACTS 1. */
  worldToScreen(x, y) {
    return worldToDevice(this.cam, this.view(), x, y);
  }

  /**
   * World -> CSS pixels: the space a pointer event and a screenshot share.
   *
   * This is the helper whose absence caused the DPR bug. `mouseScreen` arrives
   * in CSS pixels from `e.offsetX`, so anything comparing a pointer position
   * with the map must use this, never `worldToScreen`.
   */
  worldToCss(x, y) {
    return worldToCss(this.cam, this.view(), x, y);
  }

  /** CSS pixels -> world. The inverse of `worldToCss`. */
  screenToWorld(sx, sy) {
    return cssToWorld(this.cam, this.view(), sx, sy);
  }

  /**
   * Zooms while keeping the world point under a CSS-pixel pointer fixed.
   * Returns the new camera; assigning it is the caller's job.
   */
  zoomAt(px, py, zoom) {
    return zoomAtPointer(this.cam, this.view(), px, py, zoom);
  }

  /** Terrain chunk activity this frame: tiles drawn, generated, and the cost. */
  terrainStats() {
    return {
      ...(this._terrainCost || { tiles: 0, generated: 0, ms: 0 }),
      cacheSize: this._tiles.size,
      cacheMax: this._tiles.max,
      detail: tileDetail(this.cam.zoom),
    };
  }

  // ---------- terrain ----------
  /**
   * Prepares decoration for a terrain seed. The terrain RASTER is no longer
   * pre-built: it is generated per visible tile in `_drawTerrain`, so close
   * zoom gets a 2x-detail raster instead of an upscaled 1024px image, and
   * nothing is generated for parts of the map nobody can see.
   */
  buildTerrain(terrain) {
    if (this._terrainSeed !== terrain.seed) {
      this._blobs = decorativePatches(terrain);
      this._terrainSeed = terrain.seed;
      this._tiles.clear();
    }
  }

  /**
   * Draws the visible terrain tiles.
   *
   * A tile missing from the cache is rasterised on the spot, so the first
   * frame after a pan pays for exactly the tiles it shows and later frames
   * pay nothing. Generation cost is recorded in _terrainCost for inspection.
   */
  _drawTerrain(ctx, terrain, cam) {
    const view = this.view();
    const zoom = this.cam.zoom * this._dpr;
    const detail = tileDetail(this.cam.zoom);
    const tiles = visibleTiles(this.cam, view);
    this._terrainCost = { tiles: tiles.length, generated: 0, ms: 0 };

    for (const [gx, gy, spanWu] of tiles) {
      let canvas = this._tiles.get(gx, gy, detail, spanWu);
      if (!canvas) {
        const t0 = performance.now();
        const data = rasterizeTile(terrain, gx, gy, detail, spanWu);
        const px = tilePx(detail);
        canvas = document.createElement('canvas');
        canvas.width = px;
        canvas.height = px;
        canvas.getContext('2d').putImageData(new ImageData(data, px, px), 0, 0);
        this._tiles.put(gx, gy, detail, canvas, spanWu);
        this._terrainCost.generated++;
        this._terrainCost.ms += performance.now() - t0;
      }
      const [sx, sy] = this.worldToScreen(gx * spanWu, gy * spanWu);
      const w = spanWu * zoom;
      ctx.drawImage(canvas, sx, sy, w, w);
    }
  }

  // ---------- main draw ----------
  draw(state) {
    const { ctx, canvas } = this;
    const { net, traffic, eco, terrain, preview } = state;
    this._net = net;
    if (this._terrainSeed !== terrain.seed) this.buildTerrain(terrain);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PALETTE.water2;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const zoom = this.cam.zoom * this._dpr;

    // terrain: only the visible chunked tiles, each at its own detail level
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    this._drawTerrain(ctx, terrain, this.cam);

    // decorative patches (in world space)
    for (const b of this._blobs) {
      const [bx, by] = this.worldToScreen(b.x, b.y);
      if (b.trees) {
        // forest: soft ground tint + tree dots
        ctx.fillStyle = PALETTE.forest;
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.ellipse(bx, by, b.r * zoom, b.r * zoom * 0.72, b.x % 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        for (const [dx, dy, tr, dark] of b.trees) {
          const [tx, ty] = this.worldToScreen(b.x + dx, b.y + dy);
          ctx.fillStyle = dark ? PALETTE.treeDark : PALETTE.tree;
          ctx.beginPath();
          ctx.arc(tx, ty, tr * zoom, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = PALETTE[b.kind];
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.ellipse(bx, by, b.r * zoom, b.r * zoom * 0.72, b.x % 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // roads — passes so junction areas merge cleanly: soft shadow, every casing,
    // every fill on top covering the crossing casings (outlines never cut through
    // junction interiors), then the junction footprints themselves.
    for (const edge of net.edges.values()) this._drawEdgeShadow(ctx, edge, zoom);
    for (const edge of net.edges.values()) this._drawEdgeCasing(ctx, edge, zoom);
    // The junction outline belongs to the CASING pass, not after the fills: drawn
    // on top it would cut a grey seam straight across the pavement, which DESIGN
    // section 3 forbids ('hide internal seam/casing strokes').
    this._drawJunctionCasing(ctx, net, zoom);
    for (const edge of net.edges.values()) this._drawEdgeFill(ctx, edge, zoom);
    this._drawJunctionFill(ctx, net, zoom);
    for (const edge of net.edges.values()) this._drawEdgeMarkings(ctx, edge, net, zoom);

    // roundabout islands (grass center inside each ring)
    this._drawIslands(ctx, net, zoom);

    // nodes (roundabouts, lights)
    for (const node of net.nodes.values()) this._drawNode(ctx, node, zoom, state);

    // interactive cursor previews & badges (Trafficity diegetic UI)
    this._drawToolPreviews(ctx, state, zoom);

    // buildings
    for (const b of eco.buildings.values()) this._drawBuilding(ctx, b, net, zoom);

    // cars
    if (traffic) for (const car of traffic.cars.values()) this._drawCar(ctx, car, zoom);

    // Analytic overlays. Exactly one can be active (DESIGN section 1), and the
    // id comes from the controller rather than from a flag on the renderer, so
    // the toggle control and the drawing can never disagree.
    if (state.overlay === 'traffic') this._drawTrafficOverlay(ctx, net, zoom);
    else if (state.overlay === 'access') this._drawAccessOverlay(ctx, state.accessStates, eco, zoom);

    // inspect highlight
    if (state.selected) this._drawSelection(ctx, state.selected, zoom, net, eco);
  }

  _pathPolyline(ctx, pts, zoom) {
    ctx.beginPath();
    const [x0, y0] = this.worldToScreen(pts[0][0], pts[0][1]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = this.worldToScreen(pts[i][0], pts[i][1]);
      ctx.lineTo(x, y);
    }
  }

  _drawEdgeCasing(ctx, edge, zoom) {
    const d = roadDimensions(edge);
    const pts = edge.pts;
    if (!pts || pts.length < 2) return;
    this._pathPolyline(ctx, pts, zoom);
    // fill px width + casing that shrinks slower than zoom so outlines stay visible
    ctx.lineWidth = Math.max(d.width * zoom, 3.2) + Math.max(2.4 * zoom, 1);
    // Squared at a junction, so the casing cannot bulge into the disk DESIGN
    // section 3 rules out. The junction footprint pass supplies the outline there.
    ctx.lineCap = this._capForEdge(edge); ctx.lineJoin = 'round';
    ctx.strokeStyle = edge.cls === 'highway' ? PALETTE.highwayOutline : PALETTE.roadOutline;
    ctx.stroke();
  }

  _drawEdgeShadow(ctx, edge, zoom) {
    const d = roadDimensions(edge);
    const pts = edge.pts;
    if (!pts || pts.length < 2) return;
    this._pathPolyline(ctx, pts, zoom);
    ctx.lineWidth = Math.max(d.width * zoom, 3.2) + Math.max(2.4 * zoom, 1);
    ctx.lineCap = this._capForEdge(edge); ctx.lineJoin = 'round';
    ctx.strokeStyle = PALETTE.roadShadow;
    ctx.stroke();
  }

  /**
   * Cap style for an edge: rounded only where BOTH ends are bends or dead ends.
   *
   * A round cap at a shared junction node extends half the pavement width in
   * every direction from the node centre, so the union of round caps at a
   * junction is exactly the circular disk DESIGN section 3 rules out.
   */
  _capForEdge(edge) {
    return capForNode(Math.max(this._nodeDegree(edge.a), this._nodeDegree(edge.b)));
  }

  _nodeDegree(nodeId) {
    return this._net ? (this._net.nodes.get(nodeId)?.edges.size ?? 0) : 0;
  }

  /** Pavement fill only. Markings are their own pass, drawn after the junctions. */
  _drawEdgeFill(ctx, edge, zoom) {
    const cls = roadDimensions(edge);
    const pts = edge.pts;
    if (!pts || pts.length < 2) return;

    // clamp: keep roads readable as white ribbons when zoomed far out
    this._pathPolyline(ctx, pts, zoom);
    ctx.lineWidth = Math.max(cls.width * zoom, 3.2);
    ctx.lineCap = this._capForEdge(edge); ctx.lineJoin = 'round';
    ctx.strokeStyle = PALETTE.road;
    ctx.stroke();
  }

  /**
   * Junction pavement, drawn AFTER every edge fill and BEFORE the markings.
   *
   * A junction's outline is produced by filling an inset-expanded footprint in
   * the casing colour, then the true footprint in the road colour: the interior
   * is covered, leaving only an outer ring. Stroking each quad individually
   * would draw a visible seam wherever two quads overlap, which DESIGN forbids.
   */
  /**
   * Every node that is a real junction: 3+ connected edges. A degree-2 node is a
   * BEND (S01.5b), where a round join of the widest connected pavement is already
   * geometrically correct and a footprint would be wrong.
   */
  _junctionNodes(net) {
    return [...net.nodes.values()].filter(n => n.edges.size >= 3);
  }

  /**
   * The junction outline, drawn with the road casings and therefore UNDER the
   * pavement fills. Any grey it lays across a road is covered by that road's own
   * fill, so no seam survives.
   *
   * The inset matches the edge casing's per-side extension, so the junction
   * outline continues the road casing rather than stepping wider or narrower.
   */
  _drawJunctionCasing(ctx, net, zoom) {
    const inset = Math.max(2.4 * zoom, 1) / 2;
    for (const node of this._junctionNodes(net)) {
      const outer = junctionFootprint(net, node, { inset });
      if (outer.quads.length) this._fillQuads(ctx, outer.quads, zoom, PALETTE.roadOutline);
    }
  }

  /** The junction pavement, drawn with the road fills and therefore on top of the
   * junction casing, leaving only its outer rim visible. */
  _drawJunctionFill(ctx, net, zoom) {
    for (const node of this._junctionNodes(net)) {
      const inner = junctionFootprint(net, node);
      if (inner.quads.length) this._fillQuads(ctx, inner.quads, zoom, PALETTE.road);
    }
  }

  _fillQuads(ctx, quads, zoom, colour) {
    ctx.save();
    ctx.fillStyle = colour;
    for (const quad of quads) {
      ctx.beginPath();
      for (let k = 0; k < quad.length; k++) {
        const [x, y] = this.worldToScreen(quad[k][0], quad[k][1]);
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Lane markings, on top of every pavement fill and junction footprint.
   *
   * Split out of the fill pass so a junction's pavement can never be painted
   * over a marking that was already drawn.
   */
  _drawEdgeMarkings(ctx, edge, net, zoom) {
    const pts = edge.pts;
    if (!pts || pts.length < 2) return;

    // Per-end trim: a junction end is cleared as far as the widest CONNECTED
    // pavement reaches, which is not the same as this road's own width.
    const trims = edgeEndTrims(net, edge);
    const marks = laneMarkings(edge, zoom, edge.cum[edge.cum.length - 1]);
    const span = trimPolylineEnds(pts, edge.cum, trims.start, trims.end);

    if (marks.showDashes && marks.dividerOffsets.length) {
      ctx.strokeStyle = PALETTE.laneDash;
      ctx.lineWidth = marks.dashWidth;
      ctx.setLineDash(marks.dash);
      for (const off of marks.dividerOffsets) {
        for (const sgn of [1, -1]) {
          this._strokeWorldPolyline(ctx, offsetPolyline(span, off * sgn), zoom);
        }
      }
      ctx.setLineDash([]);
    }

    // Yellow centreline, omitted where there is no median to divide, which
    // includes every one-way and ring edge.
    if (marks.showCentreline) {
      ctx.lineWidth = marks.centrelineWidth;
      ctx.strokeStyle = PALETTE.centerline;
      this._strokeWorldPolyline(ctx, span, zoom);
    }
  }

  /**
   * Strokes a polyline given in WORLD coordinates.
   *
   * Trimming and offsetting happen in world space (src/render/markings.js) so a
   * lane keeps a constant lateral distance from the centreline through bends and
   * the ends are cut at an exact distance rather than snapped to vertices.
   */
  _strokeWorldPolyline(ctx, pts, zoom) {
    if (!Array.isArray(pts) || pts.length < 2) return;
    ctx.beginPath();
    for (let k = 0; k < pts.length; k++) {
      const [x, y] = this.worldToScreen(pts[k][0], pts[k][1]);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /**
   * Offset polyline restricted to the trimmed span, so a lane dash can never be
   * painted past the pavement end into a junction mouth.
   */
  /**
   * Offset polyline restricted to the trimmed span, so a lane dash can never be
   * painted past the pavement end into a junction mouth.
   */
  // Roundabout ring components -> one grass island each (cached per version)
  _islandData(net) {
    if (this._islandVersion === net.version && this._islands) return this._islands;
    const seen = new Set();
    const islands = [];
    for (const e of net.edges.values()) {
      if (!e.ring || seen.has(e.id)) continue;
      // BFS the ring component
      const ringEdgeIds = new Set();
      const ringNodes = [];
      const queue = [e.id];
      while (queue.length) {
        const eid = queue.pop();
        if (ringEdgeIds.has(eid)) continue;
        ringEdgeIds.add(eid);
        const ed = net.edges.get(eid);
        for (const nid of [ed.a, ed.b]) {
          const n = net.nodes.get(nid);
          if (!n) continue;
          if (!ringNodes.includes(nid)) ringNodes.push(nid);
          for (const eid2 of n.edges) {
            const e2 = net.edges.get(eid2);
            if (e2?.ring && !ringEdgeIds.has(eid2)) queue.push(eid2);
          }
        }
      }
      for (const eid of ringEdgeIds) seen.add(eid);
      if (ringNodes.length < 3) continue;
      // centroid over all ring-edge polyline points (robust for irregular rings)
      let cx = 0, cy = 0, n = 0;
      for (const eid of ringEdgeIds) {
        const ed = net.edges.get(eid);
        for (const p of ed.pts) { cx += p[0]; cy += p[1]; n++; }
      }
      cx /= n; cy /= n;
      let rMin = Infinity;
      for (const eid of ringEdgeIds) {
        const ed = net.edges.get(eid);
        for (const p of ed.pts) rMin = Math.min(rMin, Math.hypot(p[0] - cx, p[1] - cy));
      }
      islands.push({ x: cx, y: cy, r: Math.max(6, rMin - 7), seed: ringNodes[0].charCodeAt(0) + ringNodes.length });
    }
    this._islands = islands;
    this._islandVersion = net.version;
    return islands;
  }

  _drawIslands(ctx, net, zoom) {
    for (const isl of this._islandData(net)) {
      const [x, y] = this.worldToScreen(isl.x, isl.y);
      const r = isl.r * zoom;
      if (r < 2) continue;
      // curb ring
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE.island;
      ctx.fill();
      ctx.lineWidth = 1.6 * zoom;
      ctx.strokeStyle = PALETTE.roadOutline;
      ctx.stroke();
      // grass heart + a few trees (deterministic per island)
      ctx.beginPath();
      ctx.arc(x, y, r * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE.islandGrass;
      ctx.fill();
      const n = 3 + (isl.seed % 2);
      for (let k = 0; k < n; k++) {
        const a = (isl.seed * 2.399963 + k * 2.399963) % (Math.PI * 2);
        const rr = r * 0.34 * ((k % 2) ? 0.8 : 1);
        ctx.fillStyle = k % 2 ? PALETTE.tree : PALETTE.treeDark;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 2.6 * zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  _drawNode(ctx, node, zoom, state) {
    const [x, y] = this.worldToScreen(node.x, node.y);

    if (node.type === 'light') {
      // Shared phase authority (signals.js) - the same function the simulator
      // obeys. Previously this computed its own half-cycle comparison, ignoring
      // greenRatio and yellow, so the dot could show green while traffic was
      // held (EVIDENCE E04).
      const phase = getLegacyPhase(node.light, state.simTime);
      const axisA = node.light.axis === 'y' ? 'y' : 'x';
      const onA = phase.axis === axisA;
      const colour = phase.state === 'green' && onA ? '#3fae5a'
        : phase.state === 'yellow' && onA ? '#e8b93f'
        : '#e2574c';

      ctx.beginPath();
      ctx.arc(x, y, 4.5 * zoom, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.lineWidth = 1.5 * zoom;
      ctx.strokeStyle = UI_TOKENS.surfaceRaised;
      ctx.stroke();
    }
  }

  // In-world diegetic badge: white rounded pill with subtle shadow and border
  _drawPillBadge(ctx, sx, sy, parts) {
    // parts = [{ text: '$200', bold: true }, { text: 'Parallel', color: UI_TOKENS.muted }]
    ctx.save();
    ctx.font = '500 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    let totalW = 16;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) totalW += 8; // separator space
      ctx.font = parts[i].bold ? '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' : '500 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      totalW += ctx.measureText(parts[i].text).width;
    }
    const h = 22;
    const r = 11;
    const x = sx;
    const y = sy - h / 2;

    // drop shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;

    // white background
    ctx.fillStyle = UI_TOKENS.surfaceRaised;
    ctx.beginPath();
    ctx.roundRect(x, y, totalW, h, r);
    ctx.fill();

    // subtle border
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1;
    ctx.strokeStyle = parts.some(p => p.error) ? alpha(UI_TOKENS.danger, 0.4) : 'rgba(0, 0, 0, 0.12)';
    ctx.stroke();

    // render text segments
    let curX = x + 8;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        // subtle vertical divider
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(curX - 4, y + 4);
        ctx.lineTo(curX - 4, y + h - 4);
        ctx.stroke();
      }
      const p = parts[i];
      ctx.font = p.bold ? '600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' : '500 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = p.error ? UI_TOKENS.danger : (p.color || UI_TOKENS.ink);
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, curX, y + h / 2);
      curX += ctx.measureText(p.text).width + 8;
    }
    ctx.restore();
  }

  /**
   * A short, whole-word version of a failure reason for the preview badge.
   * Truncating at a character count cut words in half ("...would cross water or").
   */
  _shortReason(reason) {
    const text = reason ?? 'invalid here';
    if (text.length <= 34) return text;
    const cut = text.slice(0, 34);
    const space = cut.lastIndexOf(' ');
    return (space > 12 ? cut.slice(0, space) : cut) + '…';
  }

  _drawToolPreviews(ctx, state, zoom) {
    const { tool, preview, mouseWorld, mouseScreen, net, terrain, eco } = state;
    if (!mouseWorld) return;
    const [mx, my] = mouseWorld;
    // `mouseScreen` arrives in CSS pixels; the rest of this pass draws in device
    // pixels. Converting at the boundary is what fixes the HiDPI offset.
    const view = this.view();
    const [msx, msy] = mouseScreen
      ? [mouseScreen[0] * view.dpr, mouseScreen[1] * view.dpr]
      : this.worldToScreen(mx, my);

    if (tool === 'road' || tool === 'avenue' || tool === 'highway') {
      const cls = roadDimensions({ cls: tool === 'avenue' ? 'avenue' : tool === 'highway' ? 'highway' : 'street' });
      const roadW = cls.width * zoom;

      // When actively drafting points.
      //
      // The geometry comes from the evaluated record (src/roadDraft.js), so the
      // preview IS what will be built. The renderer used to spline the raw
      // control points itself, which was a THIRD geometry path that could
      // disagree with both the draft evaluator and the commit.
      if (preview && preview.length >= 1) {
        const record = state.draftRecord;
        const poly = record && record.polyline && record.polyline.length >= 2
          ? record.polyline
          : (preview.length >= 2 ? splinePoints(preview, 12).pts : preview);
        const ok = record ? record.ok : true;

        // The drafted pavement.
        ctx.lineWidth = roadW;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = ok ? alpha(UI_TOKENS.accent, 0.45) : alpha(UI_TOKENS.danger, 0.32);
        this._strokeWorldPolyline(ctx, poly, zoom);

        // The centreline, so the draft reads as a road rather than a ribbon.
        ctx.lineWidth = Math.max(1.2 * zoom, 1);
        ctx.strokeStyle = ok ? alpha(UI_TOKENS.accent, 0.85) : alpha(UI_TOKENS.danger, 0.7);
        ctx.setLineDash([6 * zoom, 6 * zoom]);
        this._strokeWorldPolyline(ctx, poly, zoom);
        ctx.setLineDash([]);

        // Control points, from the record so they sit where the road will.
        const controls = record && record.controls && record.controls.length
          ? record.controls : preview;
        for (const p of controls) {
          const [px, py] = this.worldToScreen(p[0], p[1]);
          ctx.beginPath();
          ctx.arc(px, py, 4 * zoom, 0, Math.PI * 2);
          ctx.fillStyle = ok ? UI_TOKENS.accent : UI_TOKENS.danger;
          ctx.fill();
          ctx.strokeStyle = UI_TOKENS.surfaceRaised;
          ctx.lineWidth = 1.5 * zoom;
          ctx.stroke();
        }

        // Mark where the draft fails, so an invalid road says WHERE.
        if (record && record.failAt) {
          const [fx, fy] = this.worldToScreen(record.failAt[0], record.failAt[1]);
          ctx.beginPath();
          ctx.arc(fx, fy, 8 * zoom, 0, Math.PI * 2);
          ctx.strokeStyle = UI_TOKENS.danger;
          ctx.lineWidth = 2 * zoom;
          ctx.stroke();
        }

        // Length, not a fictional price: no currency exists yet, and DESIGN
        // section 5 forbids showing a cost the simulation does not compute.
        let len = 0;
        for (let i = 1; i < poly.length; i++) {
          len += dist(poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]);
        }
        const shownLength = record ? Math.round(record.length) : Math.round(len);
        const parts = ok
          ? [{ text: `${shownLength} wu`, bold: true },
            { text: tool.charAt(0).toUpperCase() + tool.slice(1), color: UI_TOKENS.muted }]
          : [{ text: 'Cannot build', error: true, bold: true },
            { text: this._shortReason(record?.reason), color: UI_TOKENS.danger }];

        this._drawPillBadge(ctx, msx + 18, msy - 12, parts);
      } else {
        // Idle cursor hover in road tool - show node snap or road cost badge
        const snapNode = net._snapNode(mx, my);
        if (snapNode) {
          const [snx, sny] = this.worldToScreen(snapNode.x, snapNode.y);
          ctx.beginPath();
          ctx.arc(snx, sny, 7 * zoom, 0, Math.PI * 2);
          ctx.fillStyle = alpha(UI_TOKENS.accent, 0.3);
          ctx.fill();
          ctx.strokeStyle = UI_TOKENS.accent;
          ctx.lineWidth = 2 * zoom;
          ctx.stroke();
          this._drawPillBadge(ctx, msx + 18, msy - 12, [
            { text: 'Connect', bold: true, color: UI_TOKENS.accent },
            { text: snapNode.isRing ? 'Roundabout' : 'Junction', color: UI_TOKENS.muted }
          ]);
        }
      }
    } else if (tool === 'roundabout') {
      // Trafficity cyan ring preview with circulation arrow and price badge
      const snap = net._snapNode(mx, my);
      const ringR = 26 * zoom;
      const [cx, cy] = snap ? this.worldToScreen(snap.x, snap.y) : [msx, msy];

      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.lineWidth = 7 * zoom;
      ctx.strokeStyle = alpha(UI_TOKENS.accent, 0.55);
      ctx.stroke();

      // Inner and outer guide lines
      ctx.beginPath();
      ctx.arc(cx, cy, ringR - 3.5 * zoom, 0, Math.PI * 2);
      ctx.arc(cx, cy, ringR + 3.5 * zoom, 0, Math.PI * 2);
      ctx.lineWidth = 1 * zoom;
      ctx.strokeStyle = alpha(UI_TOKENS.accent, 0.85);
      ctx.stroke();

      // Directional arrow on the ring (counterclockwise)
      const arrowAng = -Math.PI / 4;
      const ax = cx + Math.cos(arrowAng) * ringR;
      const ay = cy + Math.sin(arrowAng) * ringR;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(arrowAng - Math.PI / 2);
      ctx.fillStyle = UI_TOKENS.ink;
      ctx.beginPath();
      ctx.moveTo(0, -3.5 * zoom);
      ctx.lineTo(3 * zoom, 3 * zoom);
      ctx.lineTo(-3 * zoom, 3 * zoom);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // If snap exists on roundabout vs junction
      if (snap && snap.isRing) {
        this._drawPillBadge(ctx, cx + ringR + 10, cy, [
          { text: 'Already roundabout', error: true, bold: true }
        ]);
      } else {
        this._drawPillBadge(ctx, cx + ringR + 10, cy, [
          { text: '$200', bold: true },
          { text: snap ? 'Convert junction' : 'Place roundabout', color: UI_TOKENS.muted }
        ]);
      }
    } else if (tool === 'light') {
      const snap = net._snapNode(mx, my);
      if (snap) {
        const [nx, ny] = this.worldToScreen(snap.x, snap.y);
        ctx.beginPath();
        ctx.arc(nx, ny, 8 * zoom, 0, Math.PI * 2);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2 * zoom;
        ctx.stroke();
        this._drawPillBadge(ctx, msx + 18, msy - 12, [
          { text: snap.type === 'light' ? 'Configure light' : 'Install light', bold: true },
          { text: `${snap.edges.size} roads`, color: UI_TOKENS.muted }
        ]);
      }
    } else if (tool === 'house' || tool === 'shop' || tool === 'factory') {
      const def = BUILDING_DEFS[tool];
      const s = def.size * zoom;
      // The preview must agree with the commit: evaluateBuildingPlacement checks
      // stock, terrain, overlap and road reach, so the preview can never show
      // valid teal when the placement will fail (DESIGN section 5).
      const preview = previewPlacement({ net, terrain, eco }, tool, mx, my);
      const ok = preview.ok;

      ctx.save();
      ctx.translate(msx, msy);
      ctx.fillStyle = ok ? alpha(UI_TOKENS.accent, 0.4) : alpha(UI_TOKENS.danger, 0.4);
      ctx.strokeStyle = ok ? UI_TOKENS.accent : UI_TOKENS.danger;
      ctx.lineWidth = 1.5 * zoom;
      this._roundRect(ctx, -s / 2, -s / 2, s, s, 3 * zoom);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      const parts = ok
        ? [{ text: def.label, bold: true }, { text: `Available: ${eco.batch[tool] || 0}`, color: UI_TOKENS.muted }]
        : [{ text: preview.label, error: true, bold: true }];

      this._drawPillBadge(ctx, msx + s / 2 + 12, msy - 10, parts);
    } else if (tool === 'bulldoze') {
      // Say WHAT would be removed: a ring click removes the whole ring, and a
      // shared driveway can remove several buildings (DESIGN section 1).
      const demo = demolitionPreview({ net, eco }, mx, my);
      const demoLabel = demolitionLabel(demo);
      // Bulldoze highlight ring
      ctx.beginPath();
      ctx.arc(msx, msy, 14 * zoom, 0, Math.PI * 2);
      ctx.fillStyle = alpha(UI_TOKENS.danger, 0.2);
      ctx.fill();
      ctx.strokeStyle = UI_TOKENS.danger;
      ctx.lineWidth = 1.8 * zoom;
      ctx.stroke();

      this._drawPillBadge(ctx, msx + 18, msy - 12, [
        ...(demoLabel
          ? [{ text: 'Demolish', bold: true, color: UI_TOKENS.danger },
             { text: this._shortReason(demoLabel), color: UI_TOKENS.danger }]
          : [{ text: 'Nothing here', color: UI_TOKENS.muted }])
      ]);
    }
  }

  _drawBuilding(ctx, b, net, zoom) {
    const def = BUILDING_DEFS[b.type];
    const s = def.size * zoom;
    const [x, y] = this.worldToScreen(b.x, b.y);
    const rot = b.rot || 0;

    // driveway connector
    const dn = net.nodes.get(b.drivewayNode);
    if (dn) {
      const [dx, dy] = this.worldToScreen(dn.x, dn.y);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(dx, dy);
      ctx.lineWidth = 5 * zoom;
      ctx.strokeStyle = '#dedbcd';
      ctx.stroke();
      ctx.lineWidth = 3.4 * zoom;
      ctx.strokeStyle = '#f5f3ea';
      ctx.stroke();
    }

    const colors = {
      house: { top: '#8fc66a', side: '#6da24d', roof: '#7ab457' },
      shop: { top: '#5b8fd9', side: '#4272b5', roof: '#4f80c9' },
      factory: { top: '#9a9a97', side: '#7d7d7a', roof: '#e8975a' },
    }[b.type];

    // Orientation comes from the driveway, not from the stored cosmetic rot:
    // the ENTRY faces the road (DESIGN section 3). A building with no driveway
    // keeps its cosmetic rotation rather than snapping to a guess.
    const facing = entryAngle(b, net) ?? rot;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(facing);

    // Ground shadow, in the fixed screen direction. The offset is counter-rotated
    // because this block is inside ctx.rotate: applying (+3,+4) directly made
    // the shadow rotate with the building (fixed in S02.3b).
    const bShadow = offsetInRotatedFrame(facing, ...shadowOffset(1));
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    this._roundRect(ctx, -s / 2 + bShadow[0] * zoom, -s / 2 + bShadow[1] * zoom, s, s, 3 * zoom);
    ctx.fill();

    // side (extrusion)
    ctx.fillStyle = colors.side;
    this._roundRect(ctx, -s / 2 + 2.5 * zoom, -s / 2 + 3.5 * zoom, s, s, 3 * zoom);
    ctx.fill();

    // top face
    ctx.fillStyle = colors.top;
    this._roundRect(ctx, -s / 2, -s / 2, s, s, 3 * zoom);
    ctx.fill();

    // Silhouette details, chosen from the building ID so they survive a
    // save/load unchanged, and drawn in the entry-oriented frame so +x is the
    // door side. Unit-space shapes are scaled by the building size.
    const shapes = variantGeometry(b.type, buildingVariant(b.id));
    for (const shape of shapes) {
      ctx.fillStyle = shape.role === 'roofDark' ? colors.side
        : shape.role === 'accent' ? colors.roof
        : shape.role === 'yard' ? '#b9bd8f'
        : colors.side;
      if (shape.kind === 'rect') {
        this._roundRect(ctx,
          (shape.x - shape.w / 2) * s, (shape.y - shape.h / 2) * s,
          shape.w * s, shape.h * s, 1.5 * zoom);
        ctx.fill();
      } else if (shape.kind === 'circle') {
        ctx.beginPath();
        ctx.arc(shape.x * s, shape.y * s, Math.max(shape.r * s, 1.2 * zoom), 0, Math.PI * 2);
        ctx.fill();
      } else if (shape.kind === 'line') {
        ctx.beginPath();
        ctx.moveTo(shape.x1 * s, shape.y1 * s);
        ctx.lineTo(shape.x2 * s, shape.y2 * s);
        ctx.lineWidth = Math.max(1.2 * zoom, 1);
        ctx.strokeStyle = colors.side;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _drawCar(ctx, car, zoom) {
    const [x, y] = this.worldToScreen(car.x, car.y);
    const L = 7 * zoom, W = 3.6 * zoom;
    const dark = 'rgba(0,0,0,0.55)';
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(car.dir);
    // Drop shadow, in the same fixed screen direction as every other object.
    // Scaled down because a car is low: physical height scales the shadow.
    const cShadow = offsetInRotatedFrame(car.dir, ...shadowOffset(0.37));
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    this._roundRect(ctx, -L / 2 + cShadow[0], -W / 2 + cShadow[1], L, W, 1.2 * zoom);
    ctx.fill();
    // body
    ctx.fillStyle = car.color;
    this._roundRect(ctx, -L / 2, -W / 2, L, W, 1.3 * zoom);
    ctx.fill();
    // cabin / glass (front = +x)
    ctx.fillStyle = dark;
    this._roundRect(ctx, -L * 0.28, -W * 0.32, L * 0.42, W * 0.64, 0.8 * zoom);
    ctx.fill();
    // windshield highlight on cabin front
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    this._roundRect(ctx, L * 0.05, -W * 0.3, L * 0.1, W * 0.6, 0.5 * zoom);
    ctx.fill();
    // brake lights when stopped
    if (car.speed < 0.5 && zoom > 0.45) {
      ctx.fillStyle = '#ff5d4d';
      ctx.fillRect(-L / 2, -W / 2 + 0.5 * zoom, 0.9 * zoom, 1.1 * zoom);
      ctx.fillRect(-L / 2, W / 2 - 1.6 * zoom, 0.9 * zoom, 1.1 * zoom);
    }
    ctx.restore();
  }

  /**
   * Traffic layer: congestion as colour + line thickness + a number.
   *
   * DESIGN section 1: "Traffic overlay is colour + line thickness + numbers, not
   * red/green alone." The previous version painted a single red wash whose only
   * variable was opacity, which is unreadable in greyscale and carries no value.
   * Each band gets its own colour and casing width, and edges carrying vehicles
   * are labelled with the vehicle count, which is the number a player acts on.
   */
  _drawTrafficOverlay(ctx, net, zoom) {
    const rows = trafficOverlay(net);
    if (!rows.length) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const row of rows) {
      const edge = net.edges.get(row.edgeId);
      if (!edge) continue;
      const style = TRAFFIC_OVERLAY_STYLE[row.tone] ?? TRAFFIC_OVERLAY_STYLE.calm;
      // Thickness carries severity, so the band survives greyscale and colour
      // blindness even before the label is read.
      ctx.lineWidth = (roadDimensions(edge).width + 3 + row.level * 2.5) * zoom;
      ctx.strokeStyle = style.stroke;
      this._pathPolyline(ctx, edge.pts, zoom);
      ctx.stroke();
    }

    // Numbers only for edges that actually hold vehicles, and only when they
    // would be legible: a count on every quiet edge is noise, not information.
    if (zoom >= 0.5) {
      ctx.font = `${Math.round(11 * Math.min(zoom, 1.4))}px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const row of rows) {
        if (row.cars <= 0) continue;
        const edge = net.edges.get(row.edgeId);
        if (!edge?.pts?.length) continue;
        const mid = edge.pts[Math.floor(edge.pts.length / 2)];
        const [x, y] = this.worldToScreen(mid[0], mid[1]);
        this._drawOverlayChip(ctx, x, y, String(row.cars), TRAFFIC_OVERLAY_STYLE[row.tone].chip);
      }
    }

    ctx.restore();
  }

  /**
   * Access layer: which buildings can reach the road network and which cannot.
   *
   * `states` is the map from `accessOverlay`; the renderer only decides how to
   * show it. Buildings with no route are the actionable ones, so they get the
   * strong treatment and a ring, and reachable ones are drawn quietly.
   */
  _drawAccessOverlay(ctx, states, eco, zoom) {
    if (!states || !eco?.buildings) return;
    ctx.save();
    for (const [id, info] of states) {
      const b = eco.buildings.get(id);
      if (!b) continue;
      const [x, y] = this.worldToScreen(b.x, b.y);
      const s = (BUILDING_DEFS[b.type]?.size ?? 24) * zoom;
      const unreachable = info.state !== ACCESS_STATE.REACHABLE;
      ctx.beginPath();
      ctx.arc(x, y, s * 0.85, 0, Math.PI * 2);
      ctx.fillStyle = unreachable ? ACCESS_OVERLAY_STYLE.unreachable.fill : ACCESS_OVERLAY_STYLE.reachable.fill;
      ctx.fill();
      ctx.lineWidth = (unreachable ? 2.4 : 1.4) * zoom;
      ctx.strokeStyle = unreachable ? ACCESS_OVERLAY_STYLE.unreachable.stroke : ACCESS_OVERLAY_STYLE.reachable.stroke;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A small rounded count chip, used by the traffic layer. */
  _drawOverlayChip(ctx, x, y, text, fill) {
    const padX = 5;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 15;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = UI_TOKENS.surfaceRaised;
    ctx.fillText(text, x, y + 0.5);
  }

  _drawSelection(ctx, sel, zoom, net, eco) {
    let x, y, s;
    if (sel.kind === 'node') {
      const n = net.nodes.get(sel.id);
      if (!n) return;
      x = n.x; y = n.y; s = 30;
    } else if (sel.kind === 'building') {
      const b = eco.buildings.get(sel.id);
      if (!b) return;
      x = b.x; y = b.y; s = BUILDING_DEFS[b.type].size + 14;
    } else return;
    const [sx, sy] = this.worldToScreen(x, y);
    ctx.beginPath();
    ctx.arc(sx, sy, s * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = '#4fc08d';
    ctx.lineWidth = 2.4 * zoom;
    ctx.setLineDash([6 * zoom, 4 * zoom]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
