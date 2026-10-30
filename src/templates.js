// Local construction templates — S03.5.
//
// WHY THIS MODULE EXISTS
// ----------------------
// Rebuilding the same junction shape by hand every time is the tedium that makes
// a road builder stop being fun. A template is a BOUNDED, DATA-ONLY description
// of a small road subgraph that can be placed, rotated and translated as one
// transaction.
//
// Two rules drive the design:
//
//   1. A template is DATA, never code. No `eval`, no `new Function`, no string
//      arithmetic. Every field is validated against a closed schema and unknown
//      fields are rejected, so an imported template cannot smuggle behaviour in.
//   2. A template is applied as ONE transaction. If any part of it fails - a
//      collision, water, a segment the graph refuses - NOTHING is built, and one
//      undo removes all of it.
//
// Everything here is pure: transform, validate and serialise without touching a
// world. Only `templateCommand` produces something the command dispatcher acts on.
import { dist } from './core.js';
import { serializeWorld } from './worldSnapshot.js';

/** Schema identifier and version. A future version must migrate, not guess. */
export const TEMPLATE_SCHEMA = 'roadflow.template';
export const TEMPLATE_VERSION = 1;

/** Rotation must be a multiple of this many degrees. */
export const ROTATION_STEP_DEG = 15;

/** Hard bounds, mirroring the save limits in CONTRACTS section 7. */
export const TEMPLATE_LIMITS = {
  bytes: 1024 * 1024,
  segments: 100,
  roundabouts: 20,
  coordinate: 20000,
  nameLength: 80,
};

/** Fields a template record may carry. Anything else is rejected. */
const TEMPLATE_FIELDS = new Set([
  'schema', 'version', 'name', 'kind', 'segments', 'roundabouts', 'bbox', 'meta',
]);

/** Fields a segment may carry. S05.4: grade/oneway extend segments to carry
 * interchange geometry — still data, validated against closed enums. */
const SEGMENT_FIELDS = new Set(['from', 'to', 'cls', 'grade', 'oneway']);
const GRADE_KINDS = new Set(['ground', 'bridge', 'ramp', 'tunnel']);

/** Fields a roundabout may carry. */
const ROUNDABOUT_FIELDS = new Set(['at', 'radius']);

const ROAD_CLASSES = new Set(['street', 'avenue', 'highway']);

const fail = (reason) => ({ ok: false, reason });

/**
 * Validates a template record.
 *
 * Strict on purpose: unknown top-level or per-item fields are an error, because a
 * permissive reader is how a data format turns into an attack surface.
 *
 * @param {unknown} raw
 * @returns {{ok:true, template:object} | {ok:false, reason:string}}
 */
