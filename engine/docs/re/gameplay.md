# Beach Head 2002: gameplay rules (reverse engineered from BH2.exe)

Companion to [architecture.md](architecture.md). Addresses are BH2.exe virtual addresses. Confidence: **[H]** high, **[M]** medium, **[L]** low.
Detailed working notes: `artifacts/re/notes/10-fun004051c8.md` (enemy AI), `20-fun004154b7.md` (projectiles and damage), `30-renderer.md`, `40-frontend.md`.

**Units.** Distances are world units (heightmap cell = 20, height = byte x 8). Time is game frames at a fixed ~34.5 fps (29 ms per frame, no delta time). "u/f" = units per frame (x34.5 for per second). Angles are degrees. `rand()` is MSVC's LCG (0..32767); `rand>>6` is 0..511, and so on.

## 1. World layout and directions [H]
- The player is a fixed bunker turret at the origin. The eye is at (0, 820, 0); guns pivot at (0, 800, 0). Enemies aim at (0, 800..860, 0).
- Yaw 0 looks toward -Z, 90 toward -X, 180 toward +Z (the starting view), 270 toward +X.
- Level directions (spawn side):

| keyword | code | ground spawn (tank/APC) | facing |
|---|---|---|---|
| North | 1 | x = rand/2 - 8192 (±8192), z = -7500..-9547 | 180 (drives toward +Z) |
| South | 2 | z = +7500..+9547 | 0 |
| East | 3 | x = +7500..+9547, z = ±8192 | 90 |
| West | 4 | x = -7500..-9547 | 270 |
| (none) | 0 | random direction per spawn | |

  So North = -Z, South = +Z, East = +X, West = -X. The player starts facing South. Ground spawns are retried until the MMap byte < 0x20.
- Aircraft spawn 32000..48383 out along the direction with ±8192 sideways offset and fly toward the origin.
- The direction keyword applies to the object group it follows (it sets one direction for the whole type).

## 2. Level file semantics (`FUN_00429201`) [H]
- `Object TYPE` / `ObjectInc` activate the next slot of the type. `Delay N` makes the current slot inactive and spawns it N frames after level start (independent per slot, see architecture.md §2).
- Slot ranges: TANK 12, APC1/APC2/APC3 4 each, JET 16, BOMBER 9, COBRA 12, CH53 8, C130 8.
- `Ammo b c m f`: bullets (cap 500), cannon shells (cap 20), missiles (cap 20), flares (cap 20). The handgun always gets 15 rounds per level.
- `Aggression a b c d` (tank, jet, heli gun, heli rocket): stored as a+320, b+500, c+40, d+50. Use in §5.
- `Daytime` (default is night), `Spotlight` (night only), `Crosshair`, `Bombers`, `AltGun`, `AltGun2`, `End`.
- C130 options per plane: `passes n` (1..127, default 127), `alternate`, `far`, `troops1 n` (<= 16), `troops2 n` (<= 16), `hdrop`/`adrop`/`pdrop`/`mdrop n` (<= 4 each).
- **Not recognised by BH2.exe** (strings absent; ignored): `Artillery`, `AltCannon`, `Nightime`. The bomber direction line is overridden at call time (random heading).
- Enemy meter (ENEMY bar) starts at the sum over scheduled slots: TANK 10, APC1 6, APC2 11, APC3 11, JET 10, COBRA 10, CH53 6, C130 troops1 + troops2. Bombers count 0.
- Level filename: `Level_0%d` (< 10), `Level_%d` (< 100), else `Level_(level%10 + 91)`.

## 3. Player controls and aiming (`FUN_0040101d`) [H]
- Mouse position offset from screen centre, clamped to ±320 x ±240 (fixed values, even at 800/1024 width).
- **Yaw is rate controlled** by the horizontal offset (cursor is not re-centred):
  - flag 0 (menu "LOOSE"): yaw -= x x 0.02 deg/frame (max 6.4 deg/frame at the edge).
  - flag 1 (menu "TIGHT", `a` key toggles): yaw -= x x |x| x 0.0001 deg/frame (quadratic: fine near centre, max 10.24 deg/frame).
