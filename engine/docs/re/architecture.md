# Beach Head 2002: engine architecture (reverse engineered)

Source: Ghidra 12.2 headless analysis of the user's own copies of `BH2002.exe`, `bh2.ews` and `BH2Game/BH2.exe`.
Raw exports (decompiled C for every function, function index, strings, imports, data constants, disassembly) are in `artifacts/re/` (gitignored); see `artifacts/re/INDEX.txt`. Per-subsystem working notes with more detail: `artifacts/re/notes/*.md`.

Addresses are virtual addresses in the named executable. Confidence: **[H]** high (read in code, cross-checked), **[M]** medium (inferred from code, one path), **[L]** low (guess).
Gameplay numbers (weapons, enemies, damage) are in [gameplay.md](gameplay.md).

## 1. Process model

| Program | Role | Tech |
|---|---|---|
| `BH2002.exe` (launcher, 60 fns) | Black fullscreen popup, Pentium check (RDTSC), disables the screensaver, then runs the menu and the game alternately. | Win32 only [H] |
| `bh2.ews` (front end, 644 fns) | Intro, title, menus, options, save/load, weapons chart (rotating `vehicles/*.3DB`), score chart. Built on the "Exelib 0.8.0" engine. | DirectDraw7 + Direct3D7, DirectInput, own DirectSound XM tracker player [H] |
| `BH2Game/BH2.exe` (game, 235 fns) | The 3D game. Plays levels back to back by itself. | DirectDraw7 + Direct3D7 HAL as a rasterizer, software T&L, DirectSound, Win32 mouse [H] |

Launcher state machine (`FUN_00401000`, state `DAT_00405594`) [H]:
1. `CreateProcessA("BH2.EWS", "intro")` on the first launch only; later launches pass no command line. Working directory is inherited.
2. Busy-poll `GetExitCodeProcess` with `Sleep(0)`. Menu exit code 0 ends everything. Any other code runs `./bh2game/bh2.exe` with working directory `./bh2game/`.
3. When the game exits (any code), relaunch `BH2.EWS` without `intro`.

### Menu to game handoff: `BH2Game/BeachheadIn` [H]
Written by `bh2.ews` `FUN_00409390` as `"%d\n"` x6, read by BH2.exe `FUN_00429058` with `fscanf("%d%d%d%d%d%d")`.

| # | Meaning | Source in menu | BH2.exe global |
|---|---|---|---|
| 1 | level number | current level `DAT_0042aa88` | `DAT_0043b040` |
| 2 | screen width 640 / 800 / 1024 (height 480 / 600 / 768) | ini `Resolution` 0/1/2 | `DAT_00462254` |
| 3 | mouse tight flag (0 = loose, 1 = tight) | ini key **`MouseInvert`** (names are swapped in the ini) | `DAT_0044a9d0` |
| 4 | mouse reverse flag (0 = normal, 1 = reverse) | ini key **`MouseMode`** | `DAT_0044aba8` |
| 5 | sound effects on | ini `Fx` | `DAT_0043b07c` |
| 6 | colour depth 16 (RGB565) or 15 (RGB555) | primary-surface pixel mask probe | `DAT_004621e4` (picks the 24-to-16-bit texture converter) |

Shipped sample `1 800 1 0 1 16` matches the shipped `BH2002.ini`.

### Game to menu: `BH2Game/BeachheadOut` [H]
BH2.exe `FUN_004291b5` writes `"%d\n%d\n"` = status `DAT_00462230`, level. The menu reads it on every start (`FUN_00409420`).
- `0` = died (shield reached 0, then a 150-frame countdown). The menu checks for a high score.
- `1` = ESC quit.
- `3` = running (internal; the main loop runs while status == 3).
- Clearing a level is not a status. BH2.exe increments the level and reloads in-process (`FUN_004021c4`). The menu only regains control on death or ESC. "Continue" replays the level you died or quit on; "New Game" resets to 1.

Score = level reached at death. The default table (50, 30, 25 ... 5) is levels. A high score is entered only on death, when the level beats entry 10 (ties rank lower) [H].

Other front-end facts [H]: the menu forces `ResX=640`, `ResY=480` in the ini and always runs at 640x480x16. `Music` only affects menu XM music (`preludio.xm`, `MENU.XM`); `Texturas` is dead. Saves: `Save/00000001.sav`..`00000020.sav`, 54 bytes ASCII: name[30], level[10], width[10], two mouse flags[2+2] (mouse flags are overwritten before launch). No video playback (DirectShow path exists but no AVI/MPG ships; `AVIFIL32.dll` is a stray string, not an import). `lang.dat`/`os.dat` are InstallShield files: language is chosen at install time.

