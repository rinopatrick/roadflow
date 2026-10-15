// Preview placement validity (S02.5b).
//
// Why this exists
// ---------------
// `_drawToolPreviews` checked `eco.canPlace(tool)` (stock) and
// `terrain.isRoadable` (terrain), but `evaluateBuildingPlacement` also checks
// OVERLAP with existing buildings and NO_ROAD within ACCESS_MAX_DISTANCE.
// The preview therefore showed valid teal over an existing building, or past the
// road reach — and the commit then failed with a reason the preview never
// mentioned. DESIGN section 5: "It must not show valid cyan when placement will
// fail."
//
// This module is the ONE place that maps a placement evaluation to what the
// preview draws, so the preview and the commit can never disagree.
import { evaluateBuildingPlacement, PLACEMENT_REASON } from '../access.js';

/**
 * Evaluates a would-be placement and returns what the preview should draw.
 *
 * Pure: the same world, type and position always produce the same result.
 *
 * @param {{net:object, terrain:object, eco:object}} world
 * @param {string} type house | shop | factory
 * @param {number} x world x
 * @param {number} y world y
 * @returns {{ok: boolean, reason: string|null, colour: 'accent'|'danger',
 *            label: string}} `label` is the badge text for the failure mode
 */
export function previewPlacement(world, type, x, y) {
  const result = evaluateBuildingPlacement(world, { type, x, y });
  if (result.ok) {
    return { ok: true, reason: null, colour: 'accent', label: null };
  }
  return {
    ok: false,
    reason: result.reason,
    colour: 'danger',
    label: reasonLabel(result.reason, type),
  };
}

/**
 * A short badge label for a placement failure.
 *
 * The full `reason` from PLACEMENT_REASON is the inspect-panel text; the badge
 * is a shorter version that still names the cause (DESIGN section 1: invalid
 * actions explain the actual reason).
 */
export function reasonLabel(reason, type) {
  const plural = type === 'factory' ? 'factories' : type === 'house' ? 'houses' : 'shops';
  switch (reason) {
    case PLACEMENT_REASON.NO_STOCK:
      return `No ${plural} left`;
    case PLACEMENT_REASON.TERRAIN:
      return 'Invalid terrain';
    case PLACEMENT_REASON.OVERLAP:
      return 'Too close to a building';
    case PLACEMENT_REASON.NO_ROAD:
      return 'No road within reach';
    case PLACEMENT_REASON.NOT_FINITE:
      return 'Invalid position';
    case PLACEMENT_REASON.UNKNOWN_TYPE:
      return 'Unknown building';
    default:
      return reason ?? 'Cannot place here';
  }
}
