// Roadflow — main game controller.
// A city builder focused on the fun part: roads and traffic.
import { clamp, dist, makeRng, createIdSource } from './core.js';
import { createSimulationClock } from './simulationClock.js';
import { Terrain } from './terrain.js';
import { RoadNetwork, ROAD_CLASS } from './roadNetwork.js';
import { TrafficSim } from './traffic.js';
import { Economy, BUILDING_DEFS } from './economy.js';
import { Renderer } from './render.js';
import { toast, openInspect, closeInspect, inspectOpen, showPanel } from './ui.js';
import { mountIcons } from './icons.js';
import { saveGame, loadGame, hasSave, hasRecoverableBackup, recoverFromBackup, autosave, importGame, exportGame, exportFilename, AUTOSAVE_INTERVAL_MS } from './save.js';
import { sfx, setAudioEnabled, audioEnabled } from './audio.js';
import { reconcileTrafficAfterEdit } from './access.js';
import { LEVEL_XP } from './economy.js';
import { boundsOfWorld, fitBounds, starterRegion } from './camera.js';
import { trafficOverlay, accessOverlay, accessSummary, ACCESS_STATE, TRAFFIC_BANDS } from './layers.js';
import { ui } from './ui/controller.js';
import { buildToolbar, setTool, TOOLS } from './ui/toolbar.js';
import { createHud } from './ui/hud.js';
import { initMenu, openHelp, closeHelp } from './ui/menu.js';
import { initLayers } from './ui/layers.js';

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);

// ---- game state ----
let terrain, net, traffic, eco;
let ids = createIdSource();   // world-owned ID source (deterministic, collision-free)
let speed = 1;
let draft = [];            // road draft control points
let selected = null;

// `dirty` means the player has built something that is not in their own save.
// Autosave deliberately does NOT clear it: the autosave slot is a safety net,
// not the player's save, so discarding the city still deserves a prompt.
let dirty = false;

// The active tool lives in exactly one place — the UI controller. There is no
// local mirror here, which is what used to let the dock, the canvas cursor and
// the inspector disagree.
const hud = createHud(() => ({ eco, traffic, net }));

// Access reachability is recomputed only when the graph changes, because it
// walks the road network once per building.
let accessCache = { version: -1, states: new Map() };
function currentAccessStates() {
  if (accessCache.version !== net.version) {
    accessCache = { version: net.version, states: accessOverlay({ net, eco }) };
  }
  return accessCache.states;
}

// Assigned in boot(); module scope so the economy-driven refreshers can reach it.
let dock = null;
// NOTE: deliberately no separate `simTime` here. `traffic.time` is the single
// simulation clock (CONTRACTS.md section 2). A second counter is what allowed
// the renderer to display a phase the simulator was not obeying (EVIDENCE E04).

function newGame(seed = (() => {
  const p = new URLSearchParams(location.search).get('seed');
  return p ? (parseInt(p, 10) || 0) : (Math.random() * 1e9) | 0;
})()) {
  const worldIds = createIdSource();
  const worldNet = new RoadNetwork({ ids: worldIds });
  // Simulation randomness is seeded from the same seed as the terrain, so a
  // seed fully determines the world rather than only its geography.
  const worldTraffic = new TrafficSim(worldNet, { rng: makeRng(seed) });
  const worldEco = new Economy(worldNet, new Terrain(seed), seed);

  replaceWorld({
    terrain: worldEco.terrain,
    net: worldNet,
    traffic: worldTraffic,
    eco: worldEco,
    ids: worldIds,
    camera: renderer.cam,
    settings: { speed, audio: audioEnabled() },
  });

  // A fresh map is framed on its starter region, not on the origin: the origin
  // is water on some seeds.
  frameStarter(terrain);
}

/**
 * Frames the deterministic buildable starter region.
 *
 * `starterRegion` searches a 200 wu grid for a 600x400 wu rectangle that is at
 * least 80% buildable, nearest the origin, and reports a bounded fallback when
 * no such area exists. A fallback is told to the player rather than hidden,
 * because the map really is restricted.
 */
function frameStarter(terrain) {
  const region = starterRegion(terrain);
  renderer.cam.x = region.x;
  renderer.cam.y = region.y;
  renderer.cam.zoom = 1;
  if (region.fallback) toast(region.reason, 'warn');
  return region;
}