export function validateTemplate(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('a template must be a JSON object');
  }

  for (const key of Object.keys(raw)) {
    if (!TEMPLATE_FIELDS.has(key)) return fail(`unknown template field: ${key}`);
  }

  if (raw.schema !== TEMPLATE_SCHEMA) {
    return fail(`schema must be "${TEMPLATE_SCHEMA}", got ${JSON.stringify(raw.schema)}`);
  }
  if (raw.version !== TEMPLATE_VERSION) {
    return fail(`unsupported template version ${JSON.stringify(raw.version)}; `
      + `this build reads version ${TEMPLATE_VERSION}`);
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return fail('a template needs a name');
  if (name.length > TEMPLATE_LIMITS.nameLength) {
    return fail(`the name must be at most ${TEMPLATE_LIMITS.nameLength} characters`);
  }

  const kind = raw.kind === undefined ? 'user' : raw.kind;
  if (kind !== 'builtin' && kind !== 'user') {
    return fail(`kind must be "builtin" or "user", got ${JSON.stringify(kind)}`);
  }

  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    return fail('a template needs at least one segment');
  }
  if (raw.segments.length > TEMPLATE_LIMITS.segments) {
    return fail(`a template may hold at most ${TEMPLATE_LIMITS.segments} segments`);
  }

  const segments = [];
  for (let i = 0; i < raw.segments.length; i++) {
    const s = raw.segments[i];
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      return fail(`segment ${i + 1} must be an object`);
    }
    for (const key of Object.keys(s)) {
      if (!SEGMENT_FIELDS.has(key)) return fail(`segment ${i + 1} has unknown field: ${key}`);
    }
    for (const end of ['from', 'to']) {
      const p = s[end];
      if (!Array.isArray(p) || p.length !== 2) {
        return fail(`segment ${i + 1} ${end} must be a [x, y] pair`);
      }
      for (const v of p) {
        if (!Number.isFinite(v)) return fail(`segment ${i + 1} ${end} must be finite numbers`);
        if (Math.abs(v) > TEMPLATE_LIMITS.coordinate) {
          return fail(`segment ${i + 1} ${end} is outside ±${TEMPLATE_LIMITS.coordinate} wu`);
        }
      }
    }
    const cls = s.cls ?? 'street';
    if (!ROAD_CLASSES.has(cls)) {
      return fail(`segment ${i + 1} has unknown road class: ${JSON.stringify(cls)}`);
    }
    if (dist(s.from[0], s.from[1], s.to[0], s.to[1]) < 1) {
      return fail(`segment ${i + 1} has zero length`);
    }
    const seg = { from: [s.from[0], s.from[1]], to: [s.to[0], s.to[1]], cls };
    if (s.oneway !== undefined) {
      if (typeof s.oneway !== 'boolean') return fail(`segment ${i + 1} oneway must be boolean`);
      seg.oneway = s.oneway;
    }
    if (s.grade !== undefined) {
      const g = s.grade;
      if (g === null || typeof g !== 'object' || Array.isArray(g)) {
        return fail(`segment ${i + 1} grade must be an object`);
      }
      for (const key of Object.keys(g)) {
        if (!['kind', 'za', 'zb'].includes(key)) return fail(`segment ${i + 1} grade has unknown field: ${key}`);
      }
      if (!GRADE_KINDS.has(g.kind)) return fail(`segment ${i + 1} grade kind must be ground|bridge|ramp|tunnel`);
      if (!Number.isFinite(g.za) || !Number.isFinite(g.zb)) {
        return fail(`segment ${i + 1} grade za/zb must be finite`);
      }
      seg.grade = { kind: g.kind, za: g.za, zb: g.zb };
    }
    segments.push(seg);
  }

  const roundabouts = [];
  if (raw.roundabouts !== undefined) {
    if (!Array.isArray(raw.roundabouts)) return fail('roundabouts must be an array');
    if (raw.roundabouts.length > TEMPLATE_LIMITS.roundabouts) {
      return fail(`a template may hold at most ${TEMPLATE_LIMITS.roundabouts} roundabouts`);
    }
    for (let i = 0; i < raw.roundabouts.length; i++) {
      const r = raw.roundabouts[i];
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        return fail(`roundabout ${i + 1} must be an object`);
      }
      for (const key of Object.keys(r)) {
        if (!ROUNDABOUT_FIELDS.has(key)) return fail(`roundabout ${i + 1} has unknown field: ${key}`);
      }
      const at = r.at;
      if (!Array.isArray(at) || at.length !== 2 || !at.every(Number.isFinite)) {
        return fail(`roundabout ${i + 1} at must be a finite [x, y] pair`);
      }
      if (Math.abs(at[0]) > TEMPLATE_LIMITS.coordinate
        || Math.abs(at[1]) > TEMPLATE_LIMITS.coordinate) {
        return fail(`roundabout ${i + 1} is outside ±${TEMPLATE_LIMITS.coordinate} wu`);
      }
      const radius = r.radius ?? 32;
      if (!Number.isFinite(radius) || radius < 24 || radius > 100) {
        return fail(`roundabout ${i + 1} radius must be between 24 and 100 wu`);
      }
      roundabouts.push({ at: [at[0], at[1]], radius });
    }
  }

  // The bounding box is derived, never trusted: a supplied one could disagree with
  // the geometry and mislead a preview.
  const bbox = boundsOf(segments);

  return {
    ok: true,
    template: { schema: TEMPLATE_SCHEMA, version: TEMPLATE_VERSION, name, kind, segments, roundabouts, bbox },
  };
}

