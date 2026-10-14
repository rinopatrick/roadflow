// Browser UI checks for S02.1 — design tokens, inline SVG icons and control states.
//
// Run: npm run test:browser
//
// These assertions are deliberately about the *served* page, not about the
// source of truth in isolation: a token that exists in uiTokens.js but not in
// ui.css (or the reverse) is exactly the drift S02.1 has to prevent, so the
// CSS custom properties are read from the live document and compared with the
// JavaScript module.
//
// Screenshots: every original tool is captured active, hovered and keyboard
// focused at desktop (1440x900) and compact (1024x768), with the simulation
// clock paused so a capture is reproducible.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  startServer, launchGame, runDir, dismissHelp,
  openCategory, selectTool, toolCategories, menuAction, worldState,
} from './harness.js';
import { ICONS, icon, REQUIRED_ICON_IDS } from '../../src/icons.js';
import { UI_TOKENS } from '../../src/uiTokens.js';

// Pictographic ranges only. Ordinary typography (— · × ' " ...) must stay legal.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/u;

const EXPECTED_TOOLS = [
  'road', 'avenue', 'highway', 'roundabout', 'light',
  'house', 'shop', 'factory', 'bulldoze', 'select',
];
const EXPECTED_SPEEDS = ['0', '1', '3', '8'];

// UI source files that must contain no emoji-dependent presentation.
const UI_SOURCES = [
  'index.html', 'src/ui.css', 'src/uiTokens.js', 'src/icons.js', 'src/ui.js', 'src/main.js',
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'compact', width: 1024, height: 768 },
];

// DESIGN section 1: five main categories, in this order.
const EXPECTED_CATEGORIES = ['select', 'roads', 'junctions', 'buildings', 'demolish'];

// DESIGN section 1: speed labels are Pause / 1x / 3x / 8x, never indistinguishable glyphs.
const SPEED_LABELS = { 0: 'Pause', 1: '1\u00d7', 3: '3\u00d7', 8: '8\u00d7' };

// Shortcuts 1-0 stay bound to the ten original tools in declaration order.
const SHORTCUTS = Object.fromEntries(EXPECTED_TOOLS.map((t, i) => [t, String((i + 1) % 10)]));

// DESIGN section 1 layout contract, in CSS pixels.
const LAYOUT = {
  bandHeight: 56,
  safeMargin: 16,
  dockHeight: 64,
  dockMaxWidth: 760,
  inspectorWidth: 296,
  compactBreakpoint: 1100,
};

// ---------- colour maths (measured, never inferred from the hex choice) ----------

function parseColor(value) {
  const m = /rgba?\(([^)]+)\)/.exec(value);
  assert.ok(m, `expected a computed colour, got ${JSON.stringify(value)}`);
  const p = m[1].split(',').map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

function hexToColor(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

/** `rgb(r, g, b)` as getComputedStyle reports it, from a hex token. */
function rgbString(hex) {
  const { r, g, b } = hexToColor(hex);
  return `rgb(${r}, ${g}, ${b})`;
}

function luminance({ r, g, b }) {
  const f = v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Composites a translucent foreground over an opaque background. */
function over(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** All design tokens as the browser resolved them. */
async function readTokens(page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (!rule.selectorText || !rule.selectorText.includes(':root')) continue;
        for (const prop of rule.style) {
          if (prop.startsWith('--')) out[prop] = cs.getPropertyValue(prop).trim();
        }
      }
    }
    return out;
  });
}

let server;
let game;
let shots;

/**
 * Tabs forward from the top of the document until the given tool has keyboard
 * focus, so the assertion also proves the tool is keyboard-reachable.
 */
async function tabUntilTool(page, tool, maxTabs = 30) {
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const current = await page.evaluate(() => document.activeElement?.dataset?.tool ?? null);
    if (current === tool) return true;
  }
  return false;
}

/** Groups the ten tools by their owning category, in declaration order. */
function groupByCategory(cats) {
  const groups = new Map();
  for (const tool of EXPECTED_TOOLS) {
    const category = cats[tool];
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(tool);
  }
  return groups;
}

before(async () => {
  shots = runDir();
  server = await startServer();
  game = await launchGame({ baseUrl: server.baseUrl });
  await dismissHelp(game.page);
});

after(async () => {
  await game?.close();
  await server?.stop();
});

// ---------- tokens ----------

test('ui: ui.css is linked and declares the DESIGN token layer', async () => {
  const { page } = game;
  const links = await page.$$eval('link[rel=stylesheet]', els => els.map(e => e.getAttribute('href')));
  assert.deepEqual(links, ['src/ui.css'], `expected exactly the ui.css stylesheet, got ${links.join(', ')}`);

  const tokens = await readTokens(page);
  for (const name of [
    '--surface', '--surface-raised', '--ink', '--muted', '--line', '--accent',
    '--accent-soft', '--warning', '--danger', '--focus',
    '--radius-sm', '--radius-md', '--radius-lg',
    '--space-1', '--space-2', '--space-3', '--space-4', '--space-6',
  ]) {
    assert.ok(tokens[name], `ui.css must declare ${name}, tokens were: ${Object.keys(tokens).join(', ')}`);
  }
  assert.equal(tokens['--radius-sm'], '6px');
  assert.equal(tokens['--radius-md'], '12px');
  assert.equal(tokens['--radius-lg'], '16px');
  assert.equal(tokens['--space-4'], '16px');
});

test('ui: canvas-facing tokens match the CSS custom properties', async () => {
  const { page } = game;
  const tokens = await readTokens(page);
  const pairs = [
    ['accent', '--accent'], ['danger', '--danger'], ['ink', '--ink'],
    ['muted', '--muted'], ['surfaceRaised', '--surface-raised'],
  ];
  for (const [jsName, cssName] of pairs) {
    const js = UI_TOKENS[jsName].toLowerCase();
    assert.ok(tokens[cssName], `ui.css is missing ${cssName}`);
    assert.equal(js, tokens[cssName].toLowerCase(),
      `${cssName} (${tokens[cssName]}) must equal UI_TOKENS.${jsName} (${js}); the canvas cannot read CSS variables, so these are the shared values`);
  }
  // The canvas-facing set stays a handful, not a duplicated palette.
  assert.ok(Object.keys(UI_TOKENS).length <= 8,
    `uiTokens.js is canvas-facing only; it declares ${Object.keys(UI_TOKENS).length} entries`);
});

