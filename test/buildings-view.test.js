// Building silhouettes (S02.4c): variant selection, entry orientation, geometry.
//
// Why this module is pure
// -----------------------
// Three rules from DESIGN section 3 and S02.4 have to hold together:
//
//   1. "Variants and shading are seeded from stable building ID, not
//      re-randomized during draw." A variant chosen from anything else would
//      flicker on save/load.
//   2. "Building orientation aligns with driveway/nearest road tangent." The
//      stored `rot` is cosmetic noise; the ENTRY must face the driveway.
//   3. Drawing must consume no simulation RNG, or a save could not reproduce
//      its own look and rendering would perturb the simulation.
//
// All three are numeric, so they are asserted here without a canvas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource } from '../src/core.js';
import { RoadNetwork } from '../src/roadNetwork.js';
import {
  VARIANT_COUNT, buildingVariant, entryAngle, variantGeometry, GEOMETRY_TYPES,
} from '../src/render/buildings.js';

/** A building record shaped like the economy's. */
function building(id, x, y, drivewayNode = 'n1') {
  return { id, type: 'house', x, y, drivewayNode, rot: 0.2 };
}

// ------------------------------------------------------------- the variant ---

test('the variant is a pure function of the building id', () => {
  for (const id of ['b1', 'b2', 'b17', 'b999', 'house-at-origin']) {
    assert.equal(buildingVariant(id), buildingVariant(id),
      `${id}: the same id must always choose the same variant`);
  }
});

test('different ids can choose different variants', () => {
  const seen = new Set();
  for (let i = 1; i <= 200; i++) seen.add(buildingVariant(`b${i}`));
  assert.equal(seen.size, VARIANT_COUNT,
    `all ${VARIANT_COUNT} variants must be reachable across 200 ids, saw ${seen.size}`);
});

test('the variant stays inside the declared range', () => {
  for (let i = 0; i < 500; i++) {
    const v = buildingVariant(`id-${i}`);
    assert.ok(Number.isInteger(v) && v >= 0 && v < VARIANT_COUNT,
      `variant ${v} for id-${i} is out of range 0..${VARIANT_COUNT - 1}`);
  }
});

test('the variant count is three, as the design requires', () => {
  assert.equal(VARIANT_COUNT, 3, 'DESIGN section 3 asks for three variants per type');
});

test('an id with different string content does not collide trivially', () => {
  // A hash that only looked at the first character would map b1 and b10 alike.
  const distinct = new Set(['b1', 'b10', 'b100', 'b1000'].map(buildingVariant));
  assert.ok(distinct.size > 1, 'ids differing only in length must not all collide');
});

// ---------------------------------------------------------- orientation ---

function worldWithRoad() {
  const ids = createIdSource();
  const net = new RoadNetwork({ ids });
  const built = net.addRoad([[0, 0], [600, 0]], 'street');
  const edge = net.edges.get(built.edgeIds[0]);
  return { net, nodeA: edge.a, nodeB: edge.b };
}

test('the entry angle points from the building toward its driveway node', () => {
  const { net, nodeA } = worldWithRoad();
  const n = net.nodes.get(nodeA);
  const b = building('b1', n.x - 40, n.y + 30, nodeA);

  const a = entryAngle(b, net);
  assert.ok(a !== null, 'a building with a driveway node has an entry angle');
  // The angle must point at the node: stepping along it moves toward the node.
  const step = 5;
  const nx = b.x + Math.cos(a) * step;
  const ny = b.y + Math.sin(a) * step;
  const before = Math.hypot(n.x - b.x, n.y - b.y);
  const after = Math.hypot(n.x - nx, n.y - ny);
  assert.ok(after < before,
    `stepping along the entry angle must approach the node: ${before} -> ${after}`);
});

