// Local map/challenge editor — S07.7.
//
// The editor opens a SEPARATE draft world and pauses simulation; it never
// mutates the live save until explicit 'Play copy'. All edits go through the
// same commands/validators as gameplay — no privileged bypasses, no free
// inventory outside authoring mode. Export is data-only JSON (schema +
// content versions, title/author text limits, <=10MiB); import validates
// with snapshot validators and escaped text. No scripts, remote URLs, HTML
// assets, or upload service.
export const EDITOR_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  titleLength: 80,
  descriptionLength: 2000,
  authorLength: 60,
};

export function openDraft(liveWorld, { seed, profile }) {
  return {
    world: { seed, profile, draft: true, buildings: [], roads: [] },
    liveRef: liveWorld,
    paused: true,
  };
}

export function validateDraftScenario(draft) {
  if (!draft || typeof draft !== 'object') return { ok: false, reason: 'draft required' };
  const g = draft.graph ?? {};
  if (!Number.isInteger(g.nodes) || g.nodes < 1) return { ok: false, reason: 'graph needs at least one node' };
  if (!Array.isArray(draft.origins) || !draft.origins.length) return { ok: false, reason: 'needs valid origins' };
  if (!Array.isArray(draft.destinations) || !draft.destinations.length) return { ok: false, reason: 'needs valid destinations' };
  for (const o of draft.objectives ?? []) {
    if (typeof o?.metric !== 'string') return { ok: false, reason: 'objective metric allowlist applies' };
    const { ALLOWED } = { ALLOWED: ['served', 'unmetFreight', 'trips', 'level', 'satisfaction', 'cancelled'] };
    if (!ALLOWED.includes(o.metric)) return { ok: false, reason: `metric not allowlisted: ${o.metric}` };
  }
  if (!Array.isArray(draft.events)) return { ok: false, reason: 'events must be an array' };
  if (draft.events.length > 200) return { ok: false, reason: 'event schedule bounded at 200' };
  if (!(draft.budget >= 0)) return { ok: false, reason: 'budget must be nonnegative' };
  if (!draft.playableStart) return { ok: false, reason: 'needs at least one playable start' };
  return { ok: true };
}

export function exportScenario(scenario) {
  if (typeof scenario?.title !== 'string' || !scenario.title
    || scenario.title.length > EDITOR_LIMITS.titleLength) {
    return { ok: false, reason: 'title required, max 80 chars' };
  }
  if (typeof scenario?.description === 'string'
    && scenario.description.length > EDITOR_LIMITS.descriptionLength) {
    return { ok: false, reason: 'description max 2000 chars' };
  }
  const record = {
    schema: 'roadflow.scenario',
    version: 1,
    id: scenario.id ?? 'untitled',
    title: scenario.title,
    author: String(scenario.author ?? '').slice(0, EDITOR_LIMITS.authorLength),
    description: scenario.description ?? '',
    objectives: scenario.objectives ?? [],
  };
  const json = JSON.stringify(record);
  if (json.length > EDITOR_LIMITS.maxBytes) return { ok: false, reason: 'scenario exceeds 10MiB' };
  if (/<script[\s>]|https?:\/\/|<(\/|iframe|img|a[\s>])/i.test(json)) return { ok: false, reason: 'no scripts, URLs or HTML allowed' };
  return { ok: true, json };
}

export function importScenario(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'input must be text' };
  if (text.length > EDITOR_LIMITS.maxBytes) return { ok: false, reason: 'import exceeds 10MiB' };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
    return { ok: false, reason: 'scenario needs a string id' };
  }
  // Re-validated as data; the live city is never touched by this function.
  return { ok: true, scenario: raw };
}