- **Pitch is delta controlled**: pitch -= dy x 0.2 per frame (inverted by the reverse flag or `i`/`r`), clamped to [-25, +80].
- Weapons selected by `DAT_004478f0`: 0 main gun, 1 cannon, 2 handgun. `Space` cycles gun -> cannon -> gun; it only reaches the handgun when bullets are 0 and handgun rounds > 0. `g` selects the handgun. When the level gives 0 bullets you start on the handgun.
- Fire = left mouse button held. Firing stops once the level is cleared.

## 4. Player weapons [H]
Projectiles move `pos += vel` then `vel.y -= gravity` every frame. A shot fired from the bunker that falls back within range of the player also hurts the player (see §6).

| weapon | trigger | rate | ammo (per shot) | muzzle / speed | gravity | effect |
|---|---|---|---|---|---|---|
| Twin gun (default) | LMB, weapon 0 | 2 rounds per 7 frames, alternating barrels (~9.9/s) | bullets -1 | barrel + fwd x 220 ± 30 lateral, 500 u/f | 0.16 | bullet, `AntiAir.wav` |
| AltGun / AltGun2 (`AltGun`, `AltGun2` keywords) | LMB, weapon 0 | 1 round per 3 frames (~11.5/s) | bullets -1 | fwd x 80 + side x 8, 500 u/f | 0.16 | bullet, `MachineGun.wav`, ejects casings |
| Cannon | LMB, weapon 1 | 1 shell per 30 frames (0.87 s) | cannon -1 | fwd x 265, 400 u/f | 0.16 | shell, `CannonClose.wav` |
| Handgun | LMB, weapon 2, one shot per click | max 1 per 4 frames | handgun rounds (15/level, not refilled, no cheat) | fwd x 100, 400 u/f | 0.16 | bullet, `Pistol.wav` |
| Guided missiles | `m` | 2 rails; a rail reloads when its missile is gone and ammo remains | missiles -1 | launcher ±100 lateral, view direction, 280 u/f, lifetime 130 | none | homing, `Missile.wav` |
| Flares | `f`, **night only** | up to 4 in the air | flares -1 | 200 u/f along view (if |pitch| >= 60: (80-|pitch|) x 10) | 2/frame while rising | night light source, `Missile.wav` |
| Bomber airstrike | `b`, level has `Bombers`, once per level | 9 bombers (objects 0x85-0x8d) | - | random heading, see §5.6 | | friendly bombs |

- Bullets hit-test with a 500-unit ray each frame; shells 400.
- Missile homing: starts after 10 frames, only while y > 800. It picks the airborne target (jet, bomber, cobra, CH53, C130) with the largest cos angle >= 0.8 (~37 deg cone), turning at most 5 deg/frame in pitch and yaw. Proximity kill within 300 (3D) of any aircraft when y >= 800; below 800 it ray-tests tanks, APCs and CH53 and destroys on hit. Ground impact acts like a shell.
- Flares have **no missile decoy logic**: enemies never fire guided missiles in practice (see §5.3). After 20 frames a flare becomes a slow-falling light (vy -7.5, or -20 above y 4000) that lights objects within ~5100-6300 units.
- Recoil animations, ejected casings and muzzle flashes (ExplodeF sizes 0.15 gun, 0.6 cannon, 0.25 handgun) are cosmetic.
- **Ammo-out loss**: when bullets, cannon, missiles and handgun are all 0 and the enemy meter is > 0, a counter runs from 150 to 90 frames and then shield is set to 0. Any prize resets the counter to 150.

## 5. Enemies (`FUN_004051c8` AI, `FUN_004154b7` firing and damage)
Spawn: when a slot's Delay reaches 0 it becomes active with state 1 and is initialised on the next frame [H].

