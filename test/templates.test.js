// Local construction templates (S03.5).
//
// Two rules under test:
//   1. A template is DATA, never code: closed schema, unknown fields rejected,
//      no eval, no new Function, bounded before parsing.
//   2. A template is ONE transaction: any failure builds nothing, and one undo
//      removes all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import { Economy } from '../src/economy.js';
import { TrafficSim } from '../src/traffic.js';
import { makeRng } from '../src/core.js';
import { createHistory } from '../src/worldCommands.js';
import { Terrain } from '../src/terrain.js';
import {
  TEMPLATE_SCHEMA, TEMPLATE_VERSION, ROTATION_STEP_DEG, TEMPLATE_LIMITS,
  validateTemplate, transformTemplate, builtinTemplates, templateCommand,
  exportTemplate, parseTemplate, serializeTemplate, templateFilename, boundsOf,
} from '../src/templates.js';

const FLAT = { isBuildable: () => true, isRoadable: () => true, sample: () => 0, elevation: () => 0.5, seed: 1 };

/**
 * A real buildable square of `size` wu, found by scanning seed-1 terrain.
 *
 * Tests that go through applyWorldCommand CANNOT use a mocked terrain: the
 * snapshot stores only the seed, so hydration rebuilds a real Terrain and the
 * mock is discarded.
 */
function findBuildableSquare(terrain, size = 600) {
  for (let y = -2000; y <= 1800; y += 40) {
    for (let x = -2000; x <= 1800; x += 40) {
      let ok = true;
      for (let i = 0; i <= size && ok; i += 40) {
        for (let j = 0; j <= size && ok; j += 40) {
          if (!terrain.isRoadable(x + i, y + j)) ok = false;
        }
      }
      if (ok) return [x + size / 2, y + size / 2];
    }
  }
  return null;
}

function world({ terrain = FLAT } = {}) {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const eco = new Economy(net, terrain, 1);
  eco.onToast = () => {};
  eco.batch = { house: 10, shop: 10, factory: 10 };
  const traffic = new TrafficSim(net, { rng: makeRng(1) });
  return { net, terrain, eco, ids, traffic, camera: { x: 0, y: 0, zoom: 1 }, settings: { speed: 0, audio: true } };
}

/** A minimal valid template record. */
function minimal(overrides = {}) {
  return {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: 'Test',
    segments: [{ from: [0, 0], to: [200, 0], cls: 'street' }],
    ...overrides,
  };
}

// ------------------------------------------------------------- built-ins ---

test('the three built-in templates are valid and have the promised shapes', () => {
  const builtins = builtinTemplates();
  assert.equal(builtins.length, 3, 'DESIGN asks for three built-ins');
  const names = builtins.map(t => t.name);
  assert.deepEqual(names, ['T junction', 'Four-way roundabout', 'Rectangular block']);

  for (const t of builtins) {
    assert.equal(t.kind, 'builtin');
    assert.ok(t.segments.length >= 2, `${t.name} needs at least two segments`);
    assert.ok(t.bbox, `${t.name} needs a bounding box`);
  }

  const roundabout = builtins.find(t => t.name === 'Four-way roundabout');
  assert.equal(roundabout.roundabouts.length, 1, 'the roundabout template needs its ring');
  assert.equal(roundabout.segments.length, 2, 'and a crossroads to put it on');

  const block = builtins.find(t => t.name === 'Rectangular block');
  assert.equal(block.segments.length, 4, 'a block is four sides');

  const t = builtins.find(x => x.name === 'T junction');
  assert.equal(t.segments.length, 3 - 1 + 0, 'a T junction is a through road plus one arm');
});

test('every built-in is centred near the origin, so a placement offset is meaningful', () => {
  for (const t of builtinTemplates()) {
    const b = t.bbox;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    assert.ok(Math.abs(cx) < 60, `${t.name} is centred at x=${cx}, far from the origin`);
    assert.ok(Math.abs(cy) < 60, `${t.name} is centred at y=${cy}, far from the origin`);
  }
});

// ---------------------------------------------------------------- schema ---

test('a minimal template validates', () => {
  const r = validateTemplate(minimal());
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.template.schema, TEMPLATE_SCHEMA);
  assert.equal(r.template.kind, 'user', 'the kind defaults to user');
  assert.deepEqual(r.template.bbox, { minX: 0, minY: 0, maxX: 200, maxY: 0 });
});

