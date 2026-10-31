// S08.3: safe packaging. Allowlist dist, traversal-proof server, offline
// PWA explicitly deferred (marked not shipped), recovery fixtures.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE_ALLOWLIST, isAllowedAsset, resolvePublicPath, OFFLINE_STATUS,
} from '../scripts/package-lib.js';

describe('S08.3 packaging', () => {
  it('allowlist covers runtime, excludes everything else', () => {
    assert.ok(isAllowedAsset('index.html'));
    assert.ok(isAllowedAsset('src/main.js'));
    assert.ok(isAllowedAsset('src/ui.css'));
    assert.equal(isAllowedAsset('test/economy.test.js'), false);
    assert.equal(isAllowedAsset('docs/roadmap/README.md'), false);
    assert.equal(isAllowedAsset('.git/config'), false);
    assert.equal(isAllowedAsset('node_modules/x/y.js'), false);
    assert.equal(isAllowedAsset('server.log'), false);
    assert.ok(PACKAGE_ALLOWLIST.length > 5, 'explicit allowlist, not a glob');
  });

  it('path resolution blocks traversal, siblings, encodings', () => {
    const root = '/app/dist';
    const ok = resolvePublicPath(root, '/index.html');
    assert.ok(ok && ok.endsWith('index.html'), 'index resolves inside root');
    assert.equal(resolvePublicPath(root, '/..%2fsecret'), null);
    assert.equal(resolvePublicPath(root, '/%2e%2e/x'), null);
    assert.equal(resolvePublicPath(root, '/dist-evil/x'), null, 'sibling prefix blocked');
    assert.equal(resolvePublicPath(root, '/sub/../../x'), null);
    assert.equal(resolvePublicPath(root, '/test/economy.test.js'), null, 'non-allowlisted blocked');
  });

  it('offline PWA explicitly deferred, not silently missing', () => {
    assert.equal(OFFLINE_STATUS.shipped, false);
    assert.match(OFFLINE_STATUS.reason, /deferred|not shipped/i);
  });

  it('every module in the main.js import closure is allowlisted', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const ROOT = new URL('../', import.meta.url).pathname;
    const seen = new Set(['index.html']);
    const walk = (f) => {
      if (seen.has(f)) return;
      seen.add(f);
      let t;
      try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return; }
      const dir = path.posix.dirname(f);
      for (const m of t.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        let p = m[1];
        if (!p.endsWith('.js')) p += '.js';
        walk(path.posix.normalize(path.posix.join(dir, p)));
      }
    };
    walk('src/main.js');
    // S08.3 regression: terrain.js was missing from the hand-written list
    // and the game booted to a blank canvas under the hardened server.
    const { PACKAGE_ALLOWLIST } = await import('../scripts/package-lib.js');
    const missing = [...seen].filter(f => f.startsWith('src/') && !PACKAGE_ALLOWLIST.includes(f));
    assert.deepEqual(missing, [], `import closure must be servable: missing ${missing.join(', ')}`);
  });
});