### 5.1 Damage model [H]
- Hit-tests use per-type collision polygons from `ShapeData` (`FUN_00423d9d`), after a bounding-sphere check (tank/APC 500, jet 670, bomber 1100 vs bullets / 640 vs shells, cobra 590, CH53 900, C130 1270, parachute 700). Ray tests on aircraft only when the projectile is at y >= 750, ground vehicles and soldiers below 750. CH53 and parachutes are tested at all heights.
- Polygons are grouped into zones: **zone 0 = instant kill, zone 1 = -2 HP, zone 2 = -1 HP** per bullet.
- **Bullets do not damage tanks or APCs** (hit flash only). Any cannon shell or missile hit destroys any vehicle regardless of HP.
- HP: JET 4, BOMBER 4, COBRA 8, CH53 8, C130 8. When HP < 1 the aircraft enters a crash state and falls (the meter drops when it hits the ground).

### 5.2 TANK (12 slots, objects 0x25-0x30, turret +0xc, barrel +0x18) [H]
- Top speed 20 u/f, acceleration 0.5. Steering: yawRate smoothed 0.1/0.9; yaw += yawRate x speed x 0.0035. Follows terrain (pitch/roll from 4 height samples at ±150 fwd, ±100 side).
- Patrol each frame with r = rand>>6: r = 310/311 random wander for 30..93 frames. If it leaves the ±10000 box it turns back toward a random point within ±2048. Avoids other vehicles within 1500 and the bunker corners.
- **Attack** when `319 < r <= a + 320`: **probability (a+1)/512 per frame** (a = tank aggression; 1 -> 0.4 %/frame, 9 -> 2 %/frame). It stops, turns the turret at 1.5 deg/frame and the barrel at 0.5 deg/frame toward (0, 860, 0), then fires **one shell** 60 frames after lock-on, and resumes patrol.
- Shell: from barrel + fwd x 240, 500 u/f, gravity 0.16, `CannonFar.wav`. Within 250 of (0,800,0): **shield -5**.
- Killed by a shell or missile: turret blown off (vy 40, gravity 3), meter -10.

### 5.3 APC1 / APC2 / APC3 (4 slots each, 0x49-0x54) [H]
- Same driving as tanks (20 u/f). Each carries 6 troops. After 400..527 frames, or when within 2800 of the origin, it stops, opens the ramp (2 deg/frame to 120) and unloads **6 soldiers** about 10 frames apart. APC1 then stays parked. APC2/3 close the ramp and resume.
- APC2: gun attack with the **tank** aggression chance (a+1)/512 per frame, aim (0,860,0), **4-round burst** of bullets (500 u/f), each bullet within 300 of the player = shield -1.
- APC3: gun attack as above (aim (0,840,0)) plus **2 rockets total** at a fixed 4/512 chance per frame: 280 u/f straight, lifetime 130; within 300 of the player: shield -5.
- Destroyed only by shell or missile. Meter -6 (APC1) or -11 (APC2/3) when the APC still had its troop flag set [M on that condition]. Destruction also sets nearby soldiers on fire (burn event).

### 5.4 JET (16 slots, 0x75-0x84) [H]
- Altitude 2000..6095, speed 160..191 u/f. Turn/pitch rates smoothed 0.08/0.92, roll = yawRate x 30. Random manoeuvres, re-target inside the ±25000 box, terrain pull-up below 2240.
- **Attack** when `499 < r <= b + 500` (r = rand>>6) **and** the jet is more than 16000 out on either axis: **probability (b+1)/512 per frame**. It lines up on (0,800,0), dives, and fires its gun every 2nd frame (500 u/f, ±32 jitter per axis) until within 6000, below 1800, or too steep; then pulls up.
- A missile branch exists but jets never get missiles (ammo field never set), so they only strafe [M].
- Bullets: shield -1 each within 300. Crash within 300 of the origin: shield -5 and shake. Crash or kill: meter -10, `ExBig.wav`.

### 5.5 COBRA (12 slots, 0x8e-0x99) [H]
- Altitude 1500..2523, max speed 140, rotors spin. Hover wobble when slow.
- Gun attack when `39 < r <= c + 40` (r = rand>>7): **(c+1)/256 per frame**, only inside |x| <= 12000, -12000 <= z <= 3000, outside the 4000 box, speed >= 130. It lines up, decelerates to a hover for 60..123 frames, then fires a bullet every 4 frames for 16..47 frames at a jittered point around (0, 672..928, 0), then leaves.
- Rocket attack at a **fixed 4/256 chance** per frame (outside the 10000 box): 4 rockets 8 frames apart, 280 u/f, lifetime 100. Ground impact within 300 (horizontal) of the player: shield -5.
- **Aggression `d` (heli rocket) is never read** [H].
- Crash: rotor slows, gravity 1/frame. Crash within 300: shield -5. Meter -10.

