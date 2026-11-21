# Effects, projectile visuals, night lights and sound

Modules: `src/game/effects.ts`, `src/game/night-lights.ts`, `src/game/sound.ts`, wired by `src/game/install-fx.ts`.

## Wiring

```ts
import { installFx } from './game/install-fx'
// after `game` exists and before game.startLevel(...):
const fx = await installFx(world, game, scene, fs)
// in the animation loop, after game.frame(now) and before renderer.render(...):
fx.render(game.alpha)
```

`installFx` sets `world.effects` and `world.sound`, adds the effect meshes and lights to the scene, and resumes the
`AudioContext` on the first `pointerdown`/`keydown` (browser autoplay policy). Until then `play()` is a no-op.

## Effects (`EffectSystem implements Effects`)

All state advances once per game frame in `update(world)`. `render(alpha)` only interpolates (`prev` to `pos`) and
rebuilds instance buffers. Each billboard template is one `InstancedMesh` (one draw call). The animated `.t24` sheets
are uploaded as one texture each (vertical strip of square frames, no mipmaps like the original); a per-instance
attribute selects the frame, the brightness and a U mirror. Blend factors are the D3D7 ones from `g3dscene.ts`.

Pools keep the original slot counts and round-robin overwrite (notes 20 §11):

| kind | pool | frames | quad | mode |
|---|---|---|---|---|
| `explodeV` | 8 | 12, once | x ±400, y 0..800 | 3 multiply |
| `explodeF` hit flash | 8 | 16, once | ±100 x scale | 5 screen |
| `explodeF` muzzle flash | 8 | first 5, once | ±100 x scale | 5 |
| `explodeA` | 8 | 32, once | ±200 x scale | 5 |
| `fire` | 12 | 38, loop, random start 0..31, yaw-only billboard | x ±140, y 0..360, default xz 0.25 / y 0.5 | 5 |
| `dirt` (bullet dust) | 8 | 10, once, at ground height, brightness 0.5 day / 0.25 night | x ±40, y 0..100 | 5 |
| `dirt` (blast debris) | 36 | static, vel drag 0.75/0.85, y += 3, fade 0.02, 51 frames | ±200 | 2 darken |
| `blood` | 4 | 10, once | ±100 | 5 |
| `smokeWhite` | 120 | scale 0.2 +0.015, y -2, fade 0.016 day / 0.004 night, 60 frames | ±100 | 5 |
| `smokeBlack` | 120 | scale 0.4 +0.015, fade 0.016, 60 frames | ±200 | 2 |

- Once-only animations never show their last frame: the original switches the record off in the same update that
  would display it. Reproduced.
- Consecutive slots of ExplodeV and Fire use mirrored UVs, as in the Geometry.3D templates.
- `opts.velocity` moves any particle; `opts.frames` is the lifetime of `fire` (default 150) and selects the muzzle
  pool for `explodeF` when `<= 5`. Without `frames`, `explodeF` sizes below 1 are muzzle flashes (player guns 0.15,
  0.25, 0.6). **Tank muzzle flashes (2.0) must pass `frames: 5`.**
- `spawn` returns an `EffectHandle` (typed `void` through the `Effects` interface). Moving `handle.pos` makes the effect
  follow something, e.g. a burning soldier; `handle.active = false` removes it.

Projectile visuals, drawn each render from `world.projectiles.list`:

- bullets: Tracer32x32, ±15 x 1.5, screen; shells: same texture x 2; flares: Flare128x128 ±15, x 15 once falling;
  grenades: Grenade64x64 (colour key, UV 31/63 x 57/63, night tint 0x40).
- missiles and APC3 rockets use the MISSILE model (470), cobra rockets ROCKETS (480), bombs BOMBS (496): clones in
  the effects group, nose (-Z) along velocity.
- rocket/APC rocket flames: ExplodeF frames 0..4 looping from frame 2, placed 200 ahead of the pre-move position
  (80 behind the rocket).
- player missiles: white smoke trail, one puff per frame at the pre-move position.

