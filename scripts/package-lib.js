// Packaging library — S08.3. Explicit allowlist (no globs that can leak),
// traversal-proof path resolution, offline status marker.
import { normalize, join, sep } from 'node:path';

// Generated from the real import closure of src/main.js (S08.3 fix: the
// hand-written list silently omitted terrain.js and friends, breaking the
// game under the hardened server). index.html + ui.css + docs statement
// are entry/assets.
export const PACKAGE_ALLOWLIST = [
  'index.html',
  'README.md',
  'docs/a11y-statement.md',
  'src/ui.css',
  'src/a11y.js',
  'src/access.js',
  'src/audio.js',
  'src/budget.js',
  'src/camera.js',
  'src/construction.js',
  'src/constructionEdits.js',
  'src/core.js',
  'src/demand.js',
  'src/economy.js',
  'src/editor.js',
  'src/environment.js',
  'src/events.js',
  'src/experiments.js',
  'src/grades.js',
  'src/gridDraft.js',
  'src/icons.js',
  'src/input.js',
  'src/junctions.js',
  'src/laneChanges.js',
  'src/layers.js',
  'src/logistics.js',
  'src/main.js',
  'src/mapProfiles.js',
  'src/menuBindings.js',
  'src/metrics.js',
  'src/pathfinding.js',
  'src/render.js',
  'src/render/buildings.js',
  'src/render/junctions.js',
  'src/render/markings.js',
  'src/render/preview.js',
  'src/render/terrain.js',
  'src/roadDraft.js',
  'src/roadNetwork.js',
  'src/roadProfiles.js',
  'src/rules.js',
  'src/save.js',
  'src/scenarios.js',
  'src/signals.js',
  'src/simulationClock.js',
  'src/startScreen.js',
  'src/templatePanel.js',
  'src/templates.js',
  'src/terrain.js',
  'src/content/scenarios.js',
  'src/traffic.js',
  'src/trafficMetrics.js',
  'src/transit.js',
  'src/tutorial.js',
  'src/ui.js',
  'src/ui/controller.js',
  'src/ui/hud.js',
  'src/ui/layers.js',
  'src/ui/menu.js',
  'src/ui/toolbar.js',
  'src/uiTokens.js',
  'src/walking.js',
  'src/worldCommands.js',
  'src/worldSnapshot.js',
];

/** Offline PWA: explicitly deferred per S08.3 scoping. */
export const OFFLINE_STATUS = {
  shipped: false,
  reason: 'Offline PWA deferred: local server support ships first; offline mode not shipped.',
};

const ALLOWED = new Set(PACKAGE_ALLOWLIST);

export function isAllowedAsset(rel) {
  const norm = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  return ALLOWED.has(norm);
}

/**
 * Resolves a request path against the dist root. Returns the absolute file
 * path, or null when blocked (traversal, sibling prefix, non-allowlisted).
 */
export function resolvePublicPath(root, urlPath) {
  let path;
  try {
    path = decodeURIComponent(String(urlPath).split('?')[0]);
  } catch {
    return null; // malformed encoding: controlled rejection, no crash
  }
  if (!path.startsWith('/')) return null;
  const rel = path.slice(1);
  // Block encoded traversal before normalization can hide it.
  if (/%2e|%2f|%5c/i.test(rel)) return null;
  const file = normalize(join(root, rel));
  const rootNorm = normalize(root + sep);
  if (file !== normalize(root) && !file.startsWith(rootNorm)) return null;
  // Sibling-prefix trick: /dist-evil must not pass a startsWith check.
  const relPath = file.slice(rootNorm.length).replace(/\\/g, '/');
  if (!isAllowedAsset(relPath) && relPath !== 'index.html') return null;
  return file;
}
