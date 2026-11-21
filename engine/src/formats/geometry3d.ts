// BH2Game/Geometry.3D: plain-text display-list source compiled by BH2.exe at load time
// (loader at 0x425391). See docs/formats/geometry3d.md. Input must be CRLF-normalized.
//
// BH2.exe reads the file token by token with fscanf("%s") and silently skips unknown
// tokens (that is how comments work). This parser is stricter: it is line based and
// reports every unknown directive, wrong argument count, or bad number in `issues`.

export type Vec3 = readonly [number, number, number]
export type RGB = readonly [number, number, number]
export type UV = readonly [number, number]

export const POLY_TYPES = [
  'BoundingVol',
  'Smooth',
  'SmoothL',
  'Vertices',
  'Textured',
  'TexturedL',
  'Reflected',
  'ReflectedL',
  'TxtrAlpha',
  'SortTxtr',
  'ConvertTexturedL',
] as const
export type PolyType = (typeof POLY_TYPES)[number]

export type VertexField = 'x' | 'y' | 'z' | 'nx' | 'ny' | 'nz' | 'shade' | 'u' | 'v'

/** Numbers per vertex line, in file order, per PolyType (BH2.exe scanf formats). */
export const VERTEX_LAYOUT: Readonly<Record<PolyType, readonly VertexField[]>> = {
  BoundingVol: ['x', 'y', 'z'],
  Vertices: ['x', 'y', 'z'],
  Smooth: ['x', 'y', 'z', 'shade'],
  SmoothL: ['x', 'y', 'z', 'nx', 'ny', 'nz'],
  Reflected: ['x', 'y', 'z', 'nx', 'ny', 'nz'],
  ReflectedL: ['x', 'y', 'z', 'nx', 'ny', 'nz'],
  Textured: ['x', 'y', 'z', 'shade', 'u', 'v'],
  TxtrAlpha: ['x', 'y', 'z', 'shade', 'u', 'v'],
  SortTxtr: ['x', 'y', 'z', 'shade', 'u', 'v'],
  TexturedL: ['x', 'y', 'z', 'nx', 'ny', 'nz', 'u', 'v'],
  ConvertTexturedL: ['x', 'y', 'z', 'nx', 'ny', 'nz', 'u', 'v'],
}

export interface Vertex {
  position: Vec3
  /** As written. BH2.exe normalizes to length 1 (length 0.5 for Reflected*). */
  normal: Vec3 | null
  /** As written (0..255). BH2.exe stores shade / 255. */
  shade: number | null
  /** As written, in texel-ish units. See Polygon.uvNormalized for the engine's 0..1 values. */
  uv: UV | null
}

/** File-order render state when the polygon was read. See doc: runtime state carries across objects. */
export interface PolygonState {
  color: RGB | null
  /** Texture slot (TextureMap index or runtime animation slot). 0 = NullTexture / disabled. */
  texture: number | null
  textureArg2: number | null
  /** SetTexture 3rd argument: 0 off, 1 opaque, 2..5 blend modes. */
  blendMode: number | null
  /** Last ZBufferOn/ZBufferOff (D3D ZENABLE). null = never set. */
  zEnable: boolean | null
}

export interface Polygon {
  line: number
  objectId: number
  polyType: PolyType
  vertices: Vertex[]
  /** UVs exactly as BH2.exe computes them at load time (u/TextureScale or TxtrAdjust for ConvertTexturedL). */
  uvNormalized: UV[] | null
  textureScale: number
  state: PolygonState
}

export interface TxtrAdjust {
  uOffset: number
  uDivisor: number
  vDivisor: number
}

export interface DistantLight {
  type: 'distant'
  id: number
  direction: Vec3
  /** As written. BH2.exe stores value / 255. */
  intensity: number
  color: RGB
}
export interface PointLight {
  type: 'point'
  id: number
  position: Vec3
  /** BH2.exe stores 1 / range. */
  range: number
  intensity: number
  color: RGB
}
export interface SpotLight {
  type: 'spot'
  id: number
  position: Vec3
  direction: Vec3
  /** Cosine of the cone edge. BH2.exe stores 1 / (1 - cosCutoff). */
  cosCutoff: number
  range: number
  intensity: number
  color: RGB
}
export type Light = DistantLight | PointLight | SpotLight

