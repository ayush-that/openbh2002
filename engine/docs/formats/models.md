# Vehicle model formats: ShapeData and .3DB

Confidence tags: **[confirmed]** = read from the loader disassembly and verified against every shipped file;
**[inferred]** = consistent with code and data but not proven; **[unknown]** = not determined.

Addresses are virtual addresses in the original executables (`objdump -d` output).

## Who uses what

| File | Loaded by | Purpose |
|---|---|---|
| `BH2Game/Geometry.3D` (text, `POLY`) | `BH2.exe` (the game) | In-game render meshes, `.t24` textures. Separate spec. |
| `BH2Game/ShapeData` (text) | `BH2.exe` | Projectile hit shapes (ray vs polygon), per-part hit result. Not rendered. |
| `vehicles/*.3DB` + `vehicles/*.tga` | `bh2.ews` (front-end/menu) | Vehicle showcase screen. Never read by the game. |

- **[confirmed]** `BH2.exe` has no `3DB`/`3DBF`/`.tga`/`vehicles` strings and no `'3DBF'` compare. It opens `Geometry.3D` and `ShapeData` only.
- **[confirmed]** `bh2.ews` is a PE (Exelweiss front-end; `BH2002.exe` runs `BH2.EWS`, which runs `./bh2game/bh2.exe`). It contains the hard-coded list `vehicles/apc1.3DB, apc2, apc3, Mbt70, B58, F104, Ch53, C130, Cobra` and the `.3DB` loader at `0x4111d0` (`cmp [esp+0x28], '3DBF'`).
- **[confirmed]** All three share one coordinate frame. APC `BodyTop` vertices and UVs in `Geometry.3D` (`64 156 177`, uv `0 92`) equal `apc1.3DB` exactly (uv × 256). ShapeData bounds equal the `.3DB` bounds exactly for Bomber/B58 and C130 and within a few units for the rest (sanity images show the hit hulls wrapping the meshes).
- **[inferred]** `.3DB` files are the 3ds Max exports ("EXPORT3DB", root node `EXPORT3DB_ARREL`, Catalan for "root") that `Geometry.3D` vehicles were derived from. They are higher detail (MBT70: 1487 triangles) and carry hierarchy, normals and per-corner UVs. Prefer them for rendering vehicles in the browser engine. For in-game fidelity, see the Geometry.3D spec.

## Coordinate frame (both formats)

- **[confirmed]** Y up. Forward is **-Z**: tank gun, APC front, C130/F104 nose are at -Z, APC rear ramp at +Z. Rotor hub at the origin for helicopters. Ground vehicles sit on y ≈ 5.
- **[confirmed]** Raw `.3DB` triangles wind **counter-clockwise** (right-handed cross product) around their stored normals. That holds for every non-degenerate triangle in all 9 files except one flipped triangle in the Apc2 turret. Use raw coordinates directly in Three.js (right-handed, CCW front faces).
- **[confirmed]** The `.3DB` node transforms always compose to a net `diag(-1, 1, 1)` X mirror: the root is a Y/Z swap and the top mesh is `-X` plus a Y/Z swap. The mirror converts to left-handed Direct3D, so the front-end shows the same image as raw coordinates in a right-handed renderer. `db3MeshMatrices()` cancels the mirror by default, and `check-models.ts` asserts the net rotation is identity.
- **[unknown]** Units. Compared with the real vehicles (MBT-70 width 3.5 m = 237 units, C-130 span 40.4 m = 2534 units), 1 unit ≈ 1.5 cm. Treat this as a scale hint only.

## ShapeData (text)

CRLF, whitespace-separated. `BH2.exe` reads it with a `fscanf("%s")` token loop (`0x428dc3`). Any token it does not recognise is skipped silently. That is how the `/*** Name ***/` comments and the names after `Part` are ignored.

| Directive | Meaning | Status |
|---|---|---|
| `/*** Name ***/` | Comment. Names the following object (Tank, APC, Jet, Bomber, Cobra, CH53, C130, Parachute, BoxAir, BoxGround). | in file; ignored by exe |
| `Object` | Starts an object. Its slot is its 0-based file order (Tank=0 … BoxGround=9). Resets Scale=1, Translate=0. | **[confirmed]** |
| `Part <names>` | Starts a hit part. Names are comma-separated labels (`engines,tank`, `body_primary`) that the exe never reads. | **[confirmed]** |
| `P <n>` + n lines `x y z` | A polygon with n vertices (3–16 in file). Stored as `v * Scale + Translate`. | **[confirmed]** |
| `ObjectEnd` | Ends the object. | **[confirmed]** |
| `End` | Ends the file. | **[confirmed]** |
| `Scale <s>` | Uniform scale for later vertices in this object. | exe only, **unused** in file |
| `Translate <x y z>` | Offset for later vertices in this object. | exe only, **unused** in file |

Contents: 10 objects, 697 polygons. 153 are triangles and 490 are quads. Some quads repeat a vertex (degenerate). Polygons may be non-convex.

Runtime stream ([confirmed]). Each object becomes a flat dword stream:
`2` for each Part, then `n, x,y,z × n` for each polygon, `1` at ObjectEnd and `0` at End. Object start pointers are stored at `0x463020[slot]`.

Use ([inferred], high). `0x423d9d(instance, slot, origin(double×3), dir(double×3), length)` is called from 10 sites. It:
1. Transforms each polygon by the instance's 3×3 rotation and position (table `0x44abf4`, stride `0x84`) into a ray-aligned frame.
2. Rejects polygons by their AABB.
3. Runs a 2-D crossing-number point-in-polygon test.
4. Returns the 0-based **Part index** of the nearest hit, or -1, and stores the hit distance in `0x44abb0`.

