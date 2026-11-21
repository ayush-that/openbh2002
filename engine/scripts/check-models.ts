// Parses BH2Game/ShapeData and every vehicles/*.3DB from the local game copy and prints a summary.
// Usage (from engine/): npx tsx scripts/check-models.ts [gameDir]   (default: $BH2002_DIR or ../BEACHHEAD2002)
// Exits non-zero on any parse error or failed sanity check.
import fs from 'node:fs'
import path from 'node:path'
import { parseShapeData, type Vec3 } from '../src/formats/shapedata.ts'
import { parse3DB, db3Nodes, db3MeshMatrices, apply4x3, type Db3Mesh } from '../src/formats/db3.ts'

const gameDir = path.resolve(process.argv[2] ?? process.env.BH2002_DIR ?? path.join(import.meta.dirname, '../../BEACHHEAD2002'))
let failures = 0
const fail = (msg: string) => {
  failures++
  console.error(`FAIL ${msg}`)
}

type Box = { min: Vec3; max: Vec3 }
const emptyBox = (): Box => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })
const grow = (b: Box, p: Vec3) => {
  for (let k = 0; k < 3; k++) {
    b.min[k] = Math.min(b.min[k], p[k])
    b.max[k] = Math.max(b.max[k], p[k])
  }
}
const fmt = (b: Box) => `[${b.min.map((v) => v.toFixed(1)).join(', ')}] .. [${b.max.map((v) => v.toFixed(1)).join(', ')}]`

function findFile(dir: string, name: string): string | undefined {
  const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase())
  return hit && path.join(dir, hit)
}

// ShapeData
const shapeBoxes = new Map<string, Box>()
const shapePath = findFile(path.join(gameDir, 'BH2Game'), 'ShapeData')
if (!shapePath) {
  fail(`ShapeData not found under ${gameDir}/BH2Game`)
} else {
  try {
    const sd = parseShapeData(fs.readFileSync(shapePath, 'latin1').replace(/\r\n?/g, '\n'))
    console.log(`ShapeData: ${sd.objects.length} objects`)
    for (const o of sd.objects) {
      const box = emptyBox()
      let polys = 0
      let verts = 0
      for (const p of o.parts) for (const poly of p.polygons) {
        polys++
        verts += poly.vertices.length
        poly.vertices.forEach((v) => grow(box, v))
      }
      shapeBoxes.set(o.name.toLowerCase(), box)
      const parts = o.parts.map((p) => `${p.index}:${p.names.join(',')}(${p.polygons.length})`).join(' ')
      console.log(`  #${o.index} ${o.name.padEnd(10)} polys ${String(polys).padStart(3)} verts ${String(verts).padStart(4)} bounds ${fmt(box)}  parts ${parts}`)
    }
    if (sd.objects.length !== 10) fail(`ShapeData: expected 10 objects, got ${sd.objects.length}`)
  } catch (e) {
    fail(String(e))
  }
}

// .3DB
const vehDir = path.join(gameDir, 'vehicles')
const files = fs.existsSync(vehDir) ? fs.readdirSync(vehDir).filter((f) => /\.3db$/i.test(f)).sort() : []
if (!files.length) fail(`no .3DB files in ${vehDir}`)
const shapeFor: Record<string, string> = { mbt70: 'tank', apc1: 'apc', f104: 'jet', b58: 'bomber', cobra: 'cobra', ch53: 'ch53', c130: 'c130' }

function checkMesh(file: string, node: string, m: Db3Mesh) {
  let badNormals = 0
  for (let i = 0; i < m.normals.length; i += 3) {
    const l = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2])
    if (Math.abs(l - 1) > 0.01) badNormals++
  }
  if (badNormals) fail(`${file}/${node}: ${badNormals} non-unit normals`)
  for (const uv of m.uvs) if (uv < -0.01 || uv > 1.01) return fail(`${file}/${node}: UV ${uv} outside 0..1`)
  // Winding: right-handed cross product of each triangle must point along its corner normals.
  let agree = 0
  let total = 0
  const P = (c: number): Vec3 => {
    const i = m.cornerPosition[c] * 3
    return [m.positions[i], m.positions[i + 1], m.positions[i + 2]]
  }
  for (const g of m.groups) {
    for (let t = 0; t < g.indices.length; t += 3) {
      const [a, b, c] = [P(g.indices[t]), P(g.indices[t + 1]), P(g.indices[t + 2])]
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
      let d = 0
      for (let k = 0; k < 3; k++) for (const ci of [g.indices[t], g.indices[t + 1], g.indices[t + 2]]) d += n[k] * m.normals[ci * 3 + k]
      if (Math.abs(d) < 1e-6) continue
      total++
      if (d > 0) agree++
    }
  }
  // One shipped triangle (Apc2 turret) is flipped; anything beyond 1% means a misread.
  if (agree < total * 0.99) fail(`${file}/${node}: only ${agree}/${total} triangles wind counter-clockwise around their normals`)
  return total - agree
}

for (const f of files) {
  try {
    const model = parse3DB(new Uint8Array(fs.readFileSync(path.join(vehDir, f))))
    const nodes = db3Nodes(model.root)
    const meshes = db3MeshMatrices(model.root)
    const box = emptyBox()
    let tris = 0
    let verts = 0
    let corners = 0
    let flipped = 0
    for (const [node, mat] of meshes) {
      const m = node.mesh!
      tris += m.triangleCount
      verts += m.positions.length / 3
      corners += m.cornerPosition.length
      flipped += checkMesh(f, node.name, m) ?? 0
      // Net rotation must be identity once the D3D mirror is cancelled (see models.md "Coordinate frame").
      const rot = mat.slice(0, 9)
      if (rot.some((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) > 1e-4)) fail(`${f}/${node.name}: net rotation is not identity: ${rot}`)
      for (let i = 0; i < m.positions.length; i += 3) grow(box, apply4x3(mat, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]))
    }
    const textures = new Set(model.materials.flatMap((mt) => mt.maps.map((mp) => mp.file)).filter(Boolean))
    for (const t of textures) if (!findFile(vehDir, t)) fail(`${f}: texture ${t} missing`)
    console.log(
      `${f.padEnd(10)} materials ${String(model.materials.length).padStart(2)} nodes ${nodes.length} meshes ${meshes.size} ` +
        `verts ${String(verts).padStart(4)} corners ${String(corners).padStart(4)} tris ${String(tris).padStart(4)} bounds ${fmt(box)} ` +
        `flipped ${flipped} tex ${[...textures].join(',')}`,
    )
    const depth = new Map([[model.root, 0]])
    for (const n of nodes) {
      for (const c of n.children) depth.set(c, depth.get(n)! + 1)
      const parts = n.mesh ? `mesh ${n.mesh.triangleCount} tris, groups ${n.mesh.groups.map((g) => `${g.materialIndex}:${g.indices.length / 3}`).join(' ')}` : 'dummy'
      console.log(`    ${'  '.repeat(depth.get(n)!)}${n.name.padEnd(16)} ${parts}  t=[${n.transform.slice(9).map((v) => +v.toFixed(1)).join(', ')}]`)
    }
    const s = shapeBoxes.get(shapeFor[f.replace(/\.3db$/i, '').toLowerCase()] ?? '')
    if (s) console.log(`    ShapeData ${fmt(s)}`)
  } catch (e) {
    fail(`${f}: ${e}`)
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log(`\nOK: ShapeData + ${files.length} .3DB files`)
