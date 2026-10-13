// Roadflow — main game controller.
// A city builder focused on the fun part: roads and traffic.
import { clamp, dist, makeRng, createIdSource } from './core.js';
import { createSimulationClock } from './simulationClock.js';
import { Terrain } from './terrain.js';
import { RoadNetwork, ROAD_CLASS } from './roadNetwork.js';
import { TrafficSim } from './traffic.js';
import { Economy, BUILDING_DEFS } from './economy.js';
import { Renderer } from './render.js';
import { toast, openInspect, closeInspect, inspectOpen } from './ui.js';
import { saveGame, loadGame, hasSave, exportGame } from './save.js';
import { sfx, setAudioEnabled } from './audio.js';

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);

// ---- game state ----
let terrain, net, traffic, eco;
let ids = createIdSource();   // world-owned ID source (deterministic, collision-free)
let speed = 1;
let tool = 'road';
let draft = [];            // road draft control points
let simTime = 0;
let selected = null;
let lastHud = 0;

function newGame(seed = (() => {
  const p = new URLSearchParams(location.search).get('seed');
  return p ? (parseInt(p, 10) || 0) : (Math.random() * 1e9) | 0;
})()) {
  terrain = new Terrain(seed);
  ids = createIdSource();
  net = new RoadNetwork({ ids });
  // Simulation randomness is seeded from the same seed as the terrain, so a
  // seed fully determines the world rather than only its geography.
  traffic = new TrafficSim(net, { rng: makeRng(seed) });
  eco = new Economy(net, terrain, seed);
  eco.onLevelUp = (lvl) => { toast(`City leveled up — level ${lvl}! New buildings granted.`, 'warn'); sfx.levelUp(); };
  eco.onToast = (m, k) => toast(m, k);
  simTime = 0;
  selected = null;
  clock.reset();
  closeInspect();
  renderer.buildTerrain(terrain);
  updateBatchUI();
  updateHud(true);
}

function loadFromSave() {
  const data = loadGame();
  if (!data) { newGame(); return; }
  terrain = data.terrain;
  net = data.net;

  // Adopt a fresh ID source and reserve every loaded ID, so construction after
  // a load can never reissue an identifier that already exists in the save.
  ids = createIdSource();
  for (const id of net.nodes.keys()) ids.reserve(id);
  for (const id of net.edges.keys()) ids.reserve(id);
  // Building IDs too: loadGame() deserializes the economy before net.ids is
  // attached, so reserve them here to guarantee new placements never collide.
  for (const id of eco.buildings.keys()) ids.reserve(id);
  net.ids = ids;

  traffic = new TrafficSim(net, { rng: makeRng(data.terrain.seed) });
  traffic.time = data.simTime;
  eco = data.eco; // already deserialized by loadGame()
  eco.onLevelUp = (lvl) => { toast(`City leveled up — level ${lvl}! New buildings granted.`, 'warn'); sfx.levelUp(); };
  eco.onToast = (m, k) => toast(m, k);
  simTime = data.simTime;
  if (data.camera) renderer.cam = { ...renderer.cam, ...data.camera };
  selected = null;
  clock.reset();
  closeInspect();
  renderer.buildTerrain(terrain);
  updateBatchUI();
  updateHud(true);
}

// ---------- tools ----------
const TOOLS = [
  { id: 'road', icon: '🛣️', label: 'Road', key: '1' },
  { id: 'avenue', icon: '🛤️', label: 'Avenue', key: '2' },
  { id: 'highway', icon: '🏁', label: 'Highway', key: '3' },
  { id: 'roundabout', icon: '⭕', label: 'Roundabout', key: '4' },
  { id: 'light', icon: '🚦', label: 'Traffic light', key: '5' },
  { id: 'house', icon: '🏠', label: 'House', key: '6' },
  { id: 'shop', icon: '🏪', label: 'Shop', key: '7' },
  { id: 'factory', icon: '🏭', label: 'Factory', key: '8' },
  { id: 'bulldoze', icon: '💥', label: 'Bulldoze', key: '9' },
  { id: 'select', icon: '🔍', label: 'Select', key: '0' },
];

