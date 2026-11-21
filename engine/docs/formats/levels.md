# Level scripts, menu/game handoff, and small data files

Parser: `src/formats/level.ts`. Check: `npx tsx scripts/check-levels.ts` (from `engine/`).

Confidence labels:

- **code**: confirmed in the disassembly of `BH2Game/BH2.exe`, `bh2.ews` or `BH2002.exe` (addresses given).
- **data**: inferred from the shipped files only.
- **unknown**: not determined.

## Level_NN scripts

### How BH2.exe reads them (code, `0x429201`)

- File name: `Level_0%d` for level 1-9, `Level_%d` for 10-99. Above 99 the game loads `Level_(level % 10 + 91)`, so it cycles 91..100. `Level_100` does not ship; a level ending in 9 past 99 would fail to open.
- The parser reads one whitespace-separated token at a time with `fscanf("%s")` and compares it, case-sensitively (`strcmp`), against every keyword in turn. It has no concept of lines or comments.
- `//` and `/*** ... ***/` only "work" because `//Delay` or `/***` never equals a keyword. A keyword separated by a space inside a comment (e.g. `// Delay 5`) would execute. None of the 99 files do this (the parser warns if one ever does).
- Numeric arguments use `fscanf("%d")`. A missing number consumes nothing; the next word is then read as a keyword. The target keeps its old value. Leading zeros are fine (`05` = 5).
- Unknown words are skipped silently, along with their numbers (each number is just another unmatched token).
- `End` stops parsing. Without `End`, the loop never terminates at EOF.

### Object slots

Enemies live in one global object table. `Object TYPE` points a cursor at the type's first slot and marks it present. `ObjectInc` advances the cursor by one and marks that slot present. There is no bounds check, so going past a type's capacity spills into the next slots (code).

| Type | Slots | Capacity | Kill-quota weight | Notes |
| --- | --- | --- | --- | --- |
| TANK | 37-48 | 12 | 10 | MBT70 |
| APC1 | 73-76 | 4 | 6 | "basic"; all APCs carry 6 soldiers (data comment) |
| APC2 | 77-80 | 4 | 11 | gun turret |
| APC3 | 81-84 | 4 | 11 | missile turret |
| JET | 117-132 | 16 | 10 | F104 |
| BOMBER | 133-141 | 9 | not counted | Player's B-58 air strike (see `Bombers`). Never used as `Object` in the data. |
| COBRA | 142-153 | 12 | 10 | |
| CH53 | 178-185 | 8 | 6 | carries 6 soldiers (data comment) |
| C130 | 210-217 | 8 | troops1 + troops2 | |

The "maximum N" comments in the scripts match these capacities exactly.

Overruns in the shipped data (code-level effect, gameplay effect **unknown**): Level_32 has 11 APC3 (slots 81-91, seven of them past capacity), Level_79 has 13 COBRA (slot 154). Those extra slots are not counted in the kill quota.

### Directives

