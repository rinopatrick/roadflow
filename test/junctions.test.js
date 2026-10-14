// Junction geometry and shadow direction (S02.3b).
//
// These rules are numeric, so they are asserted numerically rather than through
// a screenshot:
//
//   1. a junction's fill is its CONNECTED footprint, not a circular disk
//   2. lane markings stop at the junction mouth, measured from the CONNECTED
//      pavement, not from the incoming road's own width
//   3. every shadow points the same way in screen space
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadNetwork } from '../src/roadNetwork.js';
import { roadDimensions } from '../src/roadProfiles.js';
import {
  capForNode, halfWidth, edgeDirectionAt, connectedEdges,
  mouthTrim, edgeEndTrims, junctionFootprint, MARKING_MARGIN,
  shadowOffset, SHADOW_DIR, offsetInRotatedFrame,
} from '../src/render/junctions.js';

/** Builds a network from a list of roads. */
function net(...roads) {
  const n = new RoadNetwork();
  for (const [pts, cls] of roads) n.addRoad(pts, cls);
  return n;
}

/** The node nearest a world point. */
function nodeNear(n, x, y) {
  let best = null;
  let bd = Infinity;
  for (const node of n.nodes.values()) {
    const d = Math.hypot(node.x - x, node.y - y);
    if (d < bd) { bd = d; best = node; }
  }
  return best;
}

// ------------------------------------------------------------------- caps ---

test('a junction is squared off, a bend keeps its round join', () => {
  assert.equal(capForNode(1), 'round', 'a dead end has nothing to square against');
  assert.equal(capForNode(2), 'round',
    'a degree-2 node is a bend, where a round join is geometrically correct');
  assert.equal(capForNode(3), 'butt', 'a T junction must not paint a disk');
  assert.equal(capForNode(4), 'butt', 'a crossroads must not paint a disk');
});

// -------------------------------------------------------------- footprint ---

test('a bend produces no junction footprint, because its round join is correct', () => {
  // Two segments meeting at one node: degree 2.
  const n = net([[[0, 0], [200, 0], [200, 200]], 'street']);
  const bend = nodeNear(n, 200, 0);
  assert.equal(bend.edges.size, 2, 'fixture assumption: a degree-2 bend');
  assert.deepEqual(junctionFootprint(n, bend), { quads: [], reach: 0 },
    'a bend must not be filled as a junction');
});

test('a T junction footprint follows the connected pavements, not a disk', () => {
  // A wide avenue along x, a narrow street joining from +y.
  const n = net(
    [[[0, 0], [400, 0]], 'avenue'],
    [[[200, 0], [200, 300]], 'street'],
  );
  const junction = nodeNear(n, 200, 0);
  assert.equal(junction.edges.size, 3, 'fixture assumption: a T junction');

  const { quads, reach } = junctionFootprint(n, junction);
  assert.equal(quads.length, 3, 'every connected edge contributes one quad');
  for (const quad of quads) {
    assert.equal(quad.length, 4, 'each footprint quad needs four corners');
    for (const [x, y] of quad) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y), 'corners must be finite');
      const d = Math.hypot(x - junction.x, y - junction.y);
      assert.ok(d <= reach * Math.SQRT2 + 1e-9,
        `a footprint corner reached ${d}, far beyond the junction reach ${reach}`);
    }
  }

  const avenueHalf = halfWidth({ cls: 'avenue' });
  const streetHalf = halfWidth({ cls: 'street' });
  assert.ok(streetHalf < avenueHalf, 'fixture assumption: the street is narrower');
  assert.equal(reach, avenueHalf, 'the junction reaches as far as its widest pavement');

  // THE POINT: the street's quad must be as NARROW as the street. A circular
  // disk of radius reach would make every direction equally wide.
  const widthOf = (quad) => {
    // Quad corners are [p0, p1, p2, p3] with p1..p2 the outward face.
    return Math.hypot(quad[1][0] - quad[2][0], quad[1][1] - quad[2][1]);
  };
  const widths = quads.map(widthOf).sort((a, b) => a - b);
  assert.ok(Math.abs(widths[0] - streetHalf * 2) < 1e-9,
    `the narrowest footprint must be the street's full width ${streetHalf * 2}, got ${widths[0]}`);
  assert.ok(Math.abs(widths[widths.length - 1] - avenueHalf * 2) < 1e-9,
    `the widest footprint must be the avenue's full width ${avenueHalf * 2}, got ${widths[widths.length - 1]}`);
  assert.ok(widths[0] < widths[widths.length - 1],
    'the footprint must NOT be a disk: its widths must differ');
});

