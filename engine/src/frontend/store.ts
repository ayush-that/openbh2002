// Persistent front-end state in localStorage, standing in for ./BH2002.ini and ./SAVE/*.sav.
import type { GameFS } from '../vfs'
import { parseBh2002Ini } from '../formats/level'

const KEY_SETTINGS = 'bh2002.settings'
const KEY_SCORES = 'bh2002.scores'
const saveKey = (slot: number) => `bh2002.save.${String(slot + 1).padStart(8, '0')}.sav`

/** [SETTINGS] values as bh2.ews keeps them (FUN_00409460), all 0/1 except resolution 0/1/2. */
export interface Settings {
  resolution: number
  music: number
  fx: number
  /** 0 = MOUSE NORMAL, 1 = MOUSE REVERSE (BeachheadIn field 4). */
  mouseMode: number
  /** 0 = MOUSE LOOSE, 1 = MOUSE TIGHT (BeachheadIn field 3). */
  mouseInvert: number
  texturas: number
}

/** High-score row. The score is kept as a string like the ini (10 chars) and compared with atoi. */
export interface ScoreRow {
  name: string
  score: string
}

const DEFAULT_SCORES = [50, 30, 25, 20, 15, 13, 11, 9, 7, 5]

export const atoi = (s: string) => {
  const m = /^\s*[+-]?\d+/.exec(s)
  return m ? parseInt(m[0], 10) : 0
}

function read<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key)
    return s ? (JSON.parse(s) as T) : null
  } catch {
    return null
  }
}

export class Store {
  settings: Settings
  scores: ScoreRow[]
  private seedScores: ScoreRow[]

  private constructor(settings: Settings, seed: ScoreRow[]) {
    this.seedScores = seed
    this.settings = { ...settings, ...read<Partial<Settings>>(KEY_SETTINGS) }
    const s = this.settings
    // FUN_00409460 clamps out-of-range values.
    if (s.music !== 0 && s.music !== 1) s.music = 1
    if (s.fx !== 0 && s.fx !== 1) s.fx = 1
    if (s.mouseMode !== 0 && s.mouseMode !== 1) s.mouseMode = 0
    if (s.mouseInvert !== 0 && s.mouseInvert !== 1) s.mouseInvert = 0
    if (![0, 1, 2].includes(s.resolution)) s.resolution = 0
    this.scores = this.loadScores()
  }

  /** Defaults come from the user's BH2002.ini when present, else the shipped values. */
  static async open(fs: GameFS): Promise<Store> {
    const defaults: Settings = { resolution: 1, music: 1, fx: 1, mouseMode: 0, mouseInvert: 1, texturas: 0 }
    let seed = DEFAULT_SCORES.map((n) => ({ name: 'BEACH HEAD', score: String(n) }))
    if (fs.has('BH2002.ini')) {
      const ini = parseBh2002Ini(await fs.text('BH2002.ini'))
      defaults.resolution = ini.gameWidth === 800 ? 1 : ini.gameWidth === 1024 ? 2 : 0
      defaults.music = +ini.music
      defaults.fx = +ini.fx
      defaults.mouseMode = +ini.mouseMode
      defaults.mouseInvert = +ini.mouseInvert
      defaults.texturas = +ini.texturas
      seed = ini.highScores.map((h) => ({ name: h.name.slice(0, 29), score: String(h.level) }))
    }
    return new Store(defaults, seed)
  }

  /** FUN_004095c0: written on every menu exit. */
  saveSettings() {
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(this.settings))
  }

  /** FUN_00409720: (re)read the table, discarding unsaved edits. */
  loadScores(): ScoreRow[] {
    const s = read<ScoreRow[]>(KEY_SCORES)
    this.scores = s && s.length === 10 ? s.map((r) => ({ name: String(r.name), score: String(r.score) })) : this.seedScores.map((r) => ({ ...r }))
    return this.scores
  }

  /** FUN_004097c0 */
  saveScores() {
    localStorage.setItem(KEY_SCORES, JSON.stringify(this.scores))
  }

  /** FUN_00409980: does `level` beat entry 10? */
  qualifies(level: number) {
    return atoi(this.scores[9].score) < level
  }

  /** FUN_004099a0 + FUN_004099e0: first row with a lower score; shift down and insert an empty name. */
  insertScore(level: number): number {
    const rank = this.scores.findIndex((r) => atoi(r.score) < level)
    if (rank < 0) return -1
    this.scores.splice(rank, 0, { name: '', score: String(level) })
    this.scores.length = 10
    return rank
  }

  /** FUN_00408f80: labels (first 30 bytes) of the 20 slots; empty when the file does not exist. */
  slotNames(): string[] {
    return Array.from({ length: 20 }, (_, i) => {
      const rec = this.readSlot(i)
      return rec ? rec.name : ''
    })
  }

  readSlot(slot: number): SaveRecord | null {
    const hex = localStorage.getItem(saveKey(slot))
    if (!hex || hex.length !== SAVE_SIZE * 2) return null
    const b = new Uint8Array(SAVE_SIZE)
    for (let i = 0; i < SAVE_SIZE; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16)
    return decodeSave(b)
  }

  writeSlot(slot: number, rec: SaveRecord) {
    const b = encodeSave(rec)
    localStorage.setItem(saveKey(slot), Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''))
  }
}

// ---- Save files: 54 bytes, ASCII, NUL padded (FUN_004090e0 / FUN_00409200) ----

export const SAVE_SIZE = 54

export interface SaveRecord {
  /** name[30] */
  name: string
  /** level[10], itoa */
  level: number
  /** width[10]: 640/800/1024 */
  width: number
  /** MouseMode[2] (0 normal / 1 reverse) */
  mouseMode: number
  /** MouseInvert[2] (0 loose / 1 tight) */
  mouseInvert: number
}

function putStr(b: Uint8Array, off: number, len: number, s: string) {
  for (let i = 0; i < len - 1 && i < s.length; i++) b[off + i] = s.charCodeAt(i) & 0xff
}

function getStr(b: Uint8Array, off: number, len: number) {
  let s = ''
  for (let i = off; i < off + len && b[i]; i++) s += String.fromCharCode(b[i])
  return s
}

export function encodeSave(r: SaveRecord): Uint8Array {
  const b = new Uint8Array(SAVE_SIZE)
  putStr(b, 0, 30, r.name)
  putStr(b, 30, 10, String(r.level))
  putStr(b, 40, 10, String(r.width))
  putStr(b, 50, 2, String(r.mouseMode))
  putStr(b, 52, 2, String(r.mouseInvert))
  return b
}

export function decodeSave(b: Uint8Array): SaveRecord {
  return {
    name: getStr(b, 0, 30),
    level: atoi(getStr(b, 30, 10)),
    width: atoi(getStr(b, 40, 10)),
    mouseMode: atoi(getStr(b, 50, 2)),
    mouseInvert: atoi(getStr(b, 52, 2)),
  }
}
