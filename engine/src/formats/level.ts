// BH2Game/Level_NN wave scripts, BeachheadIn/BeachheadOut menu<->game handoff, BH2002.ini.
// Semantics follow the parser in BH2.exe (0x429201); see docs/formats/levels.md.
//
// The original reads whitespace-separated tokens with fscanf("%s") and compares each one,
// case-sensitively, against every keyword. Lines and comments have no meaning to it: "//Delay"
// is just a token that matches nothing. Numeric arguments are read with fscanf("%d"), so a
// missing number consumes nothing and leaves the previous value in place. This parser
// reproduces that token stream; line and comment tracking only feeds diagnostics.

export type ObjectType = 'TANK' | 'APC1' | 'APC2' | 'APC3' | 'JET' | 'BOMBER' | 'COBRA' | 'CH53' | 'C130'
export type DirectionGroup = 'tank' | 'apc' | 'jet' | 'bomber' | 'cobra' | 'ch53' | 'c130'
export type Direction = 'North' | 'South' | 'East' | 'West'

/** Global object-table slots each type occupies. ObjectInc walks slots without bounds checks. */
export const OBJECT_SLOTS: Record<ObjectType, { first: number; count: number }> = {
  TANK: { first: 37, count: 12 },
  APC1: { first: 73, count: 4 },
  APC2: { first: 77, count: 4 },
  APC3: { first: 81, count: 4 },
  JET: { first: 117, count: 16 },
  BOMBER: { first: 133, count: 9 },
  COBRA: { first: 142, count: 12 },
  CH53: { first: 178, count: 8 },
  C130: { first: 210, count: 8 },
}

const DIRECTION_GROUPS: [DirectionGroup, number, number][] = [
  ['tank', 37, 48],
  ['apc', 73, 84],
  ['jet', 117, 132],
  ['bomber', 133, 141],
  ['cobra', 142, 153],
  ['ch53', 178, 185],
  ['c130', 210, 217],
]

/** Kill-quota weight per slot range (C130 slots use troops1 + troops2 instead). */
const QUOTA_WEIGHTS: [number, number, number][] = [
  [37, 48, 10],
  [73, 76, 6],
  [77, 84, 11],
  [117, 132, 10],
  [142, 153, 10],
  [178, 185, 6],
]

/** Words present in the shipped scripts that BH2.exe does not recognise (no effect in the original). */
export const KNOWN_NOOP_WORDS = ['Nightime', 'Artillery', 'AltCannon', 'Far', 'pasess', 'troops', 'troops3', 'troops4', 'troops5']

export interface C130Params {
  /** Run-ins over the beach, 1..127. Default 127. */
  passes: number
  /** Cleared by the unused "alternate" keyword. Meaning unknown. Default true. */
  alternateFlag: boolean
  /** Lowercase "far" only. Drop point further out. */
  far: boolean
  /** Paratroopers per wave, 0..16. */
  troops1: number
  troops2: number
  /** Crate drops of kinds 0..3, 0..4 each. Contents unconfirmed. */
  hdrop: number
  adrop: number
  pdrop: number
  mdrop: number
}

export interface LevelUnit {
  slot: number
  /** Type that owns the slot. Differs from the group type when ObjectInc overruns capacity. */
  slotType: ObjectType | null
  /** null: present at level start. Otherwise frames until it spawns (only counts down while > 0). */
  delay: number | null
  /** False for Delay <= 0: the countdown never hits zero, so the unit never appears. */
  spawns: boolean
  line: number
  c130?: C130Params
}

export interface ObjectGroup {
  type: ObjectType
  line: number
  units: LevelUnit[]
}

export interface IgnoredDirective {
  line: number
  word: string
  args: string[]
}

