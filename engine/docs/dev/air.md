# Aircraft, helicopters, transports, parachutes, bombers

Files: `src/game/enemies/air.ts` (`AirSystem`), `src/game/enemies/parachutes.ts` (`Parachutes`), `src/game/enemies/install-air.ts`.

Wiring (main.ts, after the `World` and `Game` exist, before the first `startLevel`):

```ts
import { installAir } from './game/enemies/install-air'
installAir(world)
```

`installAir` pushes one `AirSystem` (types `JET BOMBER COBRA CH53 C130`, owns the parachute pool) into `world.enemies` and sets `world.callBombers`. `reset()` registers one `Target` per aircraft slot (60) and per parachute (64) in `world.targets`; `alive()` is false while a slot is inactive or not yet initialised.

Sound engine loops: `airEngineDistances(world)` (install-air.ts) returns `{ jet, c130, bomber, cobra, ch53 }`, each the min over active aircraft of `max(|x|, |z|)`, `Infinity` when none. FUN_00424aef plays Jet/C130 when d < 30001 at -d/8 and Bomber/Cobra/CH53 when d < 18001 at -d/4 (hundredths of dB).

## What is implemented (source: FUN_004051c8, FUN_004154b7, FUN_004232fa, FUN_004237f2)

- **Spawn**: state 1 runs on the frame after `spawn()`. Air spawn 32000..48383 out, ±8192 sideways (C130 and bombers ±4096; C130 `far` pushes 4096..8191), by level direction or random per spawn (C130 random = any heading `(rand>>7)*1.40625`).
- **JET**: all states 2..0x10: wander turns, altitude changes, 25000-box return, terrain pull-up below 2240 (look-ahead 4000, 800 off-map), attack `(b+1)/512` beyond 16000, align, dive (-|asin| pitch target quirk), gun every 2nd frame (`'bullet'`, fwd x 801 - up x 50, ±32 jitter, 500 u/f), pull-up. Dead missile branch kept (missiles always 0). Crash: smoke 0.6, roll offset, ground + 100.
- **COBRA**: 0.05/0.95 smoothing, nose-down pitch with speed, roll from yaw change x speed x 0.215, hover wobble below speed 30, climb scaled by forward.y (original quirk). Gun attack `(c+1)/256` in the zone, hover 60..123 frames, bullets every 4 frames at a jittered point (±64). Rocket attack fixed 4/256: 4 `'rocket'` (life 100, 280 u/f, pods ±105, -165). Rotor 55 deg/frame, prop -40. Crash: rotor slows to 20, gravity 1, ground + 200.
- **CH53**: landing-zone pick (2500..12740 both axes, `validGround`, 1000 from lower-index zones), homing within 4800, rate-limited steer, flare within 4830, descent, land at ground + 338, ramp to 35, 6 soldiers via `world.soldiers.spawn` (y - 270, offsets 290..-110 behind, facing away, `stagger = 310 - offset`, the negated original counter), wait 90, ramp closes, climb, leave beyond 60000.
- **C130**: drop zone 5000 box (9000 `far`), one drop every 8 frames while > 800 from the origin, random pick with fallback order troops/h/a/p/m, troops2 becomes the next pass's troops, crates reload every pass, 180 deg turn past 48000, `passes`. Four props spin -34/-36/35/33. HP-out: dive, smoke, crash at ground + 100.
- **BOMBER**: `callBombers` picks one heading, nine bombers 65000..196068 out at 200 u/f, within 18000 wait 0..31 frames then 4 `'bomb'` 8 frames apart (±40 lateral, hspeed = 200), leave beyond 60000. Any hit destroys, no meter change.
- **Damage**: bullets zone 0 kill, zone 1 -2 HP, zone 2 -1 HP (only while HP > 0); shells/missiles destroy. Hit flash ExplodeF 2.5 (jet, bomber, C130) / 1.0 (cobra, CH53). Meter: jet/cobra -10 on kill or crash; CH53 -6 when killed or HP-out before state 8; C130 -(troops1 + troops2 aboard).
- **Destruction**: shot down = ExplodeA x4 + debris (spin ±8, velocity ±82) + `ExFar`; crash = ExplodeA unless within the 400 box + debris (spin ±16, xz ±20, vy 20..85) + `ExBig` at `-0.15 x |z|` (original bug), jet/cobra crash within the ±300 box = `damagePlayer(5)`. Debris: drag 0.98, gravity 3, removed below y 0; each destruction clears the pool, as in the original.
- **Shadows** 274..293: cobra/CH53 yaw and x/z inside the 14000 box, every vertex at ground + 12.
- **Parachutes**: 64 ring, pendulum from 45 deg (`swing = -pitch x 0.008 + swing x 0.992`), 10 u/f. Crates (454..469, ring of 4 per kind) hang 250 below and swing with the canopy. Landing (canopy y - 300 < ground): paratrooper -> `world.soldiers.spawn(world, p, yaw, { paratrooper: true })`; crate is lost. Shot parachute: crate -> `world.prize` (health, bullets, cannon, missiles; missile ring slot 3 gives nothing, the original `< 0x1d5` off-by-one), ExplodeF 4; paratrooper -> meter -1, blood.