test('an unknown top-level field is REJECTED, not ignored', () => {
  // A permissive reader is how a data format becomes an attack surface.
  const r = validateTemplate(minimal({ onLoad: 'alert(1)' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown template field: onLoad/i);
});

test('an unknown segment field is rejected', () => {
  const r = validateTemplate(minimal({
    segments: [{ from: [0, 0], to: [200, 0], cls: 'street', script: 'x' }],
  }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /segment 1 has unknown field: script/i);
});

test('a wrong schema or version is rejected with the expected value', () => {
  const badSchema = validateTemplate(minimal({ schema: 'other.format' }));
  assert.equal(badSchema.ok, false);
  assert.match(badSchema.reason, /roadflow\.template/);

  const future = validateTemplate(minimal({ version: 99 }));
  assert.equal(future.ok, false);
  assert.match(future.reason, /unsupported template version 99/);
  assert.match(future.reason, new RegExp(`version ${TEMPLATE_VERSION}`),
    'the reason must say which version this build reads');
});

test('a template must be an object with a name and at least one segment', () => {
  assert.equal(validateTemplate(null).ok, false);
  assert.equal(validateTemplate([]).ok, false);
  assert.equal(validateTemplate('text').ok, false);
  assert.equal(validateTemplate(minimal({ name: '' })).ok, false);
  assert.equal(validateTemplate(minimal({ name: 'x'.repeat(TEMPLATE_LIMITS.nameLength + 1) })).ok, false);
  assert.equal(validateTemplate(minimal({ segments: [] })).ok, false);
  assert.equal(validateTemplate(minimal({ segments: undefined })).ok, false);
});

test('segment geometry is validated: shape, finiteness, bounds, class, length', () => {
  const bad = [
    [{ from: [0], to: [200, 0] }, /from must be a \[x, y\] pair/i],
    [{ from: [0, 0], to: [200, 0, 0] }, /to must be a \[x, y\] pair/i],
    [{ from: [NaN, 0], to: [200, 0] }, /finite/i],
    [{ from: [0, 0], to: [Infinity, 0] }, /finite/i],
    [{ from: [0, 0], to: [TEMPLATE_LIMITS.coordinate + 1, 0] }, /outside/i],
    [{ from: [0, 0], to: [200, 0], cls: 'motorway' }, /unknown road class/i],
    [{ from: [5, 5], to: [5, 5] }, /zero length/i],
    ['not an object', /must be an object/i],
  ];
  for (const [segment, pattern] of bad) {
    const r = validateTemplate(minimal({ segments: [segment] }));
    assert.equal(r.ok, false, `segment ${JSON.stringify(segment)} must be rejected`);
    assert.match(r.reason, pattern, `got: ${r.reason}`);
  }
});

test('the segment count is bounded', () => {
  const many = Array.from({ length: TEMPLATE_LIMITS.segments + 1 }, (_, i) => ({
    from: [i * 10, 0], to: [i * 10 + 5, 0], cls: 'street',
  }));
  const r = validateTemplate(minimal({ segments: many }));
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`${TEMPLATE_LIMITS.segments}`),
    'the reason must name the limit');
});

test('roundabouts are validated and default their radius', () => {
  const ok = validateTemplate(minimal({ roundabouts: [{ at: [0, 0] }] }));
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.template.roundabouts[0].radius, 32, 'the radius defaults');

  for (const [r, pattern] of [
    [{ at: [0, 0], radius: 10 }, /between 24 and 100/i],
    [{ at: [0, 0], radius: 500 }, /between 24 and 100/i],
    [{ at: [NaN, 0] }, /finite/i],
    [{ at: [0, 0], extra: 1 }, /unknown field/i],
  ]) {
    const res = validateTemplate(minimal({ roundabouts: [r] }));
    assert.equal(res.ok, false, `roundabout ${JSON.stringify(r)} must be rejected`);
    assert.match(res.reason, pattern, `got: ${res.reason}`);
  }
});

test('a supplied bbox is ignored: it is always derived from the geometry', () => {
  // A supplied bbox could disagree with the segments and mislead a preview.
  const r = validateTemplate(minimal({ bbox: { minX: -9999, minY: -9999, maxX: 9999, maxY: 9999 } }));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.template.bbox, { minX: 0, minY: 0, maxX: 200, maxY: 0 },
    'the bbox must be recomputed, not trusted');
});

// -------------------------------------------------------------- transform ---