## 2. BH2.exe main loop and timing

`FUN_0040101d` (WinMain) [H]:
- Window class `"Beachhead2"`, title `"3D Viewer"`, popup 1024x768, then `SetCooperativeLevel(FULLSCREEN|EXCLUSIVE|...)` and `SetDisplayMode(width, height, 16)`.
- Init order: `FUN_00429058` read BeachheadIn, `FUN_0042a62d` DDraw/D3D init, camera reset, `srand(cursor x+y)`, `FUN_00428dc3` load `ShapeData` (collision meshes), `FUN_00425391` load HMap, MMap, `Geometry.3D` and all textures, `FUN_00429201` parse `Level_NN` and reset state, `FUN_004046eb` clear particles, `FUN_0042ac3c` load WAVs. Cursor placed at screen centre.
- Per frame:
  1. Read one message with `PeekMessage(PM_REMOVE)`. For WM_KEYDOWN it calls `TranslateMessage` then `GetMessage`, so the key switch sees the **WM_CHAR character** (lower-case letters).
  2. Unless paused: mouse aim, weapon fire requests (see gameplay.md).
  3. **Frame cap**: if `DAT_0043b074 == 1` (initialised to 1, never changed) busy-wait until `GetTickCount() - last > 28` ms. So frames are at least 29 ms apart: **max ~34.5 fps** [H].
  4. `Clear(ZBUFFER only)`, camera (`FUN_00403ca9`, `FUN_00403d26`), `FUN_004051c8` (enemy AI and spawns), `FUN_004154b7` (projectiles, damage, effects, transforms, 3D render), `FUN_004021c4` (HUD quads, win/lose), `FUN_00402a1c` (HUD text via GDI `TextOutA`), `BltFast` render target to primary.
  5. `FUN_00424aef` engine-loop sounds (if sound on); frame counters `DAT_0044789c..ac` cycle mod 2..6; global wobble angles `DAT_00447830/34/38/3c` += 4.1/6.0/9.5/12.2 deg (helicopter hover); `FUN_004050f1` spawn-delay countdown.
- **There is no delta time anywhere.** Every speed, rate, counter and animation is per frame. On a modern PC the cap holds the game at ~34.5 fps (29 ms per frame because the test is `> 28`). A faithful port should run a fixed 29 ms (34.48 Hz) simulation step and interpolate rendering.
- **Level `Delay N`** = N frames from level start (≈ N x 29 ms; `Delay 100` ≈ 2.9 s, `Delay 5500` ≈ 160 s). `FUN_004050f1` decrements each inactive enemy's own counter every unpaused frame and activates it when the counter hits exactly 0. Counters are independent (not chained after the previous `ObjectInc`). Objects listed without `Delay` are active at level start [H].
- Pause (`p`) sets bit 2 of the weapon variable; while paused the whole simulation block (including spawn countdowns) is skipped but the message loop runs [H].

Keyboard (WM_CHAR codes, `FUN_0040101d`) [H]: `Esc` quit (status 1); `Space` cycle weapon; `g` handgun; `m` fire missile; `f` flare; `b` call bombers; `a` toggle mouse tight/loose; `i` or `r` invert mouse Y; `p` pause; `s` sound on/off (stops all engine loops); `1` infinite-ammo cheat; `2` god-mode cheat; `=` sets the enemy meter to 0 (instant level clear, debug).
Mouse: left button (WM_LBUTTONDOWN/UP) is fire. No DirectInput in the game.

## 3. Renderer

### 3.1 API usage [H]
- `FUN_0042a62d`: `DirectDrawCreateEx(IID_IDirectDraw7)`, QI `IID_IDirect3D7`, `CreateDevice(IID_IDirect3DHALDevice)`; HAL only, no software fallback. Always fullscreen, 16 bpp, width/height from BeachheadIn.
- Surfaces: primary; off-screen render target (`OFFSCREENPLAIN|3DDEVICE`); 16-bit z-buffer in video memory. No flip chain: each frame is `BltFast` copied to the primary.
- Render states at init: `ZENABLE=1`, `CLIPPING=0`, `LIGHTING=0`. **No D3D fog, no D3D lighting, no SetTransform.**
- Everything else (transform, lighting, clipping, projection) is a hand-written x86 asm display-list interpreter (`FUN_0042d3bd` -> `FUN_0042fc81` -> `FUN_0042d5e8`, opcode table at `0x43e670`). It submits pre-transformed `XYZRHW` triangle lists via `DrawPrimitive`. So the game is "software T&L + hardware rasterization". The `Textured`/`SetTexture`/`RenderState` strings are `Geometry.3D` keywords, not D3D calls.
- Only the z-buffer is cleared. The sky box (drawn first with Z off) covers the colour buffer.

