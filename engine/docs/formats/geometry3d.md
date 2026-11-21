# Geometry.3D

`BH2Game/Geometry.3D` is the source of every 3D model drawn by `BH2.exe`: sky, terrain, player guns, vehicles, aircraft, effects, foliage, crosshair, plus lights and the texture table. It is plain ASCII, CRLF, 133,187 lines, 4.4 MB. `BH2.exe` compiles it at startup into an in-memory display list (loader function at `0x425391`, file opened with mode `"rt"`). `bh2.ews` is a launcher and does not reference the file.

Parser: `src/formats/geometry3d.ts`. Check: `npx tsx scripts/check-geometry3d.ts` (from `engine/`).

Confidence labels:

- **confirmed (exe)**: read from the loader or renderer disassembly.
- **confirmed (data)**: holds for every occurrence in the shipped file.
- **inferred**: consistent with code and data, not proven end to end.
- **unknown**: not determined.

## Lexical rules

- `BH2.exe` reads one whitespace-separated token at a time with `fscanf("%s")` and compares it against the keyword list. Arguments are then read with `fscanf` (`%d`, `%f`). Line breaks carry no meaning to the exe. **confirmed (exe)**
- Any token that is not a keyword is skipped. This is how comments work: `/*** SkyDay ***/` and `//Wings` are just ignored words. A comment word that equals a keyword would execute; none does in the shipped file. **confirmed (exe, data)**
- The parse loop runs until the `End` keyword. There is no EOF check. **confirmed (exe)**
- The first token `POLY` is not a keyword. It is skipped like a comment. **confirmed (exe)**
- In the shipped file every directive sits on its own line with exactly its arguments, numbers match `-?\d+(\.\d+)?`, and comments start the line with `//` or `/*`. The parser relies on this and rejects anything else. **confirmed (data)**

## Objects and ids

The exe keeps an object table (base `0x44abe0`, 132 bytes per entry) indexed by the current object id.

- `Object n` sets the current id to `n`. `ObjectInc` sets it to previous id + 1. The id counter starts at 0. **confirmed (exe)**
- Both reset the object's entry: visible = 1, display-list start = current write position, identity rotation matrix, zero position, rotation, spin and light mask. They also reset the vertex scale to 1.0 (no directive changes it). **confirmed (exe)**
- `ObjectEnd` writes the end marker word `0x00000001`. Objects are not nested. **confirmed (exe)**
- Negative object references in `Instance`, `Copy`, `Link` are relative: target = current id + n. Non-negative values are absolute ids. **confirmed (exe)**
- The shipped file uses `Object 0` .. `Object 7` (lights), then 528 `ObjectInc` (ids 8..535). **confirmed (data)**
- Labels: the `/*** Name ***/` comment before an `ObjectInc` names the object for humans only. The exe never sees it. The parser stores it as `label`.

Parse-time state that does **not** reset per object: current PolyType, TextureScale, TxtrAdjust, and the last texture number used by `SetTextureInc`. PolyType and TxtrAdjust are uninitialised until first set; TextureScale starts at 1.0. **confirmed (exe)**

## Directives

Argument types follow the exe's scanf format: `d` = integer, `f` = float, `s` = word.

### Object structure

| Directive | Args | Meaning | Confidence |
|---|---|---|---|
| `Object` | `d id` | Start object with absolute id. | confirmed (exe) |
| `ObjectInc` | none | Start object with id = previous + 1. | confirmed (exe) |
| `ObjectEnd` | none | End of object's display list. | confirmed (exe) |
| `End` | none | Ends parsing. Writes a 0 word. | confirmed (exe) |
| `Visible` | `d flag` | Sets the object's visible flag (default 1). Used with 0 on objects 1..7 (lights) and object 70 (one `TMount` instance). The game toggles visibility at runtime. | confirmed (exe); purpose of object 70's flag unknown |
| `Translate` | `f x y z` | Object position, written to both the current and the base position fields. Relative to the `Link` parent (inferred from data: gun parts sit at small offsets under `Mount`). | field writes confirmed (exe); parent-relative inferred |
| `Rotate` | `f x y z` | Initial rotation. Not used in the file. Units unknown. | confirmed (exe) |
| `RotateInc` | `f x y z` | Rotation per tick (spin). Not used. | inferred |
| `Link` | `d ref` | Parent object in the hierarchy (field `+0x0c`). | confirmed (exe); parenting semantics inferred from data |
| `Instance` | `d ref` | Share the target's display list: copies its list start/backup pointers, light mask, spin and base position. Shipped `Instance` objects contain nothing else. | confirmed (exe) |
| `Copy` | `d ref` | Duplicate the target's display list commands inline (copied command by command until the end marker). Used for the 40 shadow objects so each copy is its own memory (inferred: runtime patches per copy). | copy confirmed (exe); reason inferred |
| `Backup` | none | Set the object's second list pointer (`+0x08`) to the current write position. Not used. Purpose unknown. | confirmed (exe) |
| `InstanceBackup` | `d id` | Set `+0x08` to object `id`'s list start. Absolute only. Not used. | confirmed (exe) |
| `LightMask` | `d mask` | Per-object light mask (`+0x80`). Not used. | confirmed (exe) |

