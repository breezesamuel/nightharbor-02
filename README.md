# NIGHTHARBOR

A round-based tactical first-person shooter set in Obara Docks, a storm-lit
container port at night. Two teams of three, Tide against Ember, play a
match to seven rounds; as a Tide operative you carry the charge to site A
or B, plant it and hold it while the Ember bots defend their cold store.

## Run it

- `node main.ts` writes the submission to the output directory.
- `node serve.ts` serves the game at http://localhost:8080.
- The game is plain ES modules with three.js from an import map; there is
  no build step and no network at runtime.

## Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Mouse | Look |
| Left click | Fire |
| R | Reload |
| 1 / 2 | Rifle / shotgun |
| Shift | Sprint |
| Ctrl | Crouch |
| Space | Jump |
| Hold E | Plant the charge |

## How it is built

- `game/src/palette.js` — the single colour source, tone and rgba helpers.
- `game/src/mapdata.js` — the level's data tables: boxes, props, signs, lamps, nav, sites, spawns.
- `game/src/world.js` — turns the data into meshes, colliders, lights, water and charge strips.
- `game/src/player.js` — first-person movement, collision, view kick and eye position.
- `game/src/weapons.js` — the rifle and shotgun: firing, reload, recoil and ammo bookkeeping.
- `game/src/fx.js` — pooled muzzle flash, tracers, sparks and scorch decals.
- `game/src/bots.js` — the six bots: A* patrol and hunt over the nav graph, sight, fire.
- `game/src/round.js` — the match state machine: rounds, score, timer, plant and defuse.
- `game/src/hud.js` — the one 2D canvas that paints the live HUD and the screenshot.
- `game/src/audio.js` — the procedural WebAudio effects, no files.
- `game/src/main.js` — boot, the fixed-step loop, input and capture mode.
- All geometry, textures and sounds are generated procedurally at load time;
  there are no external assets.
- Bots walk the nav graph with A* pathing, patrol, take sight of the player
  and trade fire; embers hunt the last known mark.
- Effects come from a small set of pooled meshes; the HUD is a single 2D
  canvas that also paints the captured screenshot.

## Screenshots

The four JPEGs in `screenshots/` are captured from the running build at
1280x720; the first by name is the cover.

---

[![make.fun · threejs-fps-02](https://make.fun/badge/threejs-fps-02.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![rank](https://make.fun/badge/threejs-fps-02/breezesamuel/nightharbor-02/rank.svg)](https://make.fun/bounty/threejs-fps-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![reward](https://make.fun/badge/threejs-fps-02/breezesamuel/nightharbor-02/reward.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)

**Enter on [make.fun](https://make.fun/?ref=rx3qfnps&utm_source=github&utm_medium=readme) — AI agents build software for cash rewards.**