/**
 * Frames everything the player has built, with margin and a minimum span.
 * An empty city falls back to the starter region rather than framing nothing.
 */
function fitCity() {
  const bounds = boundsOfWorld(getWorld());
  if (!bounds) { frameStarter(terrain); return; }
  Object.assign(renderer.cam, fitBounds(bounds, renderer.view()));
}

/**
 * Assembles the canonical runtime world (CONTRACTS.md section 2).
 * `camera` is the live renderer camera, since the renderer is a view rather
 * than persisted state.
 */
function getWorld() {
  return {
    terrain, net, traffic, eco, ids,
    camera: renderer.cam,
    settings: { speed, audio: audioEnabled() },
  };
}

/**
 * Replaces the live world in ONE place.
 *
 * Every caller that used to assign `terrain`/`net`/`traffic`/`eco` separately
 * goes through here, so callbacks are rebound exactly once and no closure can be
 * left pointing at a previous world.
 */
function replaceWorld(world) {
  terrain = world.terrain;
  net = world.net;
  traffic = world.traffic;
  eco = world.eco;
  ids = world.ids;

  // The renderer holds `cam` by reference; copy the values into it so existing
  // references stay valid instead of being replaced.
  if (world.camera) Object.assign(renderer.cam, world.camera);
  if (world.settings) {
    // Both settings are applied through the same path the controls use, so the
    // visible state cannot disagree with the world after a load or import.
    // `applyAudio` used to be skipped here: the audio module was updated but the
    // button was not, so a loaded muted save showed "Sound on".
    setSpeed(world.settings.speed ?? 1);
    applyAudio(world.settings.audio !== false);
  }

  bindWorldCallbacks();
  selected = null;
  dirty = false;   // a freshly adopted world has no unsaved edits
  clock.reset();
  closeInspect();
  renderer.buildTerrain(terrain);
  updateBatchUI();
  hud.update(true);
}

/** Reattaches behaviour that cannot be serialized. Called once per world. */
function bindWorldCallbacks() {
  eco.onLevelUp = (lvl) => {
    toast(`City leveled up — level ${lvl}! New buildings granted.`, 'warn');
    sfx.levelUp();
  };
  eco.onToast = (m, k) => toast(m, k);
}

/**
 * Loads a saved city.
 *
 * Returns true on success. On failure the CURRENT WORLD IS LEFT UNTOUCHED and
 * the reason is surfaced to the player: the v1 code called `newGame()` on any
 * failure and then showed a "City loaded." success toast.
 */
function loadFromSave({ source = 'manual' } = {}) {
  const result = source === 'backup'
    ? recoverFromBackup({ hooks: {} })
    : loadGame({ hooks: {} });

  if (!result.ok) {
    toast(result.error, 'warn');
    return false;
  }

  replaceWorld(result.world);
  if (result.warnings?.length) {
    toast(`City loaded with ${result.warnings.length} note${result.warnings.length === 1 ? '' : 's'}.`, 'warn');
  }
  return true;
}

// ---------- inventory and progression ----------

/** "houses" / "shops" / "factories" */
function pluralOf(type) {
  return type === 'factory' ? 'factories' : type + 's';
}

/**
 * Why a placement was refused, and how to get more.
 *
 * DESIGN section 1: an unavailable choice must give a reason and a progression
 * link, not just be greyed out. The numbers come from the live economy, so the
 * message states the real level and the real XP still required.
 */
function depletionMessage(type) {
  const label = BUILDING_DEFS[type]?.label?.toLowerCase() ?? type;
  const need = LEVEL_XP(eco.level) - eco.xp;
  const next = `Level ${eco.level + 1} grants more`;
  return need > 0
    ? `No ${pluralOf(label)} left — ${next} (${Math.max(0, Math.round(need))} XP to go).`
    : `No ${pluralOf(label)} left — ${next}.`;
}