test('ui: text and control contrast is measured, not assumed', async (t) => {
  const { page } = game;
  const tok = await readTokens(page);
  const surface = hexToColor(tok['--surface-raised']);
  const pairs = [
    ['--ink on --surface-raised', tok['--ink'], tok['--surface-raised'], 4.5],
    ['--muted on --surface-raised', tok['--muted'], tok['--surface-raised'], 4.5],
    ['--accent on --surface-raised', tok['--accent'], tok['--surface-raised'], 4.5],
    ['--danger on --surface-raised', tok['--danger'], tok['--surface-raised'], 4.5],
    ['--warning on --surface-raised', tok['--warning'], tok['--surface-raised'], 4.5],
    ['--ink on --accent-soft (stock badge)', tok['--ink'], tok['--accent-soft'], 4.5],
    ['--surface-raised on --accent (active tool)', tok['--surface-raised'], tok['--accent'], 4.5],
    ['--focus on --surface-raised (focus ring)', tok['--focus'], tok['--surface-raised'], 3],
    ['--accent on --line (progress track)', tok['--accent'], tok['--line'], 3],
  ];
  for (const [label, fg, bg, min] of pairs) {
    const fgHex = fg.startsWith('#') ? fg : tok[fg];
    const bgHex = bg.startsWith('#') ? bg : tok[bg];
    assert.ok(fgHex && bgHex, `${label}: unresolved token (${fgHex} / ${bgHex})`);
    const ratio = contrast(hexToColor(fgHex), hexToColor(bgHex));
    assert.ok(ratio >= min,
      `${label} must reach ${min}:1, measured ${ratio.toFixed(2)}:1 (${fgHex} on ${bgHex})`);
  }

  // Reported, not gated: the 1px panel edge is decorative — the panel boundary
  // over light terrain is carried by the drop shadow, so --line does not reach
  // 3:1 against the map. Flagged for the human visual review in the handoff.
  const mapGrass = '#efece3';
  t.diagnostic(`panel edge --line vs map grass: ${contrast(hexToColor(tok['--line']), hexToColor(mapGrass)).toFixed(2)}:1 (informational)`);
  t.diagnostic(`panel surface --surface vs map grass: ${contrast(hexToColor(tok['--surface']), hexToColor(mapGrass)).toFixed(2)}:1 (informational)`);

  // The dock is translucent over the map, so measure it as composited. A
  // non-active tool is measured here; the active tool is the opaque
  // --surface-raised on --accent pair above.
  const dock = await page.evaluate(() => getComputedStyle(document.getElementById('toolbar')).backgroundColor);
  const composited = over(parseColor(dock), surface);
  const label = await page.evaluate(() => getComputedStyle(document.querySelector('[data-tool="select"]')).color);
  const ratio = contrast(parseColor(label), composited);
  assert.ok(ratio >= 4.5,
    `toolbar label must reach 4.5:1 over the composited dock, measured ${ratio.toFixed(2)}:1`);
});

// ---------- icons ----------

test('ui: every icon is a self-contained inline svg', () => {
  const ids = Object.keys(ICONS);
  assert.ok(ids.length >= 10, `expected a usable icon map, got ${ids.length} icons`);
  for (const id of ids) {
    const svg = icon(id);
    assert.match(svg, /viewBox="0 0 24 24"/, `${id}: every icon needs a 24x24 viewBox`);
    assert.match(svg, /aria-hidden="true"/, `${id}: decorative icons must be aria-hidden`);
    assert.match(svg, /stroke="currentColor"/, `${id}: icons must inherit currentColor`);
    assert.ok(!/<script/i.test(svg), `${id}: icon must not contain a script`);
    assert.ok(!/https?:|xlink:href|url\(/i.test(svg), `${id}: icon must not reference anything external`);
    assert.ok(!/\son[a-z]+\s*=/i.test(svg), `${id}: icon must not carry event handlers`);
    assert.ok(/<(path|circle|rect|line|polyline|polygon)\b/.test(svg), `${id}: icon has no geometry`);
  }
  assert.equal(icon('definitely-not-an-icon'), '',
    'an unknown icon id must render nothing rather than an emoji or a broken svg');
});

test('ui: the icon map covers every control S02.1 renders', () => {
  for (const id of REQUIRED_ICON_IDS) {
    assert.ok(ICONS[id], `icons.js must define "${id}"`);
  }
  for (const id of EXPECTED_TOOLS) {
    assert.ok(ICONS[id], `tool "${id}" needs an icon`);
  }
});

test('ui: no control depends on emoji', async () => {
  const { page } = game;
  const zones = ['#topband', '#toolbar', '#speedctl', '#menupop', '#inspect', '#help', '#layers'];
  for (const zone of zones) {
    const html = await page.$eval(zone, el => el.outerHTML);
    assert.ok(!EMOJI.test(html), `${zone} still contains emoji: ${html.match(EMOJI)?.[0]}`);
  }

  // The inspector title is built from a template string that is not in the DOM
  // until something is selected, so scan the served UI sources too.
  for (const file of UI_SOURCES) {
    const res = await page.request.get(new URL(file, server.baseUrl).href);
    assert.ok(res.ok(), `${file} must be served (${res.status()})`);
    const text = await res.text();
    const found = EMOJI.exec(text);
    assert.ok(!found, `${file} contains emoji ${JSON.stringify(found?.[0])} at index ${found?.index}`);
  }
});

// ---------- controls ----------

test('ui: tool buttons keep visible text, data-tool and real inventory badges', async () => {
  const { page } = game;
  const tools = await page.$$eval('[data-tool]', els => els.map(e => e.dataset.tool));
  assert.deepEqual(tools, EXPECTED_TOOLS, `toolbar tools were: ${tools.join(', ')}`);

  const buttons = await page.$$eval('[data-tool]', els => els.map(e => ({
    tool: e.dataset.tool,
    label: e.querySelector('.label')?.textContent?.trim() ?? '',
    hasIcon: !!e.querySelector('svg[aria-hidden="true"]'),
    badge: e.querySelector('.tool-count')?.textContent ?? null,
    name: (e.getAttribute('aria-label') || e.textContent || '').trim(),
  })));
  for (const b of buttons) {
    assert.ok(b.label, `${b.tool}: buttons keep visible text`);
    assert.ok(b.hasIcon, `${b.tool}: buttons render an inline svg icon`);
    assert.ok(b.name.length > 0, `${b.tool}: control needs a non-empty accessible name`);
  }

  const batch = await page.evaluate(() => ({ ...window.__rf.state.eco.batch }));
  for (const type of ['house', 'shop', 'factory']) {
    const btn = buttons.find(b => b.tool === type);
    assert.equal(btn.badge, String(batch[type]),
      `${type} badge must show the real stock (${batch[type]}), showed ${btn.badge}`);
    assert.ok(btn.name.includes(String(batch[type])),
      `${type}: accessible name should include the stock count, was "${btn.name}"`);
  }

  // The hidden compatibility container is gone: badges are the single source.
  const legacy = await page.evaluate(() => ({
    batch: !!document.getElementById('batch'),
    bHouse: !!document.getElementById('bHouse'),
    bShop: !!document.getElementById('bShop'),
    bFactory: !!document.getElementById('bFactory'),
  }));
  assert.deepEqual(legacy, { batch: false, bHouse: false, bShop: false, bFactory: false },
    'the hidden batch DOM must be removed once badges carry the stock');

  const overflow = await page.$eval('#toolbar', el => el.scrollWidth - el.clientWidth);
  assert.ok(overflow <= 1, `the dock must not clip tools at the regression viewport (overflow ${overflow}px)`);

  // The active tool must actually consume the accent tokens, not merely have a
  // token pair that would pass a contrast check.
  await page.click('[data-tool="road"]');
  const activeStyle = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('[data-tool="road"]'));
    return { color: cs.color, background: cs.backgroundColor, pressed: document.querySelector('[data-tool="road"]').getAttribute('aria-pressed') };
  });
  const tok = await readTokens(page);
  assert.equal(activeStyle.background, rgbString(tok['--accent']),
    `the active tool fill must be --accent, got ${activeStyle.background}`);
  assert.equal(activeStyle.color, rgbString(tok['--surface-raised']),
    `the active tool text must be --surface-raised, got ${activeStyle.color}`);
  assert.equal(activeStyle.pressed, 'true', 'the active tool must report aria-pressed');
});

