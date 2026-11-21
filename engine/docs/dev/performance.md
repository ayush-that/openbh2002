# Performance and quality

`src/render/quality.ts` picks a preset for the device, applies it, and adapts the render resolution to hold a frame rate. `src/render/remaster.ts` owns the pixel ratio in both visual modes. The simulation is not involved: `Game.frame` runs fixed 29 ms steps from real time, whatever the render rate.

## Presets

| Preset | Shadows | Bloom | AA | DPR cap | Terrain LOD distance | Anisotropy | Render scale range |
|---|---|---|---|---|---|---|---|
| low | off (original blob shadows) | off | FXAA | 1 | 1200 | 2 | 0.5 to 1 |
| medium | 1 fixed 2048 map | 0.5, at 1/4 CSS size | FXAA | 1.5 | 2500 | 4 | 0.6 to 1 |
| high | 3 cascades, 2048 | 0.5, at 1/2 CSS size | SMAA | 2 | 4000 | 8 | 0.7 to 1 |
| ultra | 4 cascades, 4096 | 0.5, at 1/2 CSS size | SMAA | 2 | 8000 | 16 | 0.75 to 1 |

All presets keep haze, vignette, sea glints and tone mapping (they are part of the final full-screen pass and cost little). Every preset caps the drawing buffer at 8.3 MP (`maxPixels`, 3840 x 2160), in faithful mode too. Particle counts are not a preset knob: the effect pools keep the original game's caps (8 to 120 per kind) and each kind is one instanced draw.

The faithful mode uses only the DPR cap, pixel cap, render scale and anisotropy.

## Automatic defaults (`recommend`)

| Device | Mode | Preset |
|---|---|---|
| Software renderer (SwiftShader, llvmpipe) | faithful | low |
| Mobile: `userAgentData.mobile`, else coarse-only pointer or a mobile user agent, or a Mali/Adreno/PowerVR GPU | faithful | low |
| Desktop, 4 or fewer cores, 4 GB or less `deviceMemory`, or an integrated Intel/AMD GPU | faithful | medium |
| Other desktops | faithful | high |
| WebGL2 backend | one tier lower | |

Faithful stays the default mode everywhere; the preset applies when the player switches to remaster. Ultra is never picked automatically. The GPU string comes from `GPUDevice.adapterInfo` (WebGPU) or `WEBGL_debug_renderer_info` (WebGL2).

## Adaptive resolution

Every 500 ms window the controller looks at:

- **Late frames**: rendered intervals longer than 1.5 frame budgets. This is the main signal.
- **GPU time**: on WebGPU, the time from the end of `vm.render()` to `queue.onSubmittedWorkDone()`. Per-pass timestamp queries are not used on WebGPU: Apple GPUs overlap passes, so the bloom blur passes each report about 2.8 ms and the sum reads 48 ms for a frame that holds 100+ fps. On WebGL2, `EXT_disjoint_timer_query_webgl2` is read every 10 frames, but on ANGLE/Metal it reports 20 ms for frames that hold 120 fps, so it is only used to size steps.
- **CPU time** of the frame (game logic plus command encoding).

Rules:

- Cut when more than 10% of frames are late for two windows (or more than 30% in one), or when WebGPU queue time or CPU time exceeds 1.3 budgets. The cut is `sqrt(0.75 budget / load)`, clamped to 0.75..0.95, because cost scales with pixels.
- Raise directly only when GPU time is under 60% of the budget for three windows. Otherwise probe one 0.05 step up after a quiet period (5 s, doubled up to 60 s each time a probe is followed by a cut). GPUs clock down when lightly loaded, which inflates measured times, so "under 60%" is rarely seen at 60 fps and probing does most of the raising.
- Scale moves in 0.05 steps, at most one change per 750 ms, and windows with a gap over 250 ms (hidden tab, debugger) are ignored.
- **Target frame rate**: 60. On desktops with a display of 100 Hz or more, once the scale is at the preset maximum, it tries 120; if that cannot hold (late frames, or scale would drop to 0.9), it returns to 60 at the earlier scale and backs off before trying again. `q.set({ targetFps: n })` fixes the target.
- **Frame pacing**: when the display is faster than the target (60 fps on 120 Hz), `beginFrame` skips animation frames so frames are evenly spaced, which also saves power on phones.

## Measurements

Chrome, Apple M4 Pro, level 1, paused, default view. Resolutions are emulated: `devicePixelRatio` overridden to 2 and the renderer sized to 960x540, 1280x720 and 1920x1080 CSS pixels, giving 1920x1080, 2560x1440 and 3840x2160 drawing buffers before preset caps. Adaptive scaling off, scale 1. The display is 120 Hz and every configuration held 117 to 122 fps, so the GPU numbers are the useful comparison. WebGPU: median submit-to-completion time. WebGL2: disjoint timer (inflated on ANGLE/Metal; shown for relative cost only). Triangles and draw calls from `vm.stats`.

