// vehicles/*.3DB: binary meshes exported from 3ds Max ("EXPORT3DB"), loaded by the front-end (bh2.ews)
// for the vehicle viewer. BH2.exe never reads them. Little-endian. See docs/formats/models.md.

export type Vec3 = [number, number, number]

/** 3ds Max standard-material map slots, in file bit order (flags bit i = slot i). */
export const DB3_MAP_SLOTS = [
  'ambient',
  'diffuse',
  'specular',
  'shininess',
  'shininessStrength',
  'selfIllum',
  'opacity',
  'filterColor',
  'bump',
  'reflection',
  'refraction',
  'displacement',
] as const
export type Db3MapSlot = (typeof DB3_MAP_SLOTS)[number]

export interface Db3Map {
  slot: Db3MapSlot
  amount: number
  /** Texture file name relative to vehicles/ (may be empty). */
  file: string
}

export interface Db3Material {
  name: string
  ambient: Vec3
  diffuse: Vec3
  specular: Vec3
  /** File floats 9..12. Always 0 in shipped files; meaning unknown. */
  unknown4: [number, number, number, number]
  /** Inferred from 3ds Max defaults (0.25 / 0.05 / 1 in every file). */
  shininess: number
  shininessStrength: number
  opacity: number
  /** File floats 16..17. Always 0 in shipped files. */
  unknown2: [number, number]
  mapFlags: number
  maps: Db3Map[]
}

export interface Db3Group {
  /** 0 = plain triangles; 1 = triangles followed by 12 ignored bytes each (unused in shipped files). */
  type: number
  materialIndex: number
  /** 3 corner indices per triangle. Front faces are counter-clockwise (right-handed) around the stored normals. */
  indices: Uint32Array
}

export interface Db3Mesh {
  bboxMin: Vec3
  bboxMax: Vec3
  /** Unique positions, xyz. */
  positions: Float32Array
  /** Per-corner position index. */
  cornerPosition: Uint32Array
  /** Per-corner unit normal, xyz. */
  normals: Float32Array
  /** Per-corner UV. v = 0 is the top row of the texture (DirectX convention). */
  uvs: Float32Array
  triangleCount: number
  groups: Db3Group[]
}

export interface Db3Node {
  name: string
  /** 4x3 row-major (rows 0-2 = basis, row 3 = translation, row-vector convention). Applies to the node and its children. */
  transform: number[]
  /** 4x3 applied to this node's mesh only. Identity in shipped files. */
  meshTransform: number[]
  mesh: Db3Mesh | null
  children: Db3Node[]
}

export interface Db3Model {
  materials: Db3Material[]
  root: Db3Node
}

