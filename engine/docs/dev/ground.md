# Ground enemies and soldiers

Files: `src/game/enemies/ground.ts` (`GroundSystem`: TANK, APC1/2/3), `src/game/enemies/soldiers.ts` (`SoldierPool`: the 96 soldiers), `src/game/enemies/install-ground.ts`.

```ts
import { installGround } from './game/enemies/install-ground'
const ground = installGround(world, fs) // before game.startLevel(...)
```

`installGround` creates both, pushes `GroundSystem` into `world.enemies` and sets `world.soldiers`. `GroundSystem.update` runs the soldier pool after the vehicle AI and before terrain following, the same order as `FUN_004051c8`. The fs is needed for the soldier `Film` sheets and the fire texture, which Geometry.3D only fills at runtime. They load in the background, and sprites stay hidden until they are ready.

## Sources

- AI: decomp `FUN_004051c8`. Tank loop L1897, APC loop L2278, avoidance L2785/L2968, soldiers L4894, terrain following L6055, shadows L6177.
- Weapons and damage: `FUN_004154b7`. Fire flags L9647-9790, tank and APC kills L7990-8130 and L10925-11000, soldier ray `FUN_00424897`, burn event (`DAT_00447900`), debris `FUN_004237f2`.

## Behaviour

- **Spawn**: `spawn()` sets the vehicle active with state 1. Initialisation happens on the next AI frame: parts are shown, and the spawn point is picked by the level direction (`world.level.directions.tank` / `.apc`, or random per spawn), retried until `validGround`.
- **Driving**: max speed 20, acceleration 0.5, smoothed yaw rate (0.1/0.9) x speed x 0.0035. Wander at r = 310/311 (tank) or 320/321 (APC). Leaving the ±10000 box turns the vehicle back toward a random point within ±2048 (the z test in state 5 is not absolute, as in the original). Avoidance swerves ±12 away from vehicles within the 1500 box (cos > 0.95) and from the bunker corners (cos > 0.9).
- **Terrain**: pitch and roll come from 4 bilinear height samples (±150 forward, ±100 sideways), and y is their mean. Shadows (objects 250..273) follow inside the 14000 box, with each vertex placed at ground + 12.
- **Tank attack**: chance (a+1)/512 per frame. The tank stops, turns the turret at 1.5 deg/frame toward (0,860,0), then moves the barrel 0.5 deg/frame until cos >= 0.9996, or until the unsigned counter shows it reversed. That quirk means it can only pitch down about 1 deg. The shell is fired 60 frames later from barrel + fwd x 241 at 500 u/f, with `CannonFar` and an ExplodeF muzzle flash at scale 2.
- **APC unload**: after a timer of 400..527 frames, or within 2800 of the bunker, the APC stops and opens the ramp (+2 deg/frame to 120). It then spawns 6 soldiers through `world.soldiers.spawn(..., { stagger: offset - 130 })`. APC1 stays parked (state 0, no engine sound). APC2/3 close the ramp and drive on.
- **APC2**: gun attack with the tank aggression chance. It fires a 4-round burst (frames 20/18/16/14) of `'bullet'` from gun + fwd x 201 at 500 u/f. The original plays no sound and shows no muzzle flash for this.
- **APC3**: rockets only. The original excludes APC3 from the gun attack (`local_6c < 0x51`). Chance is 4/512 while ammo > 0; it aims at (0,840,0) and fires one `'apcRocket'` per attack (life 130, 280 u/f), 2 in total. The loaded rockets are MISSILE instances 472..479, posed on the launcher at (∓48, 0, 65) until fired. The radar spins 4..11 deg/frame.
- **Damage** (`Target.hit`): bullets only spawn ExplodeF at scale 1.
  - Tank hit by a shell or missile: ExplodeF at scale 4 and `ExFar`. If the tank was live: meter -10, barrel at -20, decelerate, and the turret is thrown (vy 40, xz ±16.4, spin ±2.05, gravity 3, drag 0.98, gone below y 0). The wreck stays active and still stops shots.
  - APC: burn event (600), meter -6 if troops are still aboard, plus -5 for APC2/3. All parts are hidden. ExplodeA at scale 4 when away from the bunker (|x| or |z| > 400), the hull shatters into spinning debris (±16 deg/frame, xz ±20, vy 20..85), and `ExFar` plays.