export interface LevelScript {
  /** Clamped to 500/20/20/20 like the original. null when absent (previous level's values persist). */
  ammo: { bullets: number; projectiles: number; missiles: number; flares: number } | null
  /** Raw 1-9 values. null when absent (previous values persist; .data defaults are 1,3,3,3). */
  aggression: { tank: number; jet: number; heliGun: number; heliRocket: number } | null
  /** Night is the default; only "Daytime" changes it. */
  daytime: boolean
  /** Effective searchlight: "Spotlight" counts only when it comes after no "Daytime". */
  spotlight: boolean
  crosshair: boolean
  /** Enables the player's one-shot B-58 air strike ('b' key). */
  bombers: boolean
  /** 0 default gun, 1 AltGun, 2 AltGun2. */
  altGun: 0 | 1 | 2
  groups: ObjectGroup[]
  /** Per-group arrival side; last one wins. Absent = engine default. */
  directions: Partial<Record<DirectionGroup, Direction>>
  /** Total the player must destroy to finish the level (sum of weights). */
  killQuota: number
  ended: boolean
  ignored: IgnoredDirective[]
  warnings: string[]
}

interface Token {
  text: string
  line: number
  comment: boolean
}

function tokenize(text: string): Token[] {
  const out: Token[] = []
  let inBlock = false
  text.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const trimmed = raw.trim()
    const startsBlock = trimmed.startsWith('/*')
    const comment = inBlock || startsBlock || trimmed.startsWith('//')
    if (startsBlock && !trimmed.includes('*/', 2)) inBlock = true
    else if (inBlock && trimmed.includes('*/')) inBlock = false
    for (const t of trimmed.split(/\s+/)) if (t) out.push({ text: t, line: i + 1, comment })
  })
  return out
}

const slotType = (slot: number): ObjectType | null => {
  for (const [type, r] of Object.entries(OBJECT_SLOTS) as [ObjectType, { first: number; count: number }][])
    if (slot >= r.first && slot < r.first + r.count) return type
  return null
}

const directionGroup = (slot: number): DirectionGroup | null => {
  for (const [g, lo, hi] of DIRECTION_GROUPS) if (slot >= lo && slot <= hi) return g
  return null
}