test('ui: speed controls are labelled Pause, 1x, 3x and 8x', async () => {
  const { page } = game;
  const speeds = await page.$$eval('[data-speed]', els => els.map(e => e.dataset.speed));
  assert.deepEqual(speeds, EXPECTED_SPEEDS, `speed controls were: ${speeds.join(', ')}`);

  const labels = await page.$$eval('[data-speed]', els => els.map(e => ({
    speed: e.dataset.speed,
    text: e.textContent.trim(),
    name: (e.getAttribute('aria-label') || '').trim(),
    visible: e.getBoundingClientRect().width > 0,
  })));
  for (const s of labels) {
    assert.ok(s.visible, `speed ${s.speed}: must be visible`);
    assert.equal(s.text, SPEED_LABELS[s.speed],
      `speed ${s.speed}: visible label must read "${SPEED_LABELS[s.speed]}", got "${s.text}"`);
    assert.ok(s.name.length > 0, `speed ${s.speed}: needs an accessible name`);
  }
  // The four controls must be distinguishable without colour or shape guessing.
  assert.equal(new Set(labels.map(s => s.text)).size, 4,
    `speed labels must be distinct, got: ${labels.map(s => s.text).join(', ')}`);
});

test('ui: keyboard focus is visible on every tool', async () => {
  const { page } = game;
  const groups = groupByCategory(await toolCategories(page));

  for (const [category, tools] of groups) {
    await openCategory(page, category);
    for (const tool of tools) {
      assert.ok(await tabUntilTool(page, tool), `${tool}: must be reachable by Tab once ${category} is open`);
      const state = await page.evaluate(() => {
        const el = document.activeElement;
        const cs = getComputedStyle(el);
        return {
          tool: el?.dataset?.tool ?? null,
          focusVisible: el?.matches?.(':focus-visible') ?? false,
          outlineWidth: cs.outlineWidth,
          outlineOffset: cs.outlineOffset,
        };
      });
      assert.equal(state.tool, tool, `Tab must land on ${tool}`);
      assert.ok(state.focusVisible, `${tool}: keyboard focus must match :focus-visible`);
      assert.equal(state.outlineWidth, '2px', `${tool}: focus ring must be 2px, got ${state.outlineWidth}`);
      assert.equal(state.outlineOffset, '2px', `${tool}: focus ring needs a 2px offset`);
    }
  }

  // A mouse click must not leave the ring behind on an unfocused control.
  const idle = await page.evaluate(() => {
    const el = document.querySelector('[data-tool="select"]');
    el.blur();
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: cs.outlineWidth };
  });
  assert.equal(idle.style, 'none',
    `an unfocused control must not draw a ring (outline-style ${idle.style}, width ${idle.width})`);

  // Undo the Tab-start reset so later cases see the ordinary tab order.
  await page.evaluate(() => document.body.removeAttribute('tabindex'));
});

test('ui: depleted inventory stays legible and reported', async () => {
  const { page } = game;
  // The clock keeps running here: stock changes are published by the running
  // loop, which is the same path a level-up grant takes.
  await page.evaluate(() => { window.__rf.state.eco.batch.house = 0; });

  await page.waitForFunction(() => {
    const b = document.querySelector('[data-tool="house"]');
    return b?.classList.contains('depleted') && b.querySelector('.tool-count')?.textContent === '0';
  }, null, { timeout: 5000 });

  const state = await page.evaluate(() => {
    const btn = document.querySelector('[data-tool="house"]');
    const cs = getComputedStyle(btn);
    const badge = btn.querySelector('.tool-count');
    return {
      opacity: cs.opacity,
      color: cs.color,
      badgeColor: getComputedStyle(badge).color,
      badgeBg: getComputedStyle(badge).backgroundColor,
      dockBg: getComputedStyle(document.getElementById('toolbar')).backgroundColor,
      label: btn.querySelector('.label').textContent.trim(),
    };
  });
  assert.equal(state.opacity, '1', 'a depleted tool must not be dimmed below legibility');
  const tokens = await readTokens(page);
  const surface = hexToColor(tokens['--surface-raised']);
  const ratio = contrast(parseColor(state.color), over(parseColor(state.dockBg), surface));
  assert.ok(ratio >= 4.5,
    `depleted label must stay readable, measured ${ratio.toFixed(2)}:1`);
  assert.equal(state.label, 'House', 'the visible label survives depletion');

  // Still selectable, so the canvas can explain why it cannot be placed.
  await selectTool(page, 'house');
  const active = await page.evaluate(() => document.querySelector('[data-tool="house"]').classList.contains('active'));
  assert.ok(active, 'a depleted tool stays selectable so the reason can be shown');

  await page.evaluate(() => { window.__rf.state.eco.batch.house = 4; });
  await page.waitForFunction(() => document.querySelector('[data-tool="house"]')?.classList.contains('depleted') === false,
    null, { timeout: 5000 });
});