type L = { line: number }
export type ObjectDirective =
  | (L & { kind: 'PolyType'; polyType: PolyType })
  | (L & { kind: 'Color'; color: RGB })
  | (L & { kind: 'SetTexture'; texture: number; arg2: number; blendMode: number })
  | (L & { kind: 'SetTextureInc'; texture: number; arg2: number; blendMode: number })
  | (L & { kind: 'DisableTexture' })
  | (L & { kind: 'RenderState'; state: number; value: number })
  | (L & { kind: 'ZBufferOn' | 'ZBufferOff' | 'ZBufferWritesOn' | 'ZBufferWritesOff' })
  | (L & { kind: 'Light'; light: Light })
  | (L & { kind: 'LightMask'; mask: number })
  | (L & { kind: 'Rotate' | 'Translate' | 'RotateInc'; value: Vec3 })
  | (L & { kind: 'Visible'; value: number })
  | (L & { kind: 'TxtrAdjust'; adjust: TxtrAdjust })
  | (L & { kind: 'TextureScale'; scale: number; ignoredTokens: string[] })
  | (L & { kind: 'Backup' })
  | (L & { kind: 'Instance' | 'Copy' | 'Link'; ref: number; target: number })
  | (L & { kind: 'InstanceBackup'; target: number })
  | (L & { kind: 'Polygon'; polygonIndex: number })
  | (L & { kind: 'Comment'; text: string })

export interface G3DObject {
  id: number
  line: number
  endLine: number | null
  declaredBy: 'Object' | 'ObjectInc'
  /** Text of the nearest preceding top-level `/*** Name ***\/` comment. */
  label: string | null
  /** Last Visible value (BH2.exe default 1). */
  visible: boolean
  /** Link target (hierarchy parent). */
  parent: number | null
  /** Instance target: this object draws that object's display list. */
  instanceOf: number | null
  /** Copy targets, in order: their display lists are duplicated inline. */
  copies: number[]
  translate: Vec3 | null
  rotate: Vec3 | null
  rotateInc: Vec3 | null
  lightMask: number | null
  lights: Light[]
  directives: ObjectDirective[]
  /** Polygons written in this object's own body (not expanded through Copy/Instance). */
  polygons: Polygon[]
}

export interface TextureMapDef {
  line: number
  kind: 'TextureMap' | 'ColorKeyed'
  file: string
  slot: number
  bitsPerPixel: number
  width: number
  height: number
}

export interface AnimationDef {
  line: number
  kind: 'Animated' | 'Film'
  set: number
  file: string
  frameCount: number
  bitsPerPixel: number
  width: number
  height: number
  /** Rows stored per frame in the file. Film frames carry 16 extra rows BH2.exe reads but does not upload. */
  rowsPerFrameInFile: number
}

export interface ParseIssue {
  line: number
  message: string
  text: string
}

export interface Geometry3D {
  header: string | null
  objects: G3DObject[]
  textures: TextureMapDef[]
  animations: AnimationDef[]
  topLevelComments: { line: number; text: string }[]
  hasEnd: boolean
  /** Count of each directive keyword as it appears in the file. */
  directiveCounts: Record<string, number>
  vertexLineCount: number
  issues: ParseIssue[]
}

const NUM = /^-?(\d+\.?\d*|\.\d+)$/
const INT = /^-?\d+$/

