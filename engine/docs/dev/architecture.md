# Engine architecture

OpenBH2002 reimplements Beach Head 2002 in the browser (TypeScript, Vite, Three.js r187 `three/webgpu`). It reads the user's original game files at runtime and never bundles them.

## Layout

| Path | Role |
|---|---|
| `src/vfs.ts` | Case-insensitive read-only view of the game folder (dev server or folder picker) |
| `src/formats/*` | Pure parsers: `geometry3d`, `shapedata`, `db3`, `level`, `raw24`, `heightmap` |
| `src/render/g3dscene.ts` | Builds one `Object3D` per Geometry.3D object id (`g3d.node(id)`), D3D7 blend modes |
| `src/world/terrain.ts` | Heightmap terrain (remaster) and `heightAt(x, z)` |
| `src/game/constants.ts` | Confirmed constants (frame time, camera, caps, object ids, hit radii) |
| `src/game/world.ts` | `World` state plus the interfaces subsystems implement: `EnemySystem`, `Target`, `Soldiers`, `Effects`, `Sound` |
| `src/game/game.ts` | Level reset, frame order, spawn countdown, win/lose, fixed 29 ms loop with render interpolation |
| `src/game/player.ts` | Turret aim, weapon timing and spawns |
| `src/game/projectiles.ts` | All projectile physics and damage (pure logic; visuals come from `Effects`) |
| `src/game/collision.ts` | Ray vs ShapeData polygons, returns the part (zone) index |
| `src/main.ts` | Boot and wiring |

## Rules every module follows

- **Per-frame simulation, no delta time.** Every speed and counter is per 29 ms game frame, exactly as in BH2.exe. `Game.step()` runs one frame; rendering interpolates `g3d` node transforms between frames automatically.
- **Simulation state lives in `g3d` nodes and module data**, never in render-only objects. Set node `position`/`rotation`/`visible` during `update()`; do not touch transforms in render callbacks.
- **Randomness** goes through `world.rand()` (MSVC LCG) so behaviour matches the original's distributions.
- **Faithful first.** Reproduce the original behaviour from `docs/re/*.md` and the decompiled code in `artifacts/re/` (gitignored, local only). Note any deliberate deviation in a code comment.
- **Coordinates:** Y up, North = -Z, South = +Z, East = +X, West = -X. Yaw 0 looks toward -Z; yaw 90 toward -X. Forward for yaw (deg) = (-sin y, 0, -cos y).
- Use `world.groundY(x, z)` for terrain height and `world.validGround(x, z)` for the MMap placement mask.

## Frame order (`Game.step`)

1. Keys and player (aim, fire)
2. `world.enemies[*].update(world)`
3. `g3d.root.updateMatrixWorld()`
4. `world.projectiles.update(world)` (hit tests use node world matrices)
5. `world.effects.update(world)`, then `game.late[*]` (HUD)
6. Win/lose, sound, spawn countdowns