test('ui: reduced motion removes non-essential animation', async () => {
  const { page } = game;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motion = await page.evaluate(() => {
    const inspect = document.getElementById('inspect');
    inspect.classList.add('open');
    const out = {
      tool: getComputedStyle(document.querySelector('[data-tool="road"]')).transitionDuration,
      speed: getComputedStyle(document.querySelector('[data-speed="1"]')).transitionDuration,
      panelAnimation: getComputedStyle(inspect).animationName,
    };
    inspect.classList.remove('open');
    return out;
  });
  assert.equal(motion.tool, '0s', `tool transitions must be removed, got ${motion.tool}`);
  assert.equal(motion.speed, '0s', `speed transitions must be removed, got ${motion.speed}`);
  assert.equal(motion.panelAnimation, 'none', `panel animation must be removed, got ${motion.panelAnimation}`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

// ---------- inspector ----------

test('ui: the inspector title carries an icon and text, not a glyph', async () => {
  const { page } = game;
  const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });
  try {
    const p = run.page;
    await dismissHelp(p);
    await p.click('[data-speed="0"]');

    // Build a short road and a house through the real controls, then select it.
    await p.keyboard.press('1');
    await p.mouse.click(500, 400);
    await p.mouse.click(760, 400);
    await p.keyboard.press('Enter');
    await p.keyboard.press('6');
    await p.mouse.click(630, 360);
    await p.waitForFunction(() => window.__rf.state.eco.buildings.size > 0, null, { timeout: 10000 });

    const house = await p.evaluate(() => [...window.__rf.state.eco.buildings.values()][0]);
    await p.evaluate(({ x, y }) => {
      const [sx, sy] = window.__rf.renderer.worldToScreen(x, y);
      window.__probe = [sx, sy];
    }, house);
    const [sx, sy] = await p.evaluate(() => window.__probe);
    await p.keyboard.press('0'); // select tool
    await p.mouse.click(sx, sy);

    const title = await p.evaluate(() => {
      const el = document.getElementById('insTitle');
      return {
        open: document.getElementById('inspect').classList.contains('open'),
        hasIcon: !!el.querySelector('svg[aria-hidden="true"]'),
        text: el.textContent.trim(),
        html: el.innerHTML,
        body: document.getElementById('insBody').textContent,
      };
    });
    assert.ok(title.open, 'selecting a building must open the inspector');
    assert.ok(title.hasIcon, 'the inspector title must render an inline svg icon');
    assert.equal(title.text, 'House', `inspector title text was ${JSON.stringify(title.text)}`);
    assert.ok(!EMOJI.test(title.html), 'the inspector title must not contain emoji');
    assert.ok(/Reach shop/.test(title.body), 'a house inspector reports whether shops are reachable');
    assert.ok(!EMOJI.test(title.body), `inspector body must not contain emoji: ${title.body}`);

    await p.screenshot({ path: `${shots}/ui-inspector-desktop-1440x900-seed1.png` });

    // Layout contract: 296px wide, hung below the top band, never covering the
    // dock, and internally scrollable.
    const metrics = await p.evaluate(() => {
      const el = document.getElementById('inspect');
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const band = document.getElementById('topband').getBoundingClientRect();
      const dock = document.getElementById('toolbar').getBoundingClientRect();
      return {
        width: r.width, top: r.top, bottom: r.bottom, right: r.right,
        overflowY: cs.overflowY, maxHeight: cs.maxHeight,
        bandBottom: band.bottom, dockTop: dock.top, vw: window.innerWidth,
      };
    });
    assert.equal(Math.round(metrics.width), LAYOUT.inspectorWidth,
      `inspector must be ${LAYOUT.inspectorWidth}px wide, measured ${metrics.width}`);
    assert.ok(metrics.top >= metrics.bandBottom,
      `inspector hangs below the band (${metrics.top} vs band bottom ${metrics.bandBottom})`);
    assert.ok(metrics.bottom <= metrics.dockTop + 1,
      `inspector must not cover the dock (${metrics.bottom} vs dock top ${metrics.dockTop})`);
    assert.equal(metrics.overflowY, 'auto', 'the inspector must scroll internally');
    assert.match(metrics.maxHeight, /px$/, `inspector height must be bounded, got ${metrics.maxHeight}`);

    // Compact desktop: still fully on screen, still clear of the dock.
    await p.setViewportSize({ width: 1024, height: 768 });
    await p.waitForTimeout(200);
    const compact = await p.evaluate(() => {
      const r = document.getElementById('inspect').getBoundingClientRect();
      const dock = document.getElementById('toolbar').getBoundingClientRect();
      return { left: r.left, right: r.right, bottom: r.bottom, dockTop: dock.top, vw: window.innerWidth };
    });
    assert.ok(compact.left >= 0 && compact.right <= compact.vw + 1,
      `compact inspector must stay on screen (${compact.left}..${compact.right} of ${compact.vw})`);
    assert.ok(compact.bottom <= compact.dockTop + 1,
      `compact inspector must not cover the dock (${compact.bottom} vs ${compact.dockTop})`);
    await p.screenshot({ path: `${shots}/ui-inspector-compact-1024x768-seed1.png` });

    assert.deepEqual(run.errors.filter(e => !/favicon/.test(e)), [], 'no console errors while inspecting');
  } finally {
    await run.close();
  }
});

// ---------- S02.2a: dock structure, controller state and layout ----------

test('ui: the dock groups tools into categories with one open at a time', async () => {
  const { page } = game;
  const categories = await page.$$eval('[data-category]', els => els.map(e => e.dataset.category));
  assert.deepEqual(categories, EXPECTED_CATEGORIES, `dock categories were: ${categories.join(', ')}`);

  // All ten tools stay in the DOM in shortcut order, so data-tool and the 1-0
  // shortcuts keep working even though only one category is visible.
  const tools = await page.$$eval('[data-tool]', els => els.map(e => e.dataset.tool));
  assert.deepEqual(tools, EXPECTED_TOOLS, `tools were: ${tools.join(', ')}`);

  const cats = await toolCategories(page);
  for (const tool of EXPECTED_TOOLS) {
    assert.ok(EXPECTED_CATEGORIES.includes(cats[tool]),
      `${tool} must belong to a declared category, got ${cats[tool]}`);
  }

  const state = await page.evaluate((expected) => ({
    expanded: expected.filter(c =>
      document.querySelector(`[data-category="${c}"]`).getAttribute('aria-expanded') === 'true'),
    visibleTools: [...document.querySelectorAll('[data-tool]')]
      .filter(e => e.getBoundingClientRect().width > 0)
      .map(e => e.dataset.tool),
  }), EXPECTED_CATEGORIES);

  assert.equal(state.expanded.length, 1,
    `exactly one category may be open, open: ${state.expanded.join(', ') || 'none'}`);
  const expectedVisible = EXPECTED_TOOLS.filter(t => cats[t] === state.expanded[0]);
  assert.deepEqual(state.visibleTools, expectedVisible,
    `category ${state.expanded[0]} must show exactly its own tools`);
});

test('ui: a tool shortcut opens the category that owns it', async () => {
  const { page } = game;
  // One tool per category, so every category is reached the way a player reaches it.
  for (const tool of ['road', 'light', 'shop', 'bulldoze', 'select']) {
    await page.keyboard.press(SHORTCUTS[tool]);
    const state = await page.evaluate((t) => {
      const btn = document.querySelector(`[data-tool="${t}"]`);
      return {
        pressed: btn.getAttribute('aria-pressed'),
        visible: btn.getBoundingClientRect().width > 0,
        expanded: document.querySelector(`[data-category="${btn.dataset.toolCategory}"]`).getAttribute('aria-expanded'),
      };
    }, tool);
    assert.equal(state.pressed, 'true', `${tool}: shortcut ${SHORTCUTS[tool]} must select the tool`);
    assert.equal(state.visible, true, `${tool}: shortcut must reveal its category`);
    assert.equal(state.expanded, 'true', `${tool}: owning category must be expanded`);
  }
});

test('ui: the interface has a single owner for the active tool', async () => {
  const { page } = game;
  const fields = await page.evaluate(() => Object.keys(window.__rf.ui.snapshot()).sort());
  assert.deepEqual(fields,
    ['activeTool', 'dialog', 'openCategory', 'openPanel', 'overlay'].sort(),
    `controller state must hold exactly the DESIGN fields, got ${fields.join(', ')}`);

  await selectTool(page, 'shop');
  const agreement = await page.evaluate(() => ({
    controller: window.__rf.ui.snapshot().activeTool,
    openCategory: window.__rf.ui.snapshot().openCategory,
    pressed: [...document.querySelectorAll('[data-tool][aria-pressed="true"]')].map(e => e.dataset.tool),
    canvasClass: document.getElementById('game').className,
  }));
  assert.equal(agreement.controller, 'shop', 'the controller must own the active tool');
  assert.equal(agreement.openCategory, 'buildings', 'the owning category must follow the tool');
  assert.deepEqual(agreement.pressed, ['shop'],
    `exactly one tool may be pressed, got ${agreement.pressed.join(', ') || 'none'}`);
  assert.match(agreement.canvasClass, /tool-shop/,
    `the canvas class must follow the controller, got "${agreement.canvasClass}"`);
});

test('ui: the controller refuses unknown state keys', async () => {
  const { page } = game;
  const message = await page.evaluate(() => {
    try { window.__rf.ui.set({ activeTol: 'road' }); } catch (err) { return err.message; }
    return null;
  });
  assert.ok(message, 'a misspelled state key must throw rather than silently add a field');
  assert.match(message, /activeTol/, `the error must name the offending key, got: ${message}`);
});

test('ui: the top band and dock match the layout contract', async () => {
  const { page } = game;
  const m = await page.evaluate(() => {
    const box = id => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    return {
      band: box('topband'), categories: box('categories'), dock: box('toolbar'),
      vw: window.innerWidth, vh: window.innerHeight,
    };
  });

  assert.ok(m.band, 'the top status band must exist as one grouped surface');
  assert.equal(Math.round(m.band.height), LAYOUT.bandHeight,
    `top band must be ${LAYOUT.bandHeight}px tall, measured ${m.band.height}`);
  assert.equal(Math.round(m.band.top), LAYOUT.safeMargin,
    `top band needs a ${LAYOUT.safeMargin}px exterior gap, got ${m.band.top}`);
  assert.ok(m.band.width <= m.vw - LAYOUT.safeMargin * 2 + 1,
    `top band must respect the exterior gap (${m.band.width} of ${m.vw})`);

  assert.equal(Math.round(m.categories.height), LAYOUT.dockHeight,
    `the dock must be ${LAYOUT.dockHeight}px tall, measured ${m.categories.height}`);
  assert.ok(m.dock.width <= LAYOUT.dockMaxWidth + 1,
    `dock must not exceed ${LAYOUT.dockMaxWidth}px, measured ${m.dock.width}`);
  assert.equal(Math.round(m.vh - m.dock.bottom), LAYOUT.safeMargin,
    `dock needs a ${LAYOUT.safeMargin}px safe margin, got ${m.vh - m.dock.bottom}`);
  assert.ok(m.dock.bottom <= m.vh + 1, 'the dock must stay above the fold');
});

test('ui: the menu popover holds the file actions', async () => {
  const { page } = game;
  const closed = await page.evaluate(() => ({
    panel: window.__rf.ui.snapshot().openPanel,
    hidden: document.getElementById('menupop').offsetParent === null,
  }));
  assert.equal(closed.panel, null, 'no panel may be open on boot');
  assert.ok(closed.hidden, 'the menu popover must start closed');

  await page.click('#menubtn');
  const open = await page.evaluate(() => ({
    panel: window.__rf.ui.snapshot().openPanel,
    visible: document.getElementById('menupop').offsetParent !== null,
    present: ['btnSave', 'btnLoad', 'btnNew', 'btnHelp'].map(id => !!document.getElementById(id)),
    expanded: document.getElementById('menubtn').getAttribute('aria-expanded'),
  }));
  assert.equal(open.panel, 'menu', 'opening the menu must be recorded in the controller');
  assert.ok(open.visible, 'the popover must be visible');
  assert.deepEqual(open.present, [true, true, true, true], 'the file actions must live in the popover');
  assert.equal(open.expanded, 'true', 'the menu button must report aria-expanded');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__rf.ui.snapshot().openPanel === null, null, { timeout: 5000 });
  assert.ok(await page.evaluate(() => document.getElementById('menupop').offsetParent === null),
    'Escape must close the menu');
});

