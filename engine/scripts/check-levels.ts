// Parse every BH2Game/Level_NN plus the handoff/ini files and print a summary.
// Fails on words BH2.exe would ignore that are not already known no-ops in the shipped scripts.
// Usage (from engine/): npx tsx scripts/check-levels.ts [path/to/BEACHHEAD2002]
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  KNOWN_NOOP_WORDS, OBJECT_SLOTS, levelFileName, parseBeachheadIn, parseBeachheadOut, parseBh2002Ini, parseLevel,
  type ObjectType,
} from '../src/formats/level.ts'

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '../../BEACHHEAD2002'))
const game = join(root, 'BH2Game')
const read = (p: string) => readFileSync(p, 'latin1')

const types = Object.keys(OBJECT_SLOTS) as ObjectType[]
const short: Record<ObjectType, string> = {
  TANK: 'TNK', APC1: 'AP1', APC2: 'AP2', APC3: 'AP3', JET: 'JET', BOMBER: 'BMB', COBRA: 'COB', CH53: 'CH53', C130: 'C130',
}
const pad = (s: string | number, n: number) => String(s).padStart(n)

const failures: string[] = []
const noops = new Map<string, number>()
let warnCount = 0

console.log(
  ['lvl', 'time', 'ammo b/p/m/f', 'aggr', 'flags', ...types.map(t => pad(short[t], 5)), 'maxDly', 'quota', 'warn'].join(' '),
)
for (let n = 1; n <= 99; n++) {
  const file = join(game, levelFileName(n))
  if (!existsSync(file)) {
    failures.push(`${levelFileName(n)} missing`)
    continue
  }
  const lv = parseLevel(read(file))
  for (const ig of lv.ignored) {
    if (KNOWN_NOOP_WORDS.includes(ig.word) && ig.args.every(a => /^\d+$/.test(a))) noops.set(ig.word, (noops.get(ig.word) ?? 0) + 1)
    else failures.push(`${levelFileName(n)}:${ig.line}: unknown directive "${[ig.word, ...ig.args].join(' ')}"`)
  }
  for (const w of lv.warnings) console.warn(`  ${levelFileName(n)}: ${w}`)
  warnCount += lv.warnings.length
  const counts = types.map(t => {
    const units = lv.groups.filter(g => g.type === t).flatMap(g => g.units)
    const delayed = units.filter(u => u.delay !== null).length
    return pad(units.length ? `${units.length}${delayed ? `/${delayed}` : ''}` : '-', 5)
  })
  const delays = lv.groups.flatMap(g => g.units).map(u => u.delay ?? 0)
  const a = lv.ammo
  const g = lv.aggression
  const flags = [lv.crosshair ? 'X' : '-', lv.bombers ? 'B' : '-', lv.spotlight ? 'S' : '-', lv.altGun ? `G${lv.altGun}` : '--'].join('')
  console.log(
    [
      pad(n, 3),
      lv.daytime ? 'day ' : 'nite',
      pad(a ? `${a.bullets}/${a.projectiles}/${a.missiles}/${a.flares}` : '-', 12),
      g ? `${g.tank}${g.jet}${g.heliGun}${g.heliRocket}` : '----',
      pad(flags, 5),
      ...counts,
      pad(Math.max(0, ...delays), 6),
      pad(lv.killQuota, 5),
      pad(lv.warnings.length, 4),
    ].join(' '),
  )
}
console.log('units column: total/delayed. flags: X crosshair, B bombers, S spotlight, G altgun.')
console.log(`known no-op words: ${[...noops].map(([w, c]) => `${w} x${c}`).join(', ') || 'none'}`)
console.log(`warnings: ${warnCount}`)

console.log('BeachheadIn:', JSON.stringify(parseBeachheadIn(read(join(game, 'BeachheadIn')))))
console.log('BeachheadOut:', JSON.stringify(parseBeachheadOut(read(join(game, 'BeachheadOut')))))
const ini = parseBh2002Ini(read(join(root, 'BH2002.ini')))
console.log('BH2002.ini:', JSON.stringify({ ...ini, highScores: ini.highScores.map(s => `${s.name}:${s.level}`) }))

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('OK: 99 levels parsed, no unknown directives')
