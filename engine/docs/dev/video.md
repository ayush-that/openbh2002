# Recording gameplay video

Dev-only tooling for the launch video: a scripted shot list played by a cinematic bot, recorded in the page at 1920x1080 with game and menu audio, then converted with ffmpeg into an MP4 that X accepts.

| File | Role |
|---|---|
| `src/debug/recorder.ts` | `Recorder`: fixed 1920x1080 render, canvas compositing, audio tap, `MediaRecorder`, chunk upload |
| `src/debug/cinematic.ts` | `Cinematic` bot, `runShots`, `LAUNCH_SHOTS`, `recordLaunch` |
| `vite.config.ts` | `POST /__video?name=<file>&part=<n>` appends to `artifacts/video/<file>` (dev only, 1 GB cap) |
| `scripts/make-tweet-video.sh` | ffmpeg conversion to the X upload format |

## Record

1. `cd engine && E2E_NO_HMR=1 npx vite --port 5185 --strictPort`. Without HMR, edits to other files will not reload the page mid-take.
2. Open `http://localhost:5185/?record=launch` in a visible tab. A hidden tab stops `requestAnimationFrame`. Keep the window size fixed while recording.
3. If the page has had no user gesture yet, click "Click to start recording" once. Audio needs that gesture.
4. Wait for `recording done` in the console, or for `window.__recording`. The take is written to `artifacts/video/launch-<ISO>.mp4` (or `.webm` if the browser cannot record MP4). `errors` lists each shot (`waited N ticks`, `recorded N ticks`) and flags any shot that started before its ready condition was met (`NOT READY`).

While recording, game audio goes only into the file, not to the speakers. Pass `speakers: true` to the recorder to also hear it.

Without the URL flag, run it from the console:

```js
const { runShots, LAUNCH_SHOTS } = await import('/src/debug/cinematic.ts')
const b = __bh
await runShots({ game: b.game, renderer: b.renderer, vm: b.vm, sound: b.world.sound, shots: LAUNCH_SHOTS.slice(1) })
```

The title shot needs the front end. From the console, create one with `createFrontend(document.querySelector('#app'), await openDevFS())` (from `/src/frontend/index.ts` and `/src/vfs.ts`) and pass it as `frontend`.

## Convert

```sh
engine/scripts/make-tweet-video.sh artifacts/video/launch-<ISO>.mp4 [out.mp4] [--in 0.5] [--out 42]
```

The output is H.264 High 4.2, yuv420p, 1920x1080, constant 60 fps (30 if the take averaged under 50 fps), `+faststart`, and AAC-LC 48 kHz 192 kbps stereo. Audio is normalised in two passes to -14 LUFS with a -1.5 dBTP peak ceiling. The default output name is `<input>-x.mp4`. The script warns if the result is over 2:20 or over 512 MB. Override the ffmpeg binary with `FFMPEG=...`.

Check the result:

```sh
ffprobe -v error -show_entries stream=codec_name,profile,width,height,avg_frame_rate,sample_rate:format=duration out.mp4
ffmpeg -i out.mp4 -af volumedetect -vn -f null - 2>&1 | grep _volume
ffmpeg -ss 5 -i out.mp4 -frames:v 1 artifacts/video/frames/check.png
```

## Shot list (`LAUNCH_SHOTS`)

| shot | level | what | length |
|---|---|---|---|
| title | front end | Esc past the logos, menu music, cursor glides to the gun, click PLAY (music fades) | 3.5 s |
| armour | 10 day | cannon on tanks and APCs, twin gun on cobras | 6 s |
| jets | 28 day | twin gun and a missile on jets | 6 s |
| prize | 13 day | shoot a C130 crate parachute; the C130 itself is not engaged | until the prize, +1.2 s, max 7 s |
| close-kill | 17 day | cannon on a tank within 4000 | 4 s |
| bombers | 18 day | bomber strike called with 4+ soldiers up | 6 s |
| night | 23 night | flares, spotlight, cobras, CH53s, APCs | 7 s |
| cleared | 1 day | last kills and the LEVEL CLEARED banner | until cleared, +2.5 s |

Each game shot is a cut. With the recorder paused and the sound off, the runner:

1. Seeds the RNG (`seed`, default the level number), so a re-record replays the same fight.
2. Sets remaster mode and starts the level.
3. Re-grips the mouse (see "Cinematic bot").
4. Fast-forwards the real loop at 16x (8 ticks per render at most) until `ready` holds, or until `maxWait` ticks. By default `ready` means the bot is locked on a target.