test('a crossroads footprint has one quad per approach, at each own width', () => {
  const n = net(
    [[[0, 200], [400, 200]], 'highway'],
    [[[200, 0], [200, 400]], 'street'],
  );
  const junction = nodeNear(n, 200, 200);
  assert.equal(junction.edges.size, 4, 'fixture assumption: a crossroads');

  const { quads, reach } = junctionFootprint(n, junction);
  assert.equal(quads.length, 4, 'four approaches, four quads');

  const hw = halfWidth({ cls: 'highway' });
  const streetHw = halfWidth({ cls: 'street' });
  assert.equal(reach, hw, 'the junction reaches the highway half-width');

  const widths = quads.map(q => Math.hypot(q[1][0] - q[2][0], q[1][1] - q[2][1])).sort((a, b) => a - b);
  assert.ok(Math.abs(widths[0] - streetHw * 2) < 1e-9,
    `two street quads must be street-width, got ${widths[0]}`);
  assert.ok(Math.abs(widths[widths.length - 1] - hw * 2) < 1e-9,
    `two highway quads must be highway-width, got ${widths[widths.length - 1]}`);
});

test('a footprint quad points outward along its own edge', () => {
  const n = net(
    [[[0, 0], [400, 0]], 'avenue'],
    [[[200, 0], [200, 300]], 'street'],
  );
  const junction = nodeNear(n, 200, 0);
  const { quads } = junctionFootprint(n, junction);

  // Each quad's far face must be `reach` from the centre, along the edge.
  const { reach } = junctionFootprint(n, junction);
  for (const quad of quads) {
    const farMid = [(quad[1][0] + quad[2][0]) / 2, (quad[1][1] + quad[2][1]) / 2];
    const d = Math.hypot(farMid[0] - junction.x, farMid[1] - junction.y);
    assert.ok(Math.abs(d - reach) < 1e-9,
      `each quad must reach exactly the junction reach, got ${d} vs ${reach}`);
  }
});

test('a footprint is refused when an edge has no usable direction', () => {
  const n = net([[[0, 0], [400, 0]], 'avenue'], [[[200, 0], [200, 300]], 'street']);
  const junction = nodeNear(n, 200, 0);
  for (const e of connectedEdges(n, junction)) e.pts = [];
  assert.deepEqual(junctionFootprint(n, junction), { quads: [], reach: 0 },
    'an edge with no polyline must be skipped, not guessed at');
});

// -------------------------------------------------------------- mouth trim ---

test('the mouth trim follows the WIDEST connected pavement, not our own width', () => {
  // This is the defect: the old rule was `width * 0.75 + 3` on the INCOMING
  // road, so a narrow street painted its centreline into a wide junction.
  const n = net(
    [[[0, 0], [400, 0]], 'highway'],
    [[[200, 0], [200, 300]], 'street'],
  );
  const junction = nodeNear(n, 200, 0);
  const streetEdge = [...connectedEdges(n, junction)].find(e => e.cls === 'street');
  const highwayHalf = halfWidth({ cls: 'highway' });

  const trim = mouthTrim(n, junction, streetEdge.id);
  assert.ok(trim >= highwayHalf,
    `the street's marking must clear the highway's ${highwayHalf}wu pavement, got ${trim}`);

  const oldRule = roadDimensions('street').width * 0.75 + 3;
  assert.ok(oldRule < highwayHalf,
    `fixture must actually expose the old bug: old rule ${oldRule} vs highway half ${highwayHalf}`);
  assert.ok(trim > oldRule, 'the new rule must trim further than the old one here');
});

