// Build a browser distribution directory from the explicit allowlist.
// No tests, docs/roadmap, artifacts, logs, node_modules, .git, credentials.
import { mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ALLOWLIST } from './package-lib.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] ?? join(ROOT, 'dist');

let bytes = 0;
const files = [];
for (const rel of PACKAGE_ALLOWLIST) {
  try {
    const src = join(ROOT, rel);
    const size = statSync(src).size;
    const dst = join(OUT, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    bytes += size;
    files.push({ file: rel, bytes: size });
  } catch {
    console.warn(`skip missing (not fatal): ${rel}`);
  }
}
const manifest = {
  builtAt: new Date().toISOString(),
  files,
  totalBytes: bytes,
  note: 'Local/static distribution. No runtime CDN dependency; ES modules load from ./src.',
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`dist: ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB -> ${OUT}`);