export function parseGeometry3D(text: string): Geometry3D {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const geo: Geometry3D = {
    header: null,
    objects: [],
    textures: [],
    animations: [],
    topLevelComments: [],
    hasEnd: false,
    directiveCounts: {},
    vertexLineCount: 0,
    issues: [],
  }
  const byId = new Map<number, G3DObject>()
  let obj: G3DObject | null = null
  // Read through a function: obj is reassigned inside closures, which defeats narrowing.
  const current = (): G3DObject | null => obj
  let curId = 0
  let label: string | null = null
  // Parse-time state in BH2.exe's loader. None of it resets at Object/ObjectInc.
  let polyType: PolyType | null = null
  let textureScale = 1
  let txtrAdjust: TxtrAdjust | null = null
  let lastTexture: number | null = null
  // File-order runtime state snapshot.
  const state: PolygonState = { color: null, texture: null, textureArg2: null, blendMode: null, zEnable: null }

  let i = 0
  const issue = (message: string, at = i) => {
    geo.issues.push({ line: at + 1, message, text: lines[at] ?? '' })
  }

  function numbers(toks: string[], pattern: string): number[] | null {
    if (toks.length - 1 !== pattern.length) {
      issue(`${toks[0]} expects ${pattern.length} argument(s), got ${toks.length - 1}`)
      return null
    }
    const out: number[] = []
    for (let k = 0; k < pattern.length; k++) {
      const t = toks[k + 1]
      if (!(pattern[k] === 'd' ? INT : NUM).test(t)) {
        issue(`${toks[0]} argument ${k + 1} "${t}" is not ${pattern[k] === 'd' ? 'an integer' : 'a number'}`)
        return null
      }
      out.push(Number(t))
    }
    return out
  }

  function needObject(kw: string): G3DObject | null {
    if (!obj) issue(`${kw} outside Object/ObjectEnd`)
    return obj
  }

  function resolve(kw: string, ref: number): number | null {
    const target = ref >= 0 ? ref : curId + ref
    if (!byId.has(target) || target === curId) {
      issue(`${kw} ${ref} resolves to object ${target}, which is not defined earlier`)
      return null
    }
    return target
  }

  function openObject(id: number, declaredBy: G3DObject['declaredBy']) {
    if (obj) issue(`${declaredBy} before ObjectEnd of object ${obj.id}`)
    if (byId.has(id)) issue(`object id ${id} defined twice`)
    curId = id
    obj = {
      id,
      line: i + 1,
      endLine: null,
      declaredBy,
      label,
      visible: true,
      parent: null,
      instanceOf: null,
      copies: [],
      translate: null,
      rotate: null,
      rotateInc: null,
      lightMask: null,
      lights: [],
      directives: [],
      polygons: [],
    }
    label = null
    byId.set(id, obj)
    geo.objects.push(obj)
  }

  function readPolygon(o: G3DObject, count: number) {
    const startLine = i
    if (!polyType) {
      issue('Polygon before any PolyType')
      return
    }
    const layout = VERTEX_LAYOUT[polyType]
    const vertices: Vertex[] = []
    for (let k = 0; k < count; k++) {
      i++
      const vt = (lines[i] ?? '').trim().split(/\s+/)
      geo.vertexLineCount++
      if (vt.length !== layout.length || !vt.every((t) => NUM.test(t))) {
        issue(`vertex ${k + 1}/${count} of ${polyType} Polygon needs ${layout.length} numbers (${layout.join(' ')})`)
        return
      }
      const f: Partial<Record<VertexField, number>> = {}
      layout.forEach((name, n) => (f[name] = Number(vt[n])))
      vertices.push({
        position: [f.x ?? 0, f.y ?? 0, f.z ?? 0],
        normal: f.nx === undefined ? null : [f.nx, f.ny ?? 0, f.nz ?? 0],
        shade: f.shade ?? null,
        uv: f.u === undefined ? null : [f.u, f.v ?? 0],
      })
    }
    let uvNormalized: UV[] | null = null
    if (layout.includes('u')) {
      if (polyType === 'ConvertTexturedL') {
        const a = txtrAdjust
        if (!a) issue('ConvertTexturedL Polygon before any TxtrAdjust', startLine)
        else uvNormalized = vertices.map((v) => [((v.uv?.[0] ?? 0) + a.uOffset) / a.uDivisor, (v.uv?.[1] ?? 0) / a.vDivisor])
      } else {
        uvNormalized = vertices.map((v) => [(v.uv?.[0] ?? 0) / textureScale, (v.uv?.[1] ?? 0) / textureScale])
      }
    }
    o.directives.push({ kind: 'Polygon', line: startLine + 1, polygonIndex: o.polygons.length })
    o.polygons.push({
      line: startLine + 1,
      objectId: o.id,
      polyType,
      vertices,
      uvNormalized,
      textureScale,
      state: { ...state },
    })
  }

  for (; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw) continue
    if (raw.startsWith('//') || raw.startsWith('/*')) {
      const o = current()
      if (o) o.directives.push({ kind: 'Comment', line: i + 1, text: raw })
      else {
        geo.topLevelComments.push({ line: i + 1, text: raw })
        const m = /^\/\*+\s*(.*?)\s*\*+\/$/.exec(raw)
        if (m) label = m[1]
      }
      continue
    }
    if (geo.hasEnd) {
      issue('content after End')
      continue
    }
    const toks = raw.split(/\s+/)
    const kw = toks[0]
    geo.directiveCounts[kw] = (geo.directiveCounts[kw] ?? 0) + 1
    const line = i + 1

    switch (kw) {
      case 'POLY': {
        if (geo.header !== null || geo.objects.length || toks.length !== 1) issue('POLY must be the first token, alone')
        geo.header = kw
        break
      }
      case 'Object': {
        const a = numbers(toks, 'd')
        if (a) openObject(a[0], 'Object')
        break
      }
      case 'ObjectInc': {
        if (numbers(toks, '')) openObject(curId + 1, 'ObjectInc')
        break
      }
      case 'ObjectEnd': {
        const o = needObject(kw)
        if (o && numbers(toks, '')) o.endLine = line
        obj = null
        break
      }
      case 'End': {
        const o = current()
        if (o) issue(`End inside object ${o.id}`)
        if (numbers(toks, '')) geo.hasEnd = true
        break
      }
      case 'Polygon': {
        const o = needObject(kw)
        const a = numbers(toks, 'd')
        if (o && a) {
          if (a[0] < 1 || a[0] > 255) issue(`Polygon vertex count ${a[0]} outside 1..255`)
          else readPolygon(o, a[0])
        }
        break
      }
      case 'PolyType': {
        const o = needObject(kw)
        if (toks.length !== 2 || !(POLY_TYPES as readonly string[]).includes(toks[1])) {
          issue(`unknown PolyType "${toks.slice(1).join(' ')}"`)
          break
        }
        polyType = toks[1] as PolyType
        o?.directives.push({ kind: 'PolyType', line, polyType })
        break
      }
      case 'Color': {
        const o = needObject(kw)
        const a = numbers(toks, 'ddd')
        if (o && a) {
          state.color = [a[0], a[1], a[2]]
          o.directives.push({ kind: 'Color', line, color: state.color })
        }
        break
      }
      case 'SetTexture':
      case 'SetTextureInc': {
        const o = needObject(kw)
        const a = numbers(toks, kw === 'SetTexture' ? 'ddd' : 'dd')
        if (!o || !a) break
        let texture: number
        if (kw === 'SetTexture') texture = a.shift() ?? 0
        else if (lastTexture === null) {
          issue('SetTextureInc before any SetTexture')
          break
        } else texture = lastTexture + 1
        const [arg2, blendMode] = a
        lastTexture = texture
        Object.assign(state, { texture, textureArg2: arg2, blendMode })
        o.directives.push({ kind: kw, line, texture, arg2, blendMode })
        break
      }
      case 'DisableTexture': {
        const o = needObject(kw)
        if (o && numbers(toks, '')) {
          Object.assign(state, { texture: 0, textureArg2: 0, blendMode: 0 })
          o.directives.push({ kind: 'DisableTexture', line })
        }
        break
      }
      case 'RenderState': {
        const o = needObject(kw)
        const a = numbers(toks, 'dd')
        if (o && a) o.directives.push({ kind: 'RenderState', line, state: a[0], value: a[1] })
        break
      }
      case 'ZBufferOn':
      case 'ZBufferOff':
      case 'ZBufferWritesOn':
      case 'ZBufferWritesOff': {
        const o = needObject(kw)
        if (o && numbers(toks, '')) {
          if (kw === 'ZBufferOn' || kw === 'ZBufferOff') state.zEnable = kw === 'ZBufferOn'
          o.directives.push({ kind: kw, line })
        }
        break
      }
      case 'LightDistant':
      case 'LightPoint':
      case 'LightSpot': {
        const o = needObject(kw)
        const a = numbers(toks, kw === 'LightDistant' ? 'dfffffff' : kw === 'LightPoint' ? 'dffffffff' : 'dffffffffffff')
        if (!o || !a) break
        const v = (k: number): Vec3 => [a[k], a[k + 1], a[k + 2]]
        const light: Light =
          kw === 'LightDistant'
            ? { type: 'distant', id: a[0], direction: v(1), intensity: a[4], color: v(5) }
            : kw === 'LightPoint'
              ? { type: 'point', id: a[0], position: v(1), range: a[4], intensity: a[5], color: v(6) }
              : { type: 'spot', id: a[0], position: v(1), direction: v(4), cosCutoff: a[7], range: a[8], intensity: a[9], color: v(10) }
        o.lights.push(light)
        o.directives.push({ kind: 'Light', line, light })
        break
      }
      case 'LightMask': {
        const o = needObject(kw)
        const a = numbers(toks, 'd')
        if (o && a) {
          o.lightMask = a[0]
          o.directives.push({ kind: 'LightMask', line, mask: a[0] })
        }
        break
      }
      case 'Rotate':
      case 'Translate':
      case 'RotateInc': {
        const o = needObject(kw)
        const a = numbers(toks, 'fff')
        if (!o || !a) break
        const value: Vec3 = [a[0], a[1], a[2]]
        if (kw === 'Rotate') o.rotate = value
        else if (kw === 'Translate') o.translate = value
        else o.rotateInc = value
        o.directives.push({ kind: kw, line, value })
        break
      }
      case 'Visible': {
        const o = needObject(kw)
        const a = numbers(toks, 'd')
        if (o && a) {
          o.visible = a[0] !== 0
          o.directives.push({ kind: 'Visible', line, value: a[0] })
        }
        break
      }
      case 'TxtrAdjust': {
        const o = needObject(kw)
        const a = numbers(toks, 'fff')
        if (o && a) {
          if (a[1] === 0 || a[2] === 0) issue('TxtrAdjust divisor is 0')
          txtrAdjust = { uOffset: a[0], uDivisor: a[1], vDivisor: a[2] }
          o.directives.push({ kind: 'TxtrAdjust', line, adjust: txtrAdjust })
        }
        break
      }
      case 'TextureScale': {
        const o = needObject(kw)
        // BH2.exe reads one %f; any further tokens on the line are skipped as unknown words.
        // The shipped file has two "TextureScale N N" lines; both values are equal.
        const ignoredTokens = toks.slice(2)
        if (ignoredTokens.some((t) => t !== toks[1])) issue('TextureScale extra tokens differ from the scale')
        const a = numbers(toks.slice(0, 2), 'f')
        if (o && a) {
          if (a[0] === 0) issue('TextureScale 0')
          textureScale = a[0]
          o.directives.push({ kind: 'TextureScale', line, scale: a[0], ignoredTokens })
        }
        break
      }
      case 'Backup': {
        const o = needObject(kw)
        if (o && numbers(toks, '')) o.directives.push({ kind: 'Backup', line })
        break
      }
      case 'Instance':
      case 'Copy':
      case 'Link':
      case 'InstanceBackup': {
        const o = needObject(kw)
        const a = numbers(toks, 'd')
        if (!o || !a) break
        if (kw === 'InstanceBackup' && a[0] < 0) {
          issue('InstanceBackup takes an absolute object id')
          break
        }
        const target = resolve(kw, a[0])
        if (target === null) break
        if (kw === 'InstanceBackup') o.directives.push({ kind: kw, line, target })
        else {
          if (kw === 'Instance') o.instanceOf = target
          else if (kw === 'Copy') o.copies.push(target)
          else o.parent = target
          o.directives.push({ kind: kw, line, ref: a[0], target })
        }
        break
      }
      case 'TextureMap':
      case 'ColorKeyed': {
        const a = toks.length === 6 ? numbers([kw, ...toks.slice(2)], 'dddd') : null
        if (toks.length !== 6) issue(`${kw} expects: file slot bpp width height`)
        if (a) geo.textures.push({ line, kind: kw, file: toks[1], slot: a[0], bitsPerPixel: a[1], width: a[2], height: a[3] })
        break
      }
      case 'Animated':
      case 'Film': {
        const a = toks.length === 7 ? numbers([kw, toks[1], ...toks.slice(3)], 'ddddd') : null
        if (toks.length !== 7) issue(`${kw} expects: set file frames bpp width height`)
        if (a)
          geo.animations.push({
            line,
            kind: kw,
            set: a[0],
            file: toks[2],
            frameCount: a[1],
            bitsPerPixel: a[2],
            width: a[3],
            height: a[4],
            rowsPerFrameInFile: kw === 'Film' ? a[4] + 16 : a[4],
          })
        break
      }
      default:
        issue(`unknown directive "${kw}"`)
    }
  }
  const open = current()
  if (open) issue(`object ${open.id} has no ObjectEnd`, lines.length - 1)
  if (!geo.hasEnd) issue('missing End', lines.length - 1)
  if (geo.header === null) issue('missing POLY header', 0)
  return geo
}