test('a dead end has no mouth to clear', () => {
  const n = net([[[0, 0], [400, 0]], 'street']);
  const end = nodeNear(n, 0, 0);
  assert.equal(end.edges.size, 1, 'fixture assumption: a dead end');
  const edge = [...connectedEdges(n, end)][0];
  assert.equal(mouthTrim(n, end, edge.id), 0,
    'nothing joins a dead end, so nothing needs clearing');
});

test('a bend has no mouth to clear', () => {
  const n = net([[[0, 0], [200, 0], [200, 200]], 'street']);
  const bend = nodeNear(n, 200, 0);
  const edge = [...connectedEdges(n, bend)][0];
  assert.equal(mouthTrim(n, bend, edge.id), 0,
    'a bend is not a junction, so its markings may run through it');
});

test('the trim includes a margin so a marking never touches the mouth', () => {
  const n = net([[[0, 0], [400, 0]], 'highway'], [[[200, 0], [200, 300]], 'street']);
  const junction = nodeNear(n, 200, 0);
  const streetEdge = [...connectedEdges(n, junction)].find(e => e.cls === 'street');
  const widest = halfWidth({ cls: 'highway' });

  // Assert the margin POSITIVELY. Comparing against MARKING_MARGIN alone is a
  // tautology: mutating the constant to 0 makes both sides of the comparison 0
  // and the test still passes, which proves nothing.
  assert.ok(MARKING_MARGIN > 0, 'the margin must be a positive clearance');
  const trim = mouthTrim(n, junction, streetEdge.id);
  assert.ok(trim > widest,
    `the trim must exceed the widest pavement so the marking cannot touch the mouth: ${trim} vs ${widest}`);
  assert.equal(trim - widest, MARKING_MARGIN,
    'the excess over the widest pavement is exactly the margin');
});

test('both ends of an edge are trimmed independently', () => {
  // A street between a highway junction and a dead end: one end must be trimmed,
  // the other must not.
  const n = net(
    [[[0, 0], [400, 0]], 'highway'],
    [[[200, 0], [200, 300]], 'street'],
  );
  const junction = nodeNear(n, 200, 0);
  const streetEdge = [...connectedEdges(n, junction)].find(e => e.cls === 'street');
  const trims = edgeEndTrims(n, streetEdge);

  const atJunction = streetEdge.a === junction.id ? trims.start : trims.end;
  const atDeadEnd = streetEdge.a === junction.id ? trims.end : trims.start;
  assert.ok(atJunction > 0, 'the junction end must be trimmed');
  assert.equal(atDeadEnd, 0, 'the dead end must not be trimmed');
});

test('the trim is never negative on a malformed node', () => {
  const n = net([[[0, 0], [400, 0]], 'street']);
  const edge = [...n.edges.values()][0];
  const ghost = { id: 'ghost', x: 0, y: 0, edges: new Set(['nope']) };
  assert.equal(mouthTrim(n, ghost, edge.id), 0,
    'an unknown connected edge must be skipped rather than throwing');
  assert.equal(edgeEndTrims(n, { id: 'e', a: 'missing', b: 'missing' }).start, 0);
});

test('the direction is taken from the segment that touches the node', () => {
  // A straight edge is symmetric, so its direction sign does not change the
  // quad and a reversed reading is invisible. A road that BENDS just after the
  // junction is not symmetric, so this fixture can tell the two ends apart.
  const n = net(
    [[[0, 0], [400, 0]], 'avenue'],
    [[[200, 0], [200, 300]], 'street'],
    [[[200, 0], [100, -260]], 'street'],
  );
  const junction = nodeNear(n, 200, 0);

  for (const edge of connectedEdges(n, junction)) {
    const dir = edgeDirectionAt(edge, junction);
    assert.ok(dir, 'every connected edge must have a usable direction at the junction');

    // The direction must point AWAY from the junction, so stepping along it
    // must increase the distance from the node.
    const step = 5;
    const away = Math.hypot(
      junction.x + dir[0] * step - junction.x,
      junction.y + dir[1] * step - junction.y,
    );
    assert.ok(Math.abs(away - step) < 1e-9,
      `direction must be a unit vector pointing away from the node, got distance ${away}`);

    // And it must match the first polyline segment from THIS node's end.
    const pts = edge.pts;
    const expected = edge.a === junction.id
      ? [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]]
      : [pts[pts.length - 2][0] - pts[pts.length - 1][0], pts[pts.length - 2][1] - pts[pts.length - 1][1]];
    const len = Math.hypot(...expected);
    assert.ok(Math.abs(dir[0] - expected[0] / len) < 1e-9
      && Math.abs(dir[1] - expected[1] / len) < 1e-9,
      `edge ${edge.id}: direction ${dir} does not match the segment at the node`);
  }

  // Concretely: the two street edges leave in different directions, so reading
  // one end's segment for the other would make them agree.
  const streets = connectedEdges(n, junction).filter(e => e.cls === 'street');
  const dirs = streets.map(e => edgeDirectionAt(e, junction));
  assert.notDeepEqual(dirs[0], dirs[1],
    'the fixture must have two streets leaving in different directions');
});