function buildToolbar() {
  const bar = document.getElementById('toolbar');
  bar.innerHTML = '';
  TOOLS.forEach((t, i) => {
    if (i === 3 || i === 5 || i === 8) {
      const sep = document.createElement('div');
      sep.className = 'tool-sep';
      bar.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = 'tool-btn' + (t.id === tool ? ' active' : '');
    btn.dataset.tool = t.id;
    const isBuilding = t.id === 'house' || t.id === 'shop' || t.id === 'factory';
    btn.innerHTML = `<span class="icon">${t.icon}</span><span>${t.label}</span>${isBuilding ? `<span class="tool-count" id="badge_${t.id}">0</span>` : ''}`;
    btn.title = `${t.label} (${t.key})`;
    btn.addEventListener('click', () => setTool(t.id));
    bar.appendChild(btn);
  });
}

function setTool(id) {
  tool = id;
  draft = [];
  canvas.className = 'tool-' + id;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === id));
  sfx.click();
}

// ---------- input ----------
let panning = false;
let panStart = null;
let mouseWorld = [0, 0];
let mouseScreen = [0, 0];

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [wx, wy] = renderer.screenToWorld(e.offsetX, e.offsetY);
  mouseWorld = [wx, wy];
  mouseScreen = [e.offsetX, e.offsetY];

  if (e.button === 1 || e.button === 2 || e.shiftKey) {
    panning = true;
    panStart = { sx: e.offsetX, sy: e.offsetY, cx: renderer.cam.x, cy: renderer.cam.y };
    canvas.classList.add('panning');
    return;
  }
  if (e.button !== 0) return;
  handlePrimary(wx, wy);
});

canvas.addEventListener('pointermove', (e) => {
  const [wx, wy] = renderer.screenToWorld(e.offsetX, e.offsetY);
  mouseWorld = [wx, wy];
  mouseScreen = [e.offsetX, e.offsetY];
  if (panning && panStart) {
    renderer.cam.x = panStart.cx - (e.offsetX - panStart.sx) / (renderer.cam.zoom);
    renderer.cam.y = panStart.cy - (e.offsetY - panStart.sy) / (renderer.cam.zoom);
  }
});

canvas.addEventListener('pointerup', () => {
  panning = false;
  panStart = null;
  canvas.classList.remove('panning');
});

canvas.addEventListener('dblclick', () => {
  if (tool === 'road' || tool === 'avenue' || tool === 'highway') finishRoad();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0012);
  // world point under the cursor stays fixed while zooming
  const [wx, wy] = renderer.screenToWorld(e.offsetX, e.offsetY);
  renderer.cam.zoom = clamp(renderer.cam.zoom * factor, 0.12, 5);
  const [nx, ny] = renderer.screenToWorld(e.offsetX, e.offsetY);
  renderer.cam.x += wx - nx;
  renderer.cam.y += wy - ny;
}, { passive: false });

function handlePrimary(wx, wy) {
  switch (tool) {
    case 'road': case 'avenue': case 'highway': {
      draft.push([wx, wy]);
      sfx.road();
      break;
    }
    case 'roundabout': placeRoundabout(wx, wy); break;
    case 'light': placeLight(wx, wy); break;
    case 'house': case 'shop': case 'factory': placeBuilding(tool, wx, wy); break;
    case 'bulldoze': bulldoze(wx, wy); break;
    case 'select': select(wx, wy); break;
  }
}

function roadClass() {
  return tool === 'avenue' ? 'avenue' : tool === 'highway' ? 'highway' : 'street';
}

function finishRoad() {
  if (draft.length < 2) { draft = []; return; }
  const cls = roadClass();
  // validate buildable
  for (const [x, y] of draft) {
    if (!terrain.isRoadable(x, y)) { toast('Roads can\'t cross water or rock!', 'warn'); return; }
  }
  const res = net.addRoad(draft, cls);
  if (res.edgeIds.length) sfx.place();
  draft = [];
}

function placeRoundabout(x, y) {
  const n = net._snapNode(x, y);
  if (!n) { toast('Place roundabouts on a road junction (build roads first).', 'warn'); return; }
  if (n.isRing) { toast('That junction is already a roundabout.', 'warn'); return; }
  const res = net.makeRoundabout(n.id);
  if (!res) { toast('That junction can\'t take a roundabout.', 'warn'); return; }
  sfx.place();
  toast('⭕ Roundabout built — traffic circulates counterclockwise.');
}