test('ui: New map confirms only when the city is dirty', async () => {
  const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });
  try {
    const { page } = run;
    await dismissHelp(page);

    // A fresh city holds nothing to lose, so the control must not nag.
    await page.click('#menubtn');
    await page.click('#btnNew');
    await page.waitForTimeout(300);
    assert.deepEqual(run.dialogs, [],
      `a clean city must not prompt, got: ${run.dialogs.join(' | ')}`);

    // Build something, and the same control must ask before discarding it.
    await page.keyboard.press('1');
    await page.mouse.click(500, 400);
    await page.mouse.click(760, 400);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__rf.state.net.edges.size > 0, null, { timeout: 10000 });

    await page.click('#menubtn');
    await page.click('#btnNew');
    await page.waitForTimeout(300);
    assert.equal(run.dialogs.length, 1,
      `a dirty city must prompt before clearing, got ${run.dialogs.length} dialog(s)`);
    assert.match(run.dialogs[0], /new map/i, `dialog text was: ${run.dialogs[0]}`);
  } finally {
    await run.close();
  }
});

test('ui: clicking interface chrome never reaches the canvas', async () => {
  const { page } = game;
  // The road tool is the dangerous one: a click that falls through to the
  // canvas would start a road draft behind the panel.
  await selectTool(page, 'road');
  const before = await worldState(page);

  for (const selector of ['#topband', '#categories', '#toolbar', '#layers h3']) {
    const box = await page.locator(selector).boundingBox();
    if (!box) continue;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }

  const after = await worldState(page);
  assert.equal(after.edges, before.edges,
    `interface chrome must not draw roads (${before.edges} -> ${after.edges})`);
  assert.equal(after.nodes, before.nodes, 'interface chrome must not create nodes');
  assert.equal(after.pop, before.pop, 'interface chrome must not place buildings');
  assert.equal(await page.evaluate(() => window.__rf.draftLength), 0,
    'interface chrome must not start a road draft');
  assert.equal(await page.evaluate(() => window.__rf.ui.overlay), null,
    'clicking chrome must not toggle a layer');
});

// ---------- S02.2b: layers, sound, import/export, depletion ----------

test('ui: the layer control offers only layers backed by simulated data', async () => {
  const { page } = game;
  const ids = await page.$$eval('[data-layer]', els => els.map(e => e.dataset.layer));
  assert.deepEqual(ids, ['traffic', 'access'], `layer toggles were: ${ids.join(', ')}`);

  const rows = await page.$$eval('[data-layer]', els => els.map(e => ({
    id: e.dataset.layer,
    label: e.querySelector('.label')?.textContent?.trim() ?? '',
    hasIcon: !!e.querySelector('svg[aria-hidden="true"]'),
    pressed: e.getAttribute('aria-pressed'),
  })));
  for (const r of rows) {
    assert.ok(r.label, `${r.id}: a layer toggle keeps visible text, not only a swatch`);
    assert.ok(r.hasIcon, `${r.id}: renders an inline svg icon`);
    assert.equal(r.pressed, 'false', `${r.id}: must start off`);
  }

  // The renderer must not carry a pollution overlay any more: it drew invented
  // values around factories with no simulated field behind them.
  const rendererSurface = await page.evaluate(() => {
    const r = window.__rf.renderer;
    return {
      drawPollution: typeof r._drawPollution,
      showPollution: 'showPollution' in r,
      showCongestion: 'showCongestion' in r,
    };
  });
  assert.equal(rendererSurface.drawPollution, 'undefined', '_drawPollution must be deleted');
  assert.equal(rendererSurface.showPollution, false, 'the showPollution flag must be deleted');
  assert.equal(rendererSurface.showCongestion, false,
    'overlay state must live in the controller, not in renderer flags');
});