## Deviations

- Projectiles are fired inside `update()` (after the craft moved, using its new matrix), so they take their first step in the same frame instead of the next one.
- Cobra/CH53 roll uses the wrapped yaw change; the original's raw difference gives a one-frame roll spike when yaw crosses ±180.
- CH53 state 4 divides by a stale local in the original; the true heading is used.
- Landing-zone search has an iteration cap (the original loops forever).
- Debris chunks are 60 triangles of the built mesh per material, not the original's 40 display-list commands.
- Ground height is the bilinear `world.groundY` (original: nearest heightmap byte x 8), 0 off the ±15000 map for crash tests.
- Per-slot rates are zeroed on spawn (the original keeps stale values from a previous life of the slot).
- A crate ring slot reused while still in the air moves to the new parachute; the old parachute disappears when it lands (original: it falls forever, invisible).
- Crash smoke uses `smokeBlack` (which billboard the 0x447d40 particles use is not confirmed).
- Jet crash roll velocity is applied as a fixed roll offset: the original AI rewrites roll every frame, so the spin never accumulates.

## Open issues

- **Scene bug (g3dscene.ts)**: chained `Instance` objects (e.g. 296 -> 295 -> 294) get no meshes because only one `instanceOf` level is followed. This hides jets 119+, bombers, cobras, CH53s, C130s, rotors, props, parachutes 2+ and crates. `shareMeshes()` in air.ts works around it for these ids (a no-op once G3DScene resolves chains). The same bug affects other instanced runs (soldier billboards are separate objects, but missiles/rockets/bombs 470..519 and tank/APC runs should be checked).
- Paratroopers are not drawn while descending: the `Soldiers` interface has no "attached to parachute" spawn, so only the canopy shows until landing.
- Burn event (`DAT_00447900`: soldiers within 600 of a crash, a landed CH53 kill, or an APC kill catch fire) is not raised; `Soldiers` has no burn API.
- Bombers whose 0..31 delay rolls 0 never drop and keep flying (original quirk, kept).
- C130 `alternate` and the per-drop toggle byte have no known effect and are ignored.
- Enemy gun muzzle flashes are not spawned (not found in the RE notes).

## Verification

`npx tsc --noEmit -p .` passes for these files. Browser checks (dev server, module loaded from the console): jets attack and strafe (shield hits recorded), a jet kill drops the meter by 10; cobra rocket and hover-gun attacks; cobra HP-out crash after 8 zone-2 hits (meter -10, 15 debris chunks); CH53 runs all states 1..12, lands 338 above ground on a valid zone and unloads 6 soldiers per landing; C130 passes and drops; shooting parachutes gives the prize and -1 per paratrooper; landed paratroopers reach `soldiers.spawn` with `{ paratrooper: true }`; the bomber strike drops 36 bombs and all nine leave. Screenshots: `artifacts/screens/air-jets.jpg`, `air-cobra-hover.jpg`, `air-c130-parachutes.jpg`.
