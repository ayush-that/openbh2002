# Loading the player's game files

The site never ships game content. `src/ui/import.ts` (`chooseGameFS`) asks for the player's copy once, keeps the files the engine needs in browser storage, and opens from there on later visits. Readers and storage live in `src/vfs.ts`.

## Sources

| Source | How it is read |
| --- | --- |
| Folder (CD, CD copy, installed copy) | `showDirectoryPicker()` where available, else `<input webkitdirectory>`, or dropping the folder (`webkitGetAsEntry`) |
| `.zip` | Own central-directory reader (stored and deflate, Zip64, UTF-8 or cp1252 names) with `fflate` `inflateSync` per file. Only the requested entries are read, so the archive is never loaded whole. |
| `.iso` | Own ISO 9660 reader. Uses the Joliet tree when present (the CD needs it: names like `beachhead titulo.tga` do not fit plain ISO 9660 names), else the primary tree. |
| Loose files | `<input multiple>`. Only works when the files carry their folder paths (a dropped or picked folder). Picked `.zip`/`.iso` files are expanded. |

The game root is found anywhere in the chosen tree by looking for `BH2Game/Geometry.3D` (shallowest match wins), so a zip with an extra parent folder, the CD root, or `Program Files/Infogrames Interactive/Beach Head 2002` (the installer's default target, see `setup.ins`) all work. The installer copies `BH2Game/`, `Fichas/` and `vehicles/` from the CD as-is, so installed copies have the same layout under the root.

Required files (a short error lists any that are missing): `BH2Game/Geometry.3D`, `BH2Game/ShapeData`, `BH2Game/MMap1501x1501.mmap`, `BH2Game/HMap1501x1501.hmap`, `BH2Game/TerrainClose01.t24`, `Fichas/TEXMENU/ini01.tga`, `Fichas/sfx/Menu.xm`, `vehicles/apc1.3DB`.

Packed textures: any `.t24`, `.r24` or opaque `.tga` may instead ship as lossless WebP named after it (`Sky1.t24.webp`). `GameFS` lists and reads it under the original name and decodes it back to the original layout (raw RGB, or an uncompressed 24-bit TGA), so nothing else in the engine knows. This roughly halves a zip of upscaled textures. A WebP is limited to 16383 px per side, so very tall sprite strips stay raw.

## Platform support

From MDN browser-compat-data (November 2026).

| Platform | Folder | Zip / ISO | Drop |
| --- | --- | --- | --- |
| Chrome / Edge desktop | `showDirectoryPicker` (86+) | yes | folder or file |
| Firefox desktop | `webkitdirectory` (50+) | yes | folder or file |
| Safari macOS | `webkitdirectory` (11.1+) | yes | folder or file |
| iOS / iPadOS Safari | `webkitdirectory` from 18.4 (earlier versions ignore it) | yes | n/a |
| Android Chrome | `showDirectoryPicker` / `webkitdirectory` from 132 | yes | n/a |
| Firefox Android | `webkitdirectory` from 142 | yes | n/a |

On phones, a `.zip` is the most reliable path: the iOS Files app and most Android file managers can compress a folder into one.

## Storage

- Kept: `BH2Game/**`, `Fichas/**`, `vehicles/**`, `BH2002.ini` (high scores and settings defaults). Skipped: installers, `DirectX/`, `DATARUS/`, executables, `.DS_Store` / `._*` / `Thumbs.db`.
- Size: 401 files, 74,204,037 bytes (70.8 MiB) from the English CD.
- Backend: OPFS (`navigator.storage.getDirectory()`, one flat directory `openbh2002/`, paths URI-encoded) when `createWritable()` exists (Chrome 86+, Android Chrome 109+, Firefox 111+, Safari 26+). Otherwise IndexedDB (`openbh2002` database, ArrayBuffer values).
- A manifest is written last, so an interrupted copy is never opened. A failed write clears that backend and tries the next one. If no storage works (quota, private browsing), the game runs from the chosen source for that session.
- After a copy, `navigator.storage.persist()` is requested. Chrome and Safari grant or deny silently based on site engagement. Firefox asks the user. Without it, data is best effort: Chrome rarely evicts. Safari deletes script-written data for sites with no user interaction in 7 days of browser use, unless the site is added to the Home Screen.
- Quotas are far above 71 MiB in current browsers (Chrome and Safari 17+: about 60% of disk per origin; Firefox: 10% of disk or 10 GiB).
- `gameFilesInfo()` returns `{ backend, files, bytes }` or `null`. `forgetGameFiles()` deletes the OPFS directory and the IndexedDB database. The next `chooseGameFS()` call shows the import screen again.

## Limits

- Multi-extent ISO files, Rock Ridge names, UDF-only images, and encrypted or non-deflate zip entries are not supported. The Beach Head 2002 CD does not need them.
- A non-Joliet ISO has uppercase 8.3 names that do not match the game's file names, so validation fails.
- Picking a very large tree (more than 50,000 files) stops with "Folder too large".
- `showDirectoryPicker` and folder drop need a real user gesture and cannot be scripted. They were checked by code review, not automation.
