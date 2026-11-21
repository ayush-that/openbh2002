# End-to-end play test (autoplay)

`src/debug/autoplay.ts` plays real levels through the real game loop and input path, then writes a JSON report (and one screenshot per level) under `artifacts/e2e/`. It is the project's E2E test: every run leaves a file a person can re-check.

## Run

1. `cd engine && npx vite --port 5179` (the dev server provides the report endpoint). For long runs while other files are being edited, start a second server without hot reload: `E2E_NO_HMR=1 npx vite --port 5180 --strictPort` and use port 5180.
2. Open `http://localhost:5179/?autoplay=1-5&seed=42` in a tab. When the tab is hidden or occluded (no render for 200 ms) a MessageChannel pump keeps the real loop running without rendering; level-end screenshots are then skipped (`"screenshot": "skipped: tab not rendering"`). Runs are silent: autoplay turns sound off.
3. Wait for `window.__autoplayReport` to appear, or watch `artifacts/e2e/latest.json`: it is rewritten after every level with `"partial": true`, and the final report has `"partial": false` (only the final one gets a timestamped file).

URL params (wired in `main.ts`): `autoplay=1-5` or `autoplay=1,3,7`, `seed=<int>` (default 1), optional `speed=<n>` and `timeout=<frames>`.

From the console, without the URL flag:

```js
const { startAutoplay } = await import('/src/debug/autoplay.ts')
startAutoplay(__bh.game, { levels: [1, 2, 3], seed: 42, speed: 4, onDone: (r) => console.log(r) })
```

Options: `levels`, `seed` (level n is seeded with `seed + n` through `world.rng.seed` right before `game.startLevel(n)`), `timeoutFrames` (default 20000 ticks per level), `speed` (default 1; scales the time passed to `game.frame`, so it still runs the real fixed-step loop, capped by its 8-ticks-per-render catch-up limit).

## What the bot does