class Reader {
  o = 0
  private b: Uint8Array
  private v: DataView
  constructor(b: Uint8Array) {
    this.b = b
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  need(n: number) {
    if (n < 0 || this.o + n > this.b.length) throw new Error(`3DB: truncated at 0x${this.o.toString(16)} (need ${n} bytes)`)
  }
  u32() {
    this.need(4)
    const x = this.v.getUint32(this.o, true)
    this.o += 4
    return x
  }
  f32() {
    this.need(4)
    const x = this.v.getFloat32(this.o, true)
    this.o += 4
    if (!Number.isFinite(x)) throw new Error(`3DB: non-finite float at 0x${(this.o - 4).toString(16)}`)
    return x
  }
  floats(n: number) {
    const out: number[] = []
    for (let i = 0; i < n; i++) out.push(this.f32())
    return out
  }
  vec3(): Vec3 {
    return [this.f32(), this.f32(), this.f32()]
  }
  cstr() {
    const end = this.b.indexOf(0, this.o)
    if (end < 0) throw new Error(`3DB: unterminated string at 0x${this.o.toString(16)}`)
    let s = ''
    for (let i = this.o; i < end; i++) s += String.fromCharCode(this.b[i])
    this.o = end + 1
    return s
  }
  count(n: number, bytesEach: number) {
    this.need(n * bytesEach)
    return n
  }
}

function readMaterial(r: Reader): Db3Material {
  const name = r.cstr()
  const f = r.floats(18)
  const mapFlags = r.u32()
  if (mapFlags >>> 12) throw new Error(`3DB: material ${name} has unknown map flags 0x${mapFlags.toString(16)}`)
  const maps: Db3Map[] = []
  DB3_MAP_SLOTS.forEach((slot, i) => {
    if (mapFlags & (1 << i)) maps.push({ slot, amount: r.f32(), file: r.cstr() })
  })
  return {
    name,
    ambient: [f[0], f[1], f[2]],
    diffuse: [f[3], f[4], f[5]],
    specular: [f[6], f[7], f[8]],
    unknown4: [f[9], f[10], f[11], f[12]],
    shininess: f[13],
    shininessStrength: f[14],
    opacity: f[15],
    unknown2: [f[16], f[17]],
    mapFlags,
    maps,
  }
}

function readMesh(r: Reader, nv: number, materialCount: number): Db3Mesh & { transforms: number[][] } {
  const nCorners = r.u32()
  const triangleCount = r.u32()
  const bboxMin = r.vec3()
  const bboxMax = r.vec3()
  const transforms = [r.floats(12), r.floats(12)]

  const positions = new Float32Array(r.count(nv, 12) * 3)
  for (let i = 0; i < positions.length; i++) positions[i] = r.f32()

  r.count(nCorners, 24)
  const cornerPosition = new Uint32Array(nCorners)
  const normals = new Float32Array(nCorners * 3)
  const uvs = new Float32Array(nCorners * 2)
  for (let i = 0; i < nCorners; i++) {
    const p = r.u32()
    if (p >= nv) throw new Error(`3DB: corner ${i} position ${p} >= ${nv}`)
    cornerPosition[i] = p
    normals[i * 3] = r.f32()
    normals[i * 3 + 1] = r.f32()
    normals[i * 3 + 2] = r.f32()
    uvs[i * 2] = r.f32()
    uvs[i * 2 + 1] = r.f32()
  }

  // Groups repeat until their triangle counts add up to triangleCount (as the loader does).
  const groups: Db3Group[] = []
  let total = 0
  while (total < triangleCount) {
    const type = r.u32()
    const count = r.u32()
    const materialIndex = r.u32()
    if (type > 1) throw new Error(`3DB: unknown face group type ${type}`)
    if (count === 0) throw new Error('3DB: empty face group')
    if (materialIndex >= materialCount) throw new Error(`3DB: material ${materialIndex} >= ${materialCount}`)
    r.count(count, type === 1 ? 24 : 12)
    const indices = new Uint32Array(count * 3)
    for (let t = 0; t < count; t++) {
      for (let k = 0; k < 3; k++) {
        const c = r.u32()
        if (c >= nCorners) throw new Error(`3DB: triangle corner ${c} >= ${nCorners}`)
        indices[t * 3 + k] = c
      }
      if (type === 1) r.o += 12
    }
    groups.push({ type, materialIndex, indices })
    total += count
  }
  if (total !== triangleCount) throw new Error(`3DB: face groups hold ${total} triangles, header says ${triangleCount}`)
  return { bboxMin, bboxMax, positions, cornerPosition, normals, uvs, triangleCount, groups, transforms }
}

function readNode(r: Reader, materialCount: number, depth: number): Db3Node {
  if (depth > 64) throw new Error('3DB: node hierarchy too deep')
  const name = r.cstr()
  const nv = r.u32()
  let mesh: Db3Mesh | null = null
  let transforms: number[][]
  if (nv === 0) {
    transforms = [r.floats(12), r.floats(12)]
  } else {
    const { transforms: t, ...m } = readMesh(r, nv, materialCount)
    transforms = t
    mesh = m
  }
  const nChildren = r.u32()
  r.count(nChildren, 5)
  const children: Db3Node[] = []
  for (let i = 0; i < nChildren; i++) children.push(readNode(r, materialCount, depth + 1))
  return { name, transform: transforms[0], meshTransform: transforms[1], mesh, children }
}

export function parse3DB(data: Uint8Array): Db3Model {
  const r = new Reader(data)
  r.need(8)
  const magic = String.fromCharCode(data[0], data[1], data[2], data[3])
  if (magic !== '3DBF') throw new Error(`3DB: bad magic "${magic}"`)
  r.o = 4
  const nMat = r.count(r.u32(), 77)
  const materials: Db3Material[] = []
  for (let i = 0; i < nMat; i++) materials.push(readMaterial(r))
  const root = readNode(r, nMat, 0)
  if (r.o !== data.length) throw new Error(`3DB: ${data.length - r.o} trailing bytes at 0x${r.o.toString(16)}`)
  return { materials, root }
}

/** Depth-first list of all nodes, root first. */
export function db3Nodes(root: Db3Node): Db3Node[] {
  return [root, ...root.children.flatMap(db3Nodes)]
}

/** Row-vector 4x3 product: applying the result equals applying `a` then `b`. */
export function mul4x3(a: number[], b: number[]): number[] {
  const out: number[] = []
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let s = row === 3 ? b[9 + col] : 0
      for (let k = 0; k < 3; k++) s += a[row * 3 + k] * b[k * 3 + col]
      out.push(s)
    }
  }
  return out
}

export function apply4x3(m: number[], p: Vec3): Vec3 {
  const [x, y, z] = p
  return [
    x * m[0] + y * m[3] + z * m[6] + m[9],
    x * m[1] + y * m[4] + z * m[7] + m[10],
    x * m[2] + y * m[5] + z * m[8] + m[11],
  ]
}

const MIRROR_X = [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

/**
 * Mesh-to-model matrix for every mesh node (meshTransform, then node transforms up to the root).
 * The exported chain ends in an X mirror (Max right-handed -> Direct3D left-handed); by default it is
 * cancelled so the result is in the same right-handed Y-up frame as the raw vertices (Three.js-ready).
 */
export function db3MeshMatrices(root: Db3Node, rightHanded = true): Map<Db3Node, number[]> {
  const out = new Map<Db3Node, number[]>()
  const end = rightHanded ? MIRROR_X : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  const walk = (n: Db3Node, parent: number[]) => {
    const world = mul4x3(n.transform, parent)
    if (n.mesh) out.set(n, mul4x3(n.meshTransform, world))
    for (const c of n.children) walk(c, world)
  }
  walk(root, end)
  return out
}