### Geometry state

| Directive | Args | Meaning | Confidence |
|---|---|---|---|
| `PolyType` | `s name` | Sets how following `Polygon` blocks are read and drawn. See table below. | confirmed (exe) |
| `Polygon` | `d n` | Followed by `n` vertex records (layout per PolyType). `n` is stored in one byte, max 255. Shipped max is 24. | confirmed (exe, data) |
| `Color` | `d r g b` | Emits a color command (`0x04000200`, then `r<<16 g<<8 b`). Material color for following polygons, 0..255. | confirmed (exe) |
| `SetTexture` | `d slot d arg2 d mode` | Emits `0x08000300`, `slot<<16 | arg2`, `mode`. Renderer binds texture `slot` and sets blend mode `mode`. `arg2` is always 0 and the renderer does not use it. | confirmed (exe); arg2 meaning unknown |
| `SetTextureInc` | `d arg2 d mode` | Same as `SetTexture (lastSlot + 1) arg2 mode`. `lastSlot` is the last slot set by either form, across objects. | confirmed (exe) |
| `DisableTexture` | none | Same as `SetTexture 0 0 0`. | confirmed (exe) |
| `TextureScale` | `f s` | UV divisor for following textured polygons: stored u = u/s, v = v/s. Default 1.0. Values in file: 255, 127, 63 for 256, 128, 64 px textures. | confirmed (exe) |
| `TxtrAdjust` | `f a f b f c` | For `ConvertTexturedL` only: u = (u + a)/b, v = v/c. Used to place parts in the 256-wide `Helicopters.t24` sheet (`128 255 639`, `0 255 519`, `0 255 255`). | confirmed (exe) |
| `RenderState` | `d state d value` | Emits `0x0C000200`, `state<<8 | value` → Direct3D 7 `SetRenderState`. Not used directly. | confirmed (exe) |
| `ZBufferOn` / `ZBufferOff` | none | `RenderState 7 1` / `7 0` (D3DRENDERSTATE_ZENABLE). Used around the sky domes and crosshair. | confirmed (exe) |
| `ZBufferWritesOn` / `ZBufferWritesOff` | none | `RenderState 14 1` / `14 0` (ZWRITEENABLE). Not used. | confirmed (exe) |

Quirk: two lines read `TextureScale 127 127` and `TextureScale 255 255`. The exe reads one float; the second token is skipped as an unknown word. The parser keeps it in `ignoredTokens`. **confirmed (exe, data)**

### SetTexture modes

From the renderer (`0x42d644`). D3D7 render states: 27 ALPHABLENDENABLE, 19 SRCBLEND, 20 DESTBLEND, 41 COLORKEYENABLE. Modes 1..5 all use stage 0 color = texture × diffuse.

| Mode | Renderer setup | Used by | Confidence |
|---|---|---|---|
| 0 | texture off, blending off, color key off | `DisableTexture` (Smooth/SmoothL parts) | confirmed (exe) |
| 1 | linear filter, blending off (opaque) | terrain, sky, vehicles, guns | confirmed (exe) |
| 2 | blend SRC=INVSRCALPHA, DEST=INVSRCCOLOR | `SMOKEBLACK` | confirmed (exe) |
| 3 | blend SRC=INVSRCALPHA, DEST=SRCCOLOR (multiply-like) | shadows, rotors, props, `ExplodeV` | confirmed (exe) |
| 4 | point filter, blending off, color key on (black = transparent) | soldiers, foliage, grenade | confirmed (exe) |
| 5 | blend SRC=SRCALPHA, DEST=INVSRCCOLOR (additive-like) | fire, explosions, tracers, white smoke, crosshair, blood, dirt | confirmed (exe) |
| 6 | texture off, alpha from diffuse, SRCALPHA/INVSRCALPHA | not used | confirmed (exe) |