- **Soldiers**: every state of the original switch is implemented, including walk, strafe or run circles, stand or kneel fire, grenades, the near-bunker loops, burning (run, flail, collapse, fire shrink), shot deaths by prior state, thrown deaths with roll spin, and corpse removal when pitch > 20.
  - Rifle: shot at counter 15, ExplodeF at scale 0.3, `Rifle`. Hits on rand > 24000 (26.8 %) call `world.damagePlayer(1)`.
  - Grenades: `'grenade'` toward (±256, 1024..2047, ±256), at 40 u/f, or 20..35 u/f in the bunker loop.
  - Billboards use g3d nodes 358..453, so game.ts interpolates them. The original quad is hidden and replaced by our own quad sampling an atlas of both Film sheets (306 frames, 128x128, bottom 16 rows dropped). Black is the colour key after RGB565 conversion. Tint is 0xd7d7d7 by day and 0x282828 by night. Yaw is the player yaw.
  - Burn fire: 12-slot ring, Fire64x2432 frames, base quad 280x360 at scale 0.25 x 0.5, additive.
- **Public extras**:
  - `SoldierPool.burnWithin(world, p, radius = 600)` is the burn event, for CH53 and aircraft fire events.
  - `GroundSystem.engineLoops()` returns `{ name: 'Tank' | 'Truck', volumeDb }[]` for the loops that should play this frame (d = max(|x|,|z|) of the nearest unit with state != 0, d < 6501, volume -d).

## Interface notes for other modules

- `spawn(world, p, yaw, opts)`: `yaw` gives the walking direction (-sin, -cos).
  - `stagger`: exit from a vehicle. State 9: the counter rises 6/frame to 6, then the soldier drops 2.4/frame. A CH53 caller gets 2.4 too, the original uses 2.6 there.
  - `paratrooper`: above ground, the soldier descends at 10/frame (frame 0xe6) until it touches down, then plays the landing frames 0xe6..0xef. The parachute itself is not ours. If a chute is shot, the C130 module has no way to remove the soldier yet.
- `killWithin(..., blown = false)` is treated as a plain shot death (state 0x3c, no blood).

## Deviations

- **Instance chains**: `g3dscene.ts` resolves `Instance` one level only, but Geometry.3D chains them. Without a fix, Tank3..12, APC3..12, their turrets and parts, and MISSILE 472..479 have no meshes. `ground.ts` (`fillInstance`) shares the chain root's meshes for its own ids, and does nothing when a node already has meshes. The real fix belongs in `g3dscene.ts` and also affects other object runs (jets, cobras, parachutes, and so on).
- **Projectile timing**: enemy projectiles spawn during `GroundSystem.update`, before the projectile step, so they move in the same frame. The original spawns them after projectile motion.
- **Soldier allocator**: the original never wraps (soldier 97+ would overwrite crate objects). Here, once all 96 are used, a free slot is reused.
- **Height lookups**: soldiers and shadows use the bilinear `groundY`. The original uses the nearest heightmap cell for these.
- **Debris**: chunks are 40 triangles of the hull mesh. The original splits the display list every 20 commands.
- **Shadows**: shadow vertices are recomputed per tick, not interpolated.

## Open

- Night lighting of vehicles and soldiers by flares and the spotlight (light masks) is not done.
- In-flight APC3 rockets are drawn by Effects from the projectile list, if it does that. Nodes 472..479 are used here only for the loaded pods. If Effects also drives those nodes, the two need to agree.
- The engine loops are exposed, not played. The sound module should read `engineLoops()`.
