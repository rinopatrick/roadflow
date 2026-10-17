// Temporary patcher: edge selection with an upgrade inspector, and the
// demolition preview in the bulldoze badge.
import { readFileSync, writeFileSync } from 'node:fs';

function patch(path, edits) {
  const raw = readFileSync(path, 'utf8');
  const crlf = raw.includes('\r\n');
  let t = raw.replace(/\r\n/g, '\n');
  let n = 0;
  for (const [from, to] of edits) {
    if (!t.includes(from)) throw new Error(`${path}: not found:\n${from.slice(0, 200)}`);
    t = t.replace(from, to);
    n++;
  }
  if (crlf) t = t.replace(/\n/g, '\r\n');
  writeFileSync(path, t);
  console.log(`${path}: ${n} edits`);
}

patch('src/main.js', [
  // Imports.
  [
    "import { evaluateGridDraft } from './gridDraft.js';",
    "import { evaluateGridDraft } from './gridDraft.js';\n"
    + "import {\n"
    + "  UPGRADE_CLASSES, ROUNDABOUT_RADIUS,\n"
    + "  validateRoadUpgrade, validateRoundaboutRadius, demolitionPreview, demolitionLabel,\n"
    + "} from './constructionEdits.js';",
  ],

  // The road inspector, with in-place upgrade.
  [
    'function select(x, y) {',
    '/**\n'
    + ' * The road inspector: what the road is, and the in-place upgrade controls.\n'
    + ' *\n'
    + ' * An upgrade keeps the edge ID and its topology, so active cars keep their\n'
    + ' * routes. Each option is validated BEFORE the click, so a disabled button\n'
    + ' * can say why it is unavailable rather than failing on commit.\n'
    + ' */\n'
    + 'function openRoadInspect(edge) {\n'
    + '  const dim = roadDimensions(edge);\n'
    + '  const rows = UPGRADE_CLASSES.map((cls) => {\n'
    + '    const current = cls === edge.cls;\n'
    + '    const check = current ? null : validateRoadUpgrade(getWorld(), edge.id, cls);\n'
    + '    const why = current ? \'already this class\' : (check.ok ? \'\' : check.reason);\n'
    + '    const dis = current || !check.ok;\n'
    + '    return `<button class="menu-btn" data-upgrade="${cls}"${dis ? \' disabled\' : \'\'}`
    + ' style="width:100%;justify-content:center;border:1px solid var(--line);`
    + 'border-radius:var(--radius-sm);margin-top:4px${dis ? \';opacity:.55\' : \'\'}">`
    + '${cls.charAt(0).toUpperCase() + cls.slice(1)}${current ? \' (current)\' : \'\'}</button>`
    + '${why ? `<div class="row"><span style="color:var(--muted);font-size:11px">${why}</span></div>` : \'\'}`;\n'
    + '  }).join(\'\');\n'
    + '\n'
    + '  openInspect(`${edge.cls.charAt(0).toUpperCase() + edge.cls.slice(1)} road`, `\n'
    + '    <div class="row"><span>Lanes</span><span class="v">${dim.forward + dim.backward}</span></div>\n'
    + '    <div class="row"><span>Width</span><span class="v">${dim.width.toFixed(0)} wu</span></div>\n'
    + '    <div class="row"><span>Speed</span><span class="v">${dim.speed} wu/s</span></div>\n'
    + '    <div class="row"><span>Length</span><span class="v">${edge.total.toFixed(0)} wu</span></div>\n'
    + '    <label>Upgrade in place</label>\n'
    + '    ${rows}\n'
    + '  `, undefined, \'road\');\n'
    + '\n'
    + '  document.getElementById(\'insBody\').querySelectorAll(\'[data-upgrade]\').forEach(btn => {\n'
    + '    btn.addEventListener(\'click\', () => {\n'
    + '      const cls = btn.dataset.upgrade;\n'
    + '      const result = runCommand({ kind: COMMAND_KIND.UPGRADE_ROAD, edgeId: edge.id, cls },\n'
    + '        { reselect: true });\n'
    + '      if (result) {\n'
    + '        sfx.place();\n'
    + '        const live = net.edges.get(edge.id);\n'
    + '        if (live) openRoadInspect(live);\n'
    + '      }\n'
    + '    });\n'
    + '  });\n'
    + '}\n'
    + '\n'
    + 'function select(x, y) {',
  ],

  // Edge selection after the node check.
  [
    "  selected = null;\n  closeInspect();\n}",
    "  // An edge: the road inspector, which is also where upgrades live.\n"
    + "  let best = null;\n"
    + "  let bd = 10 / renderer.cam.zoom;\n"
    + "  for (const e of net.edges.values()) {\n"
    + "    if (!Array.isArray(e.pts) || e.pts.length < 2) continue;\n"
    + "    let nearest = Infinity;\n"
    + "    for (let i = 1; i < e.pts.length; i++) {\n"
    + "      nearest = Math.min(nearest, distToSegment(x, y, e.pts[i - 1], e.pts[i]));\n"
    + "    }\n"
    + "    if (nearest < bd) { bd = nearest; best = e; }\n"
    + "  }\n"
    + "  if (best) {\n"
    + "    selected = { kind: 'edge', id: best.id };\n"
    + "    openRoadInspect(best);\n"
    + "    return;\n"
    + "  }\n"
    + "\n"
    + "  selected = null;\n  closeInspect();\n}\n"
    + "\n"
    + "/** Distance from a point to a segment, for edge hit testing. */\n"
    + "function distToSegment(px, py, a, b) {\n"
    + "  const abx = b[0] - a[0];\n"
    + "  const aby = b[1] - a[1];\n"
    + "  const len2 = abx * abx + aby * aby;\n"
    + "  let t = len2 > 0 ? ((px - a[0]) * abx + (py - a[1]) * aby) / len2 : 0;\n"
    + "  t = clamp(t, 0, 1);\n"
    + "  return Math.hypot(px - (a[0] + abx * t), py - (a[1] + aby * t));\n"
    + "}",
  ],

  // reselectEntity learns about edges, so an upgrade keeps its inspector open.
  [
    "  if (sel.kind === 'building') {\n    const b = eco.buildings.get(sel.id);\n    if (!b) return;\n    selected = sel;\n    openBuildingInspect(b);\n  }",
    "  if (sel.kind === 'building') {\n"
    + "    const b = eco.buildings.get(sel.id);\n"
    + "    if (!b) return;\n"
    + "    selected = sel;\n"
    + "    openBuildingInspect(b);\n"
    + "    return;\n"
    + "  }\n"
    + "  if (sel.kind === 'edge') {\n"
    + "    const e = net.edges.get(sel.id);\n"
    + "    if (!e) return;\n"
    + "    selected = sel;\n"
    + "    openRoadInspect(e);\n"
    + "  }",
  ],

  // Expose the demolition preview and radius for the renderer and tests.
  [
    "    grid: { evaluateGridDraft },",
    "    grid: { evaluateGridDraft },\n"
    + "    demolitionPreview: (x, y) => demolitionPreview(getWorld(), x, y),\n"
    + "    ROUNDABOUT_RADIUS,\n"
    + "    validateRoadUpgrade: (id, cls) => validateRoadUpgrade(getWorld(), id, cls),\n"
    + "    validateRoundaboutRadius: (id, r) => validateRoundaboutRadius(getWorld(), id, r),",
  ],
]);

// The renderer needs roadDimensions and the demolition preview for its badge.
patch('src/render.js', [
  [
    "import { previewPlacement } from './render/preview.js';",
    "import { previewPlacement } from './render/preview.js';\n"
    + "import { demolitionPreview, demolitionLabel } from './constructionEdits.js';",
  ],
]);
console.log('done');