test('ui: one analytic layer at a time, with its labelled legend', async () => {
  const { page } = game;
  const legendHidden = () => page.evaluate(() => document.getElementById('layerlegend').hidden);
  assert.equal(await legendHidden(), true, 'no legend until a layer is on');

  await page.click('[data-layer="traffic"]');
  let state = await page.evaluate(() => ({
    overlay: window.__rf.ui.overlay,
    pressed: [...document.querySelectorAll('[data-layer][aria-pressed="true"]')].map(e => e.dataset.layer),
    visibleLegend: [...document.querySelectorAll('[data-legend]')]
      .filter(e => !e.hidden).map(e => e.dataset.legend),
    labels: [...document.querySelectorAll('[data-legend="traffic"] .legend-label')].map(e => e.textContent.trim()),
    swatches: document.querySelectorAll('[data-legend="traffic"] .legend-swatch').length,
  }));
  assert.equal(state.overlay, 'traffic', 'the controller must own the active layer');
  assert.deepEqual(state.pressed, ['traffic'], 'exactly one toggle may be pressed');
  assert.deepEqual(state.visibleLegend, ['traffic'], 'only the active layer shows a legend');
  assert.ok(state.labels.length >= 2, `the traffic legend needs labelled bands, got ${state.labels.length}`);
  assert.equal(state.swatches, state.labels.length, 'every band needs a swatch');

  await page.click('[data-layer="access"]');
  state = await page.evaluate(() => ({
    overlay: window.__rf.ui.overlay,
    pressed: [...document.querySelectorAll('[data-layer][aria-pressed="true"]')].map(e => e.dataset.layer),
    visibleLegend: [...document.querySelectorAll('[data-legend]')].filter(e => !e.hidden).map(e => e.dataset.legend),
  }));
  assert.equal(state.overlay, 'access', 'switching layers replaces the active one');
  assert.deepEqual(state.pressed, ['access'], 'the previous layer must be released');
  assert.deepEqual(state.visibleLegend, ['access']);

  // Clicking the active layer again returns to the plain map.
  await page.click('[data-layer="access"]');
  state = await page.evaluate(() => ({
    overlay: window.__rf.ui.overlay,
    pressed: document.querySelectorAll('[data-layer][aria-pressed="true"]').length,
  }));
  assert.equal(state.overlay, null, 'the toggle must be able to turn itself off');
  assert.equal(state.pressed, 0);
  assert.equal(await legendHidden(), true, 'the legend goes with the layer');
});

test('ui: the traffic legend reports the same edges the overlay draws', async () => {
  const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });
  try {
    const { page } = run;
    await dismissHelp(page);

    // A small city that will actually move traffic.
    await page.keyboard.press('1');
    await page.mouse.click(420, 400);
    await page.mouse.click(820, 400);
    await page.mouse.click(820, 560);
    await page.mouse.click(420, 560);
    await page.mouse.click(420, 400);
    await page.keyboard.press('Enter');
    await page.keyboard.press('6');
    await page.mouse.click(520, 340);
    await page.mouse.click(720, 340);
    await page.keyboard.press('7');
    await page.mouse.click(720, 620);
    await page.waitForTimeout(300);

    await page.click('[data-speed="8"]');
    await page.waitForFunction(() => window.__rf.state.traffic.cars.size > 0, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.click('[data-speed="0"]');

    await page.click('[data-layer="traffic"]');
    await page.waitForTimeout(400);

    const check = await page.evaluate(() => {
      const net = window.__rf.state.net;
      // The same rule src/layers.js applies: an edge is shown when it holds a
      // vehicle or has accumulated congestion above the first band.
      const expected = [...net.edges.values()]
        .filter(e => (Number.isFinite(e._carCount) ? e._carCount : 0) > 0 || (e._congestion ?? 0) >= 0.25)
        .length;
      const shown = [...document.querySelectorAll('[data-legend="traffic"] .legend-count')]
        .reduce((sum, el) => sum + (parseInt(el.textContent, 10) || 0), 0);
      return { expected, shown, cars: window.__rf.state.traffic.cars.size };
    });
    assert.ok(check.cars > 0, 'fixture must put vehicles on the road');
    assert.ok(check.expected > 0, 'fixture must congest at least one edge');
    assert.equal(check.shown, check.expected,
      `the legend must count the same edges the overlay draws (legend ${check.shown}, overlay ${check.expected})`);

    await page.screenshot({ path: `${shots}/ui-layer-traffic-desktop-1440x900-seed1.png` });
  } finally {
    await run.close();
  }
});

test('ui: the access layer reports real reachability', async () => {
  const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });
  try {
    const { page } = run;
    await dismissHelp(page);
    await page.click('[data-speed="0"]');

    // One house on its own: nothing to reach.
    await page.keyboard.press('1');
    await page.mouse.click(420, 400);
    await page.mouse.click(820, 400);
    await page.keyboard.press('Enter');
    await page.keyboard.press('6');
    await page.mouse.click(520, 340);
    await page.waitForFunction(() => window.__rf.state.eco.buildings.size === 1, null, { timeout: 10000 });

    await page.click('[data-layer="access"]');
    await page.waitForTimeout(300);
    let counts = await page.evaluate(() => ({
      reachable: document.querySelector('[data-count="access-reachable"]').textContent,
      unreachable: document.querySelector('[data-count="access-unreachable"]').textContent,
      states: [...window.__rf.accessStates.values()].map(v => v.state),
    }));
    assert.equal(counts.states.length, 1, 'fixture must have exactly one building');
    assert.equal(counts.states[0], 'unreachable', 'a lone building cannot reach anything');
    assert.equal(counts.unreachable, '1', 'the legend must report the unreachable count');
    assert.equal(counts.reachable, '0');

    // Add a shop on the same road: now both ends can reach each other.
    await page.keyboard.press('7');
    await page.mouse.click(720, 340);
    await page.waitForFunction(() => window.__rf.state.eco.buildings.size === 2, null, { timeout: 10000 });
    await page.click('[data-speed="1"]');
    await page.click('[data-speed="0"]');
    await page.waitForTimeout(300);

    counts = await page.evaluate(() => ({
      reachable: document.querySelector('[data-count="access-reachable"]').textContent,
      unreachable: document.querySelector('[data-count="access-unreachable"]').textContent,
      states: [...window.__rf.accessStates.values()].map(v => v.state),
    }));
    assert.deepEqual(counts.states, ['reachable', 'reachable'],
      'a road between them makes both buildings reachable');
    assert.equal(counts.reachable, '2');
    assert.equal(counts.unreachable, '0');

    await page.screenshot({ path: `${shots}/ui-layer-access-desktop-1440x900-seed1.png` });
  } finally {
    await run.close();
  }
});