### 3.2 Coordinate system and camera [H]
- Right-handed, Y up, same as Three.js. Camera looks down -Z at yaw 0.
- Camera fixed at **(0, 820, 0)** (`FUN_00403ca9`). The gun mount pivots at (0, 800, 0). Ground under the bunker is 608.
- View: `rotation.order = 'YXZ'`, `rotation.y = yaw`, `rotation.x = pitch` (degrees to radians). Yaw `DAT_00447828` starts at 180 (looking +Z = towards "South"). Pitch `DAT_00447824` clamped [-25, +80] deg, positive = up.
- Screen shake: on a heavy hit, `DAT_00447840 = 2.0` deg is added to yaw, then multiplied by -0.85 each frame until |v| < 0.1 (~19 frames).
- Projection: focal length = screen width in pixels (`DAT_00477df4`, written once; no zoom). **HFOV 53.13 deg, VFOV 41.11 deg** at every resolution (Three.js `fov = 41.11`, aspect 4/3). Near 10, far 32700.
- Depth stored as z/64000 (linear). Backface culling: counter-clockwise on screen is front (Three.js default).
- Draw distance: an object is skipped if any corner of its bounding box is beyond 32700, or if all corners are outside one screen edge.

### 3.3 World scale [H]
- `HMap1501x1501.hmap` and `MMap1501x1501.mmap`: raw 8-bit, 1501x1501, row = z, column = x.
- Index: `col = floor((x + 15000) * 0.05)`, `row = floor((z + 15000) * 0.05)`. **Cell = 20 units, map covers x,z in [-15000, +15000], centred on the player.**
- **Height = byte x 8** (bytes 8..238 -> 64..1904 units). Bilinear between the 4 neighbouring samples.
- Scale guess: a tank is ~450 units long, so 1 unit ≈ 1.5-2 cm [L].
- The heightmap is **game logic only** (vehicle ground-following, projectile ground impact, shadows). Terrain is drawn from static meshes in `Geometry.3D`.
- MMap is a placement mask only: byte < 0x20 = valid ground for vehicle spawns, helicopter landing zones and C130 drops. It does not select textures [M].

### 3.4 Static scene from Geometry.3D [H]
Instance table `0x44abe0` (stride 0x84, 650 entries). Instance numbers come from `Object n` lines in `Geometry.3D`.
- Lights: instance 0 `LightDistant` (sun), 1 `LightSpot` (follows the view), 2..7 `LightPoint` (flare lights).
- Sky: instances 8 SkyDay / 9 SkyNight. Octagonal box translated (0,-1000,0), ceiling at y=7000, walls -1000..7000, radius ~30000. Drawn first, Z off, unlit. Day ceiling = `Sky1..9` 3x3 tiles, walls `SkyCylinder1..3`. Night ceiling = `SkyN1..3` + `Stars`, walls `SkyCylinderN1/N2`. The camera never moves, so the sky is static.
- Terrain: instances 10..18 "Terrain1..9", each a 10000x10000 tile with a 200-unit vertex grid, lit (`TexturedL`). The 8 outer tiles use one `TerrainFarN` each (Far5 is absent, the centre slot). The centre tile (-5000..5000) uses `TerrainClose01..16` on 16 sub-squares of 2500x2500. No LOD switching found [M].
- Trees and ground cover: static colour-keyed quads in instances 533 FoliageDay / 534 FoliageNight (`Trees256x256`, `GroundCover256x256`). Not placed by code.
- Player weapons: instance 19 "Mount" at (0,800,0), rotated to (pitch, yaw) every frame. Weapon models (LeftGun, RightGun, M60, Cannon, Mortor, Pistol, Bolt, Flaregun: instances 21..28) are linked to it.
- Crosshair: instance 535, linked to the mount at (8, 0, -14000), ±500 quad, `CrosshairAlpha64x64`, colour (255,0,32), screen blend, Z off; shown only if the level has `Crosshair`. Angular size ≈ 4.1 deg.