### 5.6 BOMBER (9 slots, 0x85-0x8d, friendly) [H]
- Called with `b`. Spawn 65000..196068 out, ±4096 sideways, altitude 2240..4287, 200 u/f, random common heading.
- Within 18000 of the origin, after 0..31 frames, it drops **4 bombs** 8 frames apart, then flies out (removed beyond 60000).
- Bombs: horizontal speed starts at the plane's speed and falls 1/frame; vy -1.5/frame. Ground impact kills soldiers within 500 (meter -1 each). Bombs do not test tanks/APCs in the code found [M]. A bomb within 300 of the player also costs shield -5.
- Your bullets or shells destroy bombers (friendly fire, meter unchanged).

### 5.7 CH53 (8 slots, 0xb2-0xb9) [H]
- Altitude 2500..3011, speed 140. It picks a landing zone 2500..12740 out on both axes (MMap < 0x20, >= 1000 from other CH53 zones), flies there, flares and descends, and lands 338 above ground.
- It opens the ramp, unloads **6 soldiers** about 13 frames apart, waits 90 frames, climbs, and leaves (removed beyond 60000).
- Does not attack. Meter -6 if killed before it finishes unloading (state < 8). Killed while landed also burns nearby soldiers.

### 5.8 C130 (8 slots, 0xd2-0xd9) [H]
- Altitude 4000..6047, speed 140, HP 8. Sideways offset ±4096 (`far`: pushed out to 4096..8191).
- Inside a 5000 box (9000 if `far`) it drops one item every 8 frames: a random choice among troops, health, bullets, cannon and missile crates, falling back to whatever remains. When troops1 runs out, troops2 becomes the next pass's load.
- Passes: after crossing beyond 48000 it turns 180 deg and repeats until `passes` runs out.
- Parachutes (64 pool) fall at 10 u/f with a pendulum swing (from 45 deg). Paratroopers become ground soldiers on landing.
- **Crates are collected only by shooting the parachute in the air**. A crate that lands is lost [M on intent].
- Kill: meter -= troops1 + troops2 still aboard.

### 5.9 Soldiers and paratroopers (96 pool, 0x166-0x1c5) [H]
- Sources: APC (6), CH53 (6), C130 paratroopers.
- Walk 4 u/f, run 8 u/f. If within 2500 they head for the bunker, else to a random point within ±2048. They strafe-circle, run, kneel or stand and fire; inside 700 they stop and fire forever.
- Rifle: a shot every 30..61 frames (`Rifle.wav`, muzzle flash). **26.8 % of shots hit: shield -1** with `Metalbig`/`Metalshort`/`Ricocht*`.
- Grenades: thrown at 20..40 u/f toward a point ~1024 above the bunker, gravity 1.0/frame. **Within 200 of (0,800,0): shield -5** and shake.
- Killed by one bullet (meter -1; 50 % chance of a `Soldead1..4` scream), shell/missile ground impact within 400, or bomb/rocket within 500 (thrown into the air). Burning soldiers run and then die (meter -1).
- Sprite frames: walk 0x4f..0x5c, stand fire 0x7d..0x89, kneel 0x76..0x7c, throw 0x5d..0x75, paratrooper 0xe6..0xef, deaths 0xa2..0xbf / 0xc0..0xdd / 0xf0..0x10d, blown up start at 138/146/154/222/270 (Soldiers128x29808, 128x144 frames).

### 5.10 Summary: what damages the player [H]
| source | radius from (0,800,0) | shield |
|---|---|---|
| any bullet (APC2, jet, cobra, own bullets falling back) | 300 (3D) | -1 |
| soldier rifle | 26.8 % of shots | -1 |
| tank shell (and own cannon shell) | 250 (3D) | -5 |
| grenade | 200 (3D) | -5 |
| APC3 rocket in flight | 300 (3D) | -5 |
| cobra rocket or bomb ground impact | 300 (horizontal) | -5 |
| jet or cobra crash | within the ±300 box | -5 |
Heavy (-5) hits shake the view and play `ExHit.wav`.

