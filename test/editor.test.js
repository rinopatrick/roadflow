// S07.7: local map/challenge editor. Separate draft world, same
// commands/validators (no bypasses), validation, data-only JSON export
// (<=10MiB, escaped text, no scripts/URLs/HTML), import rejection safety.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDraft, validateDraftScenario, exportScenario, importScenario,
  EDITOR_LIMITS,
} from '../src/editor.js';

describe('S07.7 editor', () => {
  it('draft opens separate from the live world and pauses simulation', () => {
    const live = { id: 'live', paused: false };
    const d = openDraft(live, { seed: 7, profile: 'plains' });
    assert.notEqual(d.world, live, 'separate object');
    assert.equal(d.paused, true, 'simulation paused in draft');
    assert.equal(live.paused, false, 'live untouched');
  });

  it('validation: legal graph, origins, allowlist, budget, playable start', () => {
    const bad = validateDraftScenario({ objectives: [{ metric: 'vibes', op: '>=' }] });
    assert.equal(bad.ok, false);
    const good = validateDraftScenario({
      graph: { nodes: 4, edges: 3 }, origins: ['h1'], destinations: ['s1'],
      objectives: [{ metric: 'served', op: '>=', target: 1 }],
      events: [], budget: 500, playableStart: true,
    });
    assert.equal(good.ok, true);
    const broke = validateDraftScenario({
      graph: { nodes: 0, edges: 0 }, origins: [], destinations: [],
      objectives: [{ metric: 'served', op: '>=', target: 1 }],
      events: [], budget: 500, playableStart: false,
    });
    assert.equal(broke.ok, false);
  });

  it('export is data-only JSON with versions and text limits', () => {
    const ex = exportScenario({ id: 's', title: 'T'.repeat(200), description: 'd'.repeat(5000), objectives: [] });
    assert.equal(ex.ok, false, 'title over limit rejected');
    const ok = exportScenario({ id: 's', title: 'Hi', description: 'd', objectives: [] });
    assert.equal(ok.ok, true);
    assert.ok(ok.json.includes('"schema"') && ok.json.includes('"version"'));
    assert.ok(!/<script[\s>]|https?:\/\/|<\/|<iframe|<img/i.test(ok.json), 'no scripts, URLs or HTML');
  });

  it('import rejects oversize/malformed; city untouched', () => {
    const big = 'x'.repeat(11 * 1024 * 1024);
    assert.equal(importScenario(big).ok, false);
    assert.equal(importScenario('not json').ok, false);
    assert.equal(importScenario('{"id":1}').ok, false);
    assert.equal(EDITOR_LIMITS.maxBytes, 10 * 1024 * 1024);
  });
});
