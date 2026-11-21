# In-game HUD (`src/game/hud.ts`)

Reimplements `FUN_004021c4` (rects, bars, icons, banners), `FUN_00402ca5` (flat rect), `FUN_00402d84` (icon quads from `Icons128x128.t24`) and `FUN_00402a1c` (GDI text). Constants and rectangles are copied from the decompile; see `docs/re/architecture.md` §3.8 and `artifacts/re/notes/30-renderer.md` §9.

## How it works

- A 2D canvas overlays the renderer canvas (`position: fixed`, `pointer-events: none`), sized to its box at `devicePixelRatio`.
- Layout is in original screen pixels. The window maps to a virtual screen whose height is clamped to 480..600 (width at least 640). Left/top items stay fixed; right/bottom items shift by `(W-640, H-480)` of the virtual screen, exactly like the original at 800x600 or 1024x768.
- Rect edges and icon quads snap to device pixels, so bars stay crisp at any scale.
- `update(world)` runs once per game frame through `game.late` and redraws. It is not called while paused, so the HUD freezes like the original (pause skips the whole render + HUD block; there is no pause indicator).
- Resizes and DPR changes redraw from the last state.

## Wiring (`main.ts`)

```ts
import { Hud } from './game/hud'
const hud = new Hud(renderer.domElement, game, fs)
game.late.push(hud)
```

## Faithful details

- Draw order: black boxes, navy Level box, bars, icons, then text (GDI text is drawn after `EndScene`).
- Bar colours: green `#008000` > 50, yellow `#a09000` 26..50, red `#ff0000` < 26. Flares bar uses 40/21 on its 0..80 scale. Enemy bar is always `#ff4000`.
- Missile launcher shows when spare + loaded > 0 (the original's count includes loaded rails). Loaded rail pips at W/2-18 (`rails[0]`) and W/2+10 (`rails[1]`), spares at W/2+32+12k.
- Icons is a plain `TextureMap` (no colour key) drawn with blending off, so black stays opaque (visible around the banners' rounded corners, as in the original).
- Icon source rects use the original `uv = px / 127` on the 128-pixel texture. The destroyed banner is stretched to 255x48 with bilinear filtering.
- Banners follow the raw values, not `world.outcome`: "NEXT LEVEL..." while the enemy meter is < 0.0001, "GAME OVER" while shield < 1.

## Deviations

- Font: the original used the DC's default bold "System" bitmap font (16 px cell, ascent 13), not antialiased. We use bold 13 px Tahoma (fallbacks Microsoft Sans Serif, Arial) with canvas antialiasing.
- Colours are not quantised to the original 16-bit (RGB565) framebuffer.
- HUD scale above 600 px of window height is our choice (the original never scaled; at 1024x768 it was simply smaller).

## Remaining work

- Pixel-compare against a real capture of the original at 640x480 and 800x600 (font metrics, banner filtering).
- Icon 3 (artillery "A", uv 0,32..63,63) is never drawn by `FUN_004021c4`; the `DAT_00463118` condition that enables the icon pass has no known icon. Left unimplemented.
- Remove `DebugHud` from `main.ts` once its game-over/quit `message()` overlay moves elsewhere.