const defaultC130 = (): C130Params => ({
  passes: 127, alternateFlag: true, far: false, troops1: 0, troops2: 0, hdrop: 0, adrop: 0, pdrop: 0, mdrop: 0,
})

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function parseLevel(text: string): LevelScript {
  const toks = tokenize(text)
  const warnings: string[] = []
  const ignored: IgnoredDirective[] = []
  const level: LevelScript = {
    ammo: null, aggression: null, daytime: false, spotlight: false, crosshair: false, bombers: false,
    altGun: 0, groups: [], directions: {}, killQuota: 0, ended: false, ignored, warnings,
  }

  // Engine state mirrors: per-slot active flag and delay, C130 records, parser locals.
  const active = new Map<number, number>()
  const delay = new Map<number, number>()
  const unitBySlot = new Map<number, LevelUnit>()
  const c130 = Array.from({ length: 8 }, defaultC130)
  let slot = 0
  let c130Index: number | null = null
  let lastInt = 0 // the original's shared %d scratch (ebp-0x50) used by C130 keywords
  let group: ObjectGroup | null = null
  let i = 0

  const readInt = (): number | null => {
    const t = toks[i]
    const m = t && /^[+-]?\d+/.exec(t.text)
    if (!t || !m) return null
    if (m[0].length === t.text.length) i++
    else toks[i] = { ...t, text: t.text.slice(m[0].length) }
    return parseInt(m[0], 10)
  }

  const touch = (s: number, line: number) => {
    let u = unitBySlot.get(s)
    if (!u) {
      u = { slot: s, slotType: slotType(s), delay: null, spawns: true, line }
      unitBySlot.set(s, u)
      if (group) group.units.push(u)
    }
    return u
  }

  const c130Field = (word: string, line: number, apply: (p: C130Params, v: number) => void) => {
    const v = readInt()
    if (v === null) warnings.push(`line ${line}: ${word} has no number; reuses previous value ${lastInt}`)
    else lastInt = v
    if (c130Index === null || c130Index > 7) {
      warnings.push(`line ${line}: ${word} outside a C130 record (index ${c130Index ?? 'unset'})`)
      return
    }
    apply(c130[c130Index], lastInt)
  }

  const C130_INT: Record<string, (p: C130Params, v: number) => void> = {
    passes: (p, v) => (p.passes = clamp(v, 1, 127)),
    troops1: (p, v) => (p.troops1 = clamp(v, 0, 16)),
    troops2: (p, v) => (p.troops2 = clamp(v, 0, 16)),
    hdrop: (p, v) => (p.hdrop = clamp(v, 0, 4)),
    adrop: (p, v) => (p.adrop = clamp(v, 0, 4)),
    pdrop: (p, v) => (p.pdrop = clamp(v, 0, 4)),
    mdrop: (p, v) => (p.mdrop = clamp(v, 0, 4)),
  }
  const DIRS: Direction[] = ['North', 'South', 'East', 'West']

  while (i < toks.length) {
    const tok = toks[i++]
    const w = tok.text
    const line = tok.line
    const known = w in C130_INT || (DIRS as string[]).includes(w) || [
      'Object', 'ObjectInc', 'Delay', 'alternate', 'far', 'Ammo', 'Bombers', 'Aggression', 'Daytime',
      'Spotlight', 'Crosshair', 'AltGun', 'AltGun2', 'End',
    ].includes(w)
    if (known && tok.comment) warnings.push(`line ${line}: keyword "${w}" inside a comment is executed by the original`)

    if (w === 'Object') {
      const t = toks[i++]
      const type = t?.text as ObjectType | undefined
      if (type && type in OBJECT_SLOTS) {
        slot = OBJECT_SLOTS[type].first
        if (type === 'C130') c130Index = 0
        group = { type, line, units: [] }
        level.groups.push(group)
      } else warnings.push(`line ${line}: unknown object type "${t?.text ?? ''}"; re-marks slot ${slot}`)
      active.set(slot, 1)
      touch(slot, line)
    } else if (w === 'ObjectInc') {
      if (!group) warnings.push(`line ${line}: ObjectInc before any Object`)
      slot++
      if (c130Index !== null) c130Index++
      active.set(slot, 1)
      const u = touch(slot, line)
      if (group && u.slotType !== group.type)
        warnings.push(`line ${line}: ${group.type} overflows into slot ${slot} (${u.slotType ?? 'unassigned'})`)
    } else if (w === 'Delay') {
      const v = readInt()
      if (v === null) warnings.push(`line ${line}: Delay without a number`)
      else delay.set(slot, v)
      active.set(slot, 0)
      if (!group) warnings.push(`line ${line}: Delay before any Object (slot ${slot})`)
      else {
        const u = touch(slot, line)
        u.delay = delay.get(slot) ?? 0
        u.spawns = u.delay > 0
        if (!u.spawns) warnings.push(`line ${line}: Delay ${u.delay} never spawns`)
      }
    } else if (w in C130_INT) {
      c130Field(w, line, C130_INT[w])
    } else if (w === 'alternate' || w === 'far') {
      if (c130Index === null || c130Index > 7) warnings.push(`line ${line}: ${w} outside a C130 record`)
      else if (w === 'far') c130[c130Index].far = true
      else c130[c130Index].alternateFlag = false
    } else if (w === 'Ammo') {
      const v = [readInt(), readInt(), readInt(), readInt()]
      const prev = level.ammo ?? { bullets: 0, projectiles: 0, missiles: 0, flares: 0 }
      if (v.includes(null)) warnings.push(`line ${line}: Ammo needs 4 numbers`)
      level.ammo = {
        bullets: Math.min(500, v[0] ?? prev.bullets),
        projectiles: Math.min(20, v[1] ?? prev.projectiles),
        missiles: Math.min(20, v[2] ?? prev.missiles),
        flares: Math.min(20, v[3] ?? prev.flares),
      }
    } else if (w === 'Aggression') {
      const v = [readInt(), readInt(), readInt(), readInt()]
      if (v.includes(null)) warnings.push(`line ${line}: Aggression needs 4 numbers`)
      const prev = level.aggression ?? { tank: 1, jet: 3, heliGun: 3, heliRocket: 3 }
      level.aggression = {
        tank: v[0] ?? prev.tank, jet: v[1] ?? prev.jet, heliGun: v[2] ?? prev.heliGun, heliRocket: v[3] ?? prev.heliRocket,
      }
    } else if (w === 'Bombers') level.bombers = true
    else if (w === 'Daytime') level.daytime = true
    else if (w === 'Spotlight') {
      if (level.daytime) warnings.push(`line ${line}: Spotlight ignored after Daytime`)
      else level.spotlight = true
    } else if (w === 'Crosshair') level.crosshair = true
    else if (w === 'AltGun') level.altGun = 1
    else if (w === 'AltGun2') level.altGun = 2
    else if ((DIRS as string[]).includes(w)) {
      const g = directionGroup(slot)
      if (g) level.directions[g] = w as Direction
      else warnings.push(`line ${line}: ${w} with no object group (slot ${slot})`)
    } else if (w === 'End') {
      level.ended = true
      break
    } else if (!tok.comment) {
      const prev = ignored[ignored.length - 1]
      if (/^[+-]?\d+$/.test(w) && prev && prev.line === line) prev.args.push(w)
      else ignored.push({ line, word: w, args: [] })
    }
  }

  if (!level.ended) warnings.push('no End: the original keeps reading at EOF and never stops')

  for (const g of level.groups)
    for (const u of g.units) {
      const ci = u.slot - OBJECT_SLOTS.C130.first
      if (ci >= 0 && ci < 8) u.c130 = { ...c130[ci] }
    }

  // Kill quota as computed after parsing (0x42a3a9): every slot that is active or still counting down.
  const live = (s: number) => active.get(s) === 1 || (delay.get(s) ?? 0) > 0
  for (const [lo, hi, weight] of QUOTA_WEIGHTS)
    for (let s = lo; s <= hi; s++) if (live(s)) level.killQuota += weight
  for (let k = 0; k < 8; k++) if (live(OBJECT_SLOTS.C130.first + k)) level.killQuota += c130[k].troops1 + c130[k].troops2

  return level
}