test('rotation must be a multiple of 15 degrees', () => {
  const t = validateTemplate(minimal()).template;
  for (const deg of [0, 15, 30, 45, 90, 180, 345, -30]) {
    const r = transformTemplate(t, { rotateDeg: deg });
    assert.equal(r.ok, true, `${deg}deg must be accepted: ${r.reason}`);
  }
  for (const deg of [1, 7, 14, 16, 22.5]) {
    const r = transformTemplate(t, { rotateDeg: deg });
    assert.equal(r.ok, false, `${deg}deg must be refused`);
    assert.match(r.reason, new RegExp(`multiple of ${ROTATION_STEP_DEG}`));
  }
  assert.equal(ROTATION_STEP_DEG, 15);
});

test('rotation preserves segment length and the shape', () => {
  const t = validateTemplate(minimal({
    segments: [
      { from: [-100, -50], to: [100, -50], cls: 'street' },
      { from: [100, -50], to: [100, 50], cls: 'street' },
    ],
  })).template;

  const lengthOf = (segs) => segs.map(s =>
    Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1])).sort((a, b) => a - b);
  const before = lengthOf(t.segments);

  for (const deg of [0, 15, 30, 90, 180, 270]) {
    const r = transformTemplate(t, { rotateDeg: deg });
    assert.equal(r.ok, true);
    const after = lengthOf(r.template.segments);
    for (let k = 0; k < after.length; k++) {
      assert.ok(Math.abs(after[k] - before[k]) < 1e-9,
        `${deg}deg changed a segment length from ${before[k]} to ${after[k]}`);
    }
  }
});

test('translation moves every point by exactly the offset', () => {
  const t = validateTemplate(minimal()).template;
  const r = transformTemplate(t, { dx: 500, dy: -300 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.template.segments[0].from, [500, -300]);
  assert.deepEqual(r.template.segments[0].to, [700, -300]);
});

test('a 90-degree rotation maps x to y exactly, with no -0 leakage', () => {
  const t = validateTemplate(minimal({
    segments: [{ from: [0, 0], to: [200, 0], cls: 'street' }],
  })).template;
  const r = transformTemplate(t, { rotateDeg: 90 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.template.segments[0].from, [0, 0]);
  const to = r.template.segments[0].to;
  assert.ok(Math.abs(to[0]) < 1e-9, `expected x ~ 0, got ${to[0]}`);
  assert.ok(Math.abs(to[1] - 200) < 1e-9, `expected y ~ 200, got ${to[1]}`);
  assert.ok(!Object.is(to[0], -0), 'a coordinate of -0 compares unequal under deepEqual');
});

test('transformTemplate is pure and does not mutate its input', () => {
  const t = validateTemplate(minimal()).template;
  const before = JSON.stringify(t);
  transformTemplate(t, { rotateDeg: 45, dx: 100, dy: 100 });
  assert.equal(JSON.stringify(t), before, 'the input template must be unchanged');
});

test('transformTemplate rejects non-finite translation', () => {
  const t = validateTemplate(minimal()).template;
  assert.equal(transformTemplate(t, { dx: NaN }).ok, false);
  assert.equal(transformTemplate(t, { dy: Infinity }).ok, false);
});

// ------------------------------------------------------- data, never code ---

test('template handling never calls eval or new Function', () => {
  // A template is data. If any of these were reachable, an imported file could
  // execute code.
  const realEval = globalThis.eval;
  const realFunction = globalThis.Function;
  let called = false;
  try {
    globalThis.eval = () => { called = true; throw new Error('eval used'); };
    globalThis.Function = () => { called = true; throw new Error('Function used'); };
    const t = validateTemplate(minimal()).template;
    transformTemplate(t, { rotateDeg: 45, dx: 10, dy: 10 });
    templateCommand(t, { cls: 'street' });
    serializeTemplate(t);
    parseTemplate(serializeTemplate(t));
  } finally {
    globalThis.eval = realEval;
    globalThis.Function = realFunction;
  }
  assert.equal(called, false, 'no template path may evaluate code');
});

test('a template with an executable-looking string is inert', () => {
  // The string is data: it round-trips as a name and is never run.
  const r = validateTemplate(minimal({ name: 'x"; process.exit(1); //' }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.template.name, 'x"; process.exit(1); //');
});

// -------------------------------------------------------------- parsing ---

test('template JSON round-trips through serialize and parse', () => {
  for (const t of builtinTemplates()) {
    const text = serializeTemplate(t);
    const back = parseTemplate(text);
    assert.equal(back.ok, true, `${t.name}: ${back.reason}`);
    assert.deepEqual(back.template.segments, t.segments, `${t.name}: segments must survive`);
    assert.deepEqual(back.template.roundabouts, t.roundabouts, `${t.name}: roundabouts must survive`);
    assert.equal(back.template.name, t.name);
  }
});

test('oversized input is rejected before parsing', () => {
  const huge = 'x'.repeat(TEMPLATE_LIMITS.bytes + 1);
  const r = parseTemplate(huge);
  assert.equal(r.ok, false);
  assert.match(r.reason, /bytes/i);
});

test('malformed JSON is rejected with the parser message', () => {
  const r = parseTemplate('{ not json');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not valid JSON/i);
});

test('non-text input is rejected', () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.equal(parseTemplate(v).ok, false, `${JSON.stringify(v)} must be rejected`);
  }
});