- After every `Game.step` it reads the world and sets what a player controls for the next tick: `game.input.cx/cy/button`, and keys as `KeyboardEvent`s on `window` (the same queue the keyboard uses). It never writes yaw, pitch, ammo or enemy state.
- Targets: live `world.targets` (never friendly bombers, tank wrecks (`Target.wrecked()`), or parked APC1s that already unloaded) and killable soldiers. Score = distance x priority + angle from the current view, with stickiness. Priority: soldiers within 2500 and jets or cobras on an attack run first, wanted supply crates next, then aircraft, ground, other parachutes. Ground targets and soldiers need terrain clearance; soldiers behind a vehicle are skipped for bullets (vehicles stop them).
- Aim points are the ShapeData hit volumes, not node origins (cobra and CH53 volumes hang below the origin, a parachute's is its payload). Bullets on aircraft aim at a part-0 (vital, one-hit kill) polygon that a ray from the mount reaches first. Parachute payloads are predicted with the pendulum (`Parachutes.predict`); everything else uses a constant-velocity lead solved for the discrete projectile path (bullets 500, handgun and shells 400, gravity 0.16; missiles 280 straight, shifted for the rail 100 to the side). The default twin gun's barrels sit 30 to each side, so soldier shots aim 15 beside the soldier. Yaw is rate controlled (`yaw -= cx * 0.02`), so `cx` is the one-tick correction clamped to the cursor box. Pitch follows cursor deltas (`pitch -= dy * 0.2`); when the cursor is pinned at an edge the bot sweeps it to the other edge so the pitch clamp re-anchors the mapping.
- Ammo planning (it reads the level script for tanks and APC2/3 still to come): cannon, then missiles, for tanks and APCs; loaded APC1s are left to unload when anti-tank rounds are short. Soldiers: gun, handgun under 2500, cannon on groups of 3+ or when the guns are dry. Aircraft: gun, spare cannon, spare missiles, handgun under 3000. A C130 is shot only for its troops and never while it still carries wanted crates. With nothing but the handgun left and crates still coming, the handgun is kept for crates, and the last round never goes elsewhere (ammo-out loss). With scarce ammo (and always on soldiers) it waits for a round in flight before firing at the same target again.
- Keys: `m` on aircraft within 9000 and 5 degrees while spare missiles exceed the anti-tank need by 2 (judged on the current aim: keys run before the aim moves), `f` at night when no flare is up, `b` when 6+ soldiers are alive or 3+ are within 2500. Fires only when the predicted post-tick aim error is inside the target's cone. No cheats.
- Level flow: a cleared level followed by the next number is left to the game's own 150-frame transition (`transitionTicks` records it); other cases (destroyed, timeout, non-consecutive lists) start the next level directly. Every start, including the game's own, is seeded with `seed + n` (a `startLevel` wrapper). After the last level the game is paused and all wrappers are restored.

## Report (`artifacts/e2e/report-<ISO>.json`, copy in `latest.json`)

Top level: `partial`, `seed`, `levels`, `speed`, `url`, `userAgent`, `backend`, `viewport [w, h, dpr]`, `errors`, and `results[]`, one per level. The in-page copy (`window.__autoplayReport`, `onDone`) also has `artifact`, the path the endpoint wrote.

| field | meaning |
|---|---|
| `result` | `cleared`, `destroyed` or `timeout` |
| `frames` | game ticks (29 ms each) until the outcome |
| `shield` | `min`, `final`, `every50` samples |
| `meter` | enemy meter `start`, `end`, `every50` samples |
| `kills` | by shape: targets the player hit that then died; `soldier`: soldiers going from alive to dying by any cause |
| `meterBySource` | meter reduction keyed by the function that called `reduceEnemyMeter` (e.g. `GroundSystem.killApc@ground.ts`, `AirSystem.crash@air.ts`, `SoldierPool.rayKill@soldiers.ts`) |
| `shots` | player projectiles spawned per weapon |
| `hits` | `Target.hit` calls per weapon, plus `soldier` (bullets that hit a soldier) |
| `damageBySource` | shield lost, keyed `callee < caller` of `damagePlayer` (e.g. `Projectiles.bullet`, `SoldierPool.shoot`, `Projectiles.impact < Projectiles.rocket`) |
| `prizes` | crates collected |
| `ammo` | `start` and `end` |
| `bot` | ticks with a target, ticks firing, missiles requested, bombers called |
| `frameMs` | `raf*`: real interval between `game.frame` calls; `sim*`: time inside `game.frame` (up to 8 ticks); `step*`: time of one `Game.step`; `render*`: CPU time of `renderer.render` |
| `remaining` | live targets (shape, slot, position), soldier count and `soldierRanges` at the end, for diagnosing timeouts |
| `anomalies` | sanity checks every 50 frames: NaN positions, vehicles more than 150 off the ground, soldiers more than 50 off it, units far off the map |
| `transitionTicks` | ticks from `cleared` to this level when the game itself started it (expected 150) |
| `wall` | real milliseconds for the level, and loop calls from rAF vs the hidden-tab pump |
| `bot.engaged` | ticks spent on each `target:weapon` pair |
| `errors` | `console.error`, `window.onerror` and unhandled rejections during the level |
| `screenshot` | `artifacts/e2e/shots/level-<n>-<result>-<run>.png` (canvas copied right after `renderer.render`, downscaled to 1280 wide; the HUD overlay is included only if it draws into the WebGL canvas) |

Reading it: a healthy run has no `errors`, `meter.end` 0 for cleared levels, and `hits/shots` that make sense for the weapon. A timeout with `remaining.targets` empty and `meter.end > 0` points at a spawn or meter bug rather than the bot.

## Endpoint

`vite.config.ts` (dev server only): `POST /__report` writes the JSON body to `artifacts/e2e/report-<ISO>.json` and `latest.json` (`?partial=1`: `latest.json` only); `POST /__shot?name=<file>.png` writes to `artifacts/e2e/shots/`. Bodies over 5 MB are rejected (413) and paths are confined to `artifacts/e2e`.

## Known limits

- Needs WebGPU. On the normal dev server a hot reload (any edited file) kills the run; use the `E2E_NO_HMR` server or rerun (a `vite.config.ts` change restarts even that server and reloads the page). The partial `latest.json` keeps the levels finished so far. `latest.json` is shared by every dev server: check its `url` before reading it.
- Kill counting by shape needs a player hit on that target in its current life; aircraft that were hit and then flew away would count as kills (rare). Soldier kills include deaths from bombs and fire.
- `damageBySource` cannot tell enemy bullets from the player's own falling back (both are `Projectiles.bullet`).
- Seeds make the simulation repeatable, but `Math.random` users (if any, e.g. cosmetic effects) are not seeded.
- The bot is omniscient (reads world positions, the level script, parachute payloads and C130 loads through read-only helpers, sees at night); it tests the game, not human difficulty. Some late levels are tight on ammo, so a seed can still lose (see `level-sweep.md`).