/** Script file name for a level number, as BH2.exe builds it. Levels above 99 cycle 91..100; Level_100 does not ship (BH2.exe fails to load it), Game.startLevel plays Level_99 instead. */
export function levelFileName(level: number): string {
  if (level <= 9) return `Level_0${level}`
  if (level > 99) return `Level_${(level % 10) + 91}`
  return `Level_${level}`
}

// ---- BeachheadIn / BeachheadOut ----

export interface BeachheadIn {
  /** Starting level, 1-based. */
  level: number
  /** 640, 800 or 1024 (height 480/600/768). */
  screenWidth: number
  /** In-game 'a' toggle: accelerated horizontal mouse look. The menu fills this from ini MouseInvert. */
  mouseAccel: boolean
  /** In-game 'i'/'r' toggle: inverted vertical look. The menu fills this from ini MouseMode. */
  invertMouse: boolean
  /** In-game 's' toggle: sound effects. From ini Fx. */
  sound: boolean
  /** 15 (RGB555) or 16 (RGB565), detected by the menu. */
  pixelFormat: number
}

export interface BeachheadOut {
  /** 0: player died (high-score check), 1: quit with Esc. */
  result: number
  /** Level the player was on when the game ended (the "score"). */
  level: number
}

const ints = (text: string) => text.trim().split(/\s+/).filter(Boolean).map(t => parseInt(t, 10))

