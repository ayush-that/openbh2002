// BH2Game/ShapeData: plain-text hit shapes used by BH2.exe for bullet/shell ray tests.
// See docs/formats/models.md. Input must be CRLF-normalized ('\n' only).

export type Vec3 = [number, number, number]

export interface ShapePolygon {
  /** Polygon outline in model space (same frame as Geometry.3D and .3DB). Not necessarily convex or planar. */
  vertices: Vec3[]
}

export interface ShapePart {
  /** Hit-test result index inside the object (0 = first `Part`). This is what BH2.exe returns. */
  index: number
  /** Text after `Part`, split on commas. BH2.exe never reads it; descriptive only. */
  names: string[]
  polygons: ShapePolygon[]
}

export interface ShapeObject {
  /** Object slot BH2.exe uses (file order, 0-based). */
  index: number
  /** From the preceding `/*** Name ***\/` comment, or `Object<index>` if none. */
  name: string
  parts: ShapePart[]
}

export interface ShapeData {
  objects: ShapeObject[]
}

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

export function parseShapeData(text: string): ShapeData {
  const lines = text.split('\n')
  const objects: ShapeObject[] = []
  let obj: ShapeObject | null = null
  let part: ShapePart | null = null
  let comment = ''
  let scale = 1
  let offset: Vec3 = [0, 0, 0]
  let ended = false

  function fail(i: number, msg: string): never {
    throw new Error(`ShapeData line ${i + 1}: ${msg}`)
  }
  function nums(i: number, toks: string[], n: number): number[] {
    if (toks.length !== n || !toks.every((t) => NUM.test(t))) fail(i, `expected ${n} numbers, got "${lines[i].trim()}"`)
    return toks.map(Number)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    if (ended) fail(i, 'data after End')
    const c = /^\/\*+\s*(.*?)\s*\*+\/$/.exec(line)
    if (c) {
      comment = c[1]
      continue
    }
    if (line.startsWith('//')) continue
    const toks = line.split(/\s+/)
    const head = toks[0]
    const args = toks.slice(1)

    if (head === 'Object') {
      if (obj) fail(i, 'nested Object')
      if (args.length) fail(i, 'Object takes no arguments')
      obj = { index: objects.length, name: comment || `Object${objects.length}`, parts: [] }
      part = null
      scale = 1
      offset = [0, 0, 0]
      comment = ''
    } else if (head === 'End') {
      if (obj) fail(i, 'End inside Object')
      ended = true
    } else if (!obj) {
      fail(i, `"${head}" outside Object`)
    } else if (head === 'ObjectEnd') {
      if (!obj.parts.length) fail(i, 'Object has no parts')
      objects.push(obj)
      obj = null
      part = null
    } else if (head === 'Part') {
      const names = args.join(' ').split(',').map((s) => s.trim()).filter(Boolean)
      part = { index: obj.parts.length, names, polygons: [] }
      obj.parts.push(part)
    } else if (head === 'Scale') {
      scale = nums(i, args, 1)[0]
    } else if (head === 'Translate') {
      const [x, y, z] = nums(i, args, 3)
      offset = [x, y, z]
    } else if (head === 'P') {
      if (!part) fail(i, 'polygon before any Part')
      const n = nums(i, args, 1)[0]
      if (!Number.isInteger(n) || n < 3) fail(i, `bad vertex count ${n}`)
      const vertices: Vec3[] = []
      for (let k = 0; k < n; k++) {
        i++
        if (i >= lines.length) fail(i - 1, 'unexpected end of file in polygon')
        const [x, y, z] = nums(i, lines[i].trim().split(/\s+/), 3)
        vertices.push([x * scale + offset[0], y * scale + offset[1], z * scale + offset[2]])
      }
      part.polygons.push({ vertices })
    } else {
      fail(i, `unknown directive "${head}"`)
    }
  }
  if (obj) throw new Error('ShapeData: missing ObjectEnd at end of file')
  if (!ended) throw new Error('ShapeData: missing End')
  return { objects }
}
