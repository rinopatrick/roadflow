// Temporary patcher: replace the inline input handlers with src/input.js.
//
// The file is CRLF, so matching happens on a normalised copy and the original
// line endings are restored on write.
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/main.js';
const raw = readFileSync(path, 'utf8');
const crlf = raw.includes('\r\n');
let t = raw.replace(/\r\n/g, '\n');

let n = 0;
const rep = (from, to) => {
  if (!t.includes(from)) throw new Error(`pattern not found:\n${from.slice(0, 160)}`);
  t = t.replace(from, to);
  n++;
};

// 1. Import the input module.
rep(
  "import { buildingVariant } from './render/buildings.js';",
  "import { buildingVariant } from './render/buildings.js';\n"
  + "import {\n"
  + "  pointerIntent, pushDraftPoint, PointerTracker, keyboardAction,\n"
  + "} from './input.js';",
);

// 2. Replace the pointer handlers and the draw/pan state.
rep(
  "let panning = false;\n"
  + "let panStart = null;",
  "let panning = false;   // legacy name kept for the one reader below\n"
  + "// The pointer gesture is tracked in one place (src/input.js), so a lost\n"
  + "// pointer cannot leave the map dragging with no button held.\n"
  + "const pointer = new PointerTracker();",
);

rep(
  "canvas.addEventListener('pointerdown', (e) => {\n"
  + "  canvas.setPointerCapture(e.pointerId);\n"
  + "  const [wx, wy] = renderer.screenToWorld(e.offsetX, e.offsetY);\n"
  + "  mouseWorld = [wx, wy];\n"
  + "  mouseScreen = [e.offsetX, e.offsetY];\n"
  + "\n"
  + "  if (e.button === 1 || e.button === 2 || e.shiftKey) {\n"
  + "    panning = true;\n"
  + "    panStart = { sx: e.offsetX, sy: e.offsetY, cx: renderer.cam.x, cy: renderer.cam.y };\n"
  + "    canvas.classList.add('panning');\n"
  + "    return;\n"
  + "  }\n"
  + "  if (e.button !== 0) return;\n"
  + "  handlePrimary(wx, wy);\n"
  + "});",
  "canvas.addEventListener('pointerdown', (e) => {\n"
  + "  canvas.setPointerCapture(e.pointerId);\n"
  + "  const [wx, wy] = renderer.screenToWorld(e.offsetX, e.offsetY);\n"
  + "  mouseWorld = [wx, wy];\n"
  + "  mouseScreen = [e.offsetX, e.offsetY];\n"
  + "\n"
  + "  const intent = pointerIntent(e);\n"
  + "  if (intent === 'pan') {\n"
  + "    pointer.beginPan(e.offsetX, e.offsetY, renderer.cam.x, renderer.cam.y);\n"
  + "    canvas.classList.add('panning');\n"
  + "    return;\n"
  + "  }\n"
  + "  if (intent !== 'draw') return;\n"
  + "  handlePrimary(wx, wy);\n"
  + "});",
);

rep(
  "  if (panning && panStart) {\n"
  + "    renderer.cam.x = panStart.cx - (e.offsetX - panStart.sx) / (renderer.cam.zoom);\n"
  + "    renderer.cam.y = panStart.cy - (e.offsetY - panStart.sy) / (renderer.cam.zoom);\n"
  + "  }",
  "  if (pointer.isPanning) {\n"
  + "    const cam = pointer.panTo(e.offsetX, e.offsetY, renderer.cam.zoom);\n"
  + "    if (cam) { renderer.cam.x = cam.x; renderer.cam.y = cam.y; }\n"
  + "  }",
);

