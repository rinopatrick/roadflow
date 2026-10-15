// Tutorial state machine — S02.6a.
//
// DESIGN section 6: five guided steps, each transition triggered by an actual
// world condition, never by clicking "Next". The player can skip at any time.
//
// Everything here is pure: the same world snapshot always produces the same
// step, and no simulation RNG or DOM is touched.

/**
 * The five tutorial steps, in order. Each names the world condition that
 * completes it, so the game can check the condition and advance without
 * asking the player to click anything.
 */
export const TUTORIAL_STEPS = [
  { id: 'pan',      label: 'Drag to pan, scroll to zoom',        condition: 'cameras-moved' },
  { id: 'road',     label: 'Draw a road: click to set points, Enter to finish', condition: 'road-committed' },
  { id: 'build',    label: 'Place a home and a shop near the road', condition: 'home-and-shop' },
  { id: 'trip',     label: 'Watch a trip arrive between them',    condition: 'trip-completed' },
  { id: 'work',     label: 'Add a factory so homes have work',    condition: 'factory-placed' },
];

/** The first step id. */
export const TUTORIAL_START = TUTORIAL_STEPS[0].id;

/** All step ids, in order. */
export const TUTORIAL_IDS = TUTORIAL_STEPS.map(s => s.id);

/**
 * Evaluates which tutorial step the player should be on, from the world.
 *
 * Pure: the same world always produces the same step. The step is the EARLIEST
 * condition not yet met, so a player who skips ahead by building everything at
 * once lands on the last step rather than being walked through one at a time.
 *
 * @param {{camerasMoved: boolean, hasRoad: boolean, hasHome: boolean,
 *          hasShop: boolean, hasFactory: boolean, tripsCompleted: number}} world
 * @returns {{step: string, index: number, done: boolean, label: string}}
 */
export function tutorialStep(world) {
  const w = world ?? {};
  const done = {
    'cameras-moved': !!w.camerasMoved,
    'road-committed': !!w.hasRoad,
    'home-and-shop': !!w.hasHome && !!w.hasShop,
    'trip-completed': (w.tripsCompleted ?? 0) > 0,
    'factory-placed': !!w.hasFactory,
  };

  for (let i = 0; i < TUTORIAL_STEPS.length; i++) {
    const step = TUTORIAL_STEPS[i];
    if (!done[step.condition]) {
      return { step: step.id, index: i, done: false, label: step.label };
    }
  }
  const last = TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1];
  return { step: last.id, index: TUTORIAL_STEPS.length - 1, done: true, label: last.label };
}

/**
 * Extracts the world snapshot the tutorial needs from a live world.
 *
 * Pure: reads state but never mutates it.
 *
 * @param {{net:object, eco:object, camerasMoved?:boolean}} world
 * @returns {{camerasMoved: boolean, hasRoad: boolean, hasHome: boolean,
 *            hasShop: boolean, hasFactory: boolean, tripsCompleted: number}}
 */
export function tutorialWorldSnapshot(world) {
  const net = world?.net;
  const eco = world?.eco;
  let hasRoad = false;
  let hasHome = false;
  let hasShop = false;
  let hasFactory = false;

  if (net?.edges?.size > 0) hasRoad = true;
  if (eco?.buildings) {
    for (const b of eco.buildings.values()) {
      if (b.type === 'house') hasHome = true;
      else if (b.type === 'shop') hasShop = true;
      else if (b.type === 'factory') hasFactory = true;
    }
  }

  return {
    camerasMoved: !!world?.camerasMoved,
    hasRoad,
    hasHome,
    hasShop,
    hasFactory,
    tripsCompleted: eco?.totalTrips ?? 0,
  };
}