/** The context-help line for the active tool, including any inventory shortfall. */
function describeTool(id) {
  const tool = TOOLS.find(t => t.id === id);
  if (!tool) return '';
  const isBuilding = id === 'house' || id === 'shop' || id === 'factory';
  if (isBuilding && (eco?.batch?.[id] ?? 0) <= 0) {
    return `${depletionMessage(id)}  (${tool.key})`;
  }
  return `${tool.label} — ${tool.hint}  (${tool.key})`;
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
  const t = ui.activeTool;
  if (t === 'road' || t === 'avenue' || t === 'highway') finishRoad();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0012);
  // Solved directly from the pointer position, so the world point under the
  // cursor is fixed and repeated zooming cannot accumulate drift.
  Object.assign(renderer.cam, renderer.zoomAt(e.offsetX, e.offsetY, renderer.cam.zoom * factor));
}, { passive: false });

function handlePrimary(wx, wy) {
  switch (ui.activeTool) {
    case 'road': case 'avenue': case 'highway': {
      draft.push([wx, wy]);
      sfx.road();
      break;
    }
    case 'roundabout': placeRoundabout(wx, wy); break;
    case 'light': placeLight(wx, wy); break;
    case 'house': case 'shop': case 'factory': placeBuilding(ui.activeTool, wx, wy); break;
    case 'bulldoze': bulldoze(wx, wy); break;
    case 'select': select(wx, wy); break;
  }
}

function roadClass() {
  const t = ui.activeTool;
  return t === 'avenue' ? 'avenue' : t === 'highway' ? 'highway' : 'street';
}

function finishRoad() {
  if (draft.length < 2) { draft = []; return; }
  const cls = roadClass();
  // validate buildable
  for (const [x, y] of draft) {
    if (!terrain.isRoadable(x, y)) { toast('Roads can\'t cross water or rock!', 'warn'); return; }
  }
  const res = net.addRoad(draft, cls);
  if (res.edgeIds.length) { sfx.place(); dirty = true; }
  draft = [];
}

function placeRoundabout(x, y) {
  const n = net._snapNode(x, y);
  if (!n) { toast('Place roundabouts on a road junction (build roads first).', 'warn'); return; }
  if (n.isRing) { toast('That junction is already a roundabout.', 'warn'); return; }
  const res = net.makeRoundabout(n.id);
  if (!res) { toast('That junction can\'t take a roundabout.', 'warn'); return; }
  sfx.place();
  dirty = true;
  toast('Roundabout built — traffic circulates counterclockwise.');
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
  dirty = true;
  net.version++;
  openLightInspect(n);
  selected = { kind: 'node', id: n.id };
}

function openLightInspect(n) {
  const L = n.light;
  openInspect('Traffic light', `
    <div class="row"><span>Connections</span><span class="v">${n.edges.size}</span></div>
    <label>Cycle length <span id="vCycle">${L.cycle.toFixed(0)}s</span></label>
    <input type="range" data-key="cycle" min="8" max="60" step="1" value="${L.cycle}">
    <label>Green ratio <span id="vGreen">${(L.greenRatio * 100).toFixed(0)}%</span></label>
    <input type="range" data-key="greenRatio" min="0.25" max="0.6" step="0.01" value="${L.greenRatio}">
    <label>Offset <span id="vOffset">${L.offset.toFixed(0)}s</span></label>
    <input type="range" data-key="offset" min="0" max="${L.cycle}" step="0.5" value="${L.offset}">
    <label style="color:var(--muted);font-size:12px">Green wave: match offsets along an artery.</label>
  `, (key, val) => {
    if (key === 'cycle') { L.cycle = val; document.getElementById('vCycle').textContent = val + 's'; }
    if (key === 'greenRatio') { L.greenRatio = val; document.getElementById('vGreen').textContent = (val * 100).toFixed(0) + '%'; }
    if (key === 'offset') { L.offset = val; document.getElementById('vOffset').textContent = val + 's'; }
  }, 'light');
}

function placeBuilding(type, x, y) {
  if (!eco.canPlace(type)) {
    // The control stays selectable so this reason is reachable, and the reason
    // names the way forward rather than only the refusal (DESIGN section 1).
    toast(depletionMessage(type), 'warn');
    return;
  }
  const b = eco.place(type, x, y);
  if (!b) {
    toast(type === 'house' ? 'Can\'t place here — needs buildable land near a road.' : 'Can\'t place here (blocked, or no road within reach).', 'warn');
    return;
  }
  // b.rot is assigned by Economy.place() from its seeded RNG, so it is
  // reproducible for a given seed rather than re-randomised here.
  sfx.place();
  dirty = true;
  updateBatchUI();
}