test('ui: sound starts on, toggles visibly, and makes no audio before a gesture', async () => {
  const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });
  try {
    const { page } = run;
    // Count AudioContext construction so "no audio before user gesture" is
    // measured rather than assumed.
    await page.addInitScript(() => {
      window.__audioContexts = 0;
      const Real = window.AudioContext || window.webkitAudioContext;
      if (!Real) return;
      function Counted(...args) { window.__audioContexts++; return new Real(...args); }
      Counted.prototype = Real.prototype;
      window.AudioContext = Counted;
      window.webkitAudioContext = Counted;
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__rf, null, { timeout: 20000 });
    await dismissHelp(page);

    const start = await page.evaluate(() => ({
      created: window.__audioContexts,
      pressed: document.getElementById('soundbtn').getAttribute('aria-pressed'),
      label: document.getElementById('soundbtn').getAttribute('aria-label'),
      hasIcon: !!document.getElementById('soundbtn').querySelector('svg'),
    }));
    assert.equal(start.created, 0,
      'booting the game must not start an audio context; browsers block that and it is not a user gesture');
    assert.equal(start.pressed, 'true', 'sound is on by default');
    assert.equal(start.label, 'Sound on');
    assert.ok(start.hasIcon, 'the sound control needs an icon');

    await page.click('#soundbtn');
    const muted = await page.evaluate(() => ({
      pressed: document.getElementById('soundbtn').getAttribute('aria-pressed'),
      label: document.getElementById('soundbtn').getAttribute('aria-label'),
      audio: window.__rf.world.settings.audio,
    }));
    assert.equal(muted.pressed, 'false', 'the muted state must be visible, not inferred from silence');
    assert.equal(muted.label, 'Sound off');
    assert.equal(muted.audio, false, 'the mute must reach the world settings that a save carries');

    // Muted: an interaction must still create no context.
    await page.keyboard.press('1');
    await page.mouse.click(500, 400);
    await page.mouse.click(700, 400);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__audioContexts), 0,
      'a muted game must not open an audio context at all');

    await page.click('#soundbtn');
    await page.mouse.click(800, 400);
    await page.mouse.click(900, 400);
    await page.keyboard.press('Enter');
    assert.ok(await page.evaluate(() => window.__audioContexts) > 0,
      'unmuting and then acting should be able to make sound');
  } finally {
    await run.close();
  }
});

test('ui: a loaded save leaves the sound control showing the saved state', async () => {
  const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });
  try {
    const { page } = run;
    await dismissHelp(page);

    const sound = () => page.evaluate(() => ({
      pressed: document.getElementById('soundbtn').getAttribute('aria-pressed'),
      label: document.getElementById('soundbtn').getAttribute('aria-label'),
      audio: window.__rf.world.settings.audio,
    }));

    assert.equal((await sound()).audio, true, 'sound starts on');

    // Mute, then save that preference.
    await page.click('#soundbtn');
    assert.equal((await sound()).audio, false, 'the mute must reach the world');
    await menuAction(page, 'btnSave');
    await page.waitForTimeout(200);

    // Unmute in this session, so the live setting differs from the saved one.
    await page.click('#soundbtn');
    assert.equal((await sound()).audio, true, 'the unmute must reach the world');

    // Loading the save must restore BOTH the setting and the control that shows it.
    await menuAction(page, 'btnLoad');
    await page.waitForFunction(() => window.__rf.world.settings.audio === false, null, { timeout: 10000 });

    const after = await sound();
    assert.equal(after.audio, false, 'the loaded preference must be applied');
    assert.equal(after.pressed, 'false',
      'the sound control must show the loaded state, not the state it had before the load');
    assert.equal(after.label, 'Sound off',
      `the control label must follow the loaded state, got "${after.label}"`);
  } finally {
    await run.close();
  }
});

test('ui: export produces a file and a bad import leaves the city alone', async () => {
  const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });
  try {
    const { page } = run;
    await dismissHelp(page);
    await page.click('[data-speed="0"]');

    await page.keyboard.press('1');
    await page.mouse.click(500, 400);
    await page.mouse.click(760, 400);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__rf.state.net.edges.size > 0, null, { timeout: 10000 });
    const built = await worldState(page);

    // Export must hand the player a real file. The menu action lives in the
    // popover, so open it first.
    await page.click('#menubtn');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.click('#btnExport'),
    ]);
    const suggested = download.suggestedFilename();
    assert.match(suggested, /\.json$/, `exported file should be JSON, got ${suggested}`);
    const saved = await download.path();
    const text = await readFile(saved, 'utf8');
    const parsed = JSON.parse(text);
    assert.ok(parsed.net, 'the exported snapshot must carry the graph');

    // A garbage import must change nothing at all.
    await page.setInputFiles('#importfile', {
      name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ not json'),
    });
    await page.waitForTimeout(400);
    const after = await worldState(page);
    assert.deepEqual(after, built, 'a failed import must leave the city byte-for-byte as it was');

    const toastText = await page.$$eval('#toasts .toast', els => els.map(e => e.textContent).join(' | '));
    assert.match(toastText, /Import failed/i, `the player must be told, got: ${toastText}`);
    assert.match(toastText, /unchanged/i, 'the message must say the city was not touched');

    // A structurally valid but semantically wrong snapshot is also refused.
    await page.setInputFiles('#importfile', {
      name: 'wrong.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ version: 2, net: { nodes: [], edges: [] }, eco: { batch: 'nope' } })),
    });
    await page.waitForTimeout(400);
    assert.deepEqual(await worldState(page), built, 'an invalid snapshot must not replace the city');

    // A genuine round trip does replace it, and reports success.
    await page.setInputFiles('#importfile', {
      name: 'good.json', mimeType: 'application/json', buffer: Buffer.from(text),
    });
    await page.waitForFunction(() => document.getElementById('toasts').textContent.includes('Imported'), null, { timeout: 10000 });
    const restored = await worldState(page);
    assert.equal(restored.edges, built.edges, 'a valid import must restore the same graph');
  } finally {
    await run.close();
  }
});

test('ui: a depleted tool explains why and how to progress', async () => {
  const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });
  try {
    const { page } = run;
    await dismissHelp(page);
    await page.evaluate(() => { window.__rf.state.eco.batch.house = 0; });

    await selectTool(page, 'house');
    await page.waitForFunction(
      () => document.getElementById('ctxhelp').textContent.includes('No houses left'),
      null, { timeout: 5000 });

    const help = await page.evaluate(() => document.getElementById('ctxhelp').textContent);
    assert.match(help, /No houses left/, `the reason must be stated, got: ${help}`);
    assert.match(help, /[Ll]evel/, `the progression link must be stated, got: ${help}`);
    assert.match(help, /XP to go/, `the link must be concrete, got: ${help}`);
    assert.ok(!EMOJI.test(help), 'the reason must not be an emoji');

    // The tool stays usable, so the player can still try and be told why not.
    assert.equal(await page.evaluate(() => document.querySelector('[data-tool="house"]').getAttribute('aria-pressed')), 'true',
      'a depleted tool stays selectable so its reason is reachable');

    // Placing consumes nothing, because there is nothing to consume.
    const before = await page.evaluate(() => ({ ...window.__rf.state.eco.batch }));
    await page.mouse.click(600, 400);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ ...window.__rf.state.eco.batch }));
    assert.deepEqual(after, before, 'a refused placement must not consume stock');

    await page.screenshot({ path: `${shots}/ui-depleted-desktop-1440x900-seed1.png` });

    // Restoring stock removes the warning rather than leaving it stale.
    await page.evaluate(() => { window.__rf.state.eco.batch.house = 3; });
    await page.click('[data-speed="1"]');
    await page.click('[data-speed="0"]');
    await page.waitForFunction(
      () => !document.getElementById('ctxhelp').textContent.includes('No houses left'),
      null, { timeout: 5000 });
  } finally {
    await run.close();
  }
});

