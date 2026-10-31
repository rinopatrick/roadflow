// Tiny WebAudio sound effects — synthesized, no assets.
// S08.2: separate master/SFX volumes (0..1), applied multiplicatively.
let ctx = null;
let enabled = true;
let masterVol = 1.0;
let sfxVol = 1.0;
export function setVolumes(master, sfx) {
  if (Number.isFinite(master)) masterVol = Math.max(0, Math.min(1, master));
  if (Number.isFinite(sfx)) sfxVol = Math.max(0, Math.min(1, sfx));
}
export function getVolumes() { return { master: masterVol, sfx: sfxVol }; }

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setAudioEnabled(v) { enabled = v; }
export function audioEnabled() { return enabled; }

function blip(freq, dur, type = 'sine', vol = 0.12, when = 0) {
  if (!enabled || masterVol <= 0 || sfxVol <= 0) return;
  try {
    const a = ac();
    const t = a.currentTime + when;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol * masterVol * sfxVol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination);
    o.start(t); o.stop(t + dur + 0.02);
  } catch { /* audio unavailable */ }
}

export const sfx = {
  place: () => blip(520, 0.12, 'triangle', 0.1),
  road: () => blip(300, 0.08, 'sine', 0.08),
  bulldoze: () => { blip(180, 0.15, 'sawtooth', 0.07); blip(120, 0.2, 'sawtooth', 0.05, 0.05); },
  levelUp: () => { blip(523, 0.15, 'triangle', 0.12); blip(659, 0.15, 'triangle', 0.12, 0.12); blip(784, 0.25, 'triangle', 0.12, 0.24); },
  click: () => blip(700, 0.05, 'sine', 0.05),
};