test('the inset expands a footprint outward without changing its shape', () => {
  const n = net(
    [[[0, 0], [400, 0]], 'avenue'],
    [[[200, 0], [200, 300]], 'street'],
  );
  const junction = nodeNear(n, 200, 0);

  const plain = junctionFootprint(n, junction);
  const inset = junctionFootprint(n, junction, { inset: 2 });

  assert.ok(inset.reach > plain.reach,
    `an inset must extend the reach: ${inset.reach} vs ${plain.reach}`);
  assert.equal(inset.reach - plain.reach, 2, 'the reach must grow by exactly the inset');

  // Every quad must be wider by 2 * inset and reach 2 further out, so the shape
  // is preserved rather than distorted.
  const widthOf = (q) => Math.hypot(q[1][0] - q[2][0], q[1][1] - q[2][1]);
  const plainWidths = plain.quads.map(widthOf).sort((a, b) => a - b);
  const insetWidths = inset.quads.map(widthOf).sort((a, b) => a - b);
  for (let i = 0; i < plainWidths.length; i++) {
    assert.ok(Math.abs((insetWidths[i] - plainWidths[i]) - 4) < 1e-9,
      `quad ${i} must widen by 2 * inset (4), got ${insetWidths[i] - plainWidths[i]}`);
  }
});

// ----------------------------------------------------------------- shadows ---

test('every object casts its shadow in the same screen direction', () => {
  assert.deepEqual(shadowOffset(1), SHADOW_DIR);
  // A taller object casts a longer shadow along the same direction.
  const tall = shadowOffset(2);
  assert.deepEqual(tall, [SHADOW_DIR[0] * 2, SHADOW_DIR[1] * 2]);
  assert.ok(tall[1] / tall[0] === SHADOW_DIR[1] / SHADOW_DIR[0],
    'scaling must preserve the direction, not change it');
});

test('a rotated object still casts its shadow in the fixed screen direction', () => {
  // The defect: the offset was applied INSIDE ctx.rotate(rot), so it rotated
  // with the object. Counter-rotating the offset restores a fixed direction.
  const [dx, dy] = shadowOffset(1);

  for (const rot of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3]) {
    const [lx, ly] = offsetInRotatedFrame(rot, dx, dy);
    // Rotating the local offset back by +rot must recover the screen offset.
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const backX = lx * cos - ly * sin;
    const backY = lx * sin + ly * cos;
    assert.ok(Math.abs(backX - dx) < 1e-9 && Math.abs(backY - dy) < 1e-9,
      `rot ${rot}: recovered (${backX}, ${backY}) instead of (${dx}, ${dy})`);
  }
});

test('the counter-rotation preserves the shadow length', () => {
  const [dx, dy] = shadowOffset(1);
  const len = Math.hypot(dx, dy);
  for (const rot of [0.3, 1.1, -2.4]) {
    const [lx, ly] = offsetInRotatedFrame(rot, dx, dy);
    assert.ok(Math.abs(Math.hypot(lx, ly) - len) < 1e-9,
      'a rotation must not stretch the shadow');
  }
});

test('at zero rotation the offset is unchanged', () => {
  assert.deepEqual(offsetInRotatedFrame(0, 3, 4), [3, 4]);
});