How "multiply-like" and "additive-like" look in practice depends on the diffuse alpha, which this document has not traced. **unknown**

### Lights

Written as display-list commands and registered in a light table (`0x476f00[id]`). Light colors are stored as raw floats.

| Directive | Args | Stored as | Confidence |
|---|---|---|---|
| `LightDistant` | `d id f dx dy dz f i f r g b` | normalised direction, `i/255`, r g b | confirmed (exe) |
| `LightPoint` | `d id f x y z f range f i f r g b` | position, `1/range`, `i/255`, r g b | confirmed (exe) |
| `LightSpot` | `d id f x y z f dx dy dz f cos f range f i f r g b` | position, direction (not normalised), `1/(1-cos)`, `1/range`, `i/255`, r g b | confirmed (exe) |

Calling `i` "intensity" and `cos` "cone cosine" is **inferred** from the math. Shipped lights: object 0 sun (`LightDistant 0 -1 2 1 300 255 255 255`), object 1 spotlight at (0,820,0) aimed −Z, cos 0.98, range 30000 (likely the night searchlight), objects 2..7 point lights (range 5000, i 600) at the origin, hidden, presumably moved by the game for muzzle flashes or explosions (**inferred**).

### Texture table (after the last object)

| Directive | Args | Meaning | Confidence |
|---|---|---|---|
| `TextureMap` | `s file d slot d bpp d width d height` | Load headerless raw image into texture slot. | confirmed (exe) |
| `ColorKeyed` | same | Same, with black (0,0,0) as source color key. | confirmed (exe) |
| `Animated` | `d set s file d frames d bpp d width d height` | Load `frames` consecutive `width×height` images into animation set `set` (0..5). | confirmed (exe) |
| `Film` | same | Like `Animated`, color keyed, but each frame occupies `width×(height+16)` pixels in the file. Only the first `height` rows are uploaded. | confirmed (exe) |

Raw image facts: byte order R, G, B (the 24→16-bit converter at `0x42feff` puts byte 0 in the top 5 bits); `bytes = width × height × bpp/8` read with one `fread` from offset 0; all files use bpp 24. Width and height come from the directive, not from the file name (`Boxes128.x128.t24` is 128×128; `.r24` files are 256×256). Rows are top-first (**inferred** from the plain row copy into the surface). **confirmed (exe)**; all 73 file sizes match exactly **confirmed (data)**. File names are matched case-insensitively by Windows: the file says `ExplodeVshape128x1536.t24`, the disk has `ExplodeVShape128x1536.t24`.

The first `TextureMap` or `ColorKeyed` writes a 0 word, closing the geometry stream. **confirmed (exe)**

### Runtime texture slots

Polygons use slots 25..180 and 219..230, which no `TextureMap` defines. At runtime the game copies animation frames into these slots per active effect instance (function around `0x421e5b`, writing the texture table at `0x45fc84 + slot*0x28`). **confirmed (exe)** for the bases below; the per-instance details are **inferred**:

| Slots | Source | File comment |
|---|---|---|
| 25..32 | `Animated 0` (ExplodeV, 12 frames), 8 instances | `//25-32` |
| 33..64 | `Animated 1` (ExplodeF, 16 frames); extra loops also write from base 41 and 49 | `//33-64` |
| 65..72 | `Animated 2` (ExplodeA, 32 frames) | `//65-72` |
| 73..84 | `Animated 3` (Fire, 38 frames) | `//73-84` |
| 85..180 | `Film` frames for the 96 soldier billboards (`SetTexture 85` then 95 × `SetTextureInc`) | `//85-180` |
| 219..226 | `Animated 4` (DirtHit, 10 frames) | `//219-226` |
| 227..230 | `Animated 5` (Blood, 10 frames) | `//227-230` |

A browser engine must provide these slots itself (pick the frame per effect instance).

## PolyType and vertex layouts

Each vertex is one line of numbers. Positions are multiplied by the vertex scale (always 1.0).