function placeLight(x, y) {
  const n = net._snapNode(x, y);
  if (!n) { toast('Place traffic lights on a road junction.', 'warn'); return; }
  if (n.isRing) { toast('Bulldoze the roundabout first to put a light here.', 'warn'); return; }
  if (n.type === 'light') { openLightInspect(n); return; }
  if (n.edges.size < 2) { toast('Traffic lights need at least 2 road connections.', 'warn'); return; }
  n.type = 'light';
  if (!n.light) n.light = { cycle: 14, offset: 0, greenRatio: 0.42 };
  sfx.place();
  net.version++;
  openLightInspect(n);
  selected = { kind: 'node', id: n.id };
}

function openLightInspect(n) {
  const L = n.light;
  openInspect('🚦 Traffic Light', `
    <div class="row"><span>Connections</span><span class="v">${n.edges.size}</span></div>
    <label>Cycle length <span id="vCycle">${L.cycle.toFixed(0)}s</span></label>
    <input type="range" data-key="cycle" min="8" max="60" step="1" value="${L.cycle}">
    <label>Green ratio <span id="vGreen">${(L.greenRatio * 100).toFixed(0)}%</span></label>
    <input type="range" data-key="greenRatio" min="0.25" max="0.6" step="0.01" value="${L.greenRatio}">
    <label>Offset <span id="vOffset">${L.offset.toFixed(0)}s</span></label>
    <input type="range" data-key="offset" min="0" max="${L.cycle}" step="0.5" value="${L.offset}">
    <label style="color:var(--text-dim);font-size:11px">Green wave: match offsets along an artery.</label>
  `, (key, val) => {
    if (key === 'cycle') { L.cycle = val; document.getElementById('vCycle').textContent = val + 's'; }
    if (key === 'greenRatio') { L.greenRatio = val; document.getElementById('vGreen').textContent = (val * 100).toFixed(0) + '%'; }
    if (key === 'offset') { L.offset = val; document.getElementById('vOffset').textContent = val + 's'; }
  });
}

function placeBuilding(type, x, y) {
  if (!eco.canPlace(type)) { toast(`No ${BUILDING_DEFS[type].label.toLowerCase()}s left — level up your city!`, 'warn'); return; }
  const b = eco.place(type, x, y);
  if (!b) {
    toast(type === 'house' ? 'Can\'t place here — needs buildable land near a road.' : 'Can\'t place here (blocked, or no road within reach).', 'warn');
    return;
  }
  // b.rot is assigned by Economy.place() from its seeded RNG, so it is
  // reproducible for a given seed rather than re-randomised here.
  sfx.place();
  updateBatchUI();
}

function bulldoze(x, y) {
  // building?
  for (const b of eco.buildings.values()) {
    if (dist(x, y, b.x, b.y) < BUILDING_DEFS[b.type].size * 0.8) {
      eco.remove(b.id);
      eco.batch[b.type] = (eco.batch[b.type] || 0) + 1;
      sfx.bulldoze();
      updateBatchUI();
      return;
    }
  }
  // node?
  const n = net._snapNode(x, y);
  const nodeHitR = 14 / renderer.cam.zoom;
  if (n && dist(x, y, n.x, n.y) < nodeHitR) {
    if (n.isRing || (n.edges.size && [...n.edges].some(eid => net.edges.get(eid)?.ring))) {
      // bulldozing any part of a roundabout removes the whole thing
      net.removeRoundabout(n.id);
      toast('Roundabout removed.');
    } else if (n.type === 'driveway' && n.drivewayFor) {
      eco.remove(n.drivewayFor);
      eco.batch[eco.buildings.get ? 'house' : 'house']++; // driveway buildings not in map; skip
    } else {
      net.removeNode(n.id);
    }
    sfx.bulldoze();
    net.version++;
    return;
  }
  // edge?
  let best = null, bd = 10 / renderer.cam.zoom;
  for (const e of net.edges.values()) {
    const { s, d } = projectDist(e, x, y);
    if (d < bd) { bd = d; best = e; }
  }
  if (best) {
    if (best.ring) {
      net.removeRoundabout(best.a);
      toast('Roundabout removed.');
    } else {
      net.removeEdge(best.id);
      toast('Road removed.');
    }
    sfx.bulldoze();
  }
}