| Output | Mode / preset | Drawing buffer | WebGPU GPU ms | WebGL2 timer ms | Triangles | Calls (WebGPU) |
|---|---|---|---|---|---|---|
| 1080p | faithful | 1920x1080 | 1.0 | 1.1 | 19 k | 44 |
| 1080p | low | 960x540 | 2.3 | 2.2 | 167 k | 67 |
| 1080p | medium | 1440x810 | 3.8 | 8.8 | 338 k | 87 |
| 1080p | high | 1920x1080 | 5.1 | 10.9 | 595 k | 90 |
| 1080p | ultra | 1920x1080 | 5.2 | 9.6 | 1085 k | 90 |
| 1440p | faithful | 2560x1440 | 1.1 | 0.3 | 19 k | 44 |
| 1440p | low | 1280x720 | 2.7 | 3.2 | 167 k | 67 |
| 1440p | medium | 1920x1080 | 4.8 | 10.1 | 338 k | 87 |
| 1440p | high | 2560x1440 | 5.0 | 11.1 | 595 k | 90 |
| 1440p | ultra | 2560x1440 | 5.3 | 11.2 | 1085 k | 90 |
| 4K | faithful | 3840x2160 | 1.4 | 0.3 | 19 k | 44 |
| 4K | low | 1920x1080 | 4.1 | 6.1 | 167 k | 67 |
| 4K | medium | 2880x1620 | 5.1 | 10.4 | 338 k | 87 |
| 4K | high | 3840x2160 | 5.9 | 20.5 | 595 k | 90 |
| 4K | ultra | 3840x2160 | 5.7 | 24.2 | 1085 k | 90 |

Adaptive runs (WebGL2, 4K emulated, high): at a 60 fps target the scale settled at 0.9 (3456x1944) and stayed there for 8 s; with the target forced to 120 it went to 0.7 and held 120 fps; started at 1x on the 1890x1006 window it tried 120, cut to 0.8, then returned to 60 at scale 1 and stayed there.

Mobile-like budget (WebGPU, `devicePixelRatio` forced to 2, low preset, scale 0.6, remaster): drawing buffer 1134x561, HUD canvas 3780x1872 (CSS size x DPR, unaffected by render scale). The simulation ran 34.50 steps/s (expected 1000/29 = 34.48) both at 60 rendered fps and with the target set to 30 (32 rendered fps).

## 4K correctness

- **Bloom** runs at `bloomResolution / pixelRatio` of the drawing buffer (a fixed fraction of the CSS size), updated every frame, so the glow has the same screen size at any DPR or render scale, and changing the scale does not rebuild the pipeline.
- **SMAA / FXAA** size themselves from the drawing buffer every frame.
- **Shadows** do not depend on screen resolution (map size per preset).
- **HUD** is a separate 2D canvas sized from its CSS box and `devicePixelRatio`; render scale changes only the WebGPU canvas's drawing buffer, never its CSS size, so the HUD stays sharp.
- Sprites and billboards are 3D geometry and scale with the buffer like everything else.

## Startup (time to first frame)

Warm dev-server reloads of `?level=1` (first contentful paint = first rendered frame), same machine.

| | Before | After |
|---|---|---|
| First frame | 1152 ms | 540, 544 ms |
| Parse Geometry.3D (4.4 MB text, `formats/`, unchanged) | 242 to 265 ms | 272 ms |
| `G3DScene.load` (textures + meshes) | 361 ms | 80 to 147 ms |
| Heightmap terrain build | 159 ms at startup | deferred: background slices of 4 ms from 2 s after start on desktop, on first remaster use on mobile |
| Terrain tile textures (decode + stitch) | twice (terrain and remaster) | once |
| Remaster switch, terrain not yet built | | 565 ms (build plus shader compiles) |

Changes:

- `g3dscene.ts`: texture variants (plain, colour-keyed, sphere map) are built on first use (63 textures instead of 195), and the decoded files are dropped after the build. The per-polygon grouping no longer copies arrays (it was quadratic) and the geometry builder no longer allocates per vertex.
- `terrain.ts`: chunks are built on demand or in the background, and normals use a per-chunk blurred height window (the old whole-map normal smoothing pass in `remaster.ts` is gone). The tile textures are loaded once and shared with the remaster.
- `remaster.ts`: `warmup()` compiles the pipelines of every mesh in the scene, hidden ones included, for the current mode, using `renderer.compileAsync` on proxy meshes (the scene is not touched, so the game keeps running). It runs automatically on the first frame in each mode. On WebGL2 (which compiles synchronously) it removes the first-appearance stalls: faithful 108 and 70 ms frames in the first 20 s of level 1 before, max 20 ms after (warmup took 127 ms in the background, max frame 18 ms meanwhile); remaster 174, 101 and 64 ms before, max 18 ms after. WebGPU showed no such stalls in either mode.

## Memory

| | Before | After |
|---|---|---|
| Geometry.3D textures (CPU copy, same on the GPU plus mips) | 42.8 MB (3 variants per slot) | 14.2 MB |
| Terrain tile textures | 2 x 6.6 MB | 6.6 MB |
| Heightmap terrain vertices + indices | 73 + 54 MB (Uint32 indices), always built | 76 + 40 MB (5 LODs and skirts, Uint16 indices), never built in faithful-only sessions on mobile |

## WebGL2 fallback

`?webgl` (via `rendererParameters()`) forces the WebGL2 backend. Faithful and remaster both render and play on it with every remaster feature (CSM shadows with 1 to 4 cascades, bloom, SMAA, FXAA, 4x MSAA, haze), no console errors. Nothing is disabled. Differences: shaders compile synchronously (hence `warmup`), and timer queries need `EXT_disjoint_timer_query_webgl2` and read high on ANGLE/Metal. Tested by loading the page with `navigator.gpu` hidden, which takes the same fallback path as `forceWebGL`.

## Known limits

- The terrain's CPU-side vertex arrays (~116 MB) stay in memory after upload; WebGPURenderer has no upload callback to release them safely.
- The remaster detail texture is a `clone()` of the close aerial photo with repeat wrapping; on WebGPU that is a second GPU copy (4 MB plus mips).
- No physical 4K display, discrete GPU or phone was measured; 4K and mobile numbers above are emulated on one Apple laptop GPU.
- Measurements were taken on the Vite dev server (unbundled modules); production builds load faster.