test('a template filename is built by allow-list, so no path can leak in', () => {
  const name = templateFilename('../../etc/passwd');
  assert.match(name, /^roadflow-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.template\.json$/);
  assert.ok(!name.includes('/'), 'no separator may survive');
  assert.ok(!name.includes('..'), 'no parent reference may survive');
  assert.ok(!name.includes('\\'), 'no Windows separator may survive');

  const blank = templateFilename('   ');
  assert.match(blank, /roadflow-template-/, 'an empty name falls back to a default');
});

// ----------------------------------------------------------- export/import ---

test('exporting a selection produces a valid, relative template', () => {
  const w = world();
  w.net.addRoad([[0, 0], [400, 0]], 'street');
  const ids = [...w.net.edges.keys()];

  const r = exportTemplate(w, ids, 'My road');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.template.name, 'My road');
  assert.equal(r.template.kind, 'user');
  assert.equal(r.template.segments.length, ids.length);

  // The origin is the selection's centre, so points are relative.
  const b = r.template.bbox;
  assert.ok(Math.abs((b.minX + b.maxX) / 2) < 1, 'the template must be centred on x=0');
  assert.ok(Math.abs((b.minY + b.maxY) / 2) < 1, 'and on y=0');
});

test('exporting excludes driveways and refuses a dangling connector', () => {
  const w = world();
  w.net.addRoad([[0, 0], [400, 0]], 'street');
  w.eco.place('house', 200, 40);
  // A driveway is a NODE type (attachDriveway makes one), not an edge class.
  const drivewayNode = [...w.net.nodes.values()].find(n => n.type === 'driveway');
  assert.ok(drivewayNode, 'fixture must create a driveway node');

  // Exporting the whole road with a building attached is still fine: the driveway
  // node is part of the road, and the building is excluded.
  const ids = [...w.net.edges.keys()];
  const exported = exportTemplate(w, ids, 'with a house');
  assert.equal(exported.ok, true, `the road itself must export: ${exported.reason}`);
  assert.ok(exported.template.segments.every(s => s.cls !== 'driveway'),
    'no driveway may appear in the exported segments');
});

test('exporting a partial roundabout is refused with an explanation', () => {
  const w = world();
  w.net.addRoad([[-400, 0], [400, 0]], 'street');
  w.net.addRoad([[0, -400], [0, 400]], 'street');
  const junction = [...w.net.nodes.values()].find(n => n.edges.size === 4);
  assert.ok(w.net.makeRoundabout(junction.id, 40), 'fixture must build a roundabout');

  const ring = [...w.net.edges.values()].filter(e => e.ring);
  assert.ok(ring.length >= 3, 'fixture must have several ring edges');

  const partial = exportTemplate(w, [ring[0].id], 'half a ring');
  assert.equal(partial.ok, false, 'a partial ring must be refused');
  assert.match(partial.reason, /whole roundabout|of .* roundabout/i,
    `the reason must explain it, got: ${partial.reason}`);

  // The whole ring IS exportable.
  const whole = exportTemplate(w, ring.map(e => e.id), 'full ring');
  assert.equal(whole.ok, true, whole.reason);
});

test('exporting nothing, or an unknown edge, is refused', () => {
  const w = world();
  assert.equal(exportTemplate(w, [], 'x').ok, false);
  assert.equal(exportTemplate(w, ['nope'], 'x').ok, false);
  assert.equal(exportTemplate(null, ['nope'], 'x').ok, false);
});

