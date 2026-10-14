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
import {
  startServer, launchGame, runDir, dismissHelp,
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
 * Moves focus to the Nth toolbar button using the keyboard only.
 *
 * `blur()` alone is not enough: Chromium keeps the sequential focus navigation
 * starting point where it was, so Tab would resume mid-dock. Focusing a
 * tabindex=-1 body resets the starting point to the top of the document.
 */
async function tabToTool(page, index) {
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  for (let n = 0; n <= index; n++) await page.keyboard.press('Tab');
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
  const zones = ['#toolbar', '#menu', '#speedctl', '#hud', '#inspect', '#help'];
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

test('ui: speed controls keep their values and an accessible name', async () => {
  const { page } = game;
  const speeds = await page.$$eval('[data-speed]', els => els.map(e => e.dataset.speed));
  assert.deepEqual(speeds, EXPECTED_SPEEDS, `speed controls were: ${speeds.join(', ')}`);

  const names = await page.$$eval('[data-speed]', els => els.map(e => ({
    speed: e.dataset.speed,
    name: (e.getAttribute('aria-label') || '').trim(),
    hasIcon: !!e.querySelector('svg[aria-hidden="true"]'),
  })));
  for (const s of names) {
    assert.ok(s.hasIcon, `speed ${s.speed}: renders an inline svg icon`);
    assert.ok(s.name.length > 0, `speed ${s.speed}: needs a non-emoji accessible name`);
  }
});

test('ui: keyboard focus is visible on every tool', async () => {
  const { page } = game;

  for (let i = 0; i < EXPECTED_TOOLS.length; i++) {
    await tabToTool(page, i);
    const state = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return {
        tool: el?.dataset?.tool ?? null,
        focusVisible: el?.matches?.(':focus-visible') ?? false,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        outlineOffset: cs.outlineOffset,
      };
    });
    assert.equal(state.tool, EXPECTED_TOOLS[i], `Tab order should reach ${EXPECTED_TOOLS[i]}`);
    assert.ok(state.focusVisible, `${state.tool}: keyboard focus must match :focus-visible`);
    assert.equal(state.outlineWidth, '2px', `${state.tool}: focus ring must be 2px, got ${state.outlineWidth}`);
    assert.equal(state.outlineOffset, '2px', `${state.tool}: focus ring needs a 2px offset`);
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
  await page.click('[data-tool="house"]');
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
    assert.deepEqual(run.errors.filter(e => !/favicon/.test(e)), [], 'no console errors while inspecting');
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

      for (let i = 0; i < EXPECTED_TOOLS.length; i++) {
        const tool = EXPECTED_TOOLS[i];

        await page.click(`[data-tool="${tool}"]`);
        await page.mouse.move(vp.width / 2, 40); // park the pointer off the dock
        await page.screenshot({ path: `${shots}/ui-${tag}-${tool}-active.png`, clip });

        await page.hover(`[data-tool="${tool}"]`);
        await page.screenshot({ path: `${shots}/ui-${tag}-${tool}-hover.png`, clip });

        await tabToTool(page, i);
        const focused = await page.evaluate(() => document.activeElement?.dataset?.tool ?? null);
        assert.equal(focused, tool, `${vp.name}: Tab must reach ${tool} for its focus capture`);
        await page.mouse.move(vp.width / 2, 40);
        await page.screenshot({ path: `${shots}/ui-${tag}-${tool}-focus.png`, clip });
      }

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