export function parseBeachheadIn(text: string): BeachheadIn {
  const v = ints(text)
  if (v.length < 6 || v.some(Number.isNaN)) throw new Error('BeachheadIn: expected 6 integers')
  return { level: v[0], screenWidth: v[1], mouseAccel: v[2] !== 0, invertMouse: v[3] !== 0, sound: v[4] !== 0, pixelFormat: v[5] }
}

export function formatBeachheadIn(p: BeachheadIn): string {
  const b = (x: boolean) => (x ? 1 : 0)
  return [p.level, p.screenWidth, b(p.mouseAccel), b(p.invertMouse), b(p.sound), p.pixelFormat].join('\n') + '\n'
}

export function parseBeachheadOut(text: string): BeachheadOut {
  const v = ints(text)
  if (v.length < 2 || v.some(Number.isNaN)) throw new Error('BeachheadOut: expected 2 integers')
  return { result: v[0], level: v[1] }
}

export function formatBeachheadOut(p: BeachheadOut): string {
  return `${p.result}\n${p.level}\n`
}

// ---- BH2002.ini ----

/** Sections and keys keep their case; look them up with iniGet (case-insensitive like GetPrivateProfile*). */
export type Ini = Map<string, Map<string, string>>

export function parseIni(text: string): Ini {
  const ini: Ini = new Map()
  let section: Map<string, string> | undefined
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith(';')) continue
    const sec = /^\[(.*)\]$/.exec(line)
    if (sec) {
      section = new Map()
      ini.set(sec[1], section)
    } else if (section) {
      const eq = line.indexOf('=')
      if (eq > 0) section.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
    }
  }
  return ini
}

export function iniGet(ini: Ini, section: string, key: string): string | undefined {
  const lc = (s: string) => s.toLowerCase()
  for (const [name, entries] of ini)
    if (lc(name) === lc(section)) for (const [k, v] of entries) if (lc(k) === lc(key)) return v
  return undefined
}

export interface Bh2002Settings {
  /** [SCREEN]: menu display mode. */
  menuWidth: number
  menuHeight: number
  /** [SETTINGS] Resolution 0/1/2 -> game width 640/800/1024. */
  gameWidth: number
  music: boolean
  fx: boolean
  mouseMode: boolean
  mouseInvert: boolean
  /** Menu option saved to the ini only; never passed to BH2.exe. */
  texturas: boolean
  /** Top 10, best first. Score is the level reached. */
  highScores: { name: string; level: number }[]
}

export function parseBh2002Ini(text: string): Bh2002Settings {
  const ini = parseIni(text)
  // GetPrivateProfileIntA: leading integer, else the default.
  const int = (s: string, k: string, d: number) => {
    const m = /^[+-]?\d+/.exec(iniGet(ini, s, k) ?? '')
    return m ? parseInt(m[0], 10) : d
  }
  const flag = (k: string, d: number) => int('SETTINGS', k, d) === 1
  const res = int('SETTINGS', 'Resolution', 0)
  const highScores = Array.from({ length: 10 }, (_, n) => {
    const id = String(n + 1).padStart(2, '0')
    return { name: iniGet(ini, 'NAMESCORES', `Name${id}`) ?? '', level: int('SCORES', `Score${id}`, 0) }
  })
  return {
    menuWidth: int('SCREEN', 'ResX', 640),
    menuHeight: int('SCREEN', 'ResY', 480),
    gameWidth: res === 1 ? 800 : res === 2 ? 1024 : 640,
    music: int('SETTINGS', 'Music', 1) !== 0,
    fx: int('SETTINGS', 'Fx', 1) !== 0,
    mouseMode: flag('MouseMode', 0),
    mouseInvert: flag('MouseInvert', 0),
    texturas: int('SETTINGS', 'Texturas', 0) !== 0,
    highScores,
  }
}
