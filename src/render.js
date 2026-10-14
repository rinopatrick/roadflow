// Canvas renderer — flat top-down "living map" style: soft terrain, white
// roads with yellow centerlines, extruded pastel buildings, colored cars.
import { BIOME } from './terrain.js';
import { pointAt, clamp, dist, makeRng, splinePoints } from './core.js';
import { ROAD_CLASS } from './roadNetwork.js';
import { roadDimensions } from './roadProfiles.js';
import { getLegacyPhase } from './signals.js';
import { BUILDING_DEFS } from './economy.js';
import { UI_TOKENS, alpha } from './uiTokens.js';

const WORLD_EXTENT = 3200;   // terrain rendered over [-E, E]
const TERRAIN_RES = 1024;    // offscreen resolution

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
    this.showCongestion = false;
    this.showPollution = false;
    this._terrain = null;
    this._terrainSeed = null;
    this._dpr = 1;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
  }

  worldToScreen(x, y) {
    const { cam } = this;
    return [
      (x - cam.x) * cam.zoom * this._dpr + this.canvas.width / 2,
      (y - cam.y) * cam.zoom * this._dpr + this.canvas.height / 2,
    ];
  }

  screenToWorld(sx, sy) {
    const { cam } = this;
    return [
      (sx * this._dpr - this.canvas.width / 2) / (cam.zoom * this._dpr) + cam.x,
      (sy * this._dpr - this.canvas.height / 2) / (cam.zoom * this._dpr) + cam.y,
    ];
  }

  // ---------- terrain ----------
  buildTerrain(terrain) {
    const res = TERRAIN_RES;
    const off = document.createElement('canvas');
    off.width = res; off.height = res;
    const c = off.getContext('2d');
    const img = c.createImageData(res, res);
    const E = WORLD_EXTENT;
    const rng = makeRng(terrain.seed ^ 0x9e3779b9);

    for (let py = 0; py < res; py++) {
      for (let px = 0; px < res; px++) {
        const wx = (px / res) * 2 * E - E;
        const wy = (py / res) * 2 * E - E;
        const b = terrain.sample(wx, wy);
        let col;
        if (b === BIOME.WATER) {
          const n = terrain.elevation(wx, wy);
          col = n < 0.22 ? PALETTE.water2 : PALETTE.water;
        } else if (b === BIOME.SAND) col = PALETTE.sand;
        else if (b === BIOME.ROCK) {
          // elevation-shaded rock with high-frequency dithering (no flat blob)
          const v = terrain.elevation(wx, wy);
          const t = clamp((v - 0.7) / 0.22, 0, 1);
          const n = terrain.elevation(wx * 7 + 13.7, wy * 7 - 7.3);
          col = mixHex(PALETTE.rock, PALETTE.rock2, clamp(t * 0.85 + (n - 0.5) * 0.3, 0, 1));
        }
        else {
          col = PALETTE.grass;
          // subtle grass tone variation
          const v = terrain.elevation(wx, wy);
          if (v > 0.62) col = PALETTE.grass2;
        }
        const i = (py * res + px) * 4;
        img.data[i] = parseInt(col.slice(1, 3), 16);
        img.data[i + 1] = parseInt(col.slice(3, 5), 16);
        img.data[i + 2] = parseInt(col.slice(5, 7), 16);
        img.data[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);

    // decorative blobby patches (dark grey "forests/rocks", olive fields)
    const blobs = [];
    for (let i = 0; i < 36; i++) {
      const wx = (rng() * 2 - 1) * E * 0.9;
      const wy = (rng() * 2 - 1) * E * 0.9;
      if (terrain.sample(wx, wy) !== BIOME.GRASS) continue;
      const kind = rng() < 0.6 ? 'patch' : 'patch2';
      const r = 70 + rng() * 170;
      const blob = { x: wx, y: wy, r, kind, trees: null };
      if (kind === 'patch') {
        // forests render as clusters of tree dots instead of a flat ellipse
        blob.trees = [];
        const n = 10 + Math.floor(rng() * 12);
        for (let k = 0; k < n; k++) {
          const a = rng() * Math.PI * 2;
          const rr = Math.sqrt(rng()) * r * 0.85;
          blob.trees.push([
            Math.cos(a) * rr,
            Math.sin(a) * rr * 0.72,
            (6 + rng() * 9),
            rng() < 0.5,
          ]);
        }
      }
      blobs.push(blob);
    }
    this._blobs = blobs;
    this._terrain = off;
    this._terrainSeed = terrain.seed;
  }

  // ---------- main draw ----------
  draw(state) {
    const { ctx, canvas } = this;
    const { net, traffic, eco, terrain, preview } = state;
    if (!this._terrain || this._terrainSeed !== terrain.seed) this.buildTerrain(terrain);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PALETTE.water2;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const [ox, oy] = this.worldToScreen(0, 0);
    const zoom = this.cam.zoom * this._dpr;

    // terrain (scaled offscreen, smooth)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._terrain, ox - WORLD_EXTENT * zoom, oy - WORLD_EXTENT * zoom, WORLD_EXTENT * 2 * zoom, WORLD_EXTENT * 2 * zoom);

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

    // roads — three passes so junction areas merge cleanly like Trafficity:
    // soft shadow, then every casing, then every fill on top covering the
    // crossing casings (outlines never cut through junction interiors).
    for (const edge of net.edges.values()) this._drawEdgeShadow(ctx, edge, zoom);
    for (const edge of net.edges.values()) this._drawEdgeCasing(ctx, edge, zoom);
    for (const edge of net.edges.values()) this._drawEdgeFill(ctx, edge, zoom);

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

    // overlays
    if (this.showCongestion) this._drawCongestion(ctx, net, zoom);
    if (this.showPollution) this._drawPollution(ctx, eco, zoom);

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
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = edge.cls === 'highway' ? PALETTE.highwayOutline : PALETTE.roadOutline;
    ctx.stroke();
  }

  _drawEdgeShadow(ctx, edge, zoom) {
    const d = roadDimensions(edge);
    const pts = edge.pts;
    if (!pts || pts.length < 2) return;
    this._pathPolyline(ctx, pts, zoom);
    ctx.lineWidth = Math.max(d.width * zoom, 3.2) + Math.max(2.4 * zoom, 1);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(60, 58, 50, 0.18)';
    ctx.stroke();
  }

  _drawEdgeFill(ctx, edge, zoom) {
    const cls = roadDimensions(edge);
    const pts = edge.pts;
    if (!pts || pts.length < 2) return;

    // fill (round caps extend half-width past the node, covering casing stubs)
    // clamp: keep roads readable as white ribbons when zoomed far out
    const w = Math.max(cls.width * zoom, 3.2);
    this._pathPolyline(ctx, pts, zoom);
    ctx.lineWidth = w;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = PALETTE.road;
    ctx.stroke();

    // trim markings back from both ends so they never cross junction mouths
    const trim = cls.width * 0.75 + 3;

    // Lane divider dashes, positioned by the same lane-centre model that places
    // vehicles, so a dash always sits exactly between two lanes.
    if (cls.forward + cls.backward > 2 && cls.medianWidth > 0) {
      for (let i = 1; i < cls.forward; i++) {
        const off = cls.medianWidth / 2 + i * cls.laneWidth;
        for (const sgn of [1, -1]) {
          this._pathOffsetPolyline(ctx, pts, off * sgn, zoom);
          ctx.lineWidth = 1.1 * zoom;
          ctx.setLineDash([6 * zoom, 6 * zoom]);
          ctx.strokeStyle = '#d8d5ca';
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    } else if (cls.forward + cls.backward === 2 && cls.medianWidth > 0) {
      // two-lane two-way road: the median IS the centreline, drawn below
    }

    // yellow centreline (solid, Trafficity-style), trimmed at junction mouths.
    // Omitted on one-way roads, which have no centre division.
    if (cls.medianWidth > 0) {
      this._pathPolylineTrimmed(ctx, pts, edge.cum, trim, zoom);
      ctx.lineWidth = 1.2 * zoom;
      ctx.strokeStyle = PALETTE.centerline;
      ctx.stroke();
    }
  }

  _pathPolylineTrimmed(ctx, pts, cum, trim, zoom) {
    ctx.beginPath();
    const total = cum[cum.length - 1];
    const endTrim = total - trim;
    let started = false;
    for (let k = 0; k < pts.length; k++) {
      const s = cum[k];
      if (s < trim || s > endTrim) continue;
      const [x, y] = this.worldToScreen(pts[k][0], pts[k][1]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
  }

  _pathOffsetPolyline(ctx, pts, off, zoom) {
    ctx.beginPath();
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const pd = (k < pts.length - 1)
        ? Math.atan2(pts[k + 1][1] - p[1], pts[k + 1][0] - p[0])
        : Math.atan2(p[1] - pts[k - 1][1], p[0] - pts[k - 1][0]);
      const nx = Math.sin(pd) * off, ny = -Math.cos(pd) * off;
      const [sx, sy] = this.worldToScreen(p[0] + nx, p[1] + ny);
      if (k === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
  }

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

  _drawToolPreviews(ctx, state, zoom) {
    const { tool, preview, mouseWorld, mouseScreen, net, terrain, eco } = state;
    if (!mouseWorld) return;
    const [mx, my] = mouseWorld;
    const [msx, msy] = mouseScreen || this.worldToScreen(mx, my);

    if (tool === 'road' || tool === 'avenue' || tool === 'highway') {
      const cls = roadDimensions({ cls: tool === 'avenue' ? 'avenue' : tool === 'highway' ? 'highway' : 'street' });
      const roadW = cls.width * zoom;

      // When actively drafting points
      if (preview && preview.length >= 1) {
        // spline the draft so preview matches the built road's shape
        const draftPts = preview.length >= 2 ? splinePoints(preview, 12).pts : preview;
        // Polyline connecting previous points
        ctx.beginPath();
        const [x0, y0] = this.worldToScreen(draftPts[0][0], draftPts[0][1]);
        ctx.moveTo(x0, y0);
        for (let i = 1; i < draftPts.length; i++) {
          const [px, py] = this.worldToScreen(draftPts[i][0], draftPts[i][1]);
          ctx.lineTo(px, py);
        }
        ctx.lineWidth = roadW;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = alpha(UI_TOKENS.accent, 0.45); // translucent accent ribbon
        ctx.stroke();

        // Rubberband line to mouse cursor — danger when crossing water/rock
        const lastP = preview[preview.length - 1];
        const [lx, ly] = this.worldToScreen(lastP[0], lastP[1]);
        const curOk = terrain.isRoadable(mx, my);
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(msx, msy);
        ctx.lineWidth = roadW;
        ctx.lineCap = 'round';
        ctx.strokeStyle = curOk ? alpha(UI_TOKENS.accent, 0.55) : alpha(UI_TOKENS.danger, 0.5);
        ctx.stroke();

        // Accent control point nodes — danger when placed on invalid terrain
        for (const p of preview) {
          const [px, py] = this.worldToScreen(p[0], p[1]);
          const ok = terrain.isRoadable(p[0], p[1]);
          ctx.beginPath();
          ctx.arc(px, py, 4 * zoom, 0, Math.PI * 2);
          ctx.fillStyle = ok ? UI_TOKENS.accent : UI_TOKENS.danger;
          ctx.fill();
          ctx.strokeStyle = UI_TOKENS.surfaceRaised;
          ctx.lineWidth = 1.5 * zoom;
          ctx.stroke();
        }

        // Calculate approximate cost and length
        let len = 0;
        for (let i = 1; i < preview.length; i++) {
          len += dist(preview[i-1][0], preview[i-1][1], preview[i][0], preview[i][1]);
        }
        len += dist(lastP[0], lastP[1], mx, my);
        const cost = Math.max(50, Math.round(len * 2));

        const isRoadable = terrain.isRoadable(mx, my);
        const parts = isRoadable
          ? [{ text: `$${cost}`, bold: true }, { text: tool.charAt(0).toUpperCase() + tool.slice(1), color: UI_TOKENS.muted }]
          : [{ text: `Cannot build`, error: true, bold: true }, { text: `Water / Rock`, color: UI_TOKENS.danger }];

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
      const canPlace = eco.canPlace(tool);
      const isRoadable = terrain.isRoadable(mx, my);

      ctx.save();
      ctx.translate(msx, msy);
      ctx.fillStyle = isRoadable && canPlace ? alpha(UI_TOKENS.accent, 0.4) : alpha(UI_TOKENS.danger, 0.4);
      ctx.strokeStyle = isRoadable && canPlace ? UI_TOKENS.accent : UI_TOKENS.danger;
      ctx.lineWidth = 1.5 * zoom;
      this._roundRect(ctx, -s / 2, -s / 2, s, s, 3 * zoom);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      const plural = tool === 'factory' ? 'factories' : tool + 's';
      const parts = !canPlace
        ? [{ text: `No ${plural} left`, error: true, bold: true }]
        : !isRoadable
        ? [{ text: `Invalid terrain`, error: true, bold: true }]
        : [{ text: def.label, bold: true }, { text: `Available: ${eco.batch[tool] || 0}`, color: UI_TOKENS.muted }];

      this._drawPillBadge(ctx, msx + s / 2 + 12, msy - 10, parts);
    } else if (tool === 'bulldoze') {
      // Bulldoze highlight ring
      ctx.beginPath();
      ctx.arc(msx, msy, 14 * zoom, 0, Math.PI * 2);
      ctx.fillStyle = alpha(UI_TOKENS.danger, 0.2);
      ctx.fill();
      ctx.strokeStyle = UI_TOKENS.danger;
      ctx.lineWidth = 1.8 * zoom;
      ctx.stroke();

      this._drawPillBadge(ctx, msx + 18, msy - 12, [
        { text: 'Demolish', bold: true, color: UI_TOKENS.danger }
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

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);

    // ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    this._roundRect(ctx, -s / 2 + 3 * zoom, -s / 2 + 4 * zoom, s, s, 3 * zoom);
    ctx.fill();

    // side (extrusion)
    ctx.fillStyle = colors.side;
    this._roundRect(ctx, -s / 2 + 2.5 * zoom, -s / 2 + 3.5 * zoom, s, s, 3 * zoom);
    ctx.fill();

    // top face
    ctx.fillStyle = colors.top;
    this._roundRect(ctx, -s / 2, -s / 2, s, s, 3 * zoom);
    ctx.fill();

    if (b.type === 'factory') {
      // orange roof stripes
      ctx.fillStyle = colors.roof;
      for (let i = -1; i <= 1; i++) {
        this._roundRect(ctx, i * s * 0.28 - s * 0.09, -s * 0.32, s * 0.18, s * 0.64, 2 * zoom);
        ctx.fill();
      }
    }
    if (b.type === 'shop') {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      this._roundRect(ctx, -s * 0.3, -s * 0.3, s * 0.6, s * 0.18, 2 * zoom);
      ctx.fill();
    }
    if (b.type === 'house') {
      ctx.fillStyle = colors.roof;
      this._roundRect(ctx, -s * 0.28, -s * 0.28, s * 0.56, s * 0.56, 2 * zoom);
      ctx.fill();
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
    // drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    this._roundRect(ctx, -L / 2 + 1.1, -W / 2 + 1.5, L, W, 1.2 * zoom);
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

  _drawCongestion(ctx, net, zoom) {
    for (const edge of net.edges.values()) {
      const c = edge._congestion || 0;
      if (c < 0.08) continue;
      this._pathPolyline(ctx, edge.pts, zoom);
      ctx.lineWidth = (roadDimensions(edge).width + 3) * zoom;
      ctx.strokeStyle = `rgba(226,87,76,${clamp(c, 0, 0.75)})`;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  _drawPollution(ctx, eco, zoom) {
    ctx.globalCompositeOperation = 'multiply';
    for (const b of eco.buildings.values()) {
      if (b.type !== 'factory') continue;
      const [x, y] = this.worldToScreen(b.x, b.y);
      const r = 620 * zoom;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(200,190,150,0.5)');
      g.addColorStop(1, 'rgba(220,215,200,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
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
