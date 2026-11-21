# Remaster visual mode

`src/render/remaster.ts` adds a runtime switch between two visual modes over the same scene, assets and simulation.

- **faithful** (default): the scene as built, drawn with `renderer.render`. Gamma-space half-Lambert lighting, Geometry.3D terrain (objects 10..18), original blob shadows.
- **remaster**: linear-space lighting, the heightmap terrain with procedural detail, cascaded sun shadows, distance haze, selective bloom, tone mapping, AA and vignette through a `THREE.RenderPipeline`.

## How it works

- **Material twins.** Faithful materials are never modified. Each one gets a remaster twin (built lazily, cached) that is swapped onto meshes. Switching modes back and forth costs no shader recompiles after the first switch. Meshes created later (debris, projectile models, lazily cloned nodes) are swapped on the next remaster frame (`traverseVisible`).
- **Colour.** `main.ts` disables `ColorManagement`, which turns every built-in colour-space node into a no-op. The remaster therefore converts explicitly: each twin's `colorNode` decodes `texture x vertex colour` from sRGB (the product the artists saw), and the pipeline ends with tone mapping and sRGB encode (`outputColorTransform = false`). Darken-blended smoke (mode 2) uses `1 - (1 - src)^2.2`, so it darkens the same as in gamma space. Nothing global is touched, so faithful stays bit-identical.
- **Lights.** Faithful uses `main.ts`'s `sun` and `ambient` (same values as before). Remaster hides them and uses its own directional sun (Geometry.3D light 0, direction (-1,2,1)) plus a hemisphere sky light. At night the sun becomes faint blue moonlight; flares and the searchlight (`night-lights.ts`) work in both modes.
- **Terrain.** Shows `terrain.group` (20-unit grid, 10x finer than Geometry.3D) with its own material. The close aerial photo is resampled at two small world scales (2.4 and 0.7 units per texel, the second rotated) as a luminance ratio around 1, which adds colour detail and perturbs the normal through world-space finite differences. Both fade out with distance (7000 and 2200 units). Textures are mipmapped with 16x anisotropy. Heights are 8-unit steps, so `terrain.ts` computes normals from a 5x5 blurred height grid to remove contour stripes on far slopes (render only; `heightAt` and vertex positions do not change). Chunks are built on first use or in the background and carry five LODs (vertex strides 1, 2, 4, 10, 20) with skirts; `terrainLod` picks them by distance (see `performance.md`).
- **Shadows.** `CSMShadowNode`: 3 cascades out to 14000 units, 2048 maps, PCF (r187 removed `PCFSoftShadowMap`), light margin 9000 so aircraft above the frustum still cast. Opaque and colour-keyed models cast (the shadow pass uses the key's alpha), including vehicles, aircraft, sandbags, soldiers, foliage and the player's gun. The original projected blob shadows (`* Shadow` objects 250..293) are hidden while shadows are on. `shadowCascades: 1` uses one fixed 22000-unit map instead (the camera never moves).
- **Haze.** Post-process on the scene depth: radial distance from the eye, `1 - exp(-(d - 3000) / 16000)`, reduced when looking up, skipped where depth is 1 (the sky is drawn without depth). Colour = the band just above the painted sea in `SkyCylinder*.t24` (day) or `SkyCylinderN*.t24` (night, lifted), read from the game files at load.
- **Bloom.** The scene pass writes a second `emissive` target with per-attachment material blending. Screen-blended effects (explosions, tracers, flares, fire, muzzle flashes) write their own colour; darken/multiply effects apply the same factor to it; everything else writes 0. The crosshair is excluded. So the sky and white clouds never bloom. Bloom runs at `bloomResolution` (default half) of the CSS-pixel resolution, so it looks the same at any DPR or render scale.
- **Water.** The sea is painted at the bottom of the sky walls (v > 0.86 by day). Its twin adds animated sparkle and slow wave bands (`time` uniform), scaled by the sea's own brightness, so the night version follows the moon glint. The sea is a thin band on screen, so this is subtle.
- **AA.** SMAA by default; FXAA, 4x MSAA (with alpha-to-coverage on colour-keyed sprites) or none. The HUD is a separate 2D canvas and is unaffected.

## Settings (`vm.settings`, change with `vm.set({...})`)

| Setting | Default | Effect |
|---|---|---|
| `terrain` | `true` | Heightmap terrain with detail, else Geometry.3D tiles with remaster materials |
| `color` | `true` | Linear lighting + tone mapping + sRGB output; `false` = raw gamma values |
| `toneMapping` | `'neutral'` | `'neutral'` (keeps base colours below ~0.8 unchanged), `'agx'`, `'aces'` |
| `exposure` | `1` | Tone mapping exposure |
| `shadows` | `true` | Sun shadows (hides blob shadows) |
| `shadowMapSize` | `2048` | Per cascade |
| `shadowCascades` | `3` | `1` = one fixed map over the battlefield |
| `haze` | `0.4` | Maximum haze blend, 0 = off |
| `bloom` | `0.5` | Bloom strength, 0 = off (also drops the emissive target) |
| `aa` | `'smaa'` | `'smaa'`, `'fxaa'`, `'msaa'`, `'none'` |
| `vignette` | `0.18` | 0 = off |
| `water` | `true` | Sea glints on the sky walls |
| `renderScale` | `1` | Multiplier on the capped device pixel ratio (both modes; `quality.ts` drives it) |
| `maxPixelRatio` | `2` | Cap on `devicePixelRatio` (both modes) |
| `maxPixels` | `8294400` | Cap on drawing-buffer pixels (3840 x 2160), both modes |
| `terrainLod` | `4000` | A chunk at distance d uses vertex stride s when s x terrainLod <= d; 0 = full detail |
| `bloomResolution` | `0.5` | Bloom buffer size as a fraction of the CSS-pixel size |

`vm.stats` holds the average frame time and fps over the last 120 frames and the draw calls and triangles of the last frame.

## Wiring in `main.ts`

```ts
import { VisualMode } from './render/remaster'

// after scene, sun, ambient, world, game exist (replaces applyMode and the Shift+T handler):
const vm = await VisualMode.create({ renderer, scene, camera: game.camera, g3d, terrain, fs, sun, ambient })
game.onDayNight = (day) => vm.setDayNight(day) // replaces main's handler; it also drives the faithful lights
vm.setMode(params.get('mode') === 'remaster' ? 'remaster' : 'faithful')
addEventListener('keydown', (e) => {
  if (e.code === 'KeyT' && e.shiftKey) vm.toggle()
})

// in the animation loop, replace renderer.render(scene, game.camera) with:
vm.render()
```

Create it before `game.startLevel()` (or call `vm.setDayNight(world.daytime)` afterwards). The fly camera path can keep `renderer.render(scene, fly.camera)`.

## Measured performance

Chrome, WebGPU backend, this development Mac (Apple GPU), canvas 3024x1497 device pixels (DPR 1.6; 4.5 MP, 1.23x the pixels of 2560x1440). GPU time from `renderer.resolveTimestampsAsync('render')` averaged over 2 s; level 1, paused, default view.

| Configuration | GPU ms / frame | fps (vsync 120) |
|---|---|---|
| faithful | 0.18 (timestamp coverage of the direct canvas pass looks incomplete) | 120 |
| remaster, all on (SMAA) | 5.1 to 6.2 | 116 to 120 |
| remaster, bloom off | 2.6 to 2.9 | 116 to 120 |
| remaster, FXAA | 4.6 | 120 |
| remaster, MSAA 4x | 6.4 | 120 |
| remaster, no AA | 5.4 | 120 |
| remaster, shadows off | 5.9 (within noise of all on) | 120 |

Remaster draws about 100 to 250 calls and 1.05 to 1.18 M triangles (the heightmap terrain is ~1.1 M of them; faithful is ~20 k). Bloom (emissive target plus blur chain) is the most expensive feature at about 2 to 3 ms. Discrete laptop GPUs have not been measured.

## Screenshots

Matched pairs (same level, view and paused game state; the HUD canvas is included) in `artifacts/screens/`:

| Faithful | Remaster | Scene |
|---|---|---|
| `remaster-day-faithful.jpg` | `remaster-day-remaster.jpg` | Level 1, yaw 180, pitch -7, two APCs near the bunker |
| `remaster-night-faithful.jpg` | `remaster-night-remaster.jpg` | Level 11 (night, searchlight), a falling flare |
| `remaster-combat-faithful.jpg` | `remaster-combat-remaster.jpg` | Level 1, vehicle kill explosion, fire, black smoke, bullet hits, soldiers |

## Known limits

- Flares and the searchlight do not cast shadows.
- Day foliage stays unlit like the original (it is authored that way); colour-keyed sprites cast shadows but do not receive them.
- The sea glint is a thin band at the horizon and barely visible in still images.
- Haze uses opaque depth, so transparent effects take the haze of what is behind them.
