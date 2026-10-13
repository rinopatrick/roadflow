// Verify a Roadflow checkpoint backup against its SHA-256 manifest.
//
// Usage: node scripts/verify-backup.mjs <backup-dir>
//
// Why this script exists
// ----------------------
// `sha256sum -c MANIFEST.sha256` resolves the manifest's relative paths against
// the CURRENT WORKING DIRECTORY, not against the manifest's own directory. Run
// it from the project root and every entry is checked against the live tree
// instead of the backup — so any file edited after the backup was taken is
// reported as a mismatch, which looks like backup corruption but is not.
//
// This script resolves every entry relative to the backup directory, so the
// result does not depend on where it is invoked from.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/verify-backup.mjs <backup-dir>');
  process.exitCode = 2;
} else {
  const root = path.resolve(dir);
  const manifestPath = path.join(root, 'MANIFEST.sha256');

  if (!existsSync(manifestPath)) {
    console.error(`FAIL: no MANIFEST.sha256 in ${root}`);
    process.exitCode = 2;
  } else {
    const lines = readFileSync(manifestPath, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const failures = [];
    let verified = 0;

    for (const line of lines) {
      const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
      if (!match) {
        failures.push(`malformed manifest line: ${line.slice(0, 80)}`);
        continue;
      }
      const [, expected, rel] = match;
      // Resolve against the BACKUP, never against cwd.
      const file = path.join(root, rel);

      if (!existsSync(file) || !statSync(file).isFile()) {
        failures.push(`missing: ${rel}`);
        continue;
      }
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
      if (actual !== expected) {
        failures.push(`hash mismatch: ${rel}`);
        continue;
      }
      verified++;
    }

    const report = {
      backup: root,
      manifestEntries: lines.length,
      verified,
      failures: failures.length,
    };
    console.log(JSON.stringify(report, null, 2));

    if (failures.length) {
      console.error('\nFAILURES:\n  ' + failures.join('\n  '));
      process.exitCode = 1;
    }
  }
}
