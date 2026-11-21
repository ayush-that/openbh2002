# Level sweep (all levels, autoplay)

Every level was played by the autoplay bot through the real loop and input path (see `e2e.md`): Level_01..Level_99 plus the post-99 loop, levels 100..112. Final report: `artifacts/e2e/report-2026-11-21T10-05-29-921Z.json` (seed 42). Seed 7 confirmation run: ``artifacts/e2e/report-2026-11-21T10-11-55-797Z.json``.

## Result

| Run | Levels | Cleared | Not cleared |
|---|---|---|---|
| Seed 42 (final) | 1..112 | 108 | 79 (meter 82 left), 91 (meter 10 left), 97 (meter 22 left), 106 (meter 1 left) |
| Seed 7 (confirmation) | 1..112 | 105 | 47 (meter 80 left), 55 (meter 40 left), 74 (meter 20 left), 79 (meter 29 left), 97 (meter 21 left), 106 (meter 11 left), 110 (meter 10 left) |

All 112 levels load, play and transition. Every level not cleared ended with the player destroyed (shield 0 or the ammo-out rule), never a timeout, and its meter left equals the value of the tanks, aircraft and soldiers still alive, so no meter is stuck. Seed 42 clears 1..78, 80..90, 92..96, 98..105, 107..112.

- In-process transitions: in the seed 42 run 107 levels were entered by the game itself (`outcome()` calls `startLevel(n + 1)` after the cleared banner), each exactly 150 ticks after `cleared` (`transitionTicks`). Level 1 and the levels after a loss were started directly.
- No console errors, no exceptions, and no sanity anomalies (NaN positions, vehicles or soldiers off the ground, units off the map) in the final runs. Worst single `Game.step`: 36.4 ms (level 42) on seed 42; on seed 7 one 107 ms step (level 95) that did not reproduce (see limitations). Average step is about 0.1 ms.
- Night levels (30 of 112), Spotlight levels, Bombers levels (the bot calls the strike), AltGun/AltGun2 levels, and Delay up to 14600 frames (level 90, `timeout=30000`) all ran. Every shipped script has an `Ammo` line, so the "Ammo absent keeps previous values" rule is never exercised by the shipped levels; the parser and `Game.startLevel` keep the previous values when it is absent.
- Levels above 99 use `Level_(n % 10 + 91)`; 109 maps to the missing `Level_100` and now plays `Level_99` (deliberate deviation, see below).
- Most screenshots were skipped (`"skipped: tab not rendering"`): the test tab was usually behind other tabs, and the run continued on the hidden-tab pump.

## Bugs found and fixed

| Bug | Root cause | Fix | File |
|---|---|---|---|
| Levels 86 and 87 timed out with the meter stuck at 12..16 and nothing left to shoot | After 96 soldier spawns the pool reuses only inactive slots. Corpses (state 0) stay active until the player looks up past 20 degrees, so the pool fills with corpses and every later soldier is silently dropped while still counted in the kill quota | Reuse a corpse when no slot is free; if all 96 are alive, reduce the meter by 1 instead of dropping a counted soldier (BH2.exe would write past the pool) | `src/game/enemies/soldiers.ts` |
| Paratroopers vanished in the air, meter stuck (C130-heavy levels) | The 64-slot parachute ring wraps onto chutes still in the air (a C130 with the default 127 passes keeps dropping crates). Here the trooper only exists as a parachute payload, so the overwrite deleted him. In BH2.exe the trooper is a soldier allocated at drop time and survives | When the ring overwrites an airborne trooper, spawn his soldier at that point; he falls on his own | `src/game/enemies/parachutes.ts`, `air.ts` (passes `world`) |
| Level 109, 119, ... threw `Level 109 not found` | `Level_(n % 10 + 91)` gives `Level_100`, which does not ship (BH2.exe fails the same way) | Play `Level_99` for it (deliberate deviation, documented in code and `level.ts`) | `src/game/game.ts`, `src/formats/level.ts` (comment) |
| Tank wrecks and parked APC1s kept their engine loops | `targetEngines` played every `alive()` target. A destroyed tank stays active (it must keep blocking shots), and FUN_00424aef skips state 0 | `Target.wrecked()` (tank wreck) and `Target.engineOn()` (false for state 0); the engine provider skips `engineOn() === false`. Blocking behaviour unchanged | `src/game/world.ts`, `enemies/ground.ts`, `sound.ts` |
| Unlimited soldier grenades in flight | Grenades use an 8-slot ring in BH2.exe (0x462ee0, DAT_00447870) | A 9th throw removes the oldest grenade | `src/game/enemies/soldiers.ts` |

