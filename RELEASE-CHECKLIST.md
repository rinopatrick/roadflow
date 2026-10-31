# RELEASE-CHECKLIST.md — Roadflow R4 browser release candidate

Status: **candidate**. Not a published product. No push/deploy/store
publication without a new explicit operator instruction.

## Gates (all green at commit)

- [x] Clean install from lockfile (`npm ci` in CI)
- [x] Full unit suite: 800+ tests, 0 fail (`npm test`)
- [x] Lint gate (`npm run lint`, node --check over src/test/scripts)
- [x] Browser suites: smoke + UI (`npm run test:browser`, Playwright)
- [x] 8 scenarios validate; reference solutions run (`test/scenarioFixtures.test.js`)
- [x] Save migrations v1→v6 (`test/save.test.js`, `release.test.js`)
- [x] 100 save/load cycles byte-stable; 50 undo/redo exact
- [x] Corrupt import rejected, city untouched
- [x] Performance: medium p95 5.35ms vs 8ms target (`artifacts/performance/s081-report.txt`)
- [x] Packaged dist builds from allowlist (61 files, 616 KiB)
- [x] Traversal/sibling/encoding blocked; malformed URLs 400/404, no crash

## Manual / operator sign-off (open)

- [ ] 45-min real-time soak at 1x and 3x with console/memory trends
- [ ] 5-player new-user study (first road + home/shop < 5 min unaided)
- [ ] Visual rubric re-run (R1) before/after comparison
- [ ] Firefox + Edge/manual Windows matrix; Safari/WebKit untested (waiver)
- [ ] Human review of four map profiles

## Rollback

Distribution artifact is `dist/` only. Old manual saves and the last-good
version are retained; autosave never overwrites a manual slot; a newer save
version is refused, never overwritten.