Ejected casings use the Geometry.3D nodes 29..34 (alt guns, drag 0.97) and 36 (handgun, drag 0.99) directly, so the
game's node interpolation applies. Start position, eject velocity (6 u/f, random up) and spin follow the decomp; they
are removed below y 720. The twin gun ejects none.

## Night lights (`NightLights`)

- Point lights 2..5 follow flares once they become the falling light (age > 20): range 5000, intensity 600/255 x pi.
- Spotlight 1 at the eye along the view, cone acos(0.98), penumbra 1, intensity 200/255 x pi, no range. On at night
  when the level says `Spotlight` and shield >= 26.
- Lights exist permanently and switch by intensity, so the light count (and every lit shader) never changes.

## Sound (`SoundSystem implements Sound`)

- Loads the 29 WAVs `FUN_0042ac3c` uses (Ricocht4 and HeliAttack are never loaded), decoded with `decodeAudioData`.
  `failed` lists any that did not decode; `starts` counts buffer starts per name (for debugging).
- Voices per name as in the original (AntiAir 10, MachineGun 10, ExMuffle 6, Rifle/ExClose/ExFar 4, Ricocht3/Pistol/
  Missile/CannonClose/CannonFar/ExHit 2, the rest 1), cycled round robin. A busy voice is not restarted (DirectSound
  `Play` on a playing buffer does nothing) but its volume is updated.
- Volume: DirectSound hundredths of dB, gain = 10^(db/2000), clamped to -10000..0.
- `enabled` gates `play` and `update`; `stopAll()` stops every voice and loop.
- Engine loops (`update`, once per frame): every `EngineProvider` in `engineSources` returns `{ name, volumeDb }`
  candidates; the loudest per name plays looping, names with no candidate stop. The default provider
  `targetEngines` maps live `world.targets` by shape (tank Tank, apc Truck, jet Jet, bomber Bomber, cobra Cobra,
  ch53 CH53, c130 C130) using `engineSource(name, x, z)`, which implements `FUN_00424aef`:
  d = max(|x|, |z|); Tank/Truck d < 6501 -> -d; Jet/C130 d < 30001 -> -d/8; Bomber/Cobra/CH53 d < 18001 -> -d/4.
  Enemy modules whose units are not registered targets, or that need the original `state != 0` test for tanks, can
  add their own: `(world.sound as SoundSystem).engineSources.push((w) => [engineSource('Tank', x, z)].filter(Boolean))`.

## Deviations

- Flare light falloff: Three.js applies `(1 - (d/r)^4)^2` within the range instead of the original linear `1 - d/r`
  (brighter at mid range, same 5000 cutoff). Spot cone uses smoothstep instead of the linear ramp.
- No per-object light masks: Three.js lights affect every lit material. The range cutoff covers most of the effect of
  the original 5100..6300 masks; terrain-quadrant masking is not reproduced.
- Light sum is not clamped to 1 per vertex before the material colour (the framebuffer clamps instead).
- Blast debris and bullet dust both arrive as `spawn('dirt', p)`. A `dirt` spawned in the same frame at exactly the
  position of the last `explodeV` is treated as blast debris (projectiles.ts passes the same vector). A dedicated
  kind would be cleaner.
- Player missiles get no flame: the decomp only loops flames for cobra and APC3 rockets.
- The original's smoke age counter resets the next slot instead of the spawned one (off-by-one); not reproduced.
- Visual randomness (fire start frame, debris, casings) uses `world.rand()` as the architecture requires, but the call
  order differs from BH2.exe.

## Open issues

- `g3dscene.ts` mode 2 (darken) materials have the same alpha problem fixed here: with the colour factors reused for
  alpha, `dst x (1 - srcAlpha)` writes framebuffer alpha 0 and the canvas shows the page background (black). Set
  `blendSrcAlpha = ZeroFactor`, `blendDstAlpha = OneFactor` there too.
- Effects that follow units (fire on soldiers) must set `handle.pos` before `world.effects.update` (enemy updates run
  first, so this holds) for smooth interpolation.
- Engine loops keep playing while paused (the original's behaviour while paused is not known).
- Only checked on the WebGPU backend; the WebGL2 fallback is untested.
