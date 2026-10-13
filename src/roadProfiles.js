// Road geometry: the single source of truth for pavement size and lane layout.
//
// Why this module exists
// ----------------------
// Pavement width and lane centre offsets used to come from two independent,
// inconsistent places: `ROAD_CLASS[cls].width` drove rendering while
// `laneOffset()` derived positions from `laneW` plus a hard-coded 1.2 wu median.
// The result was that the outermost lane centre plus half a car width sat
// OUTSIDE the rendered pavement (EVIDENCE E02):
//
//   street   5.65 vs 5.50  -> 0.15 wu outside
//   avenue  11.40 vs 8.00  -> 3.40 wu outside
//   highway 17.40 vs 12.00 -> 5.40 wu outside
//
// Vehicles and lane dashes therefore floated off the road surface, and the
// roundabout radius was computed from a width that rendering did not use.
//
// Everything that needs a road dimension now asks this module: rendering, lane
// positions, lane markings, hit testing, previews and roundabout sizing. There
// is one formula and one set of numbers.
//
// Units: world units (wu). Screen size is `wu * zoom`.
//
// Model
// -----
//   pavement width = (forward + backward) * laneWidth + medianWidth + 2 * shoulderWidth
//
// Lane indices count outward from the median, starting at 0.
// Direction 1 is a->b, direction -1 is b->a.
//
// S04.1 will attach a per-edge `profile` (variable lane counts, speed classes,
// access classes). This module deliberately keeps the preset shape for now so
// the dimension fix lands as a focused change; `roadDimensions(edge)` already
// accepts an edge object so that transition does not need a signature change.

/** Car body half-width, used to verify the containment rule. */
export const CAR_HALF_WIDTH = 1.8;

/** Median (centre division) width on a two-way road, in wu. */
export const MEDIAN_WIDTH = 1.2;

/** Paved shoulder each side of the outer lane, in wu. */
export const SHOULDER_WIDTH = 1.0;

/** Lane width per class, in wu. */
const LANE_WIDTH = {
  street: 6.5,
  avenue: 6.0,
  highway: 6.0,
};

/**
 * Preset road profiles.
 *
 * `forward` / `backward` are lane counts per direction; `speed` is wu per
 * simulation second; `access` is the intended usage class. `medianWidth` and
 * `shoulderWidth` are carried per preset because S04.1 turns this into a
 * per-edge profile record with exactly these fields, so the shape is already
 * correct and overrides need no signature change.
 */
export const ROAD_PRESETS = {
  street: {
    forward: 1, backward: 1, laneWidth: LANE_WIDTH.street,
    medianWidth: MEDIAN_WIDTH, shoulderWidth: SHOULDER_WIDTH,
    speed: 14, access: 'local',
  },
  avenue: {
    forward: 2, backward: 2, laneWidth: LANE_WIDTH.avenue,
    medianWidth: MEDIAN_WIDTH, shoulderWidth: SHOULDER_WIDTH,
    speed: 18, access: 'arterial',
  },
  highway: {
    forward: 3, backward: 3, laneWidth: LANE_WIDTH.highway,
    medianWidth: MEDIAN_WIDTH, shoulderWidth: SHOULDER_WIDTH,
    speed: 30, access: 'motorway',
  },
};

/** Resolves the profile for an edge-like object, a class name, or undefined. */
function resolveProfile(edgeOrClass) {
  const cls = typeof edgeOrClass === 'string'
    ? edgeOrClass
    : edgeOrClass?.cls ?? 'street';
  const preset = ROAD_PRESETS[cls];
  if (!preset) throw new RangeError(`unknown road class: ${cls}`);
  return preset;
}

/**
 * True when the edge carries traffic in one direction only. Ring edges are
 * always one-way; a future explicit `oneway` profile flag is honoured too.
 */
function isOneWay(edgeOrClass) {
  return typeof edgeOrClass === 'object' && edgeOrClass !== null
    ? !!(edgeOrClass.oneway || edgeOrClass.ring)
    : false;
}

/**
 * Dimensions for a road.
 *
 * @param {object|string} [edgeOrClass] edge object (with `.cls`) or class name
 * @returns {{laneWidth:number, medianWidth:number, shoulderWidth:number,
 *            forward:number, backward:number, width:number, speed:number,
 *            access:string, oneWay:boolean}}
 */
export function roadDimensions(edgeOrClass) {
  const preset = resolveProfile(edgeOrClass);
  const oneWay = isOneWay(edgeOrClass);

  const forward = oneWay ? Math.max(preset.forward, 1) : preset.forward;
  const backward = oneWay ? 0 : preset.backward;
  // A one-way road has no centre division to divide.
  const medianWidth = oneWay ? 0 : preset.medianWidth;
  const shoulderWidth = preset.shoulderWidth;

  const width = (forward + backward) * preset.laneWidth
    + medianWidth
    + 2 * shoulderWidth;

  return {
    laneWidth: preset.laneWidth,
    medianWidth,
    shoulderWidth,
    forward,
    backward,
    width,
    speed: preset.speed,
    access: preset.access,
    oneWay,
  };
}

/**
 * Signed lateral offset of a lane centre from the road centreline.
 *
 * Positive is to the right of a->b travel (screen y-down, matching the
 * renderer's normal convention). Forward lanes are positive, backward lanes
 * negative, and the two sides mirror exactly about the centreline.
 *
 * For asymmetric profiles (S04.1) the median shifts so that the lane bundle
 * stays centred: with `F = forward*laneWidth` and `B = backward*laneWidth`, the
 * median centre sits at `(B - F) / 2`.
 *
 * @param {object|string} edgeOrClass edge object or class name
 * @param {1|-1} dir travel direction
 * @param {number} lane lane index counted outward from the median, from 0
 * @throws {RangeError} on an unknown direction or an out-of-range lane index
 */
export function laneCenterOffset(edgeOrClass, dir, lane) {
  if (dir !== 1 && dir !== -1) {
    throw new RangeError(`direction must be 1 or -1, got ${dir}`);
  }
  if (!Number.isInteger(lane) || lane < 0) {
    throw new RangeError(`lane must be a non-negative integer, got ${lane}`);
  }

  const d = roadDimensions(edgeOrClass);
  const available = dir === 1 ? d.forward : d.backward;
  if (lane >= available) {
    throw new RangeError(
      `lane ${lane} is out of range for direction ${dir} `
      + `(${available} lane${available === 1 ? '' : 's'} available)`);
  }

  const forwardWidth = d.forward * d.laneWidth;
  const backwardWidth = d.backward * d.laneWidth;
  // Median centre relative to the geometric centre of the pavement.
  const medianCentre = (backwardWidth - forwardWidth) / 2;
  const fromMedian = d.medianWidth / 2 + (lane + 0.5) * d.laneWidth;

  return dir === 1
    ? medianCentre + fromMedian
    : medianCentre - fromMedian;
}

/**
 * The outermost lane centre on the wider side, used for sizing turn radii and
 * roundabouts so they clear the full pavement.
 */
export function outerLaneOffset(edgeOrClass) {
  const d = roadDimensions(edgeOrClass);
  const side = Math.max(d.forward, d.backward);
  if (side === 0) return 0;
  const dir = d.forward >= d.backward ? 1 : -1;
  return Math.abs(laneCenterOffset(edgeOrClass, dir, side - 1));
}