function projectDist(e, x, y) {
  // distance from point to edge polyline
  let bd = Infinity;
  const pts = e.pts;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1];
    const abx = bx - ax, aby = by - ay;
    const len2 = abx * abx + aby * aby;
    let t = len2 ? ((x - ax) * abx + (y - ay) * aby) / len2 : 0;
    t = clamp(t, 0, 1);
    const d = Math.hypot(x - (ax + abx * t), y - (ay + aby * t));
    if (d < bd) bd = d;
  }
  return { d: bd };
}

function select(x, y) {
  // building first
  for (const b of eco.buildings.values()) {
    if (dist(x, y, b.x, b.y) < BUILDING_DEFS[b.type].size * 0.9) {
      selected = { kind: 'building', id: b.id };
      const def = BUILDING_DEFS[b.type];
      const reachShop = b.type === 'house' ? !!eco.findDestination(b, 'shop') : '—';
      const reachWork = b.type === 'house' ? !!eco.findDestination(b, 'factory') : '—';
      openInspect(def.icon + ' ' + def.label, `
        <div class="row"><span>Position</span><span class="v">${b.x.toFixed(0)}, ${b.y.toFixed(0)}</span></div>
        ${b.residents ? `<div class="row"><span>Residents</span><span class="v">${b.residents}</span></div>` : ''}
        ${b.jobs ? `<div class="row"><span>Jobs</span><span class="v">${b.jobs}</span></div>` : ''}
        ${b.type === 'house' ? `
          <div class="row"><span>Reach shop</span><span class="v">${reachShop ? '✅' : '❌'}</span></div>
          <div class="row"><span>Reach work</span><span class="v">${reachWork ? '✅' : '❌'}</span></div>` : ''}
      `);
      return;
    }
  }
  const n = net._snapNode(x, y);
  if (n && dist(x, y, n.x, n.y) < 16 / renderer.cam.zoom) {
    selected = { kind: 'node', id: n.id };
    if (n.type === 'light') { openLightInspect(n); return; }
    const names = { plain: 'Junction', roundabout: '⭕ Roundabout', driveway: 'Driveway', light: '🚦 Traffic light' };
    if (n.isRing) {
      openInspect('⭕ Roundabout', `
        <div class="row"><span>Ring connections</span><span class="v">${n.edges.size}</span></div>
        <div class="row"><span>Type</span><span class="v">One-way, counterclockwise</span></div>
      `);
      return;
    }
    openInspect(names[n.type] || 'Node', `
      <div class="row"><span>Connections</span><span class="v">${n.edges.size}</span></div>
    `);
    return;
  }
  selected = null;
  closeInspect();
}

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const t = TOOLS.find(t => t.key === e.key);
  if (t) { setTool(t.id); return; }
  if (e.key === 'Enter' && draft.length >= 2) { finishRoad(); return; }
  if (e.key === 'Escape') {
    if (document.getElementById('help').classList.contains('open')) {
      document.getElementById('help').classList.remove('open');
      return; // closing help must not change the tool
    }
    if (draft.length) { draft = []; return; }
    if (inspectOpen()) { closeInspect(); return; }
    return; // keep current tool — deliberate: Esc no longer jumps to Select
  }
  if (e.key === ' ') {
    e.preventDefault();
    setSpeed(speed === 0 ? 1 : 0);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { setTool('bulldoze'); return; }
});

