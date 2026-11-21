import * as THREE from 'three/webgpu'
import type { GameFS } from '../vfs'
import type { Geometry3D, G3DObject, Polygon } from '../formats/geometry3d'
import { decodeRaw24, toRGBA } from '../formats/raw24'
import { imageTexture } from './textures'

// Builds Three.js objects from Geometry.3D. One Object3D per G3D object id, parented by Link,
// positioned by Translate. Instance/Copy objects share their target's geometry.

type Kind = 'lit' | 'unlit' | 'reflect'

const KIND: Partial<Record<Polygon['polyType'], Kind>> = {
  TexturedL: 'lit',
  ConvertTexturedL: 'lit',
  SmoothL: 'lit',
  Textured: 'unlit',
  SortTxtr: 'unlit',
  TxtrAlpha: 'unlit',
  Smooth: 'unlit',
  Reflected: 'reflect',
}

export interface G3DSceneObject {
  id: number
  label: string | null
  node: THREE.Object3D
}

export class G3DScene {
  readonly root = new THREE.Group()
  readonly nodes = new Map<number, THREE.Object3D>()
  private textures = new Map<string, THREE.Texture>()
  private materials = new Map<string, THREE.Material>()
  private meshesById = new Map<number, THREE.Mesh[]>()
  readonly geo: Geometry3D

  private constructor(geo: Geometry3D) {
    this.geo = geo
  }

  static async load(fs: GameFS, geo: Geometry3D) {
    const s = new G3DScene(geo)
    await s.loadTextures(fs)
    s.build()
    return s
  }

  node(id: number) {
    const n = this.nodes.get(id)
    if (!n) throw new Error(`No Geometry.3D object ${id}`)
    return n
  }

  /** Ids whose label (the comment before the object) matches. Instances inherit no label, so runs are contiguous. */
  idsByLabel(label: string) {
    return this.geo.objects.filter((o) => o.label === label).map((o) => o.id)
  }

  private async loadTextures(fs: GameFS) {
    await Promise.all(
      this.geo.textures.map(async (t) => {
        const img = decodeRaw24(t.file, await fs.read(`BH2Game/${t.file}`), t.width, t.height)
        this.textures.set(`${t.slot}`, imageTexture(img.width, img.height, toRGBA(img), { repeat: true }))
        this.textures.set(`${t.slot}k`, imageTexture(img.width, img.height, toRGBA(img, true), { repeat: true }))
        // Sphere maps are authored top-up; Three.js matcap samples bottom-up.
        const flipped = toRGBA(img), row = img.width * 4
        for (let y = 0; y < img.height / 2; y++) {
          const top = flipped.slice(y * row, (y + 1) * row)
          flipped.copyWithin(y * row, (img.height - 1 - y) * row, (img.height - y) * row)
          flipped.set(top, (img.height - 1 - y) * row)
        }
        this.textures.set(`${t.slot}r`, imageTexture(img.width, img.height, flipped))
      }),
    )
  }

  private texture(slot: number | null, variant: '' | 'k' | 'r') {
    if (!slot) return null
    return this.textures.get(`${slot}${variant}`) ?? null
  }

  private material(p: Polygon, kind: Kind) {
    const slot = p.state.blendMode ? p.state.texture : null
    const mode = p.state.blendMode ?? 0
    const noDepth = p.state.zEnable === false
    const key = `${kind}|${slot}|${mode}|${noDepth}`
    let m = this.materials.get(key)
    if (m) return m

    const map = this.texture(slot, kind === 'reflect' ? 'r' : mode === 4 ? 'k' : '')
    if (slot && !map) console.warn(`[g3d] texture slot ${slot} is filled at runtime (animation frame)`)
    if (kind === 'reflect') {
      m = new THREE.MeshMatcapNodeMaterial({ matcap: map ?? undefined })
    } else if (kind === 'lit') {
      m = new THREE.MeshLambertNodeMaterial({ map, vertexColors: true })
    } else {
      m = new THREE.MeshBasicNodeMaterial({ map, vertexColors: true })
    }
    m.side = THREE.DoubleSide
    // D3D7 blend modes from the original renderer (see docs/formats/geometry3d.md).
    if (mode === 4) {
      m.alphaTest = 0.5
    } else if (mode === 2 || mode === 3 || mode === 5) {
      m.transparent = true
      m.depthWrite = false
      m.blending = THREE.CustomBlending
      m.blendEquation = THREE.AddEquation
      if (mode === 2) [m.blendSrc, m.blendDst] = [THREE.ZeroFactor, THREE.OneMinusSrcColorFactor]
      if (mode === 3) [m.blendSrc, m.blendDst] = [THREE.ZeroFactor, THREE.SrcColorFactor]
      if (mode === 5) [m.blendSrc, m.blendDst] = [THREE.OneFactor, THREE.OneMinusSrcColorFactor]
    }
    if (noDepth) {
      m.depthTest = false
      m.depthWrite = false
    }
    this.materials.set(key, m)
    return m
  }