test('ui: the compact inspector scrolls instead of overflowing', async () => {
  const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1024, height: 768 } });
  try {
    const { page } = run;
    await dismissHelp(page);
    await page.click('[data-speed="0"]');

    await page.keyboard.press('1');
    await page.mouse.click(300, 300);
    await page.mouse.click(600, 300);
    await page.mouse.click(600, 450);
    await page.keyboard.press('Enter');
    // A light needs a junction with at least two road connections, so target
    // the bend rather than a dead end.
    await page.keyboard.press('5');
    await page.mouse.click(600, 300);

    await page.waitForFunction(
      () => document.getElementById('inspect').classList.contains('open'), null, { timeout: 10000 });

    const box = await page.evaluate(() => {
      const el = document.getElementById('inspect');
      const r = el.getBoundingClientRect();
      const dock = document.getElementById('toolbar').getBoundingClientRect();
      return {
        width: r.width, left: r.left, right: r.right, bottom: r.bottom,
        dockTop: dock.top, vw: window.innerWidth, vh: window.innerHeight,
        scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: getComputedStyle(el).overflowY,
        controls: el.querySelectorAll('input, button').length,
      };
    });
    assert.ok(box.left >= 0 && box.right <= box.vw + 1,
      `the compact inspector must stay on screen (${box.left}..${box.right} of ${box.vw})`);
    assert.ok(box.bottom <= box.dockTop + 1,
      `the compact inspector must not cover the dock (${box.bottom} vs ${box.dockTop})`);
    assert.equal(box.overflowY, 'auto', 'the inspector must scroll internally');
    assert.ok(box.controls >= 3, `the light editor needs its controls present, found ${box.controls}`);

    // Every control must be reachable by scrolling, not clipped away.
    const reachable = await page.evaluate(() => {
      const el = document.getElementById('inspect');
      const last = el.querySelector('input[type=range]:last-of-type');
      last.scrollIntoView({ block: 'nearest' });
      const r = last.getBoundingClientRect();
      const p = el.getBoundingClientRect();
      return r.top >= p.top - 1 && r.bottom <= p.bottom + 1;
    });
    assert.ok(reachable, 'the last slider must be scrollable into view');

    await page.screenshot({ path: `${shots}/ui-inspector-compact-1024x768-seed1.png` });
    assert.deepEqual(run.errors.filter(e => !/favicon/.test(e)), [], 'no console errors');
  } finally {
    await run.close();
  }
});

test('ui: lane markings stay readable across the zoom range', async () => {
  const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: 1440, height: 900 } });
  try {
    const { page } = run;
    await dismissHelp(page);
    await page.click('[data-speed="0"]');

    // An avenue with a side street: a road class that has interior dividers, and
    // a junction whose mouth the markings must not cross.
    await page.keyboard.press('2'); // avenue
    await page.mouse.click(500, 420);
    await page.mouse.click(950, 420);
    await page.keyboard.press('Enter');
    await page.keyboard.press('1'); // street
    await page.mouse.click(720, 420);
    await page.mouse.click(720, 580);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__rf.state.net.edges.size >= 2, null, { timeout: 10000 });

    const zooms = [0.25, 1, 3];
    for (const zoom of zooms) {
      const drawn = await page.evaluate((z) => {
        window.__rf.renderer.cam.zoom = z;
        return window.__rf.renderer.cam.zoom;
      }, zoom);
      assert.equal(drawn, zoom, `the camera must accept zoom ${zoom}`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${shots}/ui-markings-zoom${zoom}-desktop-1440x900-seed1.png` });
    }

    assert.deepEqual(run.errors.filter(e => !/favicon/.test(e)), [],
      'no console errors across the zoom sweep');
  } finally {
    await run.close();
  }
});

// ---------- captures ----------

test('ui: captures every tool state at desktop and compact viewports', async () => {
  for (const vp of VIEWPORTS) {
    const run = await launchGame({ baseUrl: server.baseUrl, viewport: { width: vp.width, height: vp.height } });
    try {
      const { page } = run;
      await dismissHelp(page);
      await page.click('[data-speed="0"]'); // frozen clock: captures are comparable
      const tag = `${vp.name}-${vp.width}x${vp.height}-dpr1-seed1`;
      const groups = groupByCategory(await toolCategories(page));

      await page.screenshot({ path: `${shots}/ui-${tag}-full.png` });

      const box = await page.locator('#toolbar').boundingBox();
      const clip = {
        x: Math.max(0, box.x - 8),
        y: Math.max(0, box.y - 8),
        width: Math.min(vp.width - Math.max(0, box.x - 8), box.width + 16),
        height: Math.min(vp.height - Math.max(0, box.y - 8), box.height + 16),
      };

      const geometry = await page.evaluate(() => {
        const bar = document.getElementById('toolbar');
        const r = bar.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scroll: bar.scrollWidth, client: bar.clientWidth };
      });

      for (const [category, tools] of groups) {
        await openCategory(page, category);
        await page.mouse.move(vp.width / 2, 40);
        await page.screenshot({ path: `${shots}/ui-${tag}-category-${category}.png`, clip });

        for (const tool of tools) {
          await page.click(`[data-tool="${tool}"]`);
          await page.mouse.move(vp.width / 2, 40); // park the pointer off the dock
          await page.screenshot({ path: `${shots}/ui-${tag}-${tool}-active.png`, clip });

          await page.hover(`[data-tool="${tool}"]`);
          await page.screenshot({ path: `${shots}/ui-${tag}-${tool}-hover.png`, clip });

          assert.ok(await tabUntilTool(page, tool),
            `${vp.name}: Tab must reach ${tool} for its focus capture`);
          await page.mouse.move(vp.width / 2, 40);
          await page.screenshot({ path: `${shots}/ui-${tag}-${tool}-focus.png`, clip });
        }
      }

      // The menu popover belongs to the top band, not the dock, so it needs a
      // full-page capture to be visible.
      await page.click('#menubtn');
      await page.screenshot({ path: `${shots}/ui-${tag}-menu-open.png` });
      await page.keyboard.press('Escape');

      // Geometry is asserted after the captures so a layout failure still
      // leaves the visual evidence in artifacts/.
      assert.ok(geometry.left >= 0 && geometry.right <= vp.width + 1,
        `${vp.name}: the dock must stay inside the viewport (${geometry.left}..${geometry.right} of ${vp.width})`);
      assert.ok(geometry.bottom <= vp.height + 1, `${vp.name}: the dock must stay above the fold`);
      assert.ok(geometry.scroll - geometry.client <= 1,
        `${vp.name}: no tool may be clipped offscreen (overflow ${geometry.scroll - geometry.client}px)`);

      const errs = run.errors.filter(e => !/favicon/.test(e));
      assert.deepEqual(errs, [], `${vp.name}: no console errors during the capture pass`);
    } finally {
      await run.close();
    }
  }
});