### 3.5 Materials and blending (`SetTexture A B mode`) [H]
Textures are 16-bit RGB with no alpha, so source alpha is effectively 1.

| mode | effect | used for | Three.js |
|---|---|---|---|
| 0 | vertex colour only | untextured | `MeshBasicMaterial` + vertex colours |
| 1 | texture x vertex colour, opaque | most geometry | opaque |
| 2 | dst x (1 - src) (darken) | black smoke | `CustomBlending`, src Zero, dst OneMinusSrcColor |
| 3 | dst x src (multiply) | shadows, rotors, props, ExplodeV | src Zero, dst SrcColor |
| 4 | colour key black, point filtering | trees, ground cover, soldiers, grenades | alphaTest on near-black |
| 5 | src + dst x (1 - src) (screen) | tracers, flares, white smoke, explosions, fire, dirt, blood, crosshair | src One, dst OneMinusSrcColor |

- Colour key value 0 after 24-to-16-bit conversion: a pixel is transparent when R<8, G<8 (555) or G<4 (565), B<8.
- No mipmaps, min filter point (distant textures alias).
- `SortTxtr` polygons are deferred, bucket-sorted back to front (8192 buckets, 4-unit resolution), drawn with z-writes off.
- `Reflected` = sphere environment map (`u = 0.5 + 0.5 n.x`, `v = 0.5 - 0.5 n.y` in camera space) = `MeshMatcapMaterial` with the `.r24` texture (GunMetal, Brass, WindowGlass).
- `.t24` / `.r24` are headerless raw RGB, 3 bytes per pixel. `TextureMap name slot bpp w h` in `Geometry.3D` names them.

### 3.6 Lighting, day and night [H]
Per-vertex software lighting, no ambient term, intensity clamped to 1.0, applied as `I x Color`. Each instance has a light mask (`+0x80`); a light only affects instances whose mask bit is set.
- Sun: `LightDistant 0 -1 2 1 300` -> direction to light (-1,2,1)/√6, half-Lambert: `I += (n·L + 1) x 0.5 x 300/255`.
- Spotlight: at the eye, direction = view, cos cutoff 0.98 (11.5 deg half-angle), intensity 200/255. Enabled only at night with level keyword `Spotlight`; turned off when shield < 26.
- Point lights 2..5: range 5000, intensity 600/255, linear falloff. They follow flares at night. Instances within ~5100-6300 units (by type) of an active flare light, and terrain tiles in its quadrant, get the light bit.
- Day (`Daytime` keyword, `DAT_00462240 = 1`): SkyDay, sun on, FoliageDay, soldiers tinted 0xd7d7d7.
- Night (default; `Nightime` is not a keyword): SkyNight, sun off, FoliageNight, soldiers 0x282828. Unlit objects are black.
- Day/night setup: `FUN_0040327f` (called by the level parser); per-frame masks inside `FUN_004154b7`.

### 3.7 Sprites and particles [H]
Animated sheets are **vertical strips of square frames** (`ExplodeA128x4096` = 32 frames of 128x128). Each frame becomes its own texture. All animations advance **1 frame per game frame**.

| sheet | frames | quad size (units) | blend | playback |
|---|---|---|---|---|
| ExplodeVShape128x1536 | 12 | x ±400, y 0..800 (bottom anchored) | multiply | once (ground explosions) |
| ExplodeF128x2048 | 16 | ±100 x scale | screen | once (hit flash); first 5 frames reused for muzzle flash (once) and rocket flame (loop) |
| ExplodeA128x4096 | 32 | ±200 x scale (scale 4 for vehicle kills = 1600 wide) | screen | once (aircraft kills) |
| Fire64x2432 | 38 | x ±140, y 0..360, yaw-only billboard | screen | loop (burning soldiers) |
| DirtHit64x640 | 10 | | screen | once (bullet ground hits) |
| Blood64x640 | 10 | | screen | once (soldier hit) |
| Soldiers128x29808 / 128x14256 | 207 / 99 | frames 128x144 in the file, last 16 rows dropped | colour key | frame chosen by AI state |

Static billboards: tracers (±15, `Tracer32x32`, scale 1.5), cannon shells (scale 2), flares (`Flare128x128`), white smoke (±100, screen), black smoke (±200, darken), grenades (`Grenade64x64`, colour key). Billboards face the camera (pitch+yaw); Fire faces it by yaw only. Particle record stride 0x28: active, scale xz, scale y, position, velocity, brightness (fade drives modes 2 and 5).

