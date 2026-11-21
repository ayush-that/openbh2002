// Screen layout tables from bh2.ews, in normalised 640x480 coordinates [x, y, w, h] and texture UVs [u0, v0, u1, v1].
export type Rect = [number, number, number, number]
export type UV = [number, number, number, number]

/** Menu bar (FUN_00403ed0 -> FUN_00401040): rect, normal UV, selected UV in botones.tga. */
export const BAR: { rect: Rect; uv: UV; uvSel: UV }[] = [
  { rect: [0.2031, 0.0125, 0.1109, 0.0541], uv: [0, 0, 0.27773, 0.1015], uvSel: [0, 0.3046, 0.27773, 0.4062] }, // FILE
  { rect: [0.3234, 0.0125, 0.1109, 0.0541], uv: [0.2773, 0, 0.5507, 0.1015], uvSel: [0.2773, 0.3046, 0.5507, 0.4062] }, // OPTIONS
  { rect: [0.4437, 0.0125, 0.1109, 0.0541], uv: [0.5507, 0, 0.8281, 0.1015], uvSel: [0.5507, 0.3046, 0.8281, 0.4062] }, // CREDITS
  { rect: [0.564, 0.0125, 0.1109, 0.0541], uv: [0, 0.1015, 0.27773, 0.2031], uvSel: [0, 0.4062, 0.27773, 0.5078] }, // HELP
  { rect: [0.6843, 0.0125, 0.1109, 0.0541], uv: [0.2773, 0.1015, 0.5507, 0.2031], uvSel: [0.2773, 0.4062, 0.5507, 0.5078] }, // QUIT
  { rect: [0.2421, 0.9333, 0.2, 0.0541], uv: [0, 0.2031, 0.5, 0.3007], uvSel: [0, 0.5078, 0.5, 0.6054] }, // WEAPONS CHART
  { rect: [0.4515, 0.9333, 0.1031, 0.0541], uv: [0.5546, 0.1015, 0.8125, 0.2031], uvSel: [0.5546, 0.4062, 0.8125, 0.5078] }, // PLAY
  { rect: [0.564, 0.9333, 0.2, 0.0541], uv: [0.5039, 0.2031, 1, 0.3007], uvSel: [0.5039, 0.5078, 1, 0.6054] }, // SCORE CHART
]

/** Dropdowns (FUN_00401100 / FUN_004010c0): bar item -> row count and first-row y. Rows are 0.05416 apart. */
export const DROPDOWN_ROWS: Record<number, { rows: number; y0: number }> = {
  0: { rows: 5, y0: 0.3583 },
  1: { rows: 3, y0: 0.41246 },
  3: { rows: 3, y0: 0.41246 },
}
export const ROW_X = 0.2718
export const ROW_W = 0.4515
export const ROW_H = 0.0604
export const ROW_STEP = 0.05416
export const ROW_HILITE_UV: UV = [0, 0.6093, 1, 0.7304]
export const DROPDOWN_RECT: Rect = [0.2953, 0.2333, 0.4, 0.5333]

/** Title screen (FUN_00402050 case 0/3): credits, exit, help, play, file ("load game.tga"). */
export const TITLE_DRAW: Rect[] = [
  [0.8, 0.5395, 0.2, 0.1333],
  [0, 0.8666, 0.2, 0.1333],
  [0.1562, 0.8666, 0.2, 0.1333],
  [0.4046, 0.8666, 0.2, 0.1333],
  [0.6890625, 0.8666, 0.2, 0.1333],
]
export const TITLE_HIT_A: Rect[] = [
  [0.8, 0.5395, 0.2, 0.1333],
  [0, 0.8666, 0.125, 0.0625],
  [0.1562, 0.8666, 0.2, 0.1333],
  [0.4046, 0.8666, 0.2, 0.1333],
  [0.6890625, 0.8666, 0.2, 0.1333],
]
export const TITLE_HIT_B: Rect[] = [
  [0.8, 0.5395, 0.2, 0.1333],
  [0, 0.8666, 0.125, 0.0625],
  [0.1562, 0.8666, 0.2, 0.1333],
  [0.47, 0.497, 0.18, 0.503],
  [0.6890625, 0.8666, 0.2, 0.1333],
]
export const GUN_RECT: Rect = [0.33, 0.497, 0.349, 0.503]
/** Unhovered title buttons are drawn faint; alpha measured from captures of the original (~0.18). */
export const TITLE_IDLE_ALPHA = 0.18

/** Door close easing in state 1 (one entry per frame), FUN_00402050 local_134[0x3c..0x4c]. */
export const DOOR_STEPS = [0.041, 0.082, 0.123, 0.164, 0.205, 0.246, 0.287, 0.328, 0.364634, 0.396901, 0.424801, 0.448335, 0.467503, 0.482304, 0.492304, 0.499304, 0.500304]

/** 2x2 "ficha" card: 512x384 at (62, 48); bottom tiles are 256x128. */
export const CARD: Rect[] = [
  [0.096875, 0.1, 0.4, 0.53333336],
  [0.496875, 0.1, 0.4, 0.53333336],
  [0.096875, 0.6333333, 0.4, 0.26666668],
  [0.496875, 0.6333333, 0.4, 0.26666668],
]
/** fondo01..04 (FUN_00405750). */
export const FONDO: Rect[] = [
  [0.1, -0.0333, 0.4, 0.5333],
  [0.5, -0.0333, 0.4, 0.5333],
  [0.1, 0.5, 0.4, 0.5333],
  [0.5, 0.5, 0.4, 0.5333],
]