test('the entry angle is exact for the four cardinal directions', () => {
  const { net, nodeA } = worldWithRoad();
  const n = net.nodes.get(nodeA);
  const cases = [
    [[n.x - 50, n.y], 0],             // building WEST of node -> faces +x (east)
    [[n.x, n.y - 50], Math.PI / 2],   // building NORTH of node -> faces +y (south, y down)
    [[n.x + 50, n.y], Math.PI],       // building EAST -> faces -x (west)
    [[n.x, n.y + 50], -Math.PI / 2],  // building SOUTH -> faces -y (north)
  ];
  for (const [[x, y], expected] of cases) {
    const b = building('b1', x, y, nodeA);
    const a = entryAngle(b, net);
    assert.ok(Math.abs(a - expected) < 1e-9,
      `building at (${x},${y}) should face ${expected}, got ${a}`);
  }
});

test('a building with no driveway node falls back rather than guessing', () => {
  const { net } = worldWithRoad();
  assert.equal(entryAngle(building('b1', 0, 0, 'missing'), net), null,
    'an unknown node has no direction');
  assert.equal(entryAngle(building('b1', 0, 0, 'missing'), null), null,
    'a missing network has no direction');
  assert.equal(entryAngle(null, net), null, 'a missing building has no direction');
  // Coincident with the node: no direction is defined.
  const { nodeA } = worldWithRoad();
  const n = net.nodes.get(nodeA);
  assert.equal(entryAngle(building('b1', n.x, n.y, nodeA), net), null,
    'a building sitting exactly on its node has no entry direction');
});

// ------------------------------------------------------------- geometry ---

test('every type has geometry for every variant', () => {
  for (const type of GEOMETRY_TYPES) {
    for (let v = 0; v < VARIANT_COUNT; v++) {
      const geo = variantGeometry(type, v);
      assert.ok(Array.isArray(geo) && geo.length > 0,
        `${type} variant ${v} must have at least one shape`);
      for (const shape of geo) {
        assert.ok(['rect', 'line', 'circle'].includes(shape.kind),
          `${type} v${v}: unknown shape kind ${shape.kind}`);
        assert.ok(['roofDark', 'accent', 'yard', 'line'].includes(shape.role),
          `${type} v${v}: unknown role ${shape.role}`);
      }
    }
  }
});

test('the three variants of a type are genuinely different silhouettes', () => {
  // DESIGN section 3 asks for three DISTINCT variants; three identical detail
  // sets would be one variant labelled three ways.
  for (const type of GEOMETRY_TYPES) {
    const geos = [0, 1, 2].map(v => JSON.stringify(variantGeometry(type, v)));
    assert.equal(new Set(geos).size, VARIANT_COUNT,
      `${type}: all three variants must differ`);
  }
});

test('every variant carries a filled shape, not just a stroke', () => {
  // DESIGN section 3 asks for three SILHOUETTES per type. A variant whose only
  // geometry is a stroked line has no silhouette at all - it would read as the
  // bare footprint with a scratch on it, and be indistinguishable from the
  // plain square at any distance.
  for (const type of GEOMETRY_TYPES) {
    for (let v = 0; v < VARIANT_COUNT; v++) {
      const filled = variantGeometry(type, v).filter(s => s.kind !== 'line');
      assert.ok(filled.length >= 1,
        `${type} v${v} must carry at least one filled shape, got only strokes`);
    }
  }
});

test('variants differ without relying on colour alone', () => {
  // DESIGN section 7: "Building classes recognizable without colour alone", and
  // the same applies to variants. Two variants whose geometry is identical once
  // the roles are stripped are the same silhouette.
  for (const type of GEOMETRY_TYPES) {
    const stripped = [0, 1, 2].map(v =>
      JSON.stringify(variantGeometry(type, v).map(({ kind, ...rest }) => ({ kind, ...rest }))));
    // Removing roles must still leave at least two distinct shapes sets,
    // otherwise the variants are the same drawing in different colours.
    const shapesOnly = [0, 1, 2].map(v =>
      JSON.stringify(variantGeometry(type, v).map(({ x, y, w, h, r, x1, y1, x2, y2 }) =>
        ({ x, y, w, h, r, x1, y1, x2, y2 }))));
    assert.equal(new Set(shapesOnly).size, VARIANT_COUNT,
      `${type}: the variants must differ in SHAPE, not only in fill role`);
  }
});

