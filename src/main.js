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
import { menuHandlers, bindToolbarButtons } from './menuBindings.js';
import { initTemplatePanel, placeTemplateByName, templateAngleDeg, templateList } from './templatePanel.js';
import { initStartScreen } from './startScreen.js';
import { sfx, setAudioEnabled, audioEnabled, setVolumes } from './audio.js';
import { validateSettings } from './a11y.js';
import { reconcileTrafficAfterEdit } from './access.js';
import { MILESTONES } from './economy.js';
import { boundsOfWorld, fitBounds, starterRegion } from './camera.js';
import { tutorialStep, tutorialWorldSnapshot } from './tutorial.js';
import { ConstructionCursor, arrowDirection } from './construction.js';
import { createHistory, COMMAND_KIND } from './worldCommands.js';
import { evaluateRoadDraft, DRAFT_MODE } from './roadDraft.js';
import { evaluateGridDraft } from './gridDraft.js';
import { roadDimensions } from './roadProfiles.js';
import {
  UPGRADE_CLASSES, ROUNDABOUT_RADIUS,
  validateRoadUpgrade, validateRoundaboutRadius, demolitionPreview,
} from './constructionEdits.js';
import { buildingVariant } from './render/buildings.js';
import {
  pointerIntent, pushDraftPoint, PointerTracker, keyboardAction,
} from './input.js';
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
let draft = [];            // road draft control points (raw, unsnapped)
let draftRecord = null;    // the evaluated record the preview and commit share
let snapDisabled = false;  // Alt held: no snapping
let angleSnap = false;     // Shift held: angle snap to 15 degrees
let selected = null;
let camerasMoved = false;  // the first tutorial condition
let tutorialMode = false;  // true when the player chose Tutorial

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
    // S08.2 a11y settings ride settings (persisted separately from saves
    // by the save layer keying; reset-to-defaults never clears saves).
    settings: { speed, audio: audioEnabled(), master: 1, sfx: 1, uiScale: 1, reducedMotion: false },
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
  // A replaced world can carry the same net.version NUMBER as the one it
  // replaced, so every version-keyed cache must be dropped, not compared.
  accessCache = { version: -1, states: new Map() };
  renderer.resetCaches();
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
  const need = (MILESTONES[eco.level - 1] ?? eco.xp) - eco.xp;
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
// The pointer gesture is tracked in one place (src/input.js), so a lost
// pointer cannot leave the map dragging with no button held.
const pointer = new PointerTracker();
const cursor = new ConstructionCursor();
// Undo/redo over full world snapshots (S03.1). One history for the session;
// New map and Load clear it, because neither is an edit you can undo away.
const history = createHistory();
let mouseWorld = [0, 0];
let mouseScreen = [0, 0];

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [wx, wy] = renderer.screenToWorld(e.offsetX, e.offsetY);
  mouseWorld = [wx, wy];
  mouseScreen = [e.offsetX, e.offsetY];

  const intent = pointerIntent(e);
  camerasMoved = true;
  if (intent === 'pan') {
    pointer.beginPan(e.offsetX, e.offsetY, renderer.cam.x, renderer.cam.y);
    canvas.classList.add('panning');
    return;
  }
  if (intent !== 'draw') return;
  handlePrimary(wx, wy);
});

canvas.addEventListener('pointermove', (e) => {
  const [wx, wy] = renderer.screenToWorld(e.offsetX, e.offsetY);
  mouseWorld = [wx, wy];
  mouseScreen = [e.offsetX, e.offsetY];
  if (draft.length && !pointer.isPanning) refreshDraftRecord([wx, wy]);
  if (pointer.isPanning) {
    const cam = pointer.panTo(e.offsetX, e.offsetY, renderer.cam.zoom);
    if (cam) { renderer.cam.x = cam.x; renderer.cam.y = cam.y; }
  }
});

canvas.addEventListener('pointerup', () => {
  pointer.endPan();
  canvas.classList.remove('panning');
});

// A lost pointer must end whatever gesture was in progress, or the map drags
// with no button held. pointercancel and lost capture are definitive (the
// gesture was interrupted), so they also discard an unfinished road draft;
// a window blur is not (the user may come back and continue).
canvas.addEventListener('pointercancel', () => {
  pointer.cancel();
  draft = [];
  canvas.classList.remove('panning');
});
canvas.addEventListener('lostpointercapture', () => {
  pointer.cancel();
  canvas.classList.remove('panning');
});
window.addEventListener('blur', () => {
  pointer.cancel();
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
  camerasMoved = true;
  Object.assign(renderer.cam, renderer.zoomAt(e.offsetX, e.offsetY, renderer.cam.zoom * factor));
}, { passive: false });

