// Packaging library — S08.3. Explicit allowlist (no globs that can leak),
// traversal-proof path resolution, offline status marker.
import { normalize, join, sep } from 'node:path';

export const PACKAGE_ALLOWLIST = [
  'index.html',
  'README.md',
  
  'src/main.js',
  'src/ui.css',
  ...[
    'access.js', 'a11y.js', 'audio.js', 'budget.js', 'camera.js',
    'construction.js', 'constructionEdits.js', 'core.js', 'demand.js',
    'economy.js', 'environment.js', 'events.js', 'experiments.js',
    'grades.js', 'gridDraft.js', 'icons.js', 'input.js', 'junctions.js',
    'laneChanges.js', 'layers.js', 'logistics.js',
    'main.js', 'mapProfiles.js', 'metrics.js', 'pathfinding.js',
    'render.js', 'roadDraft.js', 'roadNetwork.js', 'roadProfiles.js',
    'rules.js', 'save.js', 'scenarios.js', 'signals.js',
    'simulationClock.js', 'startScreen.js', 'templatePanel.js',
    'templates.js', 'traffic.js', 'trafficMetrics.js', 'transit.js',
    'tutorial.js', 'ui.js', 'uiTokens.js', 'walking.js',
    'worldCommands.js', 'worldSnapshot.js',
  ].map(f => `src/${f}`),
  'src/content/scenarios.js',
  'src/render/buildings.js',
  'src/render/junctions.js',
  'src/render/markings.js',
  'src/render/terrain.js',
  'src/ui/controller.js',
  'src/ui/hud.js',
  'src/ui/layers.js',
  'src/ui/menu.js',
  'src/ui/toolbar.js',
  'docs/a11y-statement.md',
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