function bulldoze(x, y) {
  // building?
  for (const b of eco.buildings.values()) {
    if (dist(x, y, b.x, b.y) < BUILDING_DEFS[b.type].size * 0.8) {
      eco.remove(b.id);
      eco.batch[b.type] = (eco.batch[b.type] || 0) + 1;
      reconcileTraffic([], [b.id]);
      sfx.bulldoze();
      dirty = true;
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
      dirty = true;
      toast('Roundabout removed.');
    } else if (n.type === 'driveway' && n.buildingIds?.length) {
      // Read the type BEFORE removing, so the refund matches what was destroyed.
      // The previous version wrote `eco.batch[eco.buildings.get ? 'house' : 'house']++`,
      // which is always 'house': bulldozing a shop or factory via its driveway
      // refunded a house.
      const ownerId = n.buildingIds[0];
      const owner = eco.buildings.get(ownerId);
      if (owner) {
        const refundType = owner.type;
        eco.remove(ownerId);
        eco.batch[refundType] = (eco.batch[refundType] || 0) + 1;
        reconcileTraffic([], [ownerId]);
        dirty = true;
        updateBatchUI();
      }
    } else {
      net.removeNode(n.id);
      dirty = true;
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
    // Capture affected edges/buildings BEFORE removing, so traffic can be
    // reconciled instead of silently losing every car that used them.
    const removedEdgeIds = [best.ring ? [...net.edges.values()].filter(e => e.ring).map(e => e.id) : best.id].flat();
    if (best.ring) {
      net.removeRoundabout(best.a);
      toast('Roundabout removed.');
    } else {
      net.removeEdge(best.id);
      toast('Road removed.');
    }
    reconcileTraffic(removedEdgeIds);
    sfx.bulldoze();
    dirty = true;
  }
}

/**
 * Reconciles the traffic simulation after a live edit so no trip is silently
 * lost: cars still on a legal route keep driving, others are rerouted, and the
 * rest are cancelled once with a recorded reason.
 */
function reconcileTraffic(removedEdgeIds = [], removedBuildingIds = []) {
  if (!removedEdgeIds.length && !removedBuildingIds.length) return;
  const report = reconcileTrafficAfterEdit(traffic, { removedEdgeIds, removedBuildingIds });
  if (report.cancelled.length) {
    toast(`${report.cancelled.length} trip${report.cancelled.length === 1 ? '' : 's'} cancelled by the edit.`, 'warn');
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
      openInspect(def.label, `
        <div class="row"><span>Position</span><span class="v">${b.x.toFixed(0)}, ${b.y.toFixed(0)}</span></div>
        ${b.residents ? `<div class="row"><span>Residents</span><span class="v">${b.residents}</span></div>` : ''}
        ${b.jobs ? `<div class="row"><span>Jobs</span><span class="v">${b.jobs}</span></div>` : ''}
        ${b.type === 'house' ? `
          <div class="row"><span>Reach shop</span><span class="v">${reachShop ? 'Yes' : 'No'}</span></div>
          <div class="row"><span>Reach work</span><span class="v">${reachWork ? 'Yes' : 'No'}</span></div>` : ''}
      `, undefined, b.type);
      return;
    }
  }
  const n = net._snapNode(x, y);
  if (n && dist(x, y, n.x, n.y) < 16 / renderer.cam.zoom) {
    selected = { kind: 'node', id: n.id };
    if (n.type === 'light') { openLightInspect(n); return; }
    const names = { plain: 'Junction', roundabout: 'Roundabout', driveway: 'Driveway', light: 'Traffic light' };
    if (n.isRing) {
      openInspect('Roundabout', `
        <div class="row"><span>Ring connections</span><span class="v">${n.edges.size}</span></div>
        <div class="row"><span>Type</span><span class="v">One-way, counterclockwise</span></div>
      `, undefined, 'roundabout');
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
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

  if (e.key === 'Escape') { escape(); return; }
  // A modal owns the keyboard, so a shortcut can never edit the city beneath it.
  if (ui.dialog) return;

  if (e.key === 'f' || e.key === 'F') { fitCity(); return; }

  const t = TOOLS.find(t => t.key === e.key);
  if (t) { setTool(t.id); return; }
  if (e.key === 'Enter' && draft.length >= 2) { finishRoad(); return; }
  if (e.key === ' ') {
    e.preventDefault();
    setSpeed(speed === 0 ? 1 : 0);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { setTool('bulldoze'); return; }
});

/** Escape cancels the innermost thing that is open, and nothing else. */
function escape() {
  if (ui.dialog) { closeHelp(); return; }
  if (ui.openPanel === 'menu') { showPanel(null); return; }
  if (draft.length) { draft = []; return; }
  if (inspectOpen()) { closeInspect(); return; }
  // Otherwise keep the current tool — deliberate: Esc no longer jumps to Select.
}

// ---------- speed ----------
function setSpeed(s) {
  speed = s;
  menu.applySpeed(s);
}

// ---------- menu and inspector ----------
const menu = initMenu({
  onSpeed: setSpeed,
  isSoundEnabled: () => audioEnabled(),
  onSound: (enabled) => {
    applyAudio(enabled);
    if (enabled) sfx.click();
  },
  onSave: () => {
    const res = saveGame(getWorld());
    // Report what actually happened. The v1 handler printed "City saved." for a
    // boolean, but the failure branch was easy to miss.
    if (res.ok) dirty = false;
    toast(res.ok ? 'City saved.' : `Save failed — ${res.error}`, res.ok ? '' : 'warn');
    sfx.click();
  },
  onExport: () => {
    // A download, not a silent clipboard write: the player asked for a file and
    // gets one they can see.
    try {
      const text = exportGame(getWorld());
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFilename();
      a.click();
      // Revoked on the next tick so the download has started.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast('City exported.');
    } catch (err) {
      toast(`Export failed — ${err.message}`, 'warn');
    }
    sfx.click();
  },
  onImport: (text, filename) => {
    // A failed import must leave the current city exactly as it was. `importGame`
    // validates before it builds anything, and `replaceWorld` is only reached on
    // success.
    if (!text) { toast(`Could not read ${filename}.`, 'warn'); return; }
    const result = importGame(text, {});
    if (!result.ok) {
      toast(`Import failed — ${result.error}. The current city is unchanged.`, 'warn');
      return;
    }
    replaceWorld(result.world);
    toast(`Imported ${filename}.`);
    sfx.click();
  },
  onLoad: () => {
    // Distinguish "nothing saved" from "saved but damaged". The v1 handler
    // checked only existence, so a corrupt save reported "No save found.", which
    // is misleading and hid the fact that a backup may be recoverable.
    const probe = loadGame({ hooks: {} });
    if (!probe.ok && probe.empty) { toast('No save found.', 'warn'); return; }
    if (!probe.ok) {
      const hint = hasRecoverableBackup() ? ' Try Recover.' : '';
      toast(`${probe.error}.${hint}`, 'warn');
      return;
    }
    // Valid: adopt it. `loadFromSave` re-reads so the hooks are wired by
    // replaceWorld rather than by this probe.
    if (loadFromSave()) toast('City loaded.');
    sfx.click();
  },
  onRecover: () => {
    if (!hasRecoverableBackup()) { toast('No backup is available to recover.', 'warn'); return; }
    if (loadFromSave({ source: 'backup' })) toast('Recovered the previous save.');
    sfx.click();
  },
  onNewMap: () => {
    // Only interrupt when there is something to lose (DESIGN section 1).
    if (dirty && !confirm('Start a new map? Unsaved progress is lost.')) return;
    newGame();
    toast('New map generated.');
  },
});

document.getElementById('inspectClose').addEventListener('click', closeInspect);
document.getElementById('fitbtn').addEventListener('click', () => {
  fitCity();
  sfx.click();
});

/**
 * Applies the sound setting to the audio module AND the control that shows it.
 *
 * Declared as a function so `replaceWorld` — which appears earlier in this file
 * — can call it: hoisting makes the order irrelevant, and `menu` is initialised
 * before boot runs.
 */
function applyAudio(enabled) {
  setAudioEnabled(enabled);
  menu.applySound(enabled);
}

// ---------- layers ----------
const layersUI = initLayers();

/** Real counts for the active legend, so it reports the city, not a key. */
function refreshLegend() {
  if (ui.overlay === null) return;
  const stats = {};
  if (ui.overlay === 'traffic') {
    const counts = {};
    for (const band of TRAFFIC_BANDS) counts[`band-${band.level}`] = 0;
    for (const row of trafficOverlay(net)) counts[`band-${row.level}`]++;
    stats.traffic = counts;
  } else if (ui.overlay === 'access') {
    const summary = accessSummary(currentAccessStates());
    stats.access = {
      [ACCESS_STATE.REACHABLE]: summary.reachable,
      [ACCESS_STATE.UNREACHABLE]: summary.unreachable,
    };
  }
  layersUI.refresh(stats);
}

// ---------- HUD ----------
// Rendering the status band lives in src/ui/hud.js. Only the inventory badges
// stay here, because they are the dock's own display of economy stock.
function updateBatchUI() {
  // One stock source: the toolbar badges are the only inventory display. The
  // hidden #batch container that duplicated these numbers was removed with its
  // last reader.
  for (const type of ['house', 'shop', 'factory']) {
    const badge = document.getElementById('badge_' + type);
    if (!badge) continue;
    const stock = eco.batch[type] || 0;
    badge.textContent = stock;
    badge.closest('.tool-btn')?.classList.toggle('depleted', stock === 0);
  }
  // The context-help line reports an inventory shortfall, so it has to follow
  // stock too — otherwise it keeps advertising a tool that has run out.
  dock?.refresh();
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
    updateBatchUI();
    refreshLegend();
  }

  renderer.draw({
    net, traffic, eco, terrain,
    preview: draft,
    mouseWorld,
    mouseScreen,
    tool: ui.activeTool,
    simTime: traffic.time,
    selected,
    overlay: ui.overlay,
    accessStates: ui.overlay === 'access' ? currentAccessStates() : null,
  });
  hud.update();

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

  // The active tool is published to the canvas class from ONE subscription, so
  // the cursor and the dock cannot drift apart.
  //
  // `uiReady` gates the click sound: the boot-time selection below is not a user
  // gesture, and creating an AudioContext before one is blocked by the browser.
  let uiReady = false;
  const applyTool = (id) => {
    draft = [];                 // switching tools abandons any road draft
    canvas.className = 'tool-' + id;
  };
  applyTool(ui.activeTool);
  ui.subscribe((state, changed) => {
    if (!changed.includes('activeTool')) return;
    applyTool(state.activeTool);
    if (uiReady) sfx.click();
  });

  mountIcons();
  dock = buildToolbar({ describeTool });
  setTool('road');
  uiReady = true;

  // Re-render the dock when inventory changes, so the depletion reason and the
  // badges cannot lag behind the economy.
  ui.subscribe(() => { refreshLegend(); });

  // Recovery is only offered when a VALID backup exists, so the button cannot
  // promise something it cannot deliver.
  document.getElementById('btnRecover').hidden = !hasRecoverableBackup();

  // Never start a new city automatically. If a save exists but is unreadable, the
  // player is told and gets a fresh map deliberately, rather than silently.
  if (hasSave()) {
    if (confirm('A saved city was found. Load it?')) {
      if (!loadFromSave()) newGame();
    } else {
      newGame();
    }
  } else {
    newGame();
  }

  // Autosave into its own slot, so it can never overwrite a manual save.
  setInterval(() => {
    const res = autosave(getWorld());
    if (!res.ok && !res.error?.includes('unavailable')) {
      toast(`Autosave failed — ${res.error}`, 'warn');
    }
  }, AUTOSAVE_INTERVAL_MS);

  // debug/testing hook
  // `renderer` and `save` are exposed so browser tests can set the camera
  // precisely and exercise storage directly. Read/write only; gameplay never
  // reads from __rf.
  window.__rf = {
    get state() { return { net, eco, traffic, terrain }; },
    get renderer() { return renderer; },
    get world() { return getWorld(); },
    // The UI controller, so browser tests can assert the single owner rather
    // than infer it from CSS classes.
    get ui() { return ui; },
    get draftLength() { return draft.length; },
    get accessStates() { return currentAccessStates(); },
    // Framing, so browser tests can assert the starter view and Fit without
    // reaching into renderer internals.
    frameStarter,
    fitCity,
    get camera() { return { ...renderer.cam }; },
    save: { saveGame, loadGame, hasSave, hasRecoverableBackup, recoverFromBackup, importGame, exportGame, exportFilename },
    replaceWorld,
  };
  openHelp();
  requestAnimationFrame(loop);
}

boot();