/**
 * Applies one command atomically, reconciles live traffic, and publishes the
 * result through the single `replaceWorld` boundary.
 *
 * The command never mutates the live world: it works on a hydrated copy and
 * returns it, so a refusal leaves the world exactly as it was (CONTRACTS 4.6).
 *
 * @param {{kind:string}} cmd a JSON command record
 * @param {{reselect?:boolean}} [opts] `reselect` re-opens the inspector for the
 *   current selection after publishing, so an edit that leaves the entity
 *   intact (a signal change) does not dismiss the panel the player is in.
 * @returns {object|null} the successful result, or null when refused
 */
function runCommand(cmd, { reselect = false } = {}) {
  const sel = selected;
  const result = history.execute(getWorld(), cmd);
  if (!result.ok) {
    toast(result.reason, 'warn');
    return null;
  }

  // Reconcile BEFORE publishing: a car must never be left referencing an edge
  // or building that the edit removed.
  const c = result.change;
  if (c.removedEdgeIds.length || c.removedBuildingIds.length) {
    reconcileTrafficAfterEdit(result.world.traffic, {
      removedEdgeIds: c.removedEdgeIds,
      removedBuildingIds: c.removedBuildingIds,
    });
  }

  replaceWorld(result.world);
  // replaceWorld clears `dirty` because it also adopts loaded worlds; an edit
  // is unsaved by definition.
  dirty = true;
  if (reselect) reselectEntity(sel);
  updateBatchUI();
  updateHistoryButtons();
  return result;
}

/**
 * Re-opens the inspector for a selection after the world was replaced.
 * Does nothing when the entity is gone, so a deleted thing stays deleted.
 */
function reselectEntity(sel) {
  if (!sel) return;
  if (sel.kind === 'node') {
    const node = net.nodes.get(sel.id);
    if (!node) return;
    selected = sel;
    if (node.type === 'light') openLightInspect(node);
    return;
  }
  if (sel.kind === 'building') {
    const b = eco.buildings.get(sel.id);
    if (!b) return;
    selected = sel;
    openBuildingInspect(b);
    return;
  }
  if (sel.kind === 'edge') {
    const e = net.edges.get(sel.id);
    if (!e) return;
    selected = sel;
    openRoadInspect(e);
  }
}

/**
 * Rewinds the world and the simulation to the snapshot taken before the last
 * edit, and pauses. Time cannot be rewound, so the game must stop rather than
 * pretend the edit was undone while the clock kept running.
 */
function undo() {
  const cam = { ...renderer.cam };
  const result = history.undo(getWorld());
  if (!result.ok) { toast(result.reason, 'warn'); return; }
  replaceWorld(result.world);
  // The camera stays where the player left it: only simulation and inventory
  // are rewound.
  Object.assign(renderer.cam, cam);
  setSpeed(0);
  dirty = true;
  updateBatchUI();
  updateHistoryButtons();
  toast('City restored to before edit; paused.');
}

/** Restores the state the most recent undo moved away from. */
function redo() {
  const cam = { ...renderer.cam };
  const result = history.redo(getWorld());
  if (!result.ok) { toast(result.reason, 'warn'); return; }
  replaceWorld(result.world);
  Object.assign(renderer.cam, cam);
  setSpeed(0);
  dirty = true;
  updateBatchUI();
  updateHistoryButtons();
  toast('Edit restored; paused.');
}

/** Keeps the toolbar buttons honest about what is available. */
function updateHistoryButtons() {
  const u = document.getElementById('undobtn');
  const r = document.getElementById('redobtn');
  if (u) u.disabled = history.depth === 0;
  if (r) r.disabled = !history.canRedo;
}

/**
 * Re-evaluates the current draft into the one record the preview and the
 * commit both use. Called whenever the draft or the pointer moves, so what is
 * drawn is always what would be built.
 */
function refreshDraftRecord(mouseAt) {
  if (!draft.length) { draftRecord = null; return; }
  const points = mouseAt ? [...draft, mouseAt] : draft;
  draftRecord = evaluateRoadDraft(getWorld(), {
    points,
    cls: roadClass(),
    mode: DRAFT_MODE.CURVE,
    snap: !snapDisabled,
    angleSnap,
    zoom: renderer.cam.zoom,
  });
}

