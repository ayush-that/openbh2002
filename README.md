# OpenBH2002

An open-source engine that plays Beach Head 2002 in the browser. It reimplements the original game from reverse-engineered behaviour and loads the original game files at runtime from a separate host. No game content is stored in this repository.

## Play

1. Open [bh2002.ayushworks.com](https://bh2002.ayushworks.com) in a browser with WebGPU or WebGL2 (desktop or mobile).
2. The game files load automatically.

Controls: mouse to aim, hold left button to fire, `Space` switch weapon, `m` missile, `f` flare (night), `b` bomber strike, `p` pause, `Esc` menu. `Shift+T` switches between the faithful 2001 look and the remaster.

## Develop

```sh
cd engine
npm install
npm run dev
```

The dev server serves a local game copy from `../BEACHHEAD2002` (or `BH2002_DIR`) at `/gamedata/`. Without one, it loads the hosted copy from `gamedata.ayushworks.com`.

- `?level=N` starts a level directly, `?mode=remaster`, `?time=night`, `?debug`.
- `?autoplay=1-99&seed=42&speed=8` plays levels through the real input path and writes reports to `artifacts/e2e/`.

Architecture and format notes: [`engine/docs`](engine/docs).

## Legal

Beach Head 2002 is a trademark of its respective owners. The game files served at `gamedata.ayushworks.com` are used under license.