So ShapeData is a hit/collision volume set. Part order matters: part 0 is the first `Part` (`tanks`, `engines,tank`, `engine,tubes`, `engine`), so it is probably the vulnerable zone. The polygon buffer is a 20-entry stack array, so n must be ≤ 19 ([inferred]).

## .3DB (binary, little-endian)

Loader: `0x4111d0` (file), `0x4101c0` (material), `0x411400` (node, recursive), `0x411bb0` (vertex buffer), `0x411de0` (draw).
Strings are NUL-terminated and read byte by byte, with no length prefix. All floats are f32. The parser consumes all 9 shipped files to the last byte.

### File

| Offset | Type | Field |
|---|---|---|
| 0x00 | char[4] | `3DBF` **[confirmed]** |
| 0x04 | u32 | material count (3–12; *not* a version) **[confirmed]** |
| 0x08 | Material × count | variable size |
| … | Node | root node (always dummy `EXPORT3DB_ARREL`) |

### Material (0xd4-byte struct in memory)

| Rel. offset | Type | Field | Status |
|---|---|---|---|
| 0 | cstring | name (`KENMAT_nnnn`; duplicates are normal; a CRT string function runs on it after load) | confirmed |
| n | f32[3] | ambient RGB 0..1 | confirmed order, inferred meaning |
| n+12 | f32[3] | diffuse RGB | " |
| n+24 | f32[3] | specular RGB | " |
| n+36 | f32[4] | unknown (always 0) | unknown |
| n+52 | f32 | shininess (0.25 everywhere) | inferred |
| n+56 | f32 | shininess strength (0.05) | inferred |
| n+60 | f32 | opacity (1.0) | inferred |
| n+64 | f32[2] | unknown (0) | unknown |
| n+72 | u32 | map flags, bits 0–11 | confirmed |
| n+76 | per set bit, ascending: f32 amount, cstring file | map slots | confirmed layout |

Map bit order matches the 3ds Max standard material ([inferred], strong):
0 ambient, 1 diffuse, 2 specular, 3 shininess, 4 shin. strength, 5 self-illum, 6 opacity, 7 filter, 8 bump, 9 reflection, 10 refraction, 11 displacement.
Shipped files use these combinations:
- `0x1`: empty ambient, plain colour.
- `0x3`: diffuse texture (`Jets.TGA`, `APC.TGA`, …).
- `0x43`: diffuse + opacity, `Prop64x64.TGA` / `Rotor64x64.TGA` (32-bit TGAs with alpha).
- `0x201`: reflection `WindowGlass.TGA` (glass).

Texture names resolve under `vehicles/` (case-insensitive) ([inferred]: `vehicles/` string sits beside the model paths; every referenced file exists there).

### Node

| Rel. offset | Type | Field |
|---|---|---|
| 0 | cstring | name (`OBJECT_nnnn`, `Object01`, `EXPORT3DB_ARREL`) |
| n | u32 | vertex count V; **0 = dummy node** |

Dummy (V = 0): `f32[12] transform`, `f32[12] meshTransform`, `u32 childCount`, then children.

Mesh (V > 0), offsets after the V field:

| Rel. | Type | Field |
|---|---|---|
| +0 | u32 | corner count C (unique position+normal+uv combinations) |
| +4 | u32 | triangle count T |
| +8 | f32[3] | bbox min (mesh-local) |
| +20 | f32[3] | bbox max |
| +32 | f32[12] | transform: 4×3 row-major, rows 0–2 basis, row 3 translation, row vectors (`v' = v·M`); applies to node and children |
| +80 | f32[12] | meshTransform: mesh only (identity in all files) |
| +128 | f32[3] × V | positions |
| … | 24 B × C | corner: `u32 positionIndex, f32[3] normal (unit), f32[2] uv` |
| … | face groups | repeat until the group counts sum to T |
| … | u32 | child count, then child nodes |

Face group: `u32 type, u32 count, u32 materialIndex` (index into the file's material table), then `count × u32[3]` corner indices.
- type 1 adds 12 bytes after each triangle, which the loader reads and discards. Only type 0 appears in shipped files.
- `materialIndex` is global. Each mesh refers to its own run of materials, so materials repeat.

**[confirmed]** UVs are 0..1 with v = 0 at the **top** of the image (matches Geometry.3D pixel UVs on top-down `.t24`). The `.tga` files are bottom-up (descriptor bit 5 clear), so flip rows on load, or set `flipY` to match.
**[confirmed]** Hierarchy: world = `meshTransform · transform · parent.transform · … · root.transform`. Examples: APC rear hatch `t=(0,59,177)`, Apc3 twin launchers `t=(±48,0,65)` under the turret, C130 props at `x=±300/±610`, MBT70 gun at `(0,119,-110)`.

### Worked example: F104.3DB (24,225 bytes)

`0x00` `3DBF` · `0x04` 4 materials · `0x08` `KENMAT_0000` · `0x14` 18 floats · `0x5c` flags `3`
· `0x60` ambient map (1.0, "") · `0x65` diffuse map (1.0, `Jets.TGA`) · `0x72` next material …
· `0x19d` root `EXPORT3DB_ARREL`, V = 0 at `0x1ad`, matrices `0x1b1`–`0x210`, 1 child at `0x211`
· `0x215` `OBJECT_0000`: V = 336, C = 527, T = 568, bbox at `0x22d`, transform at `0x245`, and so on.

## Unknowns

- Meaning of material floats 9–12 and 16–17. They are constant in shipped files, so they do not affect rendering.
- Exact semantics of face group type 1.
- What the front-end does with `ambient` vs `diffuse` (equal in every material).
- Exact gameplay meaning of each ShapeData part index. The hit test returns it; which caller compares it with what was not traced.
