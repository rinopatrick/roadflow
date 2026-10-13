# Roadflow

A city builder focused on the fun part: **building roads and solving traffic problems**.
Original browser game in the traffic-sim genre (inspired by games like Trafficity and Mini Motorways — all art and code original).

## Play

```bash
npm start          # serves at http://localhost:8080
```

Then open http://localhost:8080 in any modern browser. No build step, no dependencies at runtime.

## Features

- **Gridless road tools** — street / avenue / highway, drawn as smooth splines that auto-connect and auto-split into real junctions. Roads that cross create intersections.
- **Roundabouts** — convert any junction into a real one-way ring (counterclockwise circulation, grass island); cars yield to circulating traffic and never enter a blocked exit. Bulldozing any part removes the whole roundabout.
- **Fully-customizable traffic lights** — cycle length, green ratio, and offset (for green waves along an artery). Live phase indicator on the map.
- **Traffic simulation** — individual cars with safe-following physics, right-hand traffic, lane keeping, A* routing with congestion awareness.
- **Simple city economy** — houses need shops and workplaces; factories pollute; completed trips grant XP; leveling up grants a batch of new buildings to place.
- **Congestion & pollution overlays**, inspect panel with reachability checks, save/load (localStorage), speed controls (pause / 1× / 3× / 8×), synthesized sound effects.

## Controls

| Input | Action |
|---|---|
| Left click | Use current tool (place road point, building, etc.) |
| Double-click / Enter | Finish road |
| Right-click / middle-drag / Shift-drag | Pan |
| Wheel | Zoom |
| `1`–`0` | Select tool |
| Space | Pause / resume |
| Esc | Cancel draft / close dialog |
| Delete | Bulldoze mode |

## Development

```bash
npm test           # 42 unit tests (Node built-in test runner)
node playtest.js   # automated browser playtest (Playwright)
node soak.js       # 90s economy soak test with HUD logging
```

## Architecture

```
src/
  core.js          math, seeded RNG, splines, arc-length geometry
  terrain.js       seeded procedural island terrain (water/sand/grass/rock)
  roadNetwork.js   nodes, edges, lanes, junction splitting, crossing detection
  pathfinding.js   A* over the node graph, cost = travel time + congestion
  traffic.js       car following, yields, roundabouts, traffic light phases
  economy.js       buildings, trips, XP/levels, pollution
  render.js        canvas renderer (terrain, roads, buildings, cars, overlays)
  ui.js            toasts + inspect panel
  save.js          localStorage save/load
  audio.js         synthesized WebAudio SFX
  main.js          game loop, input, tools
test/              unit tests for core, network, pathfinding, traffic, economy
```

All simulation logic is pure ES modules and runs in Node — that's what the test suite covers. Rendering and input are browser-only.

## License

MIT