| PolyType | Display opcode | Vertex fields | Load-time conversion | Draw (renderer jump table `0x43e670`) | Polys in file |
|---|---|---|---|---|---|
| `BoundingVol` | `0x10` | `x y z` | none | Projects the 8 points; if all are off one screen edge, skips the rest of the object. Frustum cull box. | 16: one per terrain tile, plus Tank1, APC, Jet, Bomber, Cobra1, CH53, C130 |
| `Smooth` | `0x14` | `x y z shade` | shade/255 | untextured, per-vertex shade | 381 |
| `SmoothL` | `0x18` | `x y z nx ny nz` | normal normalised | untextured, lit | 285 |
| `Vertices` | `0x1C` | `x y z` | none | not drawn (renderer skips it); presumably read by game code (inferred) | 12: one ±15 quad at the start of each effect billboard object (TRACERS, PROJECTILES, FLARES, SMOKEWHITE/BLACK, ExplodeV/F/A, Fire, DirtHit, Blood, Grenades) |
| `Textured` | `0x20` | `x y z shade u v` | shade/255, u,v / TextureScale | textured, unlit | 242 |
| `TxtrAlpha` | `0x2001` | as Textured | as Textured | as Textured (shares opcode byte) | 0 |
| `SortTxtr` | `0x28` | as Textured | as Textured | textured, put into 8192 depth buckets and drawn sorted (for blended parts) | 604 |
| `TexturedL` | `0x24` | `x y z nx ny nz u v` | normal normalised, u,v / TextureScale | textured, lit | 21,872 |
| `ConvertTexturedL` | emits `0x24` | `x y z nx ny nz u v` | normal normalised, u=(u+a)/b, v=v/c from TxtrAdjust | as TexturedL | 1,016 |
| `Reflected` | `0x2C` | `x y z nx ny nz` | normal scaled to length 0.5 | environment-mapped with the current texture (`GunMetal.r24`, `Brass.r24`, `WindowGlass.r24`) | 1,811 |
| `ReflectedL` | `0x30` | as Reflected | as Reflected | jump table entry returns from the draw routine, so it would end the object | 0 |

Field order and load-time conversions are **confirmed (exe)**. Draw behavior: BoundingVol culling and SortTxtr bucketing **confirmed (exe)**; "untextured", "lit" and "environment-mapped" are **inferred** (Smooth/SmoothL are always preceded by `DisableTexture` in the file; L types carry normals; the reflect normal of length 0.5 matches a `0.5 + 0.5·n` sphere-map lookup). How `shade` combines with `Color` is **unknown**: Textured/SortTxtr always use 255, while Smooth uses 0..255 under `Color 0 0 0`.

Winding: not determined. **unknown**

## Render state carry-over

`Color` and `SetTexture` are display-list commands, not per-object properties. An object that sets neither (e.g. `LeftGun`, `RightGun`) draws with whatever the previous drawn object left set. In file order that is its parent's state (the guns follow `AAMount`, which sets `GunMetal.r24`, Reflected). The parser records this file-order state on every polygon (`Polygon.state`), but draw order at runtime may differ. **inferred**

## Statistics (shipped file)

From `scripts/check-geometry3d.ts`.

| Directive | Count | | Directive | Count |
|---|---|---|---|---|
| Polygon | 26,239 | | TextureScale | 54 |
| ObjectEnd | 536 | | Copy | 40 |
| ObjectInc | 528 | | DisableTexture | 17 |
| Instance | 317 | | Object | 8 |
| PolyType | 209 | | Visible | 8 |
| Color | 184 | | LightPoint | 6 |
| SetTexture | 168 | | Animated | 6 |
| Link | 146 | | TxtrAdjust | 5 |
| SetTextureInc | 116 | | ZBufferOn / ZBufferOff | 3 / 3 |
| Translate | 78 | | ColorKeyed | 3 |
| TextureMap | 62 | | Film | 2 |
| LightDistant / LightSpot | 1 / 1 | | POLY / End | 1 / 1 |

Never used: `Rotate`, `RotateInc`, `RenderState`, `ZBufferWritesOn/Off`, `Backup`, `InstanceBackup`, `LightMask`, PolyTypes `TxtrAlpha` and `ReflectedL`.

103,141 vertex lines. Comment lines: 312 `/*** ***/` labels and 349 `//` lines.

Coordinates: x −30000..30000, y −500..8000, z −30000..30000 over all polygons. Y is up (sky top at y 8000, terrain heights 0..2040). Units are not determined (a tank is 238 wide and 485 long). **unknown**

`SetTexture` modes used: 1 ×83, 2 ×1, 3 ×20, 4 ×16 (+95 via `SetTextureInc`), 5 ×48 (+21 via `SetTextureInc`). `arg2` is 0 everywhere.

## Object inventory

