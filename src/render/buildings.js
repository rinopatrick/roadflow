// Building silhouettes — S02.4c.
//
// Three rules from DESIGN section 3 and the S02.4 task have to hold together:
//
//   1. "Variants and shading are seeded from stable building ID, not
//      re-randomized during draw." The variant is a pure hash of the building's
//      id, which is deterministic (S01.1b) and stable across save/load, so a
//      saved city reproduces its own look. The previous `rot` came from a
//      cosmetic RNG stream at placement time, which made the drawn orientation
//      survive a save but had no relationship to the road.
//
//   2. "Building orientation aligns with driveway/nearest road tangent." The
//      entry angle is computed from the driveway node at draw time, so a
//      building faces its road without any stored state.
//
//   3. Drawing consumes no simulation RNG. Nothing here imports the economy or
//      touches an RNG; the geometry is a constant table.
//
// Everything is pure: the renderer only translates, rotates and fills.
//
// LOCAL COORDINATES
// -----------------
// Unit space, footprint is [-0.5, 0.5]², the renderer scales by
// BUILDING_DEFS[type].size * zoom. +x is the ENTRY side: the renderer rotates
// the frame so +x points at the driveway node, so a shape at x > 0 is at the
// door and a shape at x < 0 is at the back of the lot.

/** Number of silhouette variants per building type. */
export const VARIANT_COUNT = 3;

/** Building types that have silhouettes. */
export const GEOMETRY_TYPES = ['house', 'shop', 'factory'];

/**
 * Deterministic silhouette variant for a building id.
 *
 * FNV-1a over the id string. Chosen over a modulo of the numeric suffix so
 * ids like 'b1' and 'b10' do not collide on their shared prefix, and so any
 * future id scheme still hashes.
 *
 * @param {string} id
 * @param {number} [count] how many variants exist
 * @returns {number} 0..count-1
 */
export function buildingVariant(id, count = VARIANT_COUNT) {
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % count;
}

/**
 * Angle from a building to its driveway node, or null when none is defined.
 *
 * Returned in radians, atan2 convention (y down, matching the canvas), so the
 * renderer can `ctx.rotate(angle)` directly.
 *
 * Null, never a guess: a building with no driveway has no entry direction, and
 * the caller falls back to the stored cosmetic rotation.
 *
 * @param {{x:number,y:number,drivewayNode:string}} b
 * @param {object} net
 */
export function entryAngle(b, net) {
  const n = net?.nodes?.get?.(b?.drivewayNode);
  if (!n) return null;
  const dx = n.x - b.x;
  const dy = n.y - b.y;
  if (dx === 0 && dy === 0) return null;
  return Math.atan2(dy, dx);
}

/**
 * The silhouette details for a (type, variant) pair, in unit coordinates.
 *
 * A constant table, not generated: the three variants per type must be visibly
 * DISTINCT shapes (DESIGN section 7 scores "building classes recognizable
 * without colour alone", and the same standard applies to variants), which is
 * easier to guarantee — and to test — when each variant is written out.
 *
 * @param {string} type house | shop | factory
 * @param {number} variant 0..2
 * @returns {Array<{kind:'rect'|'line'|'circle', role:string, x?:number, y?:number,
 *   w?:number, h?:number, r?:number, x1?:number, y1?:number, x2?:number, y2?:number}>}
 */
export function variantGeometry(type, variant) {
  const geo = SILHOUETTES[type];
  if (!geo) throw new RangeError(`unknown building type: ${type}`);
  const shapes = geo[variant];
  if (!shapes) throw new RangeError(`unknown variant ${variant} for ${type}`);
  return shapes;
}

const SILHOUETTES = {
  // ---- house: ridge/hip + a yard at the door ----
  house: [
    // v0: gable — one ridge line along the entry axis, yard strip at the door.
    [
      { kind: 'line', role: 'line', x1: -0.42, y1: 0, x2: 0.42, y2: 0 },
      { kind: 'rect', role: 'yard', x: 0.34, y: 0, w: 0.24, h: 0.34 },
    ],
    // v1: hipped — inset roof square, yard patch wider than the door.
    [
      { kind: 'rect', role: 'roofDark', x: 0, y: 0, w: 0.62, h: 0.62 },
      { kind: 'rect', role: 'yard', x: 0.38, y: 0, w: 0.16, h: 0.48 },
    ],
    // v2: side garden — two yard patches flanking a short ridge.
    [
      { kind: 'line', role: 'line', x1: -0.2, y1: 0, x2: 0.2, y2: 0 },
      { kind: 'rect', role: 'yard', x: 0.36, y: -0.26, w: 0.2, h: 0.22 },
      { kind: 'rect', role: 'yard', x: 0.36, y: 0.26, w: 0.2, h: 0.22 },
    ],
  ],

  // ---- shop: awning/canopy/parapet at the entry ----
  shop: [
    // v0: awning band across the entry edge.
    [
      { kind: 'rect', role: 'accent', x: 0.38, y: 0, w: 0.14, h: 0.56 },
    ],
    // v1: awning plus an apron — a lighter patch at the door corner.
    [
      { kind: 'rect', role: 'accent', x: 0.38, y: 0, w: 0.14, h: 0.56 },
      { kind: 'rect', role: 'yard', x: 0.3, y: 0.16, w: 0.16, h: 0.2 },
    ],
    // v2: parapet — a thin border band and a small accent dot.
    [
      { kind: 'rect', role: 'roofDark', x: 0.4, y: 0, w: 0.1, h: 0.9 },
      { kind: 'circle', role: 'accent', x: 0.3, y: 0, r: 0.07 },
    ],
  ],

  // ---- factory: roof bays / chimney / sawtooth ----
  factory: [
    // v0: three filled roof bays across the lot (DESIGN: "longer roof bays").
    [
      { kind: 'rect', role: 'roofDark', x: -0.24, y: 0, w: 0.14, h: 0.68 },
      { kind: 'rect', role: 'roofDark', x: -0.02, y: 0, w: 0.14, h: 0.68 },
      { kind: 'rect', role: 'roofDark', x: 0.2, y: 0, w: 0.14, h: 0.68 },
    ],
    // v1: four bays plus a chimney by the loading side (the entry side).
    [
      { kind: 'line', role: 'line', x1: -0.26, y1: -0.36, x2: -0.26, y2: 0.36 },
      { kind: 'line', role: 'line', x1: -0.08, y1: -0.36, x2: -0.08, y2: 0.36 },
      { kind: 'line', role: 'line', x1: 0.1, y1: -0.36, x2: 0.1, y2: 0.36 },
      { kind: 'line', role: 'line', x1: 0.28, y1: -0.36, x2: 0.28, y2: 0.36 },
      { kind: 'circle', role: 'accent', x: 0.34, y: -0.28, r: 0.07 },
    ],
    // v2: sawtooth — filled angled stripes across the roof.
    [
      { kind: 'rect', role: 'roofDark', x: -0.22, y: -0.02, w: 0.18, h: 0.6 },
      { kind: 'rect', role: 'roofDark', x: 0.02, y: -0.02, w: 0.18, h: 0.6 },
      { kind: 'rect', role: 'roofDark', x: 0.26, y: -0.02, w: 0.18, h: 0.6 },
    ],
  ],
};
