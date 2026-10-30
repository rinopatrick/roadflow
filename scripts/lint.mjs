// Lint: syntax-check every module. No deps.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// One-shot patchers (tmp-*) already applied their edits and are archived;
// they are not part of build/test and are excluded from syntax gate.
const SKIP = /tmp-/;
const dirs = ['src', 'test', 'scripts'];
const files = [];
function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (/\.(m?js)$/.test(f) && !SKIP.test(f)) files.push(p);
  }
}
dirs.forEach(walk);

let fail = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail++;
    console.error(`FAIL ${f}\n${e.stderr?.toString() ?? e.message}`);
  }
}
console.log(`${files.length - fail}/${files.length} files OK`);
process.exit(fail ? 1 : 0);