/**
 * Polygons an object actually draws: Instance draws the target's list instead of its own,
 * Copy splices the target's (already expanded) list in at that point.
 */
export function expandedPolygons(geo: Geometry3D, id: number, seen: ReadonlySet<number> = new Set()): Polygon[] {
  const o = geo.objects.find((x) => x.id === id)
  if (!o || seen.has(id)) return []
  const next = new Set(seen).add(id)
  if (o.instanceOf !== null) return expandedPolygons(geo, o.instanceOf, next)
  const out: Polygon[] = []
  for (const d of o.directives) {
    if (d.kind === 'Polygon') out.push(o.polygons[d.polygonIndex])
    else if (d.kind === 'Copy') out.push(...expandedPolygons(geo, d.target, next))
  }
  return out
}

export interface TextureFileRef {
  file: string
  directive: 'TextureMap' | 'ColorKeyed' | 'Animated' | 'Film'
  /** TextureMap/ColorKeyed slot. */
  slot: number | null
  /** Animated/Film set number. */
  set: number | null
  width: number
  height: number
  bitsPerPixel: number
  frameCount: number
  /** Bytes BH2.exe reads: width * rows * frames * bpp/8. Headerless, RGB byte order, top row first. */
  expectedBytes: number
  /** Black (0,0,0) is the DirectDraw source color key (ColorKeyed and Film). */
  colorKeyBlack: boolean
  /** Number of polygons whose file-order texture is this slot (TextureMap/ColorKeyed only). */
  polygonCount: number
}