// ---------- speed controls ----------
function setSpeed(s) {
  speed = s;
  document.querySelectorAll('.spd-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.speed) === s));
}

document.querySelectorAll('.spd-btn').forEach(b =>
  b.addEventListener('click', () => setSpeed(parseFloat(b.dataset.speed))));

// ---------- menu ----------
document.getElementById('btnSave').addEventListener('click', () => {
  toast(saveGame({ terrain, net, eco, renderer, traffic }) ? 'City saved.' : 'Save failed!', 'warn');
  sfx.click();
});
document.getElementById('btnLoad').addEventListener('click', () => {
  if (!hasSave()) { toast('No save found.', 'warn'); return; }
  loadFromSave();
  toast('City loaded.');
  sfx.click();
});
document.getElementById('btnNew').addEventListener('click', () => {
  if (!confirm('Start a new map? Unsaved progress is lost.')) return;
  newGame();
  toast('New map generated.');
});
document.getElementById('btnHelp').addEventListener('click', () => {
  document.getElementById('help').classList.add('open');
});
document.getElementById('helpClose').addEventListener('click', () => {
  document.getElementById('help').classList.remove('open');
});
document.getElementById('help').addEventListener('click', (e) => {
  if (e.target.id === 'help') document.getElementById('help').classList.remove('open');
});
document.getElementById('inspectClose').addEventListener('click', closeInspect);

// ---------- HUD ----------
function updateHud(force) {
  const now = performance.now();
  if (!force && now - lastHud < 250) return;
  lastHud = now;
  document.getElementById('hLevel').textContent = eco.level;
  const prev = eco.level > 1 ? 300 * (eco.level - 1) * (eco.level - 1) : 0;
  const next = 300 * eco.level * eco.level;
  document.getElementById('xpfill').style.width = clamp((eco.xp - prev) / (next - prev) * 100, 0, 100) + '%';
  document.getElementById('hPop').textContent = eco.population();
  document.getElementById('hTrips').textContent = eco.totalTrips;
  const avg = traffic.stats.trips ? (traffic.stats.totalTripTime / traffic.stats.trips) : 0;
  document.getElementById('hAvg').textContent = traffic.stats.trips ? avg.toFixed(0) + 's' : '—';
  // congestion: weighted avg
  let sum = 0, w = 0;
  for (const e of net.edges.values()) { const c = e._congestion || 0; sum += c; w++; }
  document.getElementById('hCong').textContent = w ? Math.round(sum / w * 100 / 0.6) + '%' : '0%';
}

function updateBatchUI() {
  const h = eco.batch.house || 0;
  const s = eco.batch.shop || 0;
  const f = eco.batch.factory || 0;
  const elH = document.getElementById('bHouse'); if (elH) elH.textContent = h;
  const elS = document.getElementById('bShop'); if (elS) elS.textContent = s;
  const elF = document.getElementById('bFactory'); if (elF) elF.textContent = f;

  const bgH = document.getElementById('badge_house');
  if (bgH) {
    bgH.textContent = h;
    bgH.closest('.tool-btn')?.classList.toggle('depleted', h === 0);
  }
  const bgS = document.getElementById('badge_shop');
  if (bgS) {
    bgS.textContent = s;
    bgS.closest('.tool-btn')?.classList.toggle('depleted', s === 0);
  }
  const bgF = document.getElementById('badge_factory');
  if (bgF) {
    bgF.textContent = f;
    bgF.closest('.tool-btn')?.classList.toggle('depleted', f === 0);
  }
}

// ---------- main loop ----------
//
// The clock converts wall time into a fixed number of STEP-sized ticks. This
// replaces `dt = rawDt * speed`, which made physics depend on frame rate and
// could inject one oversized step when the speed multiplier changed.
//
// `traffic.time` is the single simulation clock. The renderer reads it directly
// instead of a second counter that could drift out of step.
const clock = createSimulationClock((dt) => {
  traffic.update(dt);
  eco.update(dt, traffic, (from, to) => traffic.spawn(from, to));
  eco.processReturns(dt, (from, to) => traffic.spawn(from, to));
  eco.checkLevelUp();
});

let lastT = performance.now();

function loop(now) {
  const wallSeconds = (now - lastT) / 1000;
  lastT = now;

  const ticks = clock.advance(Math.max(0, wallSeconds), speed);
  if (ticks > 0) {
    simTime = traffic.time;
    updateBatchUI();
  }

  renderer.draw({
    net, traffic, eco, terrain,
    preview: draft,
    mouseWorld,
    mouseScreen,
    tool,
    simTime,
    selected,
  });
  updateHud();

  requestAnimationFrame(loop);
}

// Returning from a hidden tab must not replay the hidden period.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    clock.reset();
    lastT = performance.now();
  }
});

// ---------- boot ----------
function boot() {
  renderer.resize();
  window.addEventListener('resize', () => renderer.resize());
  buildToolbar();
  setTool('road');
  if (hasSave() && confirm('A saved city was found. Load it?')) loadFromSave();
  else newGame();
  // debug/testing hook
  window.__rf = { get state() { return { net, eco, traffic, terrain }; } };
  document.getElementById('help').classList.add('open');
  requestAnimationFrame(loop);
}

boot();

