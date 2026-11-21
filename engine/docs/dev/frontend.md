# Front end (menus)

`src/frontend/` recreates `bh2.ews`, the original menu program, from the decompiled menu loop `FUN_00402050` (`artifacts/re/bh2ews.decomp.c`) and `artifacts/re/notes/40-frontend.md`. Every screen is drawn at 640x480 from the original `Fichas/` art and scaled to the container (letterboxed, `image-rendering: pixelated`). State numbers, rectangles, UVs, timings and flags match the original. Code comments name the original functions and globals.

## Modules

| File | Role |
|---|---|
| `index.ts` | `createFrontend(container, fs)` |
| `frontend.ts` | `Frontend`: the state machine, input, drawing |
| `layout.ts` | Rectangles and UVs taken from the decompiled code |
| `assets.ts` | Loads every image `bh2.ews` loads |
| `image.ts` | TGA (types 2/3/10/11, 8/24/32-bit, either row order), PCX (8-bit x 3 planes or paletted), GIF through the browser |
| `store.ts` | localStorage stand-ins for `BH2002.ini` `[SETTINGS]`, the high-score table and `SAVE/*.sav` |
| `audio.ts` | Click sounds from `Fichas/sfx/sonidos.dat` and XM music |
| `vehicles.ts` | The weapons-chart viewer: rotating `vehicles/*.3DB` models (Three.js `WebGPURenderer`) |

## API and main.ts wiring

```ts
import { createFrontend } from './frontend'

const fe = await createFrontend(app, fs) // hidden full-size layer (z-index 10) on top of the game canvas
// ... create renderer, world, game as today, but do not call game.startLevel yet ...

const play = (o: { level: number; mouseTight: boolean; mouseReverse: boolean; sound: boolean }) => {
  world.player.mouseTight = o.mouseTight
  world.player.mouseReverse = o.mouseReverse
  world.sound.enabled = o.sound
  world.paused = false
  game.startLevel(o.level)
}
const ended = (status: 0 | 1) => (level: number) => {
  world.paused = true
  fe.gameEnded({ status, level }) // high-score insert on death, FILE menu or score chart opens
  void fe.show().then(play)
}
game.events = { onGameOver: ended(0), onQuit: ended(1) }
world.paused = true
void fe.show().then(play) // first show() runs the intro (logos, disclaimer, title)
```

- `show()` resolves on PLAY, CONTINUE GAME, NEW GAME, LOAD GAME or the title Play button with the BeachheadIn values. It hides the menu layer, stops menu music and saves settings when it resolves. Calling it again while it is showing returns the same promise.
- `gameEnded({ status, level })` plays the role of BeachheadOut. `status` 0 = died (if `level` beats score 10, a row is inserted and the score chart opens with name entry), 1 = Esc (FILE menu opens, so CONTINUE replays that level). Call `show()` afterwards.
- The level reached on death or Esc stays current. CONTINUE and PLAY replay it; NEW GAME, the title Play button and confirming a high score reset it to 1, as in the original.
- `DebugHud` messages for game over and quit become unnecessary once this is wired.

## Screens implemented

| State | Screen | Notes |
|---|---|---|
| 0/500..5 | Intro: `ini` background, Infogrames, Digital Fusion, title logo, disclaimer | Fade 100/s, holds 1.5/2.5/2.0/3.0 s. Esc and click skip as in the original |
| 0/3 | Title | Machine gun on/off, hover overlays (mirror, rifle, radio), faint idle buttons |
| 1 | Bar and doors animation | Frame slides in, then the doors close on the original 17-step curve |
| 2 | Main menu bar with FILE / OPTIONS / HELP dropdowns | Row highlight, dropdown fade-in 150/s, click sound 2 |
| 10 / 11 | Save / Load | 20 slots, typed slot name (upper case, 200 px max), hover and selection shades |
| 0x14..0x16 | Options: video, audio, controls | Markers and live music/SFX volume |
| 0x1e..0x20 | Help: controls (mouse/keyboard/joystick pages), overview (5 pages with arrows), interface (diagram fade-in, game-screen page) | |
| 0x28 | Credits | 5 pages with arrows |
| 0x3c / 0x3d | Weapons chart grid and vehicle card with the rotating model | Hover sound 3, additive `highlight azul`, prev/next arrows |
| 0x50 | Score chart with name entry | Name 135 px max, OK saves, EXIT discards |
| 0x32 / 0x5a | Exit: doors open, `final.tga`, music fades over 3 s | |
| 100 / 0x6e | Start game: doors open and frame slides out / music fades over 0.5 s | |

