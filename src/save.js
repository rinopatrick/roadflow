// Save / load — localStorage slots + JSON export/import.
import { RoadNetwork } from './roadNetwork.js';
import { Economy } from './economy.js';
import { Terrain } from './terrain.js';

const KEY = 'roadflow.save';

export function saveGame(state) {
  const data = {
    v: 1,
    savedAt: Date.now(),
    seed: state.terrain.seed,
    net: state.net.toJSON(),
    eco: state.eco.toJSON(),
    camera: state.renderer.cam,
    simTime: state.traffic.time,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.error('save failed', e);
    return false;
  }
}

export function hasSave() {
  return !!localStorage.getItem(KEY);
}

// Returns {seed, net, eco, camera, simTime} or null
export function loadGame() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const seed = data.seed;
    const terrain = new Terrain(seed);
    const net = RoadNetwork.fromJSON(data.net);
    const eco = Economy.fromJSON(net, terrain, data.eco);
    return { terrain, net, eco, camera: data.camera, simTime: data.simTime || 0 };
  } catch (e) {
    console.error('load failed', e);
    return null;
  }
}

export function exportGame(state) {
  const data = { v: 1, seed: state.terrain.seed, net: state.net.toJSON(), eco: state.eco.toJSON() };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'roadflow-city.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