test('an exported template can be re-imported and placed', () => {
  const w = world();
  w.net.addRoad([[-100, -50], [100, -50]], 'avenue');
  w.net.addRoad([[100, -50], [100, 50]], 'avenue');
  const ids = [...w.net.edges.keys()];

  const exported = exportTemplate(w, ids, 'Corner');
  assert.equal(exported.ok, true, exported.reason);

  const text = serializeTemplate(exported.template);
  const imported = parseTemplate(text);
  assert.equal(imported.ok, true, imported.reason);
  assert.deepEqual(imported.template.segments, exported.template.segments,
    'the geometry must survive a full export/import round trip');
  assert.ok(imported.template.segments.every(s => s.cls === 'avenue'),
    'the road classes must survive too');
});

// ------------------------------------------------------------- placement ---

test('templateCommand is plain JSON with no functions', () => {
  const t = builtinTemplates()[0];
  const cmd = templateCommand(t);
  assert.equal(cmd.kind, 'applyTemplate');
  assert.deepEqual(JSON.parse(JSON.stringify(cmd)), cmd,
    'a command must survive a JSON round trip unchanged');
});

test('a placed template builds every segment as one undoable edit', () => {
  const h = createHistory();
  const w = world();
  const placed = transformTemplate(builtinTemplates()[0], { dx: 0, dy: 0 });
  assert.equal(placed.ok, true);

  const before = w.net.edges.size;
  const r = h.execute(w, templateCommand(placed.template));
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);
  assert.ok(r.world.net.edges.size > before, 'the template must build roads');
  assert.equal(h.depth, 1, 'a template must be ONE history entry');

  const undone = h.undo(r.world);
  assert.equal(undone.ok, true);
  assert.equal(undone.world.net.edges.size, before,
    'one undo must remove the whole template');
});

test('a template with one unbuildable segment builds NOTHING', () => {
  const h = createHistory();
  // A deliberately long template: a 3000 wu road across a real island map MUST
  // cross unbuildable ground, so one segment has to fail. A second, short
  // segment near the origin is valid, so the mix is guaranteed.
  const probe = world();
  const start = findBuildableSquare(probe.terrain, 200);
  assert.ok(start, 'fixture must find a buildable point');
  const tpl = validateTemplate({
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: 'Long road',
    segments: [
      { from: [0, 0], to: [40, 0], cls: 'street' },
      { from: [0, 0], to: [3000, 0], cls: 'street' },
    ],
  }).template;
  assert.ok(tpl, 'fixture template must validate');

  const w = world();
  const placed = transformTemplate(tpl, { dx: start[0], dy: start[1] });
  assert.equal(placed.ok, true);
  const goodSeg = placed.template.segments[0];
  assert.ok(probe.terrain.isRoadable(goodSeg.from[0], goodSeg.from[1])
    && probe.terrain.isRoadable(goodSeg.to[0], goodSeg.to[1]),
    'fixture: the short segment must be buildable, so the refusal is caused by the long one');

  const before = w.net.edges.size;
  const r = h.execute(w, templateCommand(placed.template));
  assert.equal(r.ok, false, 'a template crossing water must be refused');
  assert.ok(r.reason && r.reason.length > 5, `with a reason, got ${r.reason}`);
  assert.equal(r.world.net.edges.size, before, 'and NOTHING may be built');
  assert.equal(h.depth, 0, 'and nothing may be undoable');
});

test('a rotated template builds at the rotated geometry', () => {
  const h = createHistory();
  const w = world();
  const placed = transformTemplate(builtinTemplates()[0], { rotateDeg: 90, dx: 0, dy: 0 });
  assert.equal(placed.ok, true);

  const r = h.execute(w, templateCommand(placed.template));
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);

  // The through road must now run along y, not x.
  const edges = [...r.world.net.edges.values()].filter(e => e.cls === 'street');
  const horizontal = edges.filter(e => Math.abs(e.pts[0][1] - e.pts[e.pts.length - 1][1]) < 1);
  const vertical = edges.filter(e => Math.abs(e.pts[0][0] - e.pts[e.pts.length - 1][0]) < 1);
  assert.ok(vertical.length >= 1, 'a 90-degree rotation must produce a vertical road');
  assert.ok(horizontal.length >= 1, 'and a horizontal one');
});