/** The world bounding box of a set of segments. */
export function boundsOf(segments) {
  if (!Array.isArray(segments) || !segments.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const s of segments) {
    for (const [x, y] of [s.from, s.to]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Rotates and translates a template's geometry. Pure.
 *
 * Rotation must be a multiple of 15 degrees, and there is no scaling: lane widths
 * are physical, so a scaled template would claim pavement it does not have.
 *
 * @param {object} template a validated template
 * @param {{rotateDeg?:number, dx?:number, dy?:number}} placement
 * @returns {{ok:true, template:object} | {ok:false, reason:string}}
 */
export function transformTemplate(template, placement = {}) {
  const { rotateDeg = 0, dx = 0, dy = 0 } = placement;

  if (!Number.isFinite(rotateDeg)) return fail('rotation must be a number');
  if (rotateDeg % ROTATION_STEP_DEG !== 0) {
    return fail(`rotation must be a multiple of ${ROTATION_STEP_DEG} degrees`);
  }
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return fail('translation must be finite numbers');

  const a = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // `+ 0` normalises -0, which compares unequal under deepEqual.
  const rot = ([x, y]) => [
    (x * cos - y * sin) + 0 || 0,
    (x * sin + y * cos) + 0 || 0,
  ];
  const place = ([x, y]) => {
    const [rx, ry] = rot([x, y]);
    return [(rx + dx) + 0 || 0, (ry + dy) + 0 || 0];
  };

  const segments = template.segments.map(s => ({
    from: place(s.from),
    to: place(s.to),
    cls: s.cls,
    // S05.4: rotation/translation are planar; grade heights are invariant.
    ...(s.oneway !== undefined ? { oneway: s.oneway } : {}),
    ...(s.grade ? { grade: { ...s.grade } } : {}),
  }));
  const roundabouts = (template.roundabouts ?? []).map(r => ({
    at: place(r.at),
    radius: r.radius,
  }));

  return {
    ok: true,
    template: {
      ...template,
      segments,
      roundabouts,
      bbox: boundsOf(segments),
      meta: { ...(template.meta ?? {}), rotateDeg, dx, dy },
    },
  };
}

/**
 * The three built-in templates, in relative coordinates centred near the origin.
 *
 * All three are chosen so a player can place two buildings on them and see a real
 * trip complete: a T junction has three arms, a four-way roundabout has four, and
 * a block is a closed loop.
 */
export const BUILTIN_TEMPLATES = [
  {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: 'Diamond interchange',
    kind: 'builtin',
    // Highway east-west at ground, cross road north-south on a bridge deck
    // (z=12). Four one-way ramps link them END-TO-END: every ramp endpoint
    // lands exactly on the highway or the deck (shared node), so the ramps
    // connect rather than dangle. Ramp runs are ~295wu; the 12wu climb stays
    // within slope 0.15.
    segments: [
      { from: [-420, 0], to: [420, 0], cls: 'avenue' },
      {
        from: [0, -320], to: [0, 320], cls: 'street',
        grade: { kind: 'bridge', za: 12, zb: 12 },
      },
      {
        from: [-260, 0], to: [0, -140], cls: 'street', oneway: true,
        grade: { kind: 'ramp', za: 0, zb: 12 },
      },
      {
        from: [0, -140], to: [260, 0], cls: 'street', oneway: true,
        grade: { kind: 'ramp', za: 12, zb: 0 },
      },
      {
        from: [260, 0], to: [0, 140], cls: 'street', oneway: true,
        grade: { kind: 'ramp', za: 0, zb: 12 },
      },
      {
        from: [0, 140], to: [-260, 0], cls: 'street', oneway: true,
        grade: { kind: 'ramp', za: 12, zb: 0 },
      },
    ],
    roundabouts: [],
  },
  {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: 'Dumbbell interchange',
    kind: 'builtin',
    // Two ground roundabouts (one each side) joining the highway to four
    // one-way ramps; the cross road rides a bridge deck (z=12) over the
    // highway with no junction. Roundabout markers sit on the ground
    // highway×ramp junctions — never on the deck.
    segments: [
      { from: [-420, 0], to: [420, 0], cls: 'avenue' },
      {
        from: [0, -320], to: [0, 320], cls: 'street',
        grade: { kind: 'bridge', za: 12, zb: 12 },
      },
      {
        from: [-260, 0], to: [0, -140], cls: 'street', oneway: true,
        grade: { kind: 'ramp', za: 0, zb: 12 },
      },
      {
        from: [0, -140], to: [260, 0], cls: 'street', oneway: true,
        grade: { kind: 'ramp', za: 12, zb: 0 },
      },
      {
        from: [260, 0], to: [0, 140], cls: 'street', oneway: true,
        grade: { kind: 'ramp', za: 0, zb: 12 },
      },
      {
        from: [0, 140], to: [-260, 0], cls: 'street', oneway: true,
        grade: { kind: 'ramp', za: 12, zb: 0 },
      },
    ],
    roundabouts: [{ at: [-260, 0], radius: 36 }, { at: [260, 0], radius: 36 }],
  },
  {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: 'Directional T interchange',
    kind: 'builtin',
    // Highway east-west at ground; north arm rises on a bridge. Two one-way
    // directional ramps meet the deck end-to-end (shared nodes, no stubs).
    // Centred near the origin (bbox centre within 60wu) like every builtin.
    segments: [
      { from: [-420, 160], to: [420, 160], cls: 'avenue' },
      {
        from: [0, 160], to: [0, -160], cls: 'avenue',
        grade: { kind: 'bridge', za: 12, zb: 12 },
      },
      {
        from: [-260, 160], to: [0, 0], cls: 'street', oneway: true,
        grade: { kind: 'ramp', za: 0, zb: 12 },
      },
      {
        from: [0, 0], to: [260, 160], cls: 'street', oneway: true,
        grade: { kind: 'ramp', za: 12, zb: 0 },
      },
    ],
    roundabouts: [],
  },
  {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: 'T junction',
    kind: 'builtin',
    // A through road with one arm, meeting at the origin.
    segments: [
      { from: [-200, -100], to: [200, -100], cls: 'street' },
      { from: [0, -100], to: [0, 100], cls: 'street' },
    ],
    roundabouts: [],
  },
  {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: 'Four-way roundabout',
    kind: 'builtin',
    segments: [
      { from: [-260, 0], to: [260, 0], cls: 'street' },
      { from: [0, -260], to: [0, 260], cls: 'street' },
    ],
    roundabouts: [{ at: [0, 0], radius: 40 }],
  },
  {
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name: 'Rectangular block',
    kind: 'builtin',
    // A closed loop: a car can drive right round it.
    segments: [
      { from: [-160, -100], to: [160, -100], cls: 'street' },
      { from: [160, -100], to: [160, 100], cls: 'street' },
      { from: [160, 100], to: [-160, 100], cls: 'street' },
      { from: [-160, 100], to: [-160, -100], cls: 'street' },
    ],
    roundabouts: [],
  },
];

/** The built-ins, validated once so a malformed table is caught at load time. */
export function builtinTemplates() {
  const out = [];
  for (const raw of BUILTIN_TEMPLATES) {
    const v = validateTemplate(raw);
    if (!v.ok) throw new Error(`built-in template "${raw.name}" is invalid: ${v.reason}`);
    out.push(v.template);
  }
  return out;
}

/**
 * Turns a placed template into ONE command record for the dispatcher.
 *
 * The command carries plain geometry plus roundabout markers, so the dispatcher
 * needs no knowledge of templates at all.
 */
export function templateCommand(placedTemplate, { cls } = {}) {
  return {
    kind: 'applyTemplate',
    name: placedTemplate.name,
    segments: placedTemplate.segments.map(s => ({
      from: s.from,
      to: s.to,
      cls: cls ?? s.cls,
      ...(s.oneway !== undefined ? { oneway: s.oneway } : {}),
      ...(s.grade ? { grade: s.grade } : {}),
    })),
    roundabouts: placedTemplate.roundabouts ?? [],
  };
}

/**
 * Exports a selected road subgraph as a template.
 *
 * Deliberately excludes buildings, vehicles and any connector that would dangle
 * outside the selection: a template that references something it does not contain
 * would fail at placement time for a reason the player cannot see.
 *
 * @param {object} world
 * @param {string[]} edgeIds the selection
 * @param {string} name
 * @returns {{ok:true, template:object} | {ok:false, reason:string}}
 */
export function exportTemplate(world, edgeIds, name) {
  const net = world?.net;
  if (!net) return fail('no world to export from');
  if (!Array.isArray(edgeIds) || edgeIds.length === 0) {
    return fail('select at least one road to save as a template');
  }

  const edges = [];
  for (const id of edgeIds) {
    const e = net.edges.get(id);
    if (!e) return fail(`no road with id ${id}`);
    if (e.cls === 'driveway') {
      return fail('a driveway cannot be saved in a template; it belongs to a building');
    }
    edges.push(e);
  }

  // A ring must be selected WHOLE: a partial ring would rebuild as a broken loop.
  const ringEdges = edges.filter(e => e.ring);
  if (ringEdges.length) {
    const allRing = [...net.edges.values()].filter(e => e.ring);
    if (ringEdges.length !== allRing.length) {
      return fail(`the selection includes ${ringEdges.length} of ${allRing.length} roundabout `
        + 'roads; select the whole roundabout or none of it');
    }
  }

  // Every node touched by the selection: an endpoint outside it would dangle.
  const nodeIds = new Set();
  for (const e of edges) { nodeIds.add(e.a); nodeIds.add(e.b); }

  // Reject a selection whose road continues outside it: placing the template would
  // produce a stub that connects to nothing.
  for (const id of nodeIds) {
    const n = net.nodes.get(id);
    if (!n) continue;
    for (const eid of n.edges) {
      if (edges.some(e => e.id === eid)) continue;
      const other = net.edges.get(eid);
      if (!other || other.cls === 'driveway') continue;
      // A road leaving the selection from a node inside it is normally a dangling
      // connector. Ring nodes are the exception: a roundabout's arms always leave
      // it, and the ring is self-connected, so exporting the ring alone is valid.
      if (n.isRing) continue;
      return fail('the selection has a road leaving it; include that road or exclude its node');
    }
  }

  // Origin at the selection's own centre, so a template's points are relative.
  const bbox = boundsOf(edges.map(e => ({
    from: e.pts[0], to: e.pts[e.pts.length - 1],
  })));
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;

  const segments = edges.map(e => ({
    from: [+(e.pts[0][0] - cx).toFixed(3), +(e.pts[0][1] - cy).toFixed(3)],
    to: [+(e.pts[e.pts.length - 1][0] - cx).toFixed(3),
      +(e.pts[e.pts.length - 1][1] - cy).toFixed(3)],
    cls: e.cls,
  }));

  // Roundabouts inside the selection, expressed relative to the same origin.
  const roundabouts = [];
  const ringNodes = new Set();
  for (const e of ringEdges) { ringNodes.add(e.a); ringNodes.add(e.b); }
  const seenCentres = new Set();
  for (const id of ringNodes) {
    const n = net.nodes.get(id);
    if (!n) continue;
    // Group ring nodes by their ring component via a coarse key.
    const key = `${Math.round(n.x / 200)}:${Math.round(n.y / 200)}`;
    if (seenCentres.has(key)) continue;
    seenCentres.add(key);
    roundabouts.push({
      at: [+(n.x - cx).toFixed(3), +(n.y - cy).toFixed(3)],
      radius: 40,
    });
  }

  return validateTemplate({
    schema: TEMPLATE_SCHEMA,
    version: TEMPLATE_VERSION,
    name,
    kind: 'user',
    segments,
    roundabouts,
  });
}

/**
 * Parses and validates template JSON from text.
 *
 * Bounded before parsing: an oversized string is rejected on its length, so a
 * hostile file cannot make the parser allocate without limit.
 */
export function parseTemplate(text) {
  if (typeof text !== 'string') return fail('template input must be text');
  if (text.length > TEMPLATE_LIMITS.bytes) {
    return fail(`template is ${text.length} bytes; the limit is ${TEMPLATE_LIMITS.bytes}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail(`template is not valid JSON: ${err.message}`);
  }
  return validateTemplate(raw);
}

/** Serialises a validated template to stable, human-readable JSON. */
export function serializeTemplate(template) {
  return JSON.stringify({
    schema: template.schema,
    version: template.version,
    name: template.name,
    kind: template.kind,
    segments: template.segments,
    roundabouts: template.roundabouts ?? [],
  }, null, 2);
}

/**
 * A filename-safe slug for a template name.
 *
 * Built by allow-list rather than by stripping, so no path separator or control
 * character can survive into a download name.
 */
export function templateFilename(name, now = new Date()) {
  const slug = String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'template';
  const stamp = now.toISOString().slice(0, 10);
  return `roadflow-${slug}-${stamp}.template.json`;
}
