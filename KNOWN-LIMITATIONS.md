# KNOWN-LIMITATIONS.md — Roadflow R4

Honest limits. Nothing here is a P0/P1 (no crash, data-loss, security, or
collision bug open); lower-severity items carry reproduction + workaround.

## Simulation

- Long-truck rear sweep: connector reservations release at edge transition;
  a 12wu truck's rear may physically overlap the conflict zone for a moment at
  saturated junctions. Follower gaps bound the window; no collision observed in
  fixtures. (S06.2 note in `src/traffic.js`.)
- No bicycles or rail. Walking covers access; transit is buses only.
- Offline PWA deferred: local server support ships first (`OFFLINE_STATUS`).

## Platform

- Safari/WebKit untested in this environment (Chromium + Firefox matrix only).
  Unsupported browsers are stated, not silently supported.
- Performance measured on Ryzen AI Max+ desktop; laptop/mobile budgets may
  differ. Budgets are recorded, not waived: medium p95 5.35ms vs 8ms target.

## Content

- 8 scenarios ship; local editor shares files (no upload service, by design).
- Difficulty numbers are tuning defaults with fixture evidence, not final
  balance claims; S06.5 pacing targets 3–5 min first level-up for a competent
  tutorial city, operator-approved from play, not traces alone.

## Compatibility

- Saves v1–v6 migrate forward; a newer save version is refused, never
  overwritten. Terrain v1 (`island`) frozen byte-identical for old saves.