export interface TextureReferences {
  files: TextureFileRef[]
  /** Slot -> polygon count, from file-order SetTexture/SetTextureInc state. */
  slotUse: Map<number, number>
  /** Slots used by polygons that no TextureMap/ColorKeyed defines (runtime animation slots). */
  runtimeSlots: number[]
}

/** PolyTypes that sample the current texture (Reflected* as an environment map). */
export const TEXTURED: ReadonlySet<PolyType> = new Set<PolyType>(['Textured', 'TxtrAlpha', 'SortTxtr', 'TexturedL', 'ConvertTexturedL', 'Reflected', 'ReflectedL'])

/** Which texture files Geometry.3D loads, their exact sizes, and which slots polygons use. */
export function describeTextureReferences(geo: Geometry3D): TextureReferences {
  const slotUse = new Map<number, number>()
  for (const o of geo.objects)
    for (const p of o.polygons)
      if (TEXTURED.has(p.polyType) && p.state.texture !== null && p.state.blendMode !== 0)
        slotUse.set(p.state.texture, (slotUse.get(p.state.texture) ?? 0) + 1)
  const files: TextureFileRef[] = [
    ...geo.textures.map((t) => ({
      file: t.file,
      directive: t.kind,
      slot: t.slot,
      set: null,
      width: t.width,
      height: t.height,
      bitsPerPixel: t.bitsPerPixel,
      frameCount: 1,
      expectedBytes: (t.width * t.height * t.bitsPerPixel) / 8,
      colorKeyBlack: t.kind === 'ColorKeyed',
      polygonCount: slotUse.get(t.slot) ?? 0,
    })),
    ...geo.animations.map((a) => ({
      file: a.file,
      directive: a.kind,
      slot: null,
      set: a.set,
      width: a.width,
      height: a.height,
      bitsPerPixel: a.bitsPerPixel,
      frameCount: a.frameCount,
      expectedBytes: (a.width * a.rowsPerFrameInFile * a.frameCount * a.bitsPerPixel) / 8,
      colorKeyBlack: a.kind === 'Film',
      polygonCount: 0,
    })),
  ]
  const defined = new Set(geo.textures.map((t) => t.slot))
  const runtimeSlots = [...slotUse.keys()].filter((s) => !defined.has(s)).sort((a, b) => a - b)
  return { files, slotUse, runtimeSlots }
}