### 3.8 HUD (`FUN_004021c4`, `FUN_00402a1c`, `FUN_00402d84`) [H]
Layout in 640x480 coordinates; right and bottom items shift by (W-640, H-480). No radar.
- SHIELD box (4,4,108,22), bar (8,8,shield,14).
- ENEMY box (528,4), bar = enemy / initial x 100, colour 0xff4000.
- Level box centred at top, navy, red text `"Level  %d"`.
- AMMO box (4,454), bar = bullets/500, cannon/20 or handgun/15 depending on weapon, count text.
- FLARES box (116,454): night only, when flares > 0.
- Bar colour: green > 50, yellow 26..50, red < 26.
- Icons from `Icons128x128`: missile launcher and pips (bottom centre), bombers-available icon, "level cleared" banner (enemy meter 0), "destroyed" banner (shield 0).
- Text uses GDI on the render target, colour 0xe0e0e0.

## 4. Sound system [H]
`FUN_0042ac3c` creates DirectSound buffers and loads the WAVs in this order, duplicating for polyphony: AntiAir x10, MachineGun x10, Tank, Truck, Jet, Bomber, Cobra, CH53, C130, Prize, Metalbig, Metalshort, Ricocht1, 2, 3, 3 (Ricocht4.wav is never loaded), Pistol x2, Rifle x4, Missile x2, CannonClose x2, CannonFar x2, ExClose x4, ExFar x4, ExMuffle x6, ExHit x2, ExBig, Soldead1..4. All playback is gated by the sound flag. Distance is expressed as DirectSound volume in hundredths of dB. Event mapping is in gameplay.md section 8.

## 5. Function map (BH2.exe)

| address | role |
|---|---|
| `FUN_0040101d` | WinMain, input, fire requests, frame cap, frame order |
| `FUN_00429058` / `FUN_004291b5` | read BeachheadIn / write BeachheadOut |
| `FUN_00429201` | Level_NN parser and full per-level reset |
| `FUN_0040327f` | day/night setup |
| `FUN_0042a62d` | DirectDraw/D3D init |
| `FUN_00425391` | load HMap, MMap, Geometry.3D, textures |
| `FUN_00428dc3` | load ShapeData (collision polygons per enemy type) |
| `FUN_0042ac3c` | load WAVs |
| `FUN_00403ca9` / `FUN_00403d26` | camera position / camera rotation and shake |
| `FUN_00403ec6`, `FUN_00404511`, `FUN_004045af`, `FUN_0040464d`, `FUN_00403f76` | instance matrix: identity, rotate X, Y, Z, parent compose |
| `FUN_004051c8` | enemy AI, spawn placement, movement, crashes, soldiers, parachutes, ground following, shadows |
| `FUN_004154b7` | projectiles, hit tests, damage, enemy meter, prizes, effects, night lighting, transforms, 3D render |
| `FUN_00423d9d` | ray vs vehicle collision polygons (returns hit zone) |
| `FUN_00424897` | ray vs soldier |
| `FUN_004232fa` / `FUN_004237f2` | aircraft / ground vehicle destruction into debris |
| `FUN_0042ffec` | billboard batch builder |
| `FUN_0042d3bd` | software display-list renderer core |
| `FUN_004021c4`, `FUN_00402a1c`, `FUN_00402ca5`, `FUN_00402d84` | HUD, win/lose countdown, rect, icon |
| `FUN_00424aef` | engine-loop sound volumes |
| `FUN_004050f1` | spawn Delay countdown |
| `FUN_004046eb` | clear particle pools |
| CRT | `FUN_00430230` rand (MSVC LCG), `FUN_00430220` srand, `FUN_00430130` fabs, `FUN_00430384` sin, `FUN_00430434` cos, `FUN_004305e4` asin, `FUN_004306b4` acos, `FUN_00430784` sqrt, `FUN_004304d0` floor, `FUN_00430920` fscanf, `FUN_00430b30` fopen |

## 6. Unknowns and caveats
- Blend formulas assume texture alpha = 1 under D3D7 defaults; confirm against screenshots of the original.
- No terrain LOD switch was found; TerrainClose vs TerrainFar is assumed static per tile [M].
- Spotlight distance falloff appears unused [M].
- Level numbers above 99 map to `Level_(level%10 + 91)`, so the game cycles levels 91..100. `Level_100` does not exist, so level 109 would fail to load [M].
- The menu's Game Interface help pages and weapons-chart view modes are only partly traced (irrelevant to gameplay).