| Directive | Args | Meaning | Confidence |
| --- | --- | --- | --- |
| `Ammo b p m f` | 4 ints | Starting bullets, projectiles (cannon shells), missiles, flares. Clamped above to 500/20/20/20, no lower clamp. With 0 bullets the game starts in weapon mode 2 instead of the gun. | code (fields, clamps); data (names from the script comment) |
| `Aggression t j hg hr` | 4 ints | Enemy fire rates: tank, jet, helicopter gun, helicopter rocket. Stored as `320+t`, `500+j`, `40+hg`, `50+hr` and compared each check against a shared random value; a unit fires when the value falls in `[base, base+N]`, so the chance grows linearly with N. Not reset per level: if absent, the previous level's values stay (initial values 1,3,3,3, which matches the "default 1,3,3,3" comment). Scripts use 1-9. | code |
| `Daytime` | none | Day lighting. Night is the default; the loader resets to night before each level. | code |
| `Spotlight` | none | Enemy searchlight. Only takes effect if no `Daytime` appeared earlier in the file (order matters). | code (flag); data (meaning) |
| `Crosshair` | none | Turns on the crosshair. Never reset by the loader (sticky across levels). All 99 levels set it. | code (flag); data (meaning) |
| `Bombers` | none | Enables the player's B-58 air strike for this level (one use, `b` key, activates slots 133-141). | code |
| `AltGun` | none | Alternate player gun model (slot 23 instead of 20-22). | code (switch); unknown (which gun) |
| `AltGun2` | none | Second alternate gun model (slot 25). Last of AltGun/AltGun2 wins; default 0 each level. | code |
| `Object TYPE` | 1 word | Start a group: cursor to the type's first slot, mark it present. TYPE is one of the table above (`BOMBER` is accepted). Unknown TYPE leaves the cursor where it is and re-marks that slot. `Object C130` also resets the C130 record index to 0. | code |
| `ObjectInc` | none | Next slot, marked present. Also advances the C130 record index (whatever the group). | code |
| `Delay N` | 1 int | Applies to the current slot: hide it and spawn it after N frames. N <= 0 means it never spawns (the countdown only fires when it reaches exactly 0). Without `Delay`, a unit is present at level start. The countdown pauses with the game. | code |
| `North` / `South` / `East` / `West` | none | Arrival side for the current slot's group (codes 1-4). One value per group, last wins; all three APC types share one value. Default 0 (engine default, behaviour **unknown**). C130 heading: North 180°, South 0°, East 90°, West 270°. Outside any group (Level_55, Level_69, where the group is commented out) it does nothing. | code |
| `passes N` | 1 int | C130 run-ins, clamped 1-127. Default 127. | code (field); data (name) |
| `troops1 N` / `troops2 N` | 1 int | C130 paratroopers, two waves, clamped 0-16. Their sum is the C130's kill-quota weight. | code |
| `hdrop` / `adrop` / `pdrop` / `mdrop N` | 1 int | C130 crate drops of kinds 0, 1, 2, 3, clamped 0-4. What each crate contains is **unknown** (h/a/p/m suggest health/ammo/?/missiles). | code (fields, clamps) |
| `far` | none | Lowercase only. C130 drop point uses a wider random offset (drops further out). | code (flag); data (meaning) |
| `alternate` | none | Clears C130 record byte +1 (default 1). Not used in any script. Meaning **unknown**. | code |
| `End` | none | Stop parsing. | code |

C130 fields write to record `index` (0-7), not to the current slot. The index is reset by `Object C130` and advanced by every `ObjectInc`, so within a C130 group it equals `slot - 210`. They read a shared integer scratch value: `mdrop` with no number (Level_13 line 132) reuses the previous C130 number (`troops1 6`), clamped to 4.

Unit order matters per group: `Object`, then alternating `Delay`/C130 fields and `ObjectInc`. A field after `ObjectInc` belongs to the new unit.

### Words the scripts use that BH2.exe ignores (code: no such keyword string in BH2.exe)

| Word | Uses | Note |
| --- | --- | --- |
| `Far` | 83 | Capitalised, so `strcmp` against `far` fails. Those C130s use the normal drop point. Only 2 lowercase `far` are live. |
| `Nightime` | 26 | No-op; night is already the default. |
| `pasess` | 4 | Typo; `passes` stays at its default 127. |
| `troops`, `troops3`, `troops4`, `troops5` | 7 | No such keywords. |
| `Artillery`, `AltCannon` | always commented | Removed features. The loader still resets an "alt cannon" flag that no keyword sets. |

The parser reports these in `LevelScript.ignored`; the check script fails on anything else.

### Units of Delay (code, `0x4050f1`, `0x401e17`)

Delays count frames. The main loop calls the countdown once per frame. Frames are capped by a busy-wait on `GetTickCount` until more than 28 ms have passed, so one frame is at least 29 ms (about 31-34 fps depending on timer resolution). Slower machines stretch delays. A browser port should advance the script clock at a fixed ~33 Hz (30 ms per tick) rather than per rendered frame.

### Kill quota and level progression (code, `0x42a3a9`, `0x402978`)

After parsing, the game sums the weights of every slot that is present or still counting down (table above). Kills subtract from it. When it drops below 0.0001 the game waits 150 frames, increments the level and loads the next script itself. There is no menu round trip between levels. The game only exits on death or Esc.

The `=` key zeroes the quota (debug skip). Running out of all ammo with enemies left ends the game (code at `0x402070`, details partly **unknown**).

### Campaign

- Levels 1-99 all ship and are all distinct; there are no gaps. The menu starts at level 1 or at a saved level.
- Level_95-99 are ordinary late levels (95-98 night, 99 day). They are also the tail of the endless cycle: after 99 the game replays 91-99 (and the missing `Level_100`) forever.
- Night levels: 11, 12, 21-24, 36-39, 51-54, 66-69, 81-84, 95-98.
- The 74/89 pair (`Ammo 9 5 5 5`, Delay 40) are short ammo-starved levels.