  private build() {
    const byId = new Map(this.geo.objects.map((o) => [o.id, o]))
    for (const o of this.geo.objects) {
      const node = new THREE.Group()
      node.name = `${o.id}:${o.label ?? ''}`
      node.visible = o.visible
      if (o.translate) node.position.set(...o.translate)
      this.nodes.set(o.id, node)
    }
    for (const o of this.geo.objects) {
      const node = this.nodes.get(o.id)!
      ;(o.parent !== null ? this.nodes.get(o.parent) ?? this.root : this.root).add(node)
      const source = o.instanceOf !== null ? byId.get(o.instanceOf)! : o
      for (const mesh of this.meshes(source, byId)) node.add(mesh)
    }
  }

  /** Meshes for an object's own polygons plus any Copy targets, cached per source id. */
  private meshes(o: G3DObject, byId: Map<number, G3DObject>): THREE.Mesh[] {
    const cached = this.meshesById.get(o.id)
    if (cached) return cached.map((m) => new THREE.Mesh(m.geometry, m.material))
    const polys = [...o.copies.flatMap((c) => byId.get(c)?.polygons ?? []), ...o.polygons]
    const groups = new Map<THREE.Material, Polygon[]>()
    for (const p of polys) {
      const kind = KIND[p.polyType]
      if (!kind || p.vertices.length < 3) continue
      const m = this.material(p, kind)
      groups.set(m, [...(groups.get(m) ?? []), p])
    }
    const meshes = [...groups].map(([m, ps]) => {
      const mesh = new THREE.Mesh(buildGeometry(ps), m)
      if (m.depthTest === false) mesh.renderOrder = o.id < 10 ? -10 : 10
      else if (m.transparent) mesh.renderOrder = 1
      return mesh
    })
    this.meshesById.set(o.id, meshes)
    return meshes
  }
}

function buildGeometry(polys: Polygon[]) {
  let tris = 0
  for (const p of polys) tris += p.vertices.length - 2
  const pos = new Float32Array(tris * 9), nrm = new Float32Array(tris * 9), col = new Float32Array(tris * 9), uv = new Float32Array(tris * 6)
  let t = 0
  const n = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (const p of polys) {
    const [cr, cg, cb] = p.state.color ?? [255, 255, 255]
    for (let k = 1; k < p.vertices.length - 1; k++) {
      const idx = [0, k, k + 1]
      a.fromArray(p.vertices[0].position)
      b.fromArray(p.vertices[k].position)
      c.fromArray(p.vertices[k + 1].position)
      const face = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize()
      for (let v = 0; v < 3; v++) {
        const vert = p.vertices[idx[v]]
        const o3 = (t * 3 + v) * 3
        pos.set(vert.position, o3)
        if (vert.normal) n.fromArray(vert.normal).normalize()
        else n.copy(face)
        nrm.set([n.x, n.y, n.z], o3)
        // Smooth parts are drawn under Color 0 0 0 with per-vertex shade: treat shade as gray level there.
        const s = (vert.shade ?? 255) / 255
        const black = cr === 0 && cg === 0 && cb === 0
        col.set(black ? [s, s, s] : [(cr / 255) * s, (cg / 255) * s, (cb / 255) * s], o3)
        const u = p.uvNormalized?.[idx[v]]
        if (u) uv.set(u, (t * 3 + v) * 2)
      }
      t++
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.computeBoundingSphere()
  return g
}