Nothing else treats a wreck as live: missile homing and proximity only consider aircraft, the HUD does not read targets, and the bot uses `wrecked()`.

## Bot improvements (`src/debug/autoplay.ts`)

Found by reading the per-level reports; none of them touch game state.

- Aim at ShapeData hit volumes instead of node origins. A ray at a cobra's origin misses (its hit parts hang 30..200 below), and the parachute hit box is the payload 180..300 below the canopy: before this, crates were almost never shot and zero-ammo levels (21, 36, 43, 44, 84) were lost.
- Bullets on aircraft aim at a part-0 (vital, one-hit kill) polygon that a ray from the mount reaches first; parachute payloads are predicted with the pendulum (`Parachutes.predict`).
- Missiles: judged on the current aim (keys run before the aim moves; ground missiles missed about 60 %), shifted for the rail 100 to the side, cooldowns reset per level (they carried over in level frames and blocked missiles for thousands of frames).
- Handgun: hold until the round leaves (it fires only on its 4-tick counter, so the old press-every-other-tick pattern could never fire), reserve it for crates when nothing else is left, never fire the last round elsewhere (ammo-out loss).
- Twin gun: aim 15 beside soldiers (barrels at ±30, soldier ray width 30).
- Ammo planning from the level script: anti-tank rounds for tanks and APC2/3 still to come, loaded APC1s left to unload when rounds are short, empty parked APC1s ignored, C130s shot only for their troops and not while they carry wanted crates, missiles kept for aircraft over lone soldiers, shells on soldier groups.
- Fire discipline: wait for a round in flight before re-firing at a soldier (dying bodies stop bullets) or when ammo is scarce, skip soldiers shielded by a vehicle, shoot cobras with scarce rounds only while they hover or up close, prioritise jets and cobras on attack runs.
- Harness: lets the game run its own 150-frame transition, seeds every start (including the game's own) with `seed + n`, keeps running from a MessageChannel pump when the tab is hidden or occluded, turns sound off, adds `anomalies`, `transitionTicks`, per-step timing, `wall`, `bot.engaged` and `soldierRanges` to the report.
- Read-only helpers added for it: `Parachutes.payloadAt`, `Parachutes.predict`, `AirSystem.c130Load`, `GroundSystem.vehicleAt`.

## Remaining limitations

- **Bot limitation, not a game bug: the Level_79/91/97 family** (levels 79, 91, 97 and their loop copies 100, 106, 110). Ammo 50/4/4/5, Aggression 9 9 9 9, 8 tanks, 4 APC1s and 8 (91, 97) or 12 (79) cobras: about 8..16 anti-tank rounds (with crates) and 65 bullet and handgun rounds for 184..224 meter. The bot runs out of ammunition or shield near the end. Across all runs on the current bot, 91 cleared 5 times, 97 4 times, 100 5, 106 4, 110 5, but 79 never (best: meter 10, one cobra left). Level 74 (9 bullets, 5 cobras) cleared 6 times and failed on seed 7.
- **Bot variance:** 47 and 55 cleared on seed 42 but were lost on seed 7 to damage (55: 15 jets took the shield from 100 to 0 in about 150 frames while the bot shot supply crates).
- Per-level replays are close but not exact: turret yaw and pitch and the cursor carry over from the previous level, so the same level and seed can play out differently in a different list (level 95, seed 7: 7821 vs 7779 frames).
- One 107 ms `Game.step` (level 95, seed 7) did not reproduce on two reruns (worst 3.1 and 5.1 ms), so it was most likely a GC or OS pause in a background tab, not the game.

- Render-side (not in this scope): in the first run, while the tab was rendering, three.js logged hundreds of `THREE.TSL: No stack defined for assign operation` errors from `MeshBasicNodeMaterial.setupDiffuseColor` during material builds (levels 1, 3, 11, 12, 13). They did not reappear in later runs, which mostly ran without rendering, so this is unconfirmed after the render changes made in parallel. Owner: `src/render/*`.
- `latest.json` is shared by every dev server; a `vite.config.ts` edit restarts even the `E2E_NO_HMR` server and reloads the page.

## Reproduce

```sh
cd engine
E2E_NO_HMR=1 npx vite --port 5181 --strictPort
# in a browser tab:
#   http://localhost:5181/?autoplay=1-112&seed=42&speed=28&timeout=30000
#   http://localhost:5181/?autoplay=1-112&seed=7&speed=28&timeout=30000
# watch artifacts/e2e/latest.json ("partial": false when done); the final report gets a timestamped copy.
npx tsc --noEmit -p .
```

## Coverage (seed 42, final run)

| Level | Script | Setup | Result | Frames | Min shield | Kills | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Level_01 | day AltGun, ammo 400/5/10/0, max delay 150 | cleared | 273 | 100 | apc 3, cobra 2 |  |
| 2 | Level_02 | day AltGun, ammo 400/5/10/0, max delay 140 | cleared | 320 | 100 | apc 5, c130 1, parachute 1 | entered by game transition (150) |
| 3 | Level_03 | day AltGun, ammo 400/8/10/5, max delay 190 | cleared | 325 | 100 | apc 5, cobra 2, tank 2 | entered by game transition (150) |
| 4 | Level_04 | day AltGun, ammo 400/10/10/0, max delay 250 | cleared | 412 | 100 | apc 7, tank 3 | entered by game transition (150) |
| 5 | Level_05 | day AltGun, ammo 400/10/20/5, max delay 360 | cleared | 529 | 90 | apc 3, jet 4 | entered by game transition (150) |
| 6 | Level_06 | day AltGun, ammo 400/5/5/5, max delay 1000 | cleared | 1065 | 94 | apc 6, cobra 4 | entered by game transition (150) |
| 7 | Level_07 | day AltGun, ammo 400/10/10/5, max delay 270 | cleared | 583 | 100 | cobra 3, jet 4, tank 4 | entered by game transition (150) |
| 8 | Level_08 | day AltGun, ammo 400/10/10/5, max delay 400 | cleared | 2539 | 100 | c130 3, cobra 3, parachute 4, soldier 10 | entered by game transition (150) |
| 9 | Level_09 | day bombers AltGun, ammo 400/10/8/5, max delay 250 | cleared | 1014 | 92 | c130 3, cobra 4, parachute 22 | entered by game transition (150) |
| 10 | Level_10 | day AltGun, ammo 400/20/10/5, max delay 480 | cleared | 1042 | 91 | apc 8, cobra 4, tank 6 | entered by game transition (150) |
| 11 | Level_11 | night spotlight AltGun, ammo 400/2/2/20, max delay 80 | cleared | 3249 | 100 | ch53 4, soldier 12 | entered by game transition (150) |
| 12 | Level_12 | night spotlight AltGun, ammo 400/10/8/10, max delay 100 | cleared | 326 | 95 | c130 2, cobra 3 | entered by game transition (150) |
| 13 | Level_13 | day bombers AltGun, ammo 400/8/8/5, max delay 600 | cleared | 1644 | 90 | c130 1, cobra 3, parachute 53, soldier 2, tank 4 | entered by game transition (150) |
| 14 | Level_14 | day, ammo 400/10/10/5, max delay 1000 | cleared | 812 | 85 | c130 3, cobra 6, parachute 27 | entered by game transition (150) |
| 15 | Level_15 | day AltGun, ammo 400/4/10/5, max delay 1000 | cleared | 3583 | 94 | apc 5, ch53 2, cobra 6, jet 4, parachute 23, soldier 18 | entered by game transition (150) |
| 16 | Level_16 | day AltGun, ammo 400/10/10/5, max delay 600 | cleared | 3339 | 80 | apc 3, ch53 3, cobra 6, jet 1, soldier 6, tank 3 | entered by game transition (150) |
| 17 | Level_17 | day AltGun, ammo 400/20/10/5, max delay 1000 | cleared | 1363 | 100 | apc 5, c130 1, cobra 6, parachute 12, tank 6 | entered by game transition (150) |
| 18 | Level_18 | day bombers AltGun, ammo 400/10/10/5, max delay 600 | cleared | 811 | 100 | apc 6, c130 3, cobra 2, parachute 32, soldier 1, tank 2 | entered by game transition (150) |
| 19 | Level_19 | day AltGun, ammo 400/20/10/5, max delay 1200 | cleared | 2520 | 87 | apc 2, c130 3, jet 3, parachute 47, soldier 2, tank 6 | entered by game transition (150) |
| 20 | Level_20 | day AltGun, ammo 400/10/10/5, max delay 700 | cleared | 1084 | 78 | cobra 12 | entered by game transition (150) |
| 21 | Level_21 | night spotlight AltGun, ammo 0/0/0/10, max delay 400 | cleared | 2926 | 100 | ch53 3, parachute 30, soldier 18 | entered by game transition (150) |
| 22 | Level_22 | night AltGun, ammo 400/20/10/10, max delay 270 | cleared | 390 | 95 | apc 5, tank 3 | entered by game transition (150) |
| 23 | Level_23 | night spotlight AltGun, ammo 400/10/10/10, max delay 750 | cleared | 2665 | 92 | apc 5, ch53 5, cobra 5, parachute 23, soldier 6 | entered by game transition (150) |
| 24 | Level_24 | night spotlight, ammo 400/5/20/5, max delay 600 | cleared | 1267 | 84 | ch53 1, jet 9, parachute 8 | entered by game transition (150) |
| 25 | Level_25 | day bombers AltGun2, ammo 300/10/2/5, max delay 3600 | cleared | 3969 | 85 | c130 5, cobra 3, jet 3, parachute 85, soldier 1 | entered by game transition (150) |
| 26 | Level_26 | day AltGun, ammo 400/20/10/5, max delay 360 | cleared | 484 | 100 | apc 6, tank 2 | entered by game transition (150) |
| 27 | Level_27 | day AltGun, ammo 400/20/10/5, max delay 360 | cleared | 713 | 80 | apc 5, jet 4 | entered by game transition (150) |
| 28 | Level_28 | day AltGun, ammo 400/10/10/5, max delay 850 | cleared | 1336 | 78 | apc 7, cobra 3, jet 2, tank 5 | entered by game transition (150) |
| 29 | Level_29 | day AltGun, ammo 400/10/10/5, max delay 650 | cleared | 920 | 100 | apc 5, cobra 3, jet 5, tank 4 | entered by game transition (150) |
| 30 | Level_30 | day AltGun2, ammo 300/10/10/5, max delay 300 | cleared | 948 | 69 | c130 1, cobra 11 | entered by game transition (150) |
| 31 | Level_31 | day AltGun, ammo 200/10/10/5, max delay 3640 | cleared | 5024 | 91 | apc 8, c130 3, jet 7, parachute 29, soldier 2, tank 7 | entered by game transition (150) |
| 32 | Level_32 | day bombers AltGun, ammo 200/10/10/5, max delay 1750 | cleared | 1820 | 95 | apc 12, c130 1, parachute 44, soldier 5, tank 8 | entered by game transition (150) |
| 33 | Level_33 | day AltGun, ammo 100/6/4/5, max delay 400 | cleared | 646 | 95 | apc 4, c130 1, parachute 7, tank 4 | entered by game transition (150) |
| 34 | Level_34 | day AltGun, ammo 300/0/0/5, max delay 500 | cleared | 1373 | 92 | apc 4, jet 3, parachute 8, soldier 6 | entered by game transition (150) |
| 35 | Level_35 | day bombers AltGun, ammo 200/5/5/5, max delay 9620 | cleared | 13071 | 86 | apc 12, c130 2, cobra 11, jet 6, parachute 129, soldier 5, tank 7 | entered by game transition (150) |
| 36 | Level_36 | night spotlight AltGun, ammo 0/0/0/0, max delay 600 | cleared | 1298 | 99 | parachute 10, soldier 12 | entered by game transition (150) |
| 37 | Level_37 | night spotlight AltGun, ammo 300/5/5/15, max delay 1000 | cleared | 1743 | 92 | c130 2, ch53 2, cobra 4, parachute 46, soldier 6 | entered by game transition (150) |
| 38 | Level_38 | night AltGun2, ammo 0/2/2/10, max delay 1200 | cleared | 1556 | 100 | apc 4, ch53 1, cobra 2, parachute 15 | entered by game transition (150) |
| 39 | Level_39 | night AltGun, ammo 400/10/10/15, max delay 660 | cleared | 753 | 100 | apc 8, cobra 2, parachute 8, tank 4 | entered by game transition (150) |
| 40 | Level_40 | day bombers AltGun2, ammo 300/0/4/5, max delay 150 | cleared | 2299 | 95 | ch53 6, cobra 4, soldier 36 | entered by game transition (150); bomber strike |
| 41 | Level_41 | day AltGun, ammo 400/10/10/5, max delay 1150 | cleared | 1184 | 55 | apc 8, c130 1, jet 12 | entered by game transition (150) |
| 42 | Level_42 | day AltGun, ammo 400/20/10/5, max delay 1150 | cleared | 1262 | 88 | apc 8, jet 4, parachute 8, tank 8 | entered by game transition (150) |
| 43 | Level_43 | day AltGun, ammo 0/0/0/5, max delay 450 | cleared | 991 | 68 | jet 7, parachute 10 | entered by game transition (150) |
| 44 | Level_44 | day AltGun, ammo 0/0/0/5, max delay 800 | cleared | 1806 | 75 | apc 2, parachute 22, soldier 24, tank 8 | entered by game transition (150) |
| 45 | Level_45 | day bombers AltGun2, ammo 200/0/7/5, max delay 670 | cleared | 1555 | 100 | c130 4, cobra 7, parachute 75, soldier 6 | entered by game transition (150) |
| 46 | Level_46 | day AltGun, ammo 400/20/10/5, max delay 300 | cleared | 939 | 95 | apc 6, ch53 1, cobra 2, jet 2, soldier 6, tank 3 | entered by game transition (150) |
| 47 | Level_47 | day AltGun, ammo 200/10/5/5, max delay 1000 | cleared | 1951 | 80 | apc 4, cobra 12, jet 4, parachute 15, tank 8 | entered by game transition (150) |
| 48 | Level_48 | day AltGun, ammo 400/7/7/5, max delay 1100 | cleared | 1150 | 100 | apc 6, cobra 6, parachute 8, tank 4 | entered by game transition (150) |
| 49 | Level_49 | day AltGun, ammo 400/10/10/5, max delay 670 | cleared | 1430 | 71 | apc 8, cobra 3, jet 7 | entered by game transition (150) |
| 50 | Level_50 | day bombers AltGun, ammo 400/10/10/5, max delay 9300 | cleared | 11596 | 54 | apc 8, c130 1, ch53 8, cobra 12, jet 13, parachute 10, soldier 12, tank 12 | entered by game transition (150); bomber strike |
| 51 | Level_51 | night spotlight AltGun, ammo 0/2/0/20, max delay 760 | cleared | 1501 | 94 | apc 2, parachute 14, soldier 13, tank 4 | entered by game transition (150) |
| 52 | Level_52 | night spotlight AltGun, ammo 0/0/2/20, max delay 600 | cleared | 3198 | 95 | cobra 4, parachute 38, soldier 5 | entered by game transition (150) |
| 53 | Level_53 | night spotlight, ammo 300/10/20/5, max delay 690 | cleared | 1245 | 90 | c130 1, cobra 11, parachute 12 | entered by game transition (150) |
| 54 | Level_54 | night spotlight bombers AltGun, ammo 300/5/5/20, max delay 550 | cleared | 1857 | 95 | ch53 7, cobra 4, parachute 17, soldier 24 | entered by game transition (150); bomber strike |
| 55 | Level_55 | day AltGun2, ammo 300/10/10/5, max delay 450 | cleared | 933 | 70 | c130 1, jet 15 | entered by game transition (150) |
| 56 | Level_56 | day AltGun, ammo 150/5/2/5, max delay 2000 | cleared | 2625 | 95 | apc 1, ch53 1, cobra 2, parachute 8, soldier 24, tank 5 | entered by game transition (150) |
| 57 | Level_57 | day, ammo 150/3/5/5, max delay 700 | cleared | 4684 | 15 | apc 1, ch53 2, jet 2, soldier 18, tank 5 | entered by game transition (150) |
| 58 | Level_58 | day, ammo 100/0/10/5, max delay 1000 | cleared | 2673 | 100 | apc 4, c130 1, ch53 2, parachute 55, soldier 6, tank 4 | entered by game transition (150) |
| 59 | Level_59 | day bombers AltGun, ammo 200/0/2/5, max delay 3680 | cleared | 6400 | 87 | c130 1, cobra 4, parachute 88, soldier 15 | entered by game transition (150); bomber strike |
| 60 | Level_60 | day bombers AltGun2, ammo 500/20/20/0, max delay 200 | cleared | 2603 | 80 | apc 10, c130 1, ch53 3, cobra 4, parachute 23, soldier 18, tank 6 | entered by game transition (150); bomber strike |
| 61 | Level_61 | day AltGun, ammo 500/8/8/5, max delay 600 | cleared | 2258 | 100 | apc 8, c130 6, parachute 11, soldier 1 | entered by game transition (150) |
| 62 | Level_62 | day AltGun, ammo 200/6/4/5, max delay 850 | cleared | 1139 | 70 | apc 7, jet 5, parachute 4, soldier 6, tank 5 | entered by game transition (150) |
| 63 | Level_63 | day AltGun2, ammo 200/0/5/5, max delay 200 | cleared | 728 | 85 | cobra 11, parachute 3 | entered by game transition (150) |
| 64 | Level_64 | day AltGun2, ammo 300/10/10/5, max delay 1100 | cleared | 1489 | 63 | apc 4, c130 2, jet 5, parachute 17 | entered by game transition (150) |
| 65 | Level_65 | day AltGun, ammo 400/20/20/5, max delay 10050 | cleared | 10383 | 85 | apc 8, c130 6, ch53 2, cobra 9, jet 5, parachute 123, soldier 18, tank 12 | entered by game transition (150) |
| 66 | Level_66 | night spotlight AltGun, ammo 300/10/10/10, max delay 1020 | cleared | 1228 | 100 | apc 4, ch53 3, cobra 4 | entered by game transition (150) |
| 67 | Level_67 | night spotlight bombers AltGun, ammo 500/20/20/20, max delay 1000 | cleared | 993 | 100 | apc 2, c130 7, parachute 3 | entered by game transition (150) |
| 68 | Level_68 | night spotlight AltGun, ammo 200/10/10/10, max delay 2000 | cleared | 4684 | 78 | apc 4, ch53 4, jet 8, parachute 11, soldier 18 | entered by game transition (150) |
| 69 | Level_69 | night spotlight AltGun, ammo 400/10/10/20, max delay 12000 | cleared | 14353 | 95 | c130 7, cobra 8, parachute 54, soldier 20 | entered by game transition (150) |
| 70 | Level_70 | day bombers AltGun, ammo 300/20/5/5, max delay 580 | cleared | 3119 | 65 | apc 12, ch53 4, parachute 29, soldier 6, tank 12 | entered by game transition (150); bomber strike |
| 71 | Level_71 | day AltGun2, ammo 200/3/2/5, max delay 3680 | cleared | 5173 | 100 | apc 6, c130 2, cobra 2, parachute 99, soldier 10, tank 5 | entered by game transition (150) |
| 72 | Level_72 | day bombers AltGun2, ammo 400/0/10/5, max delay 550 | cleared | 1708 | 80 | c130 3, cobra 7, parachute 53, soldier 11 | entered by game transition (150); bomber strike |
| 73 | Level_73 | day bombers AltGun2, ammo 400/10/10/5, max delay 400 | cleared | 1641 | 100 | c130 2, cobra 3, parachute 83, soldier 5, tank 7 | entered by game transition (150) |
| 74 | Level_74 | day AltGun, ammo 9/5/5/5, max delay 40 | cleared | 3738 | 38 | apc 4, cobra 5, tank 5 | entered by game transition (150) |
| 75 | Level_75 | day AltGun2, ammo 400/0/20/5, max delay 3600 | cleared | 4231 | 72 | apc 4, c130 1, cobra 6, jet 14 | entered by game transition (150) |
| 76 | Level_76 | day bombers AltGun, ammo 100/0/0/0, max delay 3830 | cleared | 4427 | 95 | apc 7, c130 2, cobra 3, parachute 92, soldier 2, tank 4 | entered by game transition (150) |
| 77 | Level_77 | day bombers AltGun, ammo 200/0/0/5, max delay 2500 | cleared | 2655 | 100 | apc 8, parachute 53, soldier 4, tank 3 | entered by game transition (150) |
| 78 | Level_78 | day bombers AltGun, ammo 400/10/0/5, max delay 1970 | cleared | 2405 | 90 | apc 8, c130 1, cobra 6, parachute 33 | entered by game transition (150) |
| 79 | Level_79 | day, ammo 50/4/4/5, max delay 1400 | destroyed | 2037 | 0 | cobra 4, parachute 1, soldier 22, tank 8 | entered by game transition (150); meter left 82 |
| 80 | Level_80 | day bombers AltGun, ammo 200/10/10/0, max delay 800 | cleared | 963 | 85 | apc 12, parachute 12, tank 12 |  |
| 81 | Level_81 | night bombers AltGun, ammo 300/10/0/20, max delay 1860 | cleared | 3312 | 100 | bomber 1, c130 1, ch53 5, parachute 15, soldier 18, tank 7 | entered by game transition (150); bomber strike |
| 82 | Level_82 | night bombers AltGun, ammo 500/10/15/15, max delay 3690 | cleared | 5648 | 90 | apc 8, bomber 1, ch53 7, cobra 3, jet 1, parachute 30, soldier 12 | entered by game transition (150); bomber strike |
| 83 | Level_83 | night spotlight bombers AltGun2, ammo 400/20/20/20, max delay 1000 | cleared | 1484 | 100 | c130 4, cobra 3, parachute 60, soldier 2 | entered by game transition (150) |
| 84 | Level_84 | night spotlight AltGun, ammo 0/0/0/0, max delay 900 | cleared | 2045 | 100 | apc 3, parachute 8, soldier 12 | entered by game transition (150) |
| 85 | Level_85 | day bombers AltGun, ammo 500/20/20/0, max delay 12400 | cleared | 12666 | 80 | apc 9, c130 6, ch53 3, cobra 12, jet 3, parachute 34, soldier 12, tank 12 | entered by game transition (150); bomber strike |
| 86 | Level_86 | day bombers AltGun2, ammo 400/20/10/5, max delay 480 | cleared | 1496 | 100 | apc 10, c130 2, parachute 57, soldier 29, tank 4 | entered by game transition (150); bomber strike |
| 87 | Level_87 | day bombers AltGun, ammo 400/20/10/5, max delay 480 | cleared | 1579 | 95 | apc 11, parachute 50, soldier 26, tank 4 | entered by game transition (150); bomber strike |
| 88 | Level_88 | day bombers AltGun, ammo 400/10/10/5, max delay 1370 | cleared | 2128 | 95 | apc 6, c130 5, parachute 45, soldier 6, tank 4 | entered by game transition (150); bomber strike |
| 89 | Level_89 | day AltGun, ammo 9/5/5/5, max delay 40 | cleared | 606 | 59 | apc 4, jet 4, tank 5 | entered by game transition (150) |
| 90 | Level_90 | day bombers AltGun, ammo 500/20/20/0, max delay 14600 | cleared | 14925 | 72 | apc 7, c130 7, cobra 12, jet 16, parachute 61, tank 12 | entered by game transition (150) |
| 91 | Level_91 | day AltGun, ammo 50/4/4/5, max delay 1000 | destroyed | 4318 | 0 | cobra 7, parachute 5, soldier 24, tank 8 | entered by game transition (150); meter left 10 |
| 92 | Level_92 | day AltGun2, ammo 100/5/5/5, max delay 800 | cleared | 1444 | 78 | apc 4, cobra 2, jet 8, parachute 20, tank 4 |  |
| 93 | Level_93 | day AltGun, ammo 400/20/20/5, max delay 5480 | cleared | 6652 | 55 | apc 8, c130 1, cobra 12, jet 6, parachute 60, tank 12 | entered by game transition (150) |
| 94 | Level_94 | day bombers AltGun, ammo 100/0/0/0, max delay 3840 | cleared | 4501 | 70 | apc 9, cobra 2, jet 6, parachute 75, tank 6 | entered by game transition (150) |
| 95 | Level_95 | night spotlight AltGun, ammo 400/10/10/10, max delay 7200 | cleared | 7718 | 95 | apc 8, c130 2, ch53 5, parachute 85, soldier 18, tank 4 | entered by game transition (150) |
| 96 | Level_96 | night AltGun2, ammo 400/10/10/10, max delay 7200 | cleared | 7459 | 100 | apc 8, c130 3, ch53 6, parachute 55 | entered by game transition (150) |
| 97 | Level_97 | night, ammo 50/4/4/5, max delay 1040 | destroyed | 3315 | 0 | apc 1, cobra 6, parachute 5, soldier 16, tank 8 | entered by game transition (150); meter left 22 |
| 98 | Level_98 | night spotlight AltGun, ammo 400/0/15/0, max delay 2900 | cleared | 3064 | 86 | jet 11, parachute 14 |  |
| 99 | Level_99 | day bombers AltGun, ammo 500/20/20/5, max delay 1540 | cleared | 2234 | 83 | apc 6, c130 2, ch53 3, cobra 9, jet 9, parachute 43, soldier 12, tank 8 | entered by game transition (150); bomber strike |
| 100 | Level_91 | day AltGun, ammo 50/4/4/5, max delay 1000 | cleared | 2976 | 47 | apc 1, cobra 8, parachute 5, soldier 18, tank 8 | entered by game transition (150) |
| 101 | Level_92 | day AltGun2, ammo 100/5/5/5, max delay 800 | cleared | 1159 | 95 | apc 4, cobra 2, jet 8, parachute 11, tank 4 | entered by game transition (150) |
| 102 | Level_93 | day AltGun, ammo 400/20/20/5, max delay 5480 | cleared | 5753 | 82 | apc 8, c130 2, cobra 12, jet 6, parachute 29, tank 12 | entered by game transition (150) |
| 103 | Level_94 | day bombers AltGun, ammo 100/0/0/0, max delay 3840 | cleared | 4717 | 46 | apc 9, c130 1, cobra 2, jet 6, parachute 74, tank 6 | entered by game transition (150) |
| 104 | Level_95 | night spotlight AltGun, ammo 400/10/10/10, max delay 7200 | cleared | 7743 | 100 | apc 8, ch53 6, parachute 95, soldier 12, tank 4 | entered by game transition (150) |
| 105 | Level_96 | night AltGun2, ammo 400/10/10/10, max delay 7200 | cleared | 7440 | 100 | apc 8, c130 2, ch53 5, parachute 69, soldier 6 | entered by game transition (150) |
| 106 | Level_97 | night, ammo 50/4/4/5, max delay 1040 | destroyed | 11175 | 0 | cobra 8, parachute 5, soldier 23, tank 8 | entered by game transition (150); meter left 1 |
| 107 | Level_98 | night spotlight AltGun, ammo 400/0/15/0, max delay 2900 | cleared | 3097 | 68 | jet 11, parachute 14 |  |
| 108 | Level_99 | day bombers AltGun, ammo 500/20/20/5, max delay 1540 | cleared | 2636 | 73 | apc 6, bomber 2, c130 3, ch53 1, cobra 9, jet 9, parachute 50, soldier 28, tank 8 | entered by game transition (150); bomber strike |
| 109 | Level_99 | day bombers AltGun, ammo 500/20/20/5, max delay 1540 | cleared | 2321 | 73 | apc 6, c130 3, ch53 3, cobra 9, jet 9, parachute 29, soldier 23, tank 8 | entered by game transition (150); bomber strike |
| 110 | Level_91 | day AltGun, ammo 50/4/4/5, max delay 1000 | cleared | 3263 | 56 | cobra 8, parachute 5, soldier 24, tank 8 | entered by game transition (150) |
| 111 | Level_92 | day AltGun2, ammo 100/5/5/5, max delay 800 | cleared | 1668 | 59 | apc 4, c130 1, cobra 2, jet 8, parachute 18, tank 4 | entered by game transition (150) |
| 112 | Level_93 | day AltGun, ammo 400/20/20/5, max delay 5480 | cleared | 6239 | 72 | apc 8, c130 2, cobra 12, jet 6, tank 12 | entered by game transition (150) |

## Seed 7 confirmation (levels not cleared)

- 47: destroyed at frame 1234, meter 80 left, damage Projectiles.shell 45, Projectiles.impact 15, Projectiles.bullet 70
- 55: destroyed at frame 643, meter 40 left, damage Projectiles.bullet 100
- 74: destroyed at frame 2733, meter 20 left, damage Projectiles.shell 10, Projectiles.bullet 90
- 79: destroyed at frame 3194, meter 29 left, damage Projectiles.impact 25, Projectiles.bullet 72, Projectiles.shell 25, SoldierPool.shoot 1
- 97: destroyed at frame 4214, meter 21 left, damage Projectiles.impact 5, Projectiles.bullet 88, SoldierPool.shoot 2, Projectiles.shell 35
- 106: destroyed at frame 3086, meter 11 left, damage Projectiles.impact 15, Projectiles.bullet 68, Projectiles.shell 25, SoldierPool.shoot 1
- 110: destroyed at frame 4495, meter 10 left, damage Projectiles.shell 20, Projectiles.impact 10, Projectiles.bullet 100