## Menu <-> game handoff

Processes (code, `BH2002.exe`):

1. `BH2002.exe` starts `BH2.EWS intro`.
2. The menu writes `BH2Game/BeachheadIn` and exits. Exit code 0 means quit; any other code makes the launcher start `./bh2game/bh2.exe` with working directory `./bh2game/`.
3. When the game exits, the launcher restarts `BH2.EWS` without `intro`. The menu reads `BH2Game/BeachheadOut`.

### BeachheadIn (menu writes `"%d\n"` x6 at `0x409390`; game reads `"%d%d%d%d%d%d"` at `0x429058`)

| Line | Shipped | Game meaning | Menu source |
| --- | --- | --- | --- |
| 1 | 1 | Starting level | current/loaded level |
| 2 | 800 | Screen width: 640, 800 or 1024 (height 480/600/768). Other values render as 640x480. | ini `Resolution` 0/1/2 |
| 3 | 1 | Accelerated horizontal mouse look (in-game toggle `a`) | ini `MouseInvert` |
| 4 | 0 | Inverted vertical look (in-game toggle `i` or `r`) | ini `MouseMode` |
| 5 | 1 | Sound effects on (in-game toggle `s`) | ini `Fx` |
| 6 | 16 | Pixel format: 15 = RGB555, 16 = RGB565 | detected by the menu |

Lines 3 and 4 look swapped between the two programs: the menu writes its `MouseInvert` setting where the game expects the acceleration flag, and `MouseMode` where it expects invert. Both sides are code-confirmed; which in-menu label the player sees is **unknown**. A port should map line 3 to acceleration and line 4 to invert, as the game does.

### BeachheadOut (game writes `"%d\n%d\n"` at `0x4291b5`; menu reads at `0x409420`)

| Line | Meaning |
| --- | --- |
| 1 | Result: 0 = died (game over), 1 = quit with Esc. The game uses 3 internally for "running" and never writes it. |
| 2 | Level reached |

The shipped file (`1`, `1`) is from a quit on level 1.

## Scores and saves (code, `bh2.ews`)

- The score is the level reached. After a game ending in death (result 0), if the level beats the 10th entry, the menu asks for a name and inserts it into the table.
- High scores live in `BH2002.ini`: `[NAMESCORES] Name01..Name10` and `[SCORES] Score01..Score10`. The shipped table is 50, 30, 25, 20, 15, 13, 11, 9, 7, 5.
- Saves: 20 slots, `.\SAVE\00000001.sav` .. `00000020.sav` (listed with `FindFirstFile(".\SAVE\*.sav")`). Each file is 54 bytes, all ASCII, NUL-padded fields:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 30 | Save name |
| 30 | 10 | Level (decimal) |
| 40 | 10 | Screen width (decimal) |
| 50 | 2 | Value for BeachheadIn line 4 (ini MouseMode) |
| 52 | 2 | Value for BeachheadIn line 3 (ini MouseInvert) |

Loading reads the same fields back with `atoi`. `Save/` ships empty.

## BH2002.ini (code, `bh2.ews` `0x409460`, `0x4095c0`)

Read with `GetPrivateProfileIntA`, written with `WritePrivateProfileStringA`.

| Key | Meaning |
| --- | --- |
| `[SCREEN] ResX`, `ResY` | Menu display mode |
| `[SETTINGS] Resolution` | Game resolution: 0 = 640, 1 = 800, 2 = 1024 (other values reset to 0) |
| `Music` | Menu music (XM). Values other than 0/1 become 1. Not passed to the game. |
| `Fx` | Sound effects. Becomes BeachheadIn line 5. |
| `MouseMode` | Values other than 0/1 become 0. Becomes BeachheadIn line 4. |
| `MouseInvert` | Values other than 0/1 become 0. Becomes BeachheadIn line 3. |
| `Texturas` | Menu option, saved only. Never passed to the game. |
| `[NAMESCORES]`, `[SCORES]` | High-score table (above) |

## Other root files (not used by the game)

| File | What it is |
| --- | --- |
| `lang.dat` | InstallShield setup-language strings, one `[0xLCID]` section per language |
| `os.dat` | InstallShield platform bitmask table |
| `layout.bin` | InstallShield media layout (lists the setup files on the disc) |
| `DATA.TAG` | InstallShield tag: Infogrames, BeachHead 2002, 1.00.000 |
| `lbl` | Disc label text `BH2002` |

Neither executable references these file names.