test('geometry stays inside the footprint', () => {
  // "retain geometry size": the silhouette may not spill past the bounding box
  // the collision and placement rules use.
  const EPS = 1e-9;
  for (const type of GEOMETRY_TYPES) {
    for (let v = 0; v < VARIANT_COUNT; v++) {
      for (const shape of variantGeometry(type, v)) {
        if (shape.kind === 'rect') {
          assert.ok(shape.x - shape.w / 2 >= -0.5 - EPS && shape.x + shape.w / 2 <= 0.5 + EPS,
            `${type} v${v}: rect x ${shape.x}±${shape.w / 2} leaves the footprint`);
          assert.ok(shape.y - shape.h / 2 >= -0.5 - EPS && shape.y + shape.h / 2 <= 0.5 + EPS,
            `${type} v${v}: rect y ${shape.y}±${shape.h / 2} leaves the footprint`);
        } else if (shape.kind === 'circle') {
          assert.ok(shape.x - shape.r >= -0.5 - EPS && shape.x + shape.r <= 0.5 + EPS,
            `${type} v${v}: circle x leaves the footprint`);
          assert.ok(shape.y - shape.r >= -0.5 - EPS && shape.y + shape.r <= 0.5 + EPS,
            `${type} v${v}: circle y leaves the footprint`);
        } else if (shape.kind === 'line') {
          for (const [px, py] of [[shape.x1, shape.y1], [shape.x2, shape.y2]]) {
            assert.ok(px >= -0.5 - EPS && px <= 0.5 + EPS && py >= -0.5 - EPS && py <= 0.5 + EPS,
              `${type} v${v}: line endpoint (${px},${py}) leaves the footprint`);
          }
        }
      }
    }
  }
});

test('the geometry is deterministic and consumes no unseeded randomness', () => {
  const real = Math.random;
  Math.random = () => { throw new Error('drawing consumed Math.random'); };
  try {
    for (const type of GEOMETRY_TYPES) {
      for (let v = 0; v < VARIANT_COUNT; v++) {
        const a = variantGeometry(type, v);
        const b = variantGeometry(type, v);
        assert.deepEqual(a, b, `${type} v${v}: the same call must produce identical geometry`);
      }
    }
    const { net, nodeA } = worldWithRoad();
    entryAngle(building('b1', 0, 10, nodeA), net);
  } finally {
    Math.random = real;
  }
});

test('the entry edge is where the geometry says it is', () => {
  // The renderer rotates the local frame so +x faces the driveway, so any shape
  // meant to be AT the entry must sit on the +x side. If a variant's entry
  // detail were on -x it would face away from the road.
  const { net, nodeA } = worldWithRoad();
  const n = net.nodes.get(nodeA);
  const b = building('b1', n.x - 50, n.y, nodeA); // driveway due east
  const a = entryAngle(b, net);
  assert.ok(Math.abs(a) < 1e-9, 'fixture: driveway due east, entry faces +x');

  // Every yard/apron detail (the ones that read as "entry") must have x > 0.
  for (const type of GEOMETRY_TYPES) {
    for (let v = 0; v < VARIANT_COUNT; v++) {
      for (const shape of variantGeometry(type, v)) {
        if (shape.role !== 'yard' && shape.role !== 'accent') continue;
        const cx = shape.kind === 'line' ? (shape.x1 + shape.x2) / 2 : shape.x;
        assert.ok(cx > 0,
          `${type} v${v}: an entry detail (${shape.role}) sits at x=${cx}, which faces AWAY from the driveway`);
      }
    }
  }
});

test('the variant does not change when the building moves', () => {
  // Variant comes from the ID, so relocating a building (or its driveway being
  // re-attached) must not change which silhouette it wears.
  const v1 = buildingVariant('b42');
  const moved = buildingVariant('b42');
  assert.equal(v1, moved);
});
