// Parse BEACHHEAD2002/BH2Game/Geometry.3D and print a summary. Exits 1 on any parse issue
// or texture file mismatch. Usage (from engine/): npx tsx scripts/check-geometry3d.ts [path]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeTextureReferences, expandedPolygons, parseGeometry3D, type G3DObject } from '../src/formats/geometry3d.ts'

const here = dirname(fileURLToPath(import.meta.url))
const path = resolve(process.argv[2] ?? join(here, '../../BEACHHEAD2002/BH2Game/Geometry.3D'))
if (!existsSync(path)) {
  console.error(`not found: ${path}`)
  process.exit(1)
}
const geo = parseGeometry3D(readFileSync(path, 'latin1').replace(/\r\n?/g, '\n'))
let failures = 0

console.log(`file: ${path}`)
console.log(`header: ${geo.header}  End: ${geo.hasEnd}  objects: ${geo.objects.length}  vertex lines: ${geo.vertexLineCount}`)

console.log('\ndirective counts:')
for (const [k, n] of Object.entries(geo.directiveCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${n}`)

const polys = geo.objects.flatMap((o) => o.polygons)
const byType = new Map<string, { polys: number; verts: number }>()
for (const p of polys) {
  const e = byType.get(p.polyType) ?? { polys: 0, verts: 0 }
  e.polys++
  e.verts += p.vertices.length
  byType.set(p.polyType, e)
}
console.log(`\npolygons by PolyType (${polys.length} total):`)
for (const [t, e] of [...byType].sort((a, b) => b[1].polys - a[1].polys)) console.log(`  ${t.padEnd(17)} ${String(e.polys).padStart(6)} polys ${String(e.verts).padStart(7)} verts`)

function range(list: G3DObject[]) {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const o of list)
    for (const p of o.polygons)
      for (const v of p.vertices)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], v.position[k])
          hi[k] = Math.max(hi[k], v.position[k])
        }
  return lo[0] === Infinity ? '-' : `x ${lo[0]}..${hi[0]}  y ${lo[1]}..${hi[1]}  z ${lo[2]}..${hi[2]}`
}
console.log(`\ncoordinate range (all polygons): ${range(geo.objects)}`)

console.log('\nobjects grouped by label (consecutive runs):')
const groups: { label: string; objs: G3DObject[] }[] = []
for (const o of geo.objects) {
  const last = groups.at(-1)
  const label = o.label ?? last?.label ?? '(none)'
  if (last && last.label === label) last.objs.push(o)
  else groups.push({ label, objs: [o] })
}
for (const g of groups) {
  const ids = g.objs.length === 1 ? `${g.objs[0].id}` : `${g.objs[0].id}-${g.objs[g.objs.length - 1].id}`
  const own = g.objs.reduce((n, o) => n + o.polygons.length, 0)
  const kinds = new Set(g.objs.map((o) => (o.instanceOf !== null ? `Instance ${o.instanceOf}` : o.copies.length ? `Copy ${o.copies.join(',')}` : o.polygons.length ? 'geometry' : o.lights.length ? 'light' : 'empty')))
  const parents = new Set(g.objs.filter((o) => o.parent !== null).map((o) => o.parent))
  const drawn = g.objs.reduce((n, o) => n + expandedPolygons(geo, o.id).length, 0)
  console.log(
    `  ${ids.padEnd(9)} ${g.label.padEnd(16)} n=${String(g.objs.length).padEnd(3)} own=${String(own).padEnd(5)} drawn=${String(drawn).padEnd(5)} ${[...kinds].slice(0, 3).join('; ')}${kinds.size > 3 ? '; ...' : ''}${parents.size ? `  Link->${[...parents].join(',')}` : ''}${own ? `  ${range(g.objs)}` : ''}`,
  )
}

const hidden = geo.objects.filter((o) => !o.visible).map((o) => o.id)
console.log(`\nVisible 0 objects: ${hidden.join(', ') || 'none'} (all others default to visible)`)
console.log('lights:')
for (const o of geo.objects) for (const l of o.lights) console.log(`  object ${o.id}: ${JSON.stringify(l)}`)

const tex = describeTextureReferences(geo)
console.log(`\ntexture files (${tex.files.length}):`)
const dir = dirname(path)
const listing = new Map(readdirSync(dir).map((f) => [f.toLowerCase(), f]))
for (const f of tex.files) {
  const real = listing.get(f.file.toLowerCase())
  const size = real ? statSync(join(dir, real)).size : -1
  const ok = size === f.expectedBytes
  if (!ok) failures++
  const where = f.slot !== null ? `slot ${f.slot}` : `set ${f.set}`
  console.log(
    `  ${ok ? 'ok ' : 'BAD'} ${f.directive.padEnd(10)} ${where.padEnd(8)} ${f.file.padEnd(26)} ${f.width}x${f.height}x${f.frameCount} ${f.bitsPerPixel}bpp bytes=${f.expectedBytes}${real && real !== f.file ? ` (on disk: ${real})` : ''}${size < 0 ? ' MISSING' : !ok ? ` size=${size}` : ''} polys=${f.polygonCount}`,
  )
}
console.log(`slots used by polygons without a TextureMap (runtime animation slots): ${tex.runtimeSlots.join(' ')}`)

const quirks = geo.objects.flatMap((o) => o.directives).filter((d) => d.kind === 'TextureScale' && d.ignoredTokens.length)
console.log(`\nengine-tolerated quirks: ${quirks.map((d) => `line ${d.line} TextureScale extra token(s) ignored by BH2.exe`).join('; ') || 'none'}`)

console.log(`\nparse issues: ${geo.issues.length}`)
for (const e of geo.issues.slice(0, 50)) console.log(`  line ${e.line}: ${e.message}  | ${e.text}`)
failures += geo.issues.length
if (failures) {
  console.error(`FAIL (${failures})`)
  process.exit(1)
}
console.log('PASS')