/** Bottom/top nav buttons (FUN_00406d40): plate rect + UV, label rect. Slots: top-left, top-right, bottom-left, bottom-right. */
export const NAV_PLATES: { rect: Rect; uv: UV }[] = [
  { rect: [0.215625, 0.09375, 0.2, 0.06666667], uv: [0, 0, 0.5, 0.125] },
  { rect: [0.58125, 0.09375, 0.2, 0.06666667], uv: [0.49609375, 0, 1, 0.125] },
  { rect: [0.215625, 0.83958334, 0.2, 0.06666667], uv: [0, 0.12890625, 0.5, 0.25] },
  { rect: [0.58125, 0.83958334, 0.2, 0.06666667], uv: [0.49609375, 0.12890625, 1, 0.25] },
]
export const NAV_LABELS: Rect[] = [
  [0.253125, 0.104166664, 0.125, 0.033333335],
  [0.621875, 0.104166664, 0.125, 0.033333335],
  [0.253125, 0.86041665, 0.125, 0.033333335],
  [0.621875, 0.86041665, 0.125, 0.033333335],
]
/** Label UVs per action: SAVE LOAD CANCEL YES NO EXIT JOYSTICK KEYBOARD MOUSE SCHEMATIC TESTIMONIALS DATA INTERFACE GAME. */
export const NAV_UV: UV[] = [
  [0, 0.25390625, 0.3125, 0.3125],
  [0.3125, 0.25390625, 0.625, 0.3125],
  [0.625, 0.25390625, 0.9375, 0.3125],
  [0, 0.37890625, 0.3125, 0.4375],
  [0.3125, 0.37890625, 0.625, 0.4375],
  [0.625, 0.37890625, 0.9375, 0.4375],
  [0, 0.50390625, 0.3125, 0.5625],
  [0.3125, 0.50390625, 0.625, 0.5625],
  [0.62890625, 0.50390625, 0.9375, 0.5625],
  [0, 0.62890625, 0.3046875, 0.6875],
  [0.3125, 0.62890625, 0.625, 0.6875],
  [0.625, 0.62890625, 0.9375, 0.6875],
  [0, 0.75, 0.3046875, 0.8125],
  [0.3125, 0.75, 0.625, 0.8125],
]
export const NAV_UV_HOVER: UV[] = [
  [0, 0.31640625, 0.3125, 0.375],
  [0.3125, 0.31640625, 0.625, 0.375],
  [0.625, 0.31640625, 0.9375, 0.375],
  [0, 0.44140625, 0.3125, 0.5],
  [0.3125, 0.44140625, 0.625, 0.5],
  [0.625, 0.44140625, 0.9375, 0.5],
  [0, 0.56640625, 0.3125, 0.625],
  [0.3125, 0.56640625, 0.625, 0.625],
  [0.625, 0.56640625, 0.9375, 0.625],
  [0, 0.69140625, 0.3046875, 0.75],
  [0.3125, 0.69140625, 0.625, 0.75],
  [0.62890625, 0.69140625, 0.9375, 0.75],
  [0, 0.81640625, 0.3046875, 0.875],
  [0.3125, 0.81640625, 0.625, 0.875],
]

/** Page arrows (FUN_00406450 / FUN_004068c0). */
export const ARROW_L: Rect = [0.1, 0.46875, 0.05, 0.06666667]
export const ARROW_R: Rect = [0.8484375, 0.46875, 0.05, 0.06666667]

/** Weapons chart grid (FUN_00407880): cell frame rects, thumbnail rects, thumbnail UVs in listavehiculos01.tga. */
const GX = [0.209375, 0.4015625, 0.5921875]
const GY = [0.16666667, 0.3875, 0.60833335]
const TX = [0.2203125, 0.4125, 0.6046875]
const TY = [0.18125, 0.4, 0.62083334]
const U = [
  [0, 0.33203125],
  [0.3359375, 0.6640625],
  [0.66796875, 1],
]
export const GRID_FRAME: Rect[] = []
export const GRID_THUMB: Rect[] = []
export const GRID_UV: UV[] = []
for (let i = 0; i < 9; i++) {
  const c = i % 3, r = Math.floor(i / 3)
  GRID_FRAME.push([GX[c], GY[r], 0.2078125, 0.24166666])
  GRID_THUMB.push([TX[c], TY[r], 0.1765625, 0.19791667])
  GRID_UV.push([U[c][0], U[r][0], U[c][1], U[r][1]])
}
export const GRID_FRAME_UV: UV = [0.5, 0, 0.75, 0.25]
export const CURSOR_UV: UV = [0.75391, 0, 1, 0.25]

/** Save/load slot rows (FUN_00408850): x, y in 640x480 pixels; rows are 194x20. */
export const SLOTS: [number, number][] = Array.from({ length: 20 }, (_, i) => [i < 10 ? 0x7e : 0x141, [0x7c, 0x91, 0xa6, 0xbb, 0xd0, 0xe5, 0xfa, 0x10f, 0x124, 0x13a][i % 10]])
/** Score rows (FUN_00409850): name at x 154, score right-aligned at 369. */
export const SCORE_Y = [0x94, 0xac, 0xc4, 0xdc, 0xf4, 0x10c, 0x124, 0x13c, 0x154, 0x16c]
