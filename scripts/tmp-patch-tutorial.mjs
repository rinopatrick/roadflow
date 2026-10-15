// Temporary patcher: S02.6a start screen and tutorial wiring.
import { readFileSync, writeFileSync } from 'node:fs';

const crlfOf = (p) => readFileSync(p, 'utf8').includes('\r\n');
const patch = (path, edits) => {
  const raw = readFileSync(path, 'utf8');
  const crlf = raw.includes('\r\n');
  let t = raw.replace(/\r\n/g, '\n');
  let n = 0;
  for (const [from, to] of edits) {
    if (!t.includes(from)) throw new Error(`${path}: not found:\n${from.slice(0, 120)}`);
    t = t.replace(from, to);
    n++;
  }
  if (crlf) t = t.replace(/\n/g, '\r\n');
  writeFileSync(path, t);
  console.log(`${path}: ${n} edits`);
};

// --- index.html: replace the text wall with a start screen ---
patch('index.html', [
  // The help overlay becomes the start screen: three options, not a wall of text.
  [
    '    <div class="card">\n      <h2>Roadflow</h2>\n      <p>A city builder focused on the fun part: <b>roads and traffic</b>.</p>',
    '    <div class="card">\n      <h2>Roadflow</h2>\n      <p id="startPrompt">A city builder focused on the fun part: <b>roads and traffic</b>.</p>\n      <div id="startOptions" style="margin-top:14px;display:flex;flex-direction:column;gap:8px">\n        <button class="menu-btn" id="btnTutorial" style="justify-content:center;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--accent);color:var(--surface-raised);font-weight:600">Tutorial</button>\n        <button class="menu-btn" id="btnSandbox" style="justify-content:center;border:1px solid var(--line);border-radius:var(--radius-md)">Sandbox</button>\n        <button class="menu-btn" id="btnContinue" style="justify-content:center;border:1px solid var(--line);border-radius:var(--radius-md)">Continue</button>\n      </div>\n      <div id="tutorialBanner" hidden style="margin-top:12px;padding:8px 12px;background:var(--accent-soft);border-radius:var(--radius-md);font-size:13px;color:var(--ink)">\n        <span id="tutorialLabel"></span>\n        <button id="btnSkipTutorial" style="margin-left:8px;background:none;border:1px solid var(--line);border-radius:var(--radius-sm);padding:2px 8px;cursor:pointer;font-size:11px">Skip</button>\n      </div>',
  ],
  // Hide the "Let's build" button and the how-to text (they move behind the Sandbox path).
  [
    '      <p style="margin-top:10px">\n        <b>Build roads</b>',
    '      <div id="helpDetail" style="margin-top:10px">\n        <b>Build roads</b>',
  ],
  [
    '      <button id="helpClose">Let\'s build</button>',
    '      <button id="helpClose" hidden>Let\'s build</button>',
  ],
]);

// --- main.js: tutorial wiring ---
patch('src/main.js', [
  // Import the tutorial module.
  [
    "import { boundsOfWorld, fitBounds, starterRegion } from './camera.js';",
    "import { boundsOfWorld, fitBounds, starterRegion } from './camera.js';\n"
    + "import { tutorialStep, tutorialWorldSnapshot } from './tutorial.js';",
  ],
  // Track whether the camera has moved (the first tutorial condition).
  [
    "let selected = null;\n\n// `dirty` means",
    "let selected = null;\n"
    + "let camerasMoved = false;  // the first tutorial condition\n"
    + "let tutorialMode = false;  // true when the player chose Tutorial\n\n"
    + "// `dirty` means",
  ],
  // Mark camerasMoved on any camera change (pan or zoom).
  [
    "  if (intent === 'pan') {\n    pointer.beginPan(e.offsetX, e.offsetY, renderer.cam.x, renderer.cam.y);",
    "  camerasMoved = true;\n  if (intent === 'pan') {\n    pointer.beginPan(e.offsetX, e.offsetY, renderer.cam.x, renderer.cam.y);",
  ],
  [
    "  Object.assign(renderer.cam, renderer.zoomAt(e.offsetX, e.offsetY, renderer.cam.zoom * factor));",
    "  camerasMoved = true;\n  Object.assign(renderer.cam, renderer.zoomAt(e.offsetX, e.offsetY, renderer.cam.zoom * factor));",
  ],
  // Start-screen button handlers: Tutorial, Sandbox, Continue.
  [
    "document.getElementById('fitbtn').addEventListener('click', () => {\n    fitCity();\n    sfx.click();\n  });",
    "document.getElementById('fitbtn').addEventListener('click', () => {\n    fitCity();\n    sfx.click();\n  });\n\n"
    + "  // Start screen: three options (DESIGN section 6).\n"
    + "  document.getElementById('btnTutorial')?.addEventListener('click', () => {\n"
    + "    tutorialMode = true;\n"
    + "    showStartScreen(false);\n"
    + "    updateTutorial();\n"
    + "    sfx.click();\n"
    + "  });\n"
    + "  document.getElementById('btnSandbox')?.addEventListener('click', () => {\n"
    + "    tutorialMode = false;\n"
    + "    showStartScreen(false);\n"
    + "    sfx.click();\n"
    + "  });\n"
    + "  document.getElementById('btnContinue')?.addEventListener('click', () => {\n"
    + "    showStartScreen(false);\n"
    + "    if (loadFromSave()) toast('City loaded.');\n"
    + "    else newGame();\n"
    + "    sfx.click();\n"
    + "  });\n"
    + "  document.getElementById('btnSkipTutorial')?.addEventListener('click', () => {\n"
    + "    tutorialMode = false;\n"
    + "    document.getElementById('tutorialBanner').hidden = true;\n"
    + "    sfx.click();\n"
    + "  });",
  ],
  // Tutorial update + start-screen visibility helpers.
  [
    "function applyAudio(enabled) {",
    "/**\n"
    + " * Shows or hides the start screen (the help overlay with three options).\n"
    + " * The Tutorial button starts the tutorial; Sandbox closes the overlay;\n"
    + " * Continue loads the save.\n"
    + " */\n"
    + "function showStartScreen(visible) {\n"
    + "  document.getElementById('help').classList.toggle('open', visible);\n"
    + "}\n\n"
  + "/**\n"
  + " * Reads the live world and updates the tutorial display.\n"
  + " * Called from the main loop, so the step advances when the condition is met.\n"
  + " */\n"
  + "function updateTutorial() {\n"
  + "  if (!tutorialMode) return;\n"
  + "  const snap = tutorialWorldSnapshot({\n"
  + "    net, eco, camerasMoved,\n"
  + "  });\n"
  + "  const r = tutorialStep(snap);\n"
  + "  const banner = document.getElementById('tutorialBanner');\n"
  + "  const label = document.getElementById('tutorialLabel');\n"
  + "  if (!banner || !label) return;\n"
  + "  banner.hidden = r.done;\n"
  + "  label.textContent = r.done ? 'Tutorial complete!' : `${r.index + 1}/5: ${r.label}`;\n"
  + "}\n\n"
  + "function applyAudio(enabled) {",
  ],
  // Expose the tutorial on __rf.
  [
    "    buildingVariant,",
    "    buildingVariant,\n    get tutorial() { return tutorialStep(tutorialWorldSnapshot({ net, eco, camerasMoved })); },",
  ],
  // Update the tutorial in the main loop.
  [
    "    updateBatchUI();\n    refreshLegend();\n  }",
    "    updateBatchUI();\n    refreshLegend();\n    updateTutorial();\n  }",
  ],
]);

console.log('done');