All four reference captures match. Mean absolute difference per channel after resampling to 640x480: disclaimer 9, title 7, title with Play hovered 7, FILE menu 6. The diff images show only resampling edges.

## Storage

| Key | Contents |
|---|---|
| `bh2002.settings` | `{resolution, music, fx, mouseMode, mouseInvert, texturas}`, defaults from the user's `BH2002.ini` (values clamped like `FUN_00409460`) |
| `bh2002.scores` | 10 `{name, score}` rows, scores kept as strings like the ini. Seeded from `BH2002.ini` `[NAMESCORES]`/`[SCORES]` |
| `bh2002.save.000000NN.sav` | Hex of the original 54-byte record: name[30], level[10], width[10], MouseMode[2], MouseInvert[2], ASCII and NUL padded |

## Audio

- `Fichas/sfx/sonidos.dat` is decoded (16-bit or 8-bit mono entries). Index 0 = nav button, 2 = bar button, 3 = weapons-chart hover.
- XM music: `preludio.xm` during the intro, `Menu.xm` afterwards, and `Menu.xm` from order 12, row 31 after a game, as in the original. Playback uses libopenmpt via the `chiptune3` npm package (MIT; libopenmpt is BSD). Only its AudioWorklet file is imported, as `chiptune3/chiptune3.worklet.js?worker&url`, so Vite bundles it (with the inlined wasm) into one asset.
- Volumes follow Exelib's 0..64 scale. Music is scaled to 0.7 to sit under the click sounds.
- Browsers block audio until a user gesture. The audio context starts on the first pointer or key press in the menu, then the pending module starts.

## Deviations

- Quitting (QUIT or EXIT GAME) cannot close the tab. After the 3 s fade the title screen returns.
- Intro music starts on the first click or key press (autoplay policy). In the original, `Menu.xm` replaces `preludio.xm` right after the intro assets load. Here `preludio.xm` plays through the intro and `Menu.xm` starts when the title opens the menu.
- Title buttons draw at alpha 0.18 when idle. The decompiler loses that alpha (it comes from the x87 stack through `FUN_00405270`), so it was measured from the reference captures.
- Text is drawn by the canvas in Comic Sans MS 16 px (GDI: 12 pt, weight 200, or 600 for the save field), placed like GDI `TextOut` (cell top at y), anti-aliased.
- The blinking text cursor toggles every 120 ms. The original toggles it every frame.
- Clicks still register when the button goes down and up between two frames. The menu treats them as held for one frame at the press position.
- The video option (LOW/MID/HIGH) is shown and saved, but the browser ignores the game resolution.
- The vehicle projection copies `FUN_0040f450`: 22.5 degree vertical and 30 degree horizontal half-angles. That gives a slight horizontal squeeze, as in the original. Lighting is D3D-style Lambert: ambient 0x5a5a5a plus one 0.9 directional light, with no specular.

## Remaining work

- The game resolution field in saves and BeachheadIn is not used by the browser game.
- Weapons-chart view modes 9/10/11 (SCHEMATIC/TESTIMONIALS/DATA) and the textures at `obj+0x474`/`obj+0x654` are never reached in the original (no state lists those actions, and nothing loads those slots), so they are not implemented.
- The original main loop also mixes engine sounds while the menu runs (`FUN_0040e4f0`). This was not traced and is not reproduced.
- Not yet checked: keyboard-only use (the original has none besides Esc, Backspace and typed names) and touch input.