Ids are from the parser. "own" = polygons written in the object, "Instance"/"Copy" objects reuse the first object of their run. Ranges are model-space bounds.

| Ids | Label | What it is (from label and data) |
|---|---|---|
| 0..7 | none | Lights (0 sun, 1 spotlight, 2..7 point lights; 1..7 hidden) |
| 8, 9 | SkyDay, SkyNight | Sky boxes: 9 top quads at y 8000 plus side walls, ±30000, `Translate 0 -1000 0`, z-buffer off. Day uses Sky1..9 and SkyCylinder1..3; night uses SkyN1..3, Stars, SkyCylinderN1..2 |
| 10..18 | Terrain1..9 | 3×3 terrain tiles, each 10000×10000 (x,z from −15000 to 15000), heights 0..2040, grid step 200, ~2,000..2,430 TexturedL polys each, one BoundingVol each. Tiles use TerrainFar1..9 (no Far5); the centre tile (Terrain5) uses TerrainClose01..16 instead |
| 19 | Mount | Empty pivot at `Translate 0 800 0`, parent of the player weapons |
| 20..22 | AAMount, LeftGun, RightGun | Player anti-aircraft twin gun (Reflected GunMetal); guns link to AAMount |
| 23..28 | M60, Cannon, Mortor, Pistol, Bolt, Flaregun | Other player weapons under Mount (Bolt links to Pistol, Flaregun is empty) |
| 29..36 | Shell..Shell8 | Ejected shell casings (Brass); 30..34 and 36 are Instances |
| 37..48 | Tank1..12 | Tank hull (MBT70.t24); 38..48 Instances |
| 49..60 | Turret | Tank turrets, linked one per tank |
| 61..72 | TMount | Turret gun mounts, linked one per turret (70 starts hidden) |
| 73..84 | APC | APC hulls (APC.t24) |
| 85..96 | ARamp | APC rear ramps |
| 97..116 | AGunTurret, ATurret, AMissileTurret, APCGun, Launcher, Radar | APC variants: gun turret on 77..80, missile turret on 81..84, plus guns, launchers, radars |
| 117..132 | Jet | Jets (Jets.t24), 16 |
| 133..141 | Bomber | Bombers, 9 |
| 142..177 | Cobra1..12, Cobra Rotor, Cobra Prop | Attack helicopters (Helicopters.t24, ConvertTexturedL) with rotors and tail props (SortTxtr, mode 3) |
| 178..209 | CH53, Ramp, CH53 Rotor, CH53 Prop | Transport helicopters, 8, with ramps, rotors, props |
| 210..249 | C130, PropLL/LM/RM/RR | C-130 transports, 8, with four propellers each |
| 250..293 | Tank/APC/Cobra/CH53 Shadow | Flat shadow quads at y 0 (VehicleShadow, HeliShadows), mode 3; each run is one object plus `Copy` duplicates |
| 294..357 | Parachute, Parachutes | Parachute canopy plus 63 Instances |
| 358..453 | Soldiers | 96 billboards 128×127, texture slots 85..180 (Film frames), color keyed |
| 454..469 | Health/Ammo/Projectile/MissileBoxes | Supply crates (Boxes128.x128.t24), 4 each |
| 470..519 | MISSILE, ROCKETS, BOMBS | Ordnance models with Instances |
| 520..522 | TRACERS, PROJECTILES, FLARES | Billboard quads, additive |
| 523..531 | SMOKEWHITE, SMOKEBLACK, ExplodeV, ExplodeF, ExplodeA, Fire, DirtHit, Blood, Grenades | Effect billboards using runtime animation slots |
| 532 | SandBags | Sandbag ring around the player, ±130, height 106, Concrete256x256.t24 |
| 533, 534 | FoliageDay, FoliageNight | 95 tree and ground-cover quads placed across the map (x −10686..8237, z −10776..11352), color keyed Trees/GroundCover |
| 535 | Crosshair | Quad at z −14000 linked to Mount (`Link 19`), additive, z-buffer off |

"Bunker" does not appear as a label. The player position is presumably the `Mount` pivot surrounded by `SandBags`. **inferred**

## Open questions

- How per-vertex `shade` and `Color` combine, and where diffuse alpha comes from for blend modes 2, 3, 5.
- Purpose of `Backup` / `InstanceBackup` (second list pointer, maybe a damaged or LOD variant).
- Polygon winding and the renderer's culling.
- Model units and the mapping from Geometry.3D space to `HMap1501x1501.hmap`.
- Why object 70 starts hidden.