rep(
  "canvas.addEventListener('pointerup', () => {\n"
  + "  panning = false;\n"
  + "  panStart = null;\n"
  + "  canvas.classList.remove('panning');\n"
  + "});",
  "canvas.addEventListener('pointerup', () => {\n"
  + "  pointer.endPan();\n"
  + "  canvas.classList.remove('panning');\n"
  + "});\n\n"
  + "// A lost pointer must end whatever gesture was in progress, or the map drags\n"
  + "// with no button held. pointercancel and lost capture are definitive (the\n"
  + "// gesture was interrupted), so they also discard an unfinished road draft;\n"
  + "// a window blur is not (the user may come back and continue).\n"
  + "canvas.addEventListener('pointercancel', () => {\n"
  + "  pointer.cancel();\n"
  + "  draft = [];\n"
  + "  canvas.classList.remove('panning');\n"
  + "});\n"
  + "canvas.addEventListener('lostpointercapture', () => {\n"
  + "  pointer.cancel();\n"
  + "  canvas.classList.remove('panning');\n"
  + "});\n"
  + "window.addEventListener('blur', () => {\n"
  + "  pointer.cancel();\n"
  + "  canvas.classList.remove('panning');\n"
  + "});",
);

// 3. Road draft points are deduplicated, so a double-click finaliser cannot add
//    a zero-length segment.
rep(
  "    case 'road': case 'avenue': case 'highway': {\n"
  + "      draft.push([wx, wy]);\n"
  + "      sfx.road();\n"
  + "      break;\n"
  + "    }",
  "    case 'road': case 'avenue': case 'highway': {\n"
  + "      // Deduplicated: the second pointerdown of a double-click lands on the\n"
  + "      // same pixel as the first, and a zero-length final segment would be\n"
  + "      // built into the road.\n"
  + "      draft = pushDraftPoint(draft, wx, wy);\n"
  + "      sfx.road();\n"
  + "      break;\n"
  + "    }",
);

// 4. Replace the inline keyboard handler with the scoped decision.
rep(
  "window.addEventListener('keydown', (e) => {\n"
  + "  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;\n"
  + "\n"
  + "  if (e.key === 'Escape') { escape(); return; }\n"
  + "  // A modal owns the keyboard, so a shortcut can never edit the city beneath it.\n"
  + "  if (ui.dialog) return;\n"
  + "\n"
  + "  if (e.key === 'f' || e.key === 'F') { fitCity(); return; }\n"
  + "\n"
  + "  const t = TOOLS.find(t => t.key === e.key);\n"
  + "  if (t) { setTool(t.id); return; }\n"
  + "  if (e.key === 'Enter' && draft.length >= 2) { finishRoad(); return; }\n"
  + "  if (e.key === ' ') {\n"
  + "    e.preventDefault();\n"
  + "    setSpeed(speed === 0 ? 1 : 0);\n"
  + "    return;\n"
  + "  }\n"
  + "  if (e.key === 'Delete' || e.key === 'Backspace') { setTool('bulldoze'); return; }\n"
  + "});",
  "window.addEventListener('keydown', (e) => {\n"
  + "  // The scoping decision is pure (src/input.js): which target, which scope,\n"
  + "  // which key. Order matters - a form control always wins, then Escape, then\n"
  + "  // whatever dialog or panel is open, then the individual keys.\n"
  + "  const result = keyboardAction(e, {\n"
  + "    dialog: ui.dialog,\n"
  + "    panel: ui.openPanel,\n"
  + "    hasDraft: draft.length >= 2,\n"
  + "  });\n"
  + "  if (result.preventDefault) e.preventDefault();\n"
  + "\n"
  + "  switch (result.action) {\n"
  + "    case 'escape': escape(); return;\n"
  + "    case 'fit': fitCity(); return;\n"
  + "    case 'finish-road': finishRoad(); return;\n"
  + "    case 'toggle-speed': setSpeed(speed === 0 ? 1 : 0); return;\n"
  + "    case 'bulldoze': setTool('bulldoze'); return;\n"
  + "    case 'none': return;\n"
  + "  }\n"
  + "\n"
  + "  // A possible tool shortcut: main.js owns the key-to-tool mapping.\n"
  + "  const t = TOOLS.find(t => t.key === e.key);\n"
  + "  if (t) { setTool(t.id); return; }\n"
  + "});",
);

if (crlf) t = t.replace(/\n/g, '\r\n');
writeFileSync(path, t);
console.log(`main.js: ${n} edits applied (crlf: ${crlf})`);