Recording then resumes for `seconds` of game time, or until `until` holds plus `tail` seconds. Shot fields: `level`, `seed`, `mode`, `bot` (`prefer`, `avoid`, `missiles`, `flares`, `bombers`, `god`), `ready`, `maxWait`, `seconds`, `until`, `tail`, `onStart`. To re-record differently, edit `LAUNCH_SHOTS` or pass `shots`, change a `seed` for a different fight, and trim with `--in`/`--out`.

## Cinematic bot

The bot plays through the real input path only: `game.input.cx/cy/button` and typed keys. It uses no cheats. `god` exists for emergencies and is off in every shot.

- **Aim.** A damped spring (8 rad/s, damping 0.7, about 5% overshoot) drives the yaw rate (`cx`) and pitch (`cy` deltas). Speed is capped at 4 deg/tick and acceleration at 0.35 deg/tick². The target's angular motion is fed forward. A tiny deterministic tremor is added. The cursor only moves as far as the pitch can actually go, so the mapping never drifts.
- **Mouse re-grip.** The cursor box covers 96 degrees of pitch. At each cut, `reanchor()` sweeps the cursor down, up and down so the view ends pinned at -25. It then places the cursor so the box covers -25..71. This shows as a jump, so it only runs while the recorder is paused. Targets outside the reachable pitch are skipped instead of forcing a jump.
- **Targets.** Score = angle from the view x 45 + distance x priority, x0.3 for `prefer` kinds. The bot sticks with a target for at least about 1.3 s. After a kill it holds its aim for 10 ticks. `crate` is a parachute carrying a prize crate.
- **Weapons.** Cannon on tanks and APCs (missiles once the cannon is empty), twin gun on aircraft, parachutes and soldiers (handgun when out of bullets). A missile on a jet within 9000 and 3 degrees, at most every 120 ticks. A flare at night when none is up. `bombers: 'auto'` calls the strike at 5+ soldiers.

## How the recorder works

- **Fixed size.** Before each `vm.render()`, the renderer is resized so its drawing buffer is exactly 1920x1080 at whatever pixel ratio `VisualMode` set. The canvas is styled as a centred 16:9 box and the camera aspect is set to 16:9. The HUD follows the canvas box. On stop, the old style is restored and a `resize` event lets `main.ts` put everything back.
- **Compositing.** Right after `vm.render()`, in the same task (a WebGPU canvas cannot be read after it is presented), the WebGPU canvas is drawn into a 1920x1080 2D canvas. Every other visible canvas is drawn on top in stacking order, mapped from its screen rect: the HUD, and the front-end layers with their black background. Frames are capped at 60 fps and pushed with `CanvasCaptureMediaStreamTrack.requestFrame()`.
- **Audio.** The game `SoundSystem`'s context is the mixer. Its master gain is moved from the speakers to a `MediaStreamAudioDestinationNode`. While recording, `AudioNode.prototype.connect` is patched: any node connected to a speaker output (the menu music and click sounds, created when the menu unlocks audio) goes to the recorder instead, bridged through a `MediaStream` when it lives in another context. Menu audio that was unlocked before the recorder started is not captured, so start the recorder first (the runner does).
- **Encoding.** `MediaRecorder` uses `video/mp4;codecs=avc1.64002A,mp4a.40.2` when supported, otherwise VP9/Opus WebM, at 20 Mbps. It emits 1 s chunks, which are appended to the file in order. Waiting and cuts use `pause()`/`resume()`, so they are not in the file.

## main.ts wiring (`?record=launch`)

In `start()`, before the `autoplay` branch:

```ts
const record = params.get('record')
if (record) {
  // Dev tooling: scripted launch video (docs/dev/video.md).
  world.paused = true
  void import('./debug/cinematic').then(({ recordLaunch }) =>
    recordLaunch({ game, renderer, vm, sound: world.sound, frontend: fe, name: record }),
  )
} else if (auto) {
```

`fe` is the `createFrontend` result that already exists in `main.ts`. The dynamic import keeps the tooling out of the normal startup path.

## sound.ts

`SoundSystem.master` is private. The recorder reads it through a cast (`(sound as { master }).master`). The intended minimal change is to expose it: `readonly master: GainNode` instead of `private master: GainNode`. If `master` is ever renamed, the take has no game audio and `errors` reports `sound.master not reachable`.

## Known limits

- The tab must stay visible, and the window size must not change during a take.
- The game's own sound mix peaks at 0 dBFS in busy scenes. Loudness normalisation brings the average to -14 LUFS, but peaks that were already clipped in the mix stay clipped.
- Frame pacing follows the browser. If a scene drops below 60 fps, the converter duplicates frames to reach constant 60.
- The 3D vehicle viewer in the front-end Help pages (`VehicleViewer`) is not part of any shot and has not been tested with the compositor.
