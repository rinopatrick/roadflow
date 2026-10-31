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
});