function handlePrimary(wx, wy) {
  switch (ui.activeTool) {
    case 'road': case 'avenue': case 'highway': {
      // Deduplicated: the second pointerdown of a double-click lands on the
      // same pixel as the first, and a zero-length final segment would be
      // built into the road.
      cursor.show(wx, wy);
      draft = pushDraftPoint(draft, wx, wy);
      refreshDraftRecord();
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
  if (draft.length < 2) { draft = []; draftRecord = null; return; }
  // Evaluate WITHOUT the hover point: the draft points are what was clicked.
  refreshDraftRecord();
  const record = draftRecord;
  if (!record || !record.ok) {
    // An invalid draft is RETAINED so the player can fix it, and the reason is
    // shown rather than the draft silently vanishing (S03.2 item 6).
    toast(record?.reason ?? 'the road cannot be built there', 'warn');
    return;
  }
  // Commit the SAME geometry that was previewed, not a re-derived spline.
  const result = runCommand({
    kind: COMMAND_KIND.ADD_ROAD,
    controls: record.controls,
    cls: roadClass(),
    pts: record.polyline,
  });
  if (result) sfx.place();
  draft = []; draftRecord = null; cursor.hide();
}

function placeRoundabout(x, y) {
  const n = net._snapNode(x, y);
  if (!n) { toast('Place roundabouts on a road junction (build roads first).', 'warn'); return; }
  const result = runCommand({ kind: COMMAND_KIND.MAKE_ROUNDABOUT, nodeId: n.id });
  if (result) {
    sfx.place();
    toast('Roundabout built — traffic circulates counterclockwise.');
  }
}

function placeLight(x, y) {
  const n = net._snapNode(x, y);
  if (!n) { toast('Place traffic lights on a road junction.', 'warn'); return; }
  if (n.type === 'light') { openLightInspect(n); selected = { kind: 'node', id: n.id }; return; }
  const result = runCommand({
    kind: COMMAND_KIND.SET_SIGNAL,
    nodeId: n.id,
    light: { cycle: 14, greenRatio: 0.42, offset: 0 },
  });
  if (result) {
    sfx.place();
    selected = { kind: 'node', id: n.id };
    openLightInspect(result.world.net.nodes.get(n.id));
  }
}

function openLightInspect(n) {
  const L = n.light;
  openInspect('Traffic light', `
    <div class="row"><span>Connections</span><span class="v">${n.edges.size}</span></div>
    <label for="sliderCycle">Cycle length</label> <span id="vCycle">${L.cycle.toFixed(0)}s</span></label>
    <input type="range" id="sliderCycle" data-key="cycle" min="8" max="60" step="1" aria-label="Cycle length in seconds" value="${L.cycle}">
    <label for="sliderGreen">Green ratio</label> <span id="vGreen">${(L.greenRatio * 100).toFixed(0)}%</span></label>
    <input type="range" id="sliderGreen" data-key="greenRatio" min="0.25" max="0.6" step="0.01" aria-label="Green ratio, 25 to 60 percent" value="${L.greenRatio}">
    <label for="sliderOffset">Offset</label> <span id="vOffset">${L.offset.toFixed(0)}s</span></label>
    <input type="range" id="sliderOffset" data-key="offset" min="0" max="${L.cycle}" step="0.5" aria-label="Phase offset in seconds" value="${L.offset}">
    <label style="color:var(--muted);font-size:12px">Green wave: match offsets along an artery.</label>
  `, (key, val) => {
    if (key === 'cycle') { L.cycle = val; document.getElementById('vCycle').textContent = val + 's'; }
    if (key === 'greenRatio') { L.greenRatio = val; document.getElementById('vGreen').textContent = (val * 100).toFixed(0) + '%'; }
    if (key === 'offset') { L.offset = val; document.getElementById('vOffset').textContent = val + 's'; }
  }, 'light');

  // `input` gives immediate feedback; `change` fires once on release and
  // records ONE undoable command, rather than one per pixel of movement.
  document.getElementById('insBody').querySelectorAll('input[type=range]').forEach(inp => {
    inp.addEventListener('change', () => {
      const live = net.nodes.get(n.id)?.light;
      if (!live) return;
      runCommand({ kind: COMMAND_KIND.SET_SIGNAL, nodeId: n.id, light: { ...live } }, { reselect: true });
    });
  });
}

function placeBuilding(type, x, y) {
  // The stock reason is spelled out by the command layer; a depleted tool keeps
  // its progression hint from the dock's context line (DESIGN section 1).
  if (!eco.canPlace(type)) { toast(depletionMessage(type), 'warn'); return; }
  const result = runCommand({ kind: COMMAND_KIND.PLACE_BUILDING, type, x, y });
  if (result) sfx.place();
}

function bulldoze(x, y) {
  // building?
  for (const b of eco.buildings.values()) {
    if (dist(x, y, b.x, b.y) < BUILDING_DEFS[b.type].size * 0.8) {
      if (runCommand({ kind: COMMAND_KIND.REMOVE_BUILDING, id: b.id })) sfx.bulldoze();
      return;
    }
  }
  // node?
  const n = net._snapNode(x, y);
  const nodeHitR = 14 / renderer.cam.zoom;
  if (n && dist(x, y, n.x, n.y) < nodeHitR) {
    const isRing = n.isRing || (n.edges.size && [...n.edges].some(eid => net.edges.get(eid)?.ring));
    if (isRing) {
      // Bulldozing any part of a roundabout removes the whole ring, and the
      // command refuses anything that is not a ring.
      if (runCommand({ kind: COMMAND_KIND.REMOVE_ROUNDABOUT, nodeId: n.id })) {
        sfx.bulldoze();
        toast('Roundabout removed.');
      }
    } else if (n.type === 'driveway' && n.buildingIds?.length) {
      // Refunding through removeBuilding reads the type from the building
      // record, so a shop can no longer refund a house.
      if (runCommand({ kind: COMMAND_KIND.REMOVE_BUILDING, id: n.buildingIds[0] })) sfx.bulldoze();
    } else if (runCommand({ kind: COMMAND_KIND.REMOVE_NODE, nodeId: n.id })) {
      sfx.bulldoze();
    }
    return;
  }
  // edge?
  let best = null, bd = 10 / renderer.cam.zoom;
  for (const e of net.edges.values()) {
    const { s, d } = projectDist(e, x, y);
    if (d < bd) { bd = d; best = e; }
  }
  if (best) {
    const isRing = !!best.ring;
    const cmd = isRing
      ? { kind: COMMAND_KIND.REMOVE_ROUNDABOUT, nodeId: best.a }
      : { kind: COMMAND_KIND.REMOVE_ROAD, edgeId: best.id };
    if (runCommand(cmd)) {
      sfx.bulldoze();
      toast(isRing ? 'Roundabout removed.' : 'Road removed.');
    }
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

/**
 * The building inspector, in one place so a re-selection after an edit shows
 * exactly the same panel as a fresh click.
 */
function openBuildingInspect(b) {
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
}

/**
 * The road inspector: what the road is, and the in-place upgrade controls.
 *
 * An upgrade keeps the edge ID and its topology, so active cars keep their
 * routes. Every option is validated BEFORE the click, so a disabled button
 * carries the reason it is unavailable rather than failing on commit.
 */
function openRoadInspect(edge) {
  const dim = roadDimensions(edge);
  const arrows = dim.backward > 0 ? `${dim.forward} ⇄ ${dim.backward}` : `${dim.forward} → one-way`;
  let rows = '';
  for (const cls of UPGRADE_CLASSES) {
    const current = cls === edge.cls;
    const check = current ? null : validateRoadUpgrade(getWorld(), edge.id, cls);
    const why = current ? 'already this class' : (check.ok ? '' : check.reason);
    const dis = current || !check.ok;
    rows += '<button class="menu-btn" data-upgrade="' + cls + '"'
      + (dis ? ' disabled' : '')
      + ' style="width:100%;justify-content:center;border:1px solid var(--line);'
      + 'border-radius:var(--radius-sm);margin-top:4px'
      + (dis ? ';opacity:.55' : '') + '">'
      + cls.charAt(0).toUpperCase() + cls.slice(1)
      + (current ? ' (current)' : '') + '</button>';
    if (why) {
      rows += '<div class="row"><span style="color:var(--muted);font-size:11px">'
        + why + '</span></div>';
    }
  }

  openInspect(edge.cls.charAt(0).toUpperCase() + edge.cls.slice(1) + ' road', ''
    + '<div class="row"><span>Lanes</span><span class="v">'
    + (dim.forward + dim.backward) + ` (${arrows})` + '</span></div>'
    + '<div class="row"><span>Access</span><span class="v">'
    + dim.access + (edge.oneway ? ' · one-way a→b' : '') + '</span></div>'
    + '<div class="row"><span>Width</span><span class="v">'
    + dim.width.toFixed(0) + ' wu</span></div>'
    + '<div class="row"><span>Speed</span><span class="v">'
    + dim.speed + ' wu/s</span></div>'
    + '<div class="row"><span>Length</span><span class="v">'
    + edge.total.toFixed(0) + ' wu</span></div>'
    + '<label>Upgrade in place</label>'
    + rows, undefined, 'road');

  document.getElementById('insBody').querySelectorAll('[data-upgrade]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cls = btn.dataset.upgrade;
      const result = runCommand(
        { kind: COMMAND_KIND.UPGRADE_ROAD, edgeId: edge.id, cls },
        { reselect: true },
      );
      if (!result) return;
      sfx.place();
      const live = net.edges.get(edge.id);
      if (live) openRoadInspect(live);
    });
  });
}

function select(x, y) {
  // building first
  for (const b of eco.buildings.values()) {
    if (dist(x, y, b.x, b.y) < BUILDING_DEFS[b.type].size * 0.9) {
      selected = { kind: 'building', id: b.id };
      openBuildingInspect(b);
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
  // An edge: the road inspector, which is also where upgrades live.
  let best = null;
  let bd = 10 / renderer.cam.zoom;
  for (const e of net.edges.values()) {
    if (!Array.isArray(e.pts) || e.pts.length < 2) continue;
    let nearest = Infinity;
    for (let i = 1; i < e.pts.length; i++) {
      nearest = Math.min(nearest, distToSegment(x, y, e.pts[i - 1], e.pts[i]));
    }
    if (nearest < bd) { bd = nearest; best = e; }
  }
  if (best) {
    selected = { kind: 'edge', id: best.id };
    openRoadInspect(best);
    return;
  }

  selected = null;
  closeInspect();
}

/** Distance from a point to a segment, for edge hit testing. */
function distToSegment(px, py, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  let tt = len2 > 0 ? ((px - a[0]) * abx + (py - a[1]) * aby) / len2 : 0;
  tt = clamp(tt, 0, 1);
  return Math.hypot(px - (a[0] + abx * tt), py - (a[1] + aby * tt));
}

// ---------- keyboard ----------
// Snapping modifiers. Held, not toggled, so releasing restores the default.
window.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') snapDisabled = false;
  if (e.key === 'Shift') angleSnap = false;
  if (draft.length) refreshDraftRecord();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Alt' && !snapDisabled) { snapDisabled = true; if (draft.length) refreshDraftRecord(); }
  if (e.key === 'Shift' && !angleSnap) { angleSnap = true; if (draft.length) refreshDraftRecord(); }
  // The scoping decision is pure (src/input.js): which target, which scope,
  // which key. Order matters - a form control always wins, then Escape, then
  // whatever dialog or panel is open, then the individual keys.
  const result = keyboardAction(e, {
    dialog: ui.dialog,
    panel: ui.openPanel,
    hasDraft: draft.length >= 2,
  });
  if (result.preventDefault) e.preventDefault();

  // Keyboard construction cursor: arrows move the virtual pointer when a draft is open.
  if (draft.length > 0) {
    const dir = arrowDirection(e.key);
    if (dir) { cursor.move(dir, e.shiftKey); e.preventDefault(); return; }
  }
  switch (result.action) {
    case 'escape': escape(); return;
    case 'fit': fitCity(); return;
    case 'finish-road': finishRoad(); return;
    case 'toggle-speed': setSpeed(speed === 0 ? 1 : 0); return;
    case 'draft-back':
      // Only while drawing, and never below one point.
      if (draft.length) {
        draft = draft.slice(0, -1);
        refreshDraftRecord();
        sfx.click();
      }
      return;
    case 'bulldoze': setTool('bulldoze'); return;
    case 'undo': undo(); return;
    case 'redo': redo(); return;
    case 'none': return;
  }

  // A possible tool shortcut: main.js owns the key-to-tool mapping.
  const t = TOOLS.find(t => t.key === e.key);
  if (t) { setTool(t.id); return; }
});

/** Escape cancels the innermost thing that is open, and nothing else. */
function escape() {
  if (ui.dialog) { closeHelp(); return; }
  if (ui.openPanel === 'menu') { showPanel(null); return; }
  if (draft.length) { draft = []; draftRecord = null; cursor.hide(); return; }
  if (inspectOpen()) { closeInspect(); return; }
  // Otherwise keep the current tool — deliberate: Esc no longer jumps to Select.
}

// ---------- speed ----------
function setSpeed(s) {
  speed = s;
  menuCtl?.applySpeed(s);
}

// ---------- menu and inspector ----------
// DOM bindings live in menuBindings.js / templatePanel.js / startScreen.js.
// main.js keeps world logic; the boot ctx is the only bridge.

/**
 * Applies the sound setting to the audio module AND the control that shows it.
 *
 * Declared as a function so `replaceWorld` — which appears earlier in this file
 * — can call it: hoisting makes the order irrelevant, and `menu` is initialised
 * before boot runs.
 */
/**
 * Reads the live world and updates the tutorial banner.
 * Called from the main loop, so the step advances when the condition is met.
 */
function updateTutorial() {
  if (!tutorialMode) return;
  const snap = tutorialWorldSnapshot({ net, eco, camerasMoved });
  const r = tutorialStep(snap);
  const banner = document.getElementById('tutorialBanner');
  const label = document.getElementById('tutorialLabel');
  if (!banner || !label) return;
  banner.hidden = r.done;
  label.textContent = r.done ? 'Tutorial complete!' : `Step ${r.index + 1}/5: ${r.label}`;
}

let menuCtl = null;
function applyAudio(enabled) {
  setAudioEnabled(enabled);
  // S08.2: volumes from validated settings; invalid values keep prior mix.
  const v = validateSettings({
    master: getWorld()?.settings?.master ?? 1,
    sfx: getWorld()?.settings?.sfx ?? 1,
    uiScale: getWorld()?.settings?.uiScale ?? 1,
  });
  if (v.ok) {
    setVolumes(v.settings.master, v.settings.sfx);
    document.documentElement.style.setProperty('--ui-scale', String(v.settings.uiScale));
    document.body.classList.toggle('reduced-motion', !!getWorld()?.settings?.reducedMotion);
  }
  menuCtl?.applySound(enabled);
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
    updateTutorial();
  }

  renderer.draw({
    net, traffic, eco, terrain,
    preview: draft,
    draftRecord,
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

  // DOM bindings: menu/toolbar, template panel, start screen.
  // ctx is the only bridge — no world logic leaves main.js.
  const ctx = {
    getWorld, replaceWorld, newGame, loadFromSave, runCommand, undo, redo,
    fitCity, updateHistoryButtons, updateTutorial,
    setSpeed, applyAudio,
    isSoundEnabled: () => audioEnabled(),
    isDirty: () => dirty,
    clearDirty: () => { dirty = false; },
    clearHistory: () => history.clear(),
    setTutorialMode: (v) => { tutorialMode = v; },
    camPos: () => ({ x: renderer.cam.x, y: renderer.cam.y }),
  };
  menuCtl = initMenu(menuHandlers(ctx));
  bindToolbarButtons(ctx);
  initTemplatePanel(ctx);
  initStartScreen(ctx);

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
    get draftRecord() { return draftRecord; },
    get accessStates() { return currentAccessStates(); },
    // Framing, so browser tests can assert the starter view and Fit without
    // reaching into renderer internals.
    frameStarter,
    fitCity,
    get camera() { return { ...renderer.cam }; },
    get terrainStats() { return renderer.terrainStats(); },
    // The silhouette selector, so a test can assert what will be drawn.
    buildingVariant,
    get tutorial() { return tutorialStep(tutorialWorldSnapshot({ net, eco, camerasMoved })); },
    // Undo/redo, so browser tests drive the real controls' target functions.
    undo,
    redo,
    runCommand,
    grid: { evaluateGridDraft },
    demolitionPreview: (x, y) => demolitionPreview(getWorld(), x, y),
    templates: {
      list: () => templateList(),
      angle: () => templateAngleDeg(),
      place: (name) => placeTemplateByName(name, ctx),
    },
    ROUNDABOUT_RADIUS,
    validateRoadUpgrade: (id, cls) => validateRoadUpgrade(getWorld(), id, cls),
    validateRoundaboutRadius: (id, r) => validateRoundaboutRadius(getWorld(), id, r),
    get history() { return { depth: history.depth, bytes: history.bytes, canRedo: history.canRedo, truncated: history.truncated }; },
    save: { saveGame, loadGame, hasSave, hasRecoverableBackup, recoverFromBackup, importGame, exportGame, exportFilename },
    replaceWorld,
  };
  openHelp();
  requestAnimationFrame(loop);
}

boot();