## 6. Win, lose, health and score [H]
- Shield `DAT_00479024` starts at 100 each level, cap 100.
- **Win**: enemy meter < 0.0001 shows the "cleared" banner, stops fire input, and after **150 frames** loads the next level in-process (level + 1, full reset, ammo from the new file).
- **Lose**: shield < 1 shows the "destroyed" banner and after 150 frames writes BeachheadOut `0` and exits to the menu. Out of ammo also leads here (§4).
- ESC writes status `1`.
- Score = level reached (front end). There is no points counter in the game.
- **Prizes** (shoot the parachute, `Prize.wav`): health crate +15 shield, ammo crate +50 bullets, cannon crate +4 shells, missile crate +2 missiles. Caps 100/500/20/20. Mapping from C130 `hdrop/adrop/pdrop/mdrop` to these four is by slot order [M]. One of the four missile slots gives nothing (off-by-one in the original) [H].
- **Cheats**: `1` = infinite ammo (bullets, cannon, missiles and flares are not decremented; the handgun still is). `2` = god mode (shield reset to 100 every frame). `=` = enemy meter 0 (level skip).

## 7. HUD [H]
SHIELD bar (top left), ENEMY bar (top right, current / initial), `Level N` (top centre), AMMO bar and count for the current weapon (bottom left), FLARES (night only), missile launcher with loaded-rail pips and spare count (bottom centre), bombers-available icon, optional crosshair. Bar colours: green > 50 %, yellow 26..50 %, red < 26 %. Layout in architecture.md §3.8.

## 8. Sound triggers [H]
| event | wav | notes |
|---|---|---|
| twin gun shot | AntiAir (10 voices round robin) | |
| alt gun shot | MachineGun (10) | |
| player cannon | CannonClose (2) | |
| tank fires | CannonFar (2) | always Far for tank shells |
| handgun | Pistol (2) | |
| missile launch, flare launch | Missile (2) | |
| shell or missile ground impact | ExMuffle (6) | |
| aircraft killed by gun/shell/missile | ExFar (4) | |
| bomb or rocket ground impact | ExClose if d <= 1000, ExFar if d < 4000, else ExMuffle | d = distance from the bunker (exact metric [M]) |
| crash of C130 / jet / cobra / CH53 | ExBig, volume -0.15 x \|z\| hundredths dB | original bug uses \|z\| only |
| heavy hit on player (-5) | ExHit (2) | plus screen shake |
| bullet or rifle hit on player (-1) | Metalbig 2/8, Metalshort 2/8, Ricocht1 1/8, Ricocht2 1/8, Ricocht3 2/8 | Ricocht4.wav is never loaded |
| soldier rifle | Rifle (4) | |
| soldier shot dead | Soldead1..4, 50 % chance | |
| parachute prize | Prize | |
| engine loops (`FUN_00424aef`) | Tank, Truck (APC) | nearest unit d = max(\|x\|,\|z\|) < 6501, volume -d |
| | Jet, C130 | d < 30001, volume -d/8 |
| | Bomber, Cobra, CH53 | d < 18001, volume -d/4 |
Volume is DirectSound hundredths of dB (-d means -d/100 dB). `s` toggles all sound.

## 9. Open questions
- Exact visual result of the blend modes (assumes texture alpha = 1).
- Meaning of the APC "troop flag" condition for its meter penalty, and soldier states 0x1e/0x26 that vanish in the burn event.
- Whether bombs ever damage tanks/APCs (not found).
- C130 bytes `alternate` and the per-drop toggle are parsed but their effect was not found.
- Soldier corpse removal is tied to the player's pitch > 20 (looks like a culling hack) [L].
- Exact distance metric for ExClose/ExFar/ExMuffle selection on bomb and rocket impacts [M].
- A few original quirks to decide whether to copy: cobra climb scaled by the forward vector's Y, ExBig volume uses |z| twice, soldier pool index never wraps, missile crate off-by-one, tank boundary check on z not using abs.