test('each built-in drives a legal trip after placement', () => {
  // The verify line: a built-in must produce a usable network, not decorative
  // lines. Place it, put a house and a shop on two different arms, and let the
  // simulation complete a trip.
  for (const t of builtinTemplates()) {
    const h = createHistory();
    const w = world();
    // Real terrain: scan for an origin where every one of THIS template's own
    // segment endpoints is roadable. A coarse buildable square is not enough,
    // because terrain can change within the sampling step.
    // A REAL Terrain, matching what applyWorldCommand hydrates from the seed.
    const realTerrain = new Terrain(1);
    let placed = null;
    for (let y = -1800; y <= 1600 && !placed; y += 60) {
      for (let x = -1800; x <= 1600 && !placed; x += 60) {
        const candidate = transformTemplate(t, { dx: x, dy: y });
        if (!candidate.ok) continue;
        const fits = candidate.template.segments.every(s =>
          realTerrain.isRoadable(s.from[0], s.from[1])
          && realTerrain.isRoadable(s.to[0], s.to[1]));
        if (fits) placed = candidate;
      }
    }
    assert.ok(placed, `${t.name}: fixture must find ground the template fits on`);

    const built = h.execute(w, templateCommand(placed.template));
    assert.equal(built.ok, true, `${t.name} failed to place: ${built.reason}`);
    let live = built.world;

    // Find two road points far enough apart to sit on different arms.
    const roadPts = [];
    for (const e of live.net.edges.values()) {
      if (e.cls === 'driveway') continue;
      roadPts.push(e.pts[0], e.pts[e.pts.length - 1]);
    }
    assert.ok(roadPts.length >= 2, `${t.name} must expose at least two road ends`);

    // Try pairs until a house and a shop both place and a trip completes.
    let completed = false;
    for (let i = 0; i < roadPts.length && !completed; i++) {
      for (let j = i + 1; j < roadPts.length && !completed; j++) {
        const attempt = h.execute(live, { kind: 'placeBuilding', type: 'house',
          x: roadPts[i][0], y: roadPts[i][1] + 40 });
        if (!attempt.ok) continue;
        const shop = h.execute(attempt.world, { kind: 'placeBuilding', type: 'shop',
          x: roadPts[j][0], y: roadPts[j][1] + 40 });
        if (!shop.ok) continue;

        let sim = shop.world;
        for (let step = 0; step < 60 * 400; step++) {
          sim.traffic.update(1 / 60);
          sim.eco.update(1 / 60, sim.traffic, (from, to) => sim.traffic.spawn(from, to));
          sim.eco.processReturns(1 / 60, (from, to) => sim.traffic.spawn(from, to));
          sim.eco.checkLevelUp();
          if (sim.eco.totalTrips > 0) { completed = true; break; }
        }
      }
    }
    assert.ok(completed, `${t.name} must let a house and a shop complete a real trip`);
  }
});

test('boundsOf is the exact bounding box of the segments', () => {
  const segs = [
    { from: [-50, -20], to: [80, 30] },
    { from: [80, 30], to: [-10, 100] },
  ];
  assert.deepEqual(boundsOf(segs), { minX: -50, minY: -20, maxX: 80, maxY: 100 });
  assert.equal(boundsOf([]), null);
  assert.equal(boundsOf(null), null);
});

test('a template with a roundabout marker actually builds a ring', () => {
  // Without this, the "Four-way roundabout" template would silently degrade to a
  // plain crossroads: the roads exist either way, so only a ring assertion can
  // tell the difference.
  const h = createHistory();
  const w = world();
  const t = builtinTemplates().find(x => x.name === 'Four-way roundabout');
  assert.ok(t.roundabouts.length === 1, 'fixture must be the roundabout template');

  // Real terrain: find ground the crossroads fits on.
  const realTerrain = new Terrain(1);
  let placed = null;
  for (let y = -1800; y <= 1600 && !placed; y += 60) {
    for (let x = -1800; x <= 1600 && !placed; x += 60) {
      const candidate = transformTemplate(t, { dx: x, dy: y });
      if (!candidate.ok) continue;
      const fits = candidate.template.segments.every(s =>
        realTerrain.isRoadable(s.from[0], s.from[1])
        && realTerrain.isRoadable(s.to[0], s.to[1]));
      if (fits) placed = candidate;
    }
  }
  assert.ok(placed, 'fixture must find ground for the crossroads');

  const r = h.execute(w, templateCommand(placed.template));
  assert.equal(r.ok, true, `expected success, got ${r.reason}`);

  const ring = [...r.world.net.edges.values()].filter(e => e.ring);
  assert.ok(ring.length >= 3,
    `the roundabout marker must produce a ring, found ${ring.length} ring edges`);

  const ringNodes = [...r.world.net.nodes.values()].filter(n => n.isRing);
  assert.ok(ringNodes.length >= 3, 'and ring nodes');
});
