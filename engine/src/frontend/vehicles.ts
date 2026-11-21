// Weapons-chart vehicle viewer: the rotating vehicles/*.3DB models (bh2.ews FUN_00404b70 loads, FUN_00405300 draws).
//
// Original Direct3D (left-handed, row vectors), per frame:
//   world = RotY(t * 0.036 deg/ms) . RotY(45 deg) . RotX(-30 deg) . Translate(pos[i])
//   view = identity (eye at the origin looking +Z), projection FUN_0040f450(fov 0.785, near 15, far 15000):
//   vertical half-angle 22.5 deg, horizontal half-angle 1.333 x 22.5 = 30 deg.
//   Lighting: ambient 0x5a5a5a, one directional light, diffuse 0.9, direction (1, -0.8, 0.7).
// Here the D3D chain (db3MeshMatrices(..., false) keeps the exporter's X mirror) is followed by a Z flip into
// Three.js' right-handed frame; the two mirrors cancel so winding is unchanged.
import * as THREE from 'three/webgpu'
import type { GameFS } from '../vfs'
import { db3MeshMatrices, db3Nodes, parse3DB, type Db3Model } from '../formats/db3'
import { imageTexture } from '../render/textures'
import { decodeTGA } from './image'

export const VEHICLE_FILES = ['apc1', 'apc2', 'apc3', 'Mbt70', 'B58', 'F104', 'Ch53', 'C130', 'Cobra']
// DAT_004279e0 / DAT_00427a04 / DAT_00427a28
const POS: [number, number, number][] = [
  [-140, -20, 1400],
  [-140, -20, 1400],
  [-140, -20, 1400],
  [-140, -20, 1300],
  [-280, 20, 3600],
  [-240, 0, 2000],
  [-280, 160, 2500],
  [-360, 0, 3800],
  [-140, 140, 1800],
]

type M4 = number[] // row-major 4x4, row vectors

const mul = (a: M4, b: M4): M4 => {
  const o: M4 = new Array(16).fill(0)
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c]
  return o
}
const rotY = (a: number): M4 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
}
const rotX = (a: number): M4 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
}
const translate = (x: number, y: number, z: number): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
const FLIP_Z: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]
const from4x3 = (m: number[]): M4 => [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9], m[10], m[11], 1]
/** Row-vector matrix -> THREE (column vectors) = transpose; Matrix4.set takes row-major. */
const toThree = (m: M4) => new THREE.Matrix4().set(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15])

export class VehicleViewer {
  readonly canvas: HTMLCanvasElement
  private renderer: THREE.WebGPURenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private models: (THREE.Group | null)[] = []
  private textures = new Map<string, THREE.Texture | null>()
  private fs: GameFS
  private ready: Promise<void>
  private initialized = false
  /** DAT_0042ada4: ms, wraps at 10000. */
  private spin = 0

  constructor(fs: GameFS, width: number, height: number) {
    this.fs = fs
    this.renderer = new THREE.WebGPURenderer({ alpha: true, antialias: false })
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(width, height, false)
    this.renderer.setClearColor(0x000000, 0)
    this.canvas = this.renderer.domElement
    this.camera = new THREE.PerspectiveCamera(45, Math.tan(Math.PI / 6) / Math.tan(Math.PI / 8), 15, 15000)
    const k = Math.PI // Three.js Lambert divides by PI; D3D does not.
    this.scene.add(new THREE.AmbientLight(0xffffff, (0x5a / 255) * k))
    const sun = new THREE.DirectionalLight(0xffffff, 0.9 * k)
    sun.position.set(-1, 0.8, 0.7) // towards the light: -(1, -0.8, 0.7) with Z flipped
    this.scene.add(sun)
    this.ready = this.renderer.init().then(() => {
      this.initialized = true
    })
  }

  private async texture(file: string) {
    const key = file.toLowerCase()
    if (this.textures.has(key)) return this.textures.get(key)!
    let tex: THREE.Texture | null = null
    const path = `vehicles/${file}`
    if (this.fs.has(path)) {
      const pic = decodeTGA(await this.fs.read(path))
      tex = imageTexture(pic.width, pic.height, new Uint8Array(pic.data.buffer), { repeat: true })
    }
    this.textures.set(key, tex)
    return tex
  }

  private async build(model: Db3Model) {
    const mats = await Promise.all(
      model.materials.map(async (m) => {
        const diffuse = m.maps.find((x) => x.slot === 'diffuse' && x.file)
        const opacity = m.maps.find((x) => x.slot === 'opacity' && x.file)
        const map = diffuse ? await this.texture(diffuse.file) : null
        const mat = new THREE.MeshLambertMaterial({
          color: new THREE.Color().setRGB(...m.diffuse, THREE.LinearSRGBColorSpace),
          map,
          side: opacity ? THREE.DoubleSide : THREE.FrontSide,
          alphaTest: opacity ? 0.5 : 0,
        })
        return mat
      }),
    )
    const group = new THREE.Group()
    group.matrixAutoUpdate = false
    const matrices = db3MeshMatrices(model.root, false)
    for (const node of db3Nodes(model.root)) {
      const mesh = node.mesh
      if (!mesh) continue
      const n = mesh.cornerPosition.length
      const pos = new Float32Array(n * 3)
      for (let c = 0; c < n; c++) pos.set(mesh.positions.subarray(mesh.cornerPosition[c] * 3, mesh.cornerPosition[c] * 3 + 3), c * 3)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
      geo.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2))
      const index: number[] = []
      for (const g of mesh.groups) {
        geo.addGroup(index.length, g.indices.length, g.materialIndex)
        for (const i of g.indices) index.push(i)
      }
      geo.setIndex(index)
      const obj = new THREE.Mesh(geo, mats)
      obj.matrixAutoUpdate = false
      obj.matrix.copy(toThree(from4x3(matrices.get(node)!)))
      group.add(obj)
    }
    return group
  }

  async load(i: number) {
    await this.ready
    if (this.models[i] !== undefined) return
    this.models[i] = null
    const path = this.fs.list().find((p) => p.toLowerCase() === `vehicles/${VEHICLE_FILES[i]}.3db`.toLowerCase())
    if (!path) return
    const g = await this.build(parse3DB(await this.fs.read(path)))
    g.visible = false
    this.scene.add(g)
    this.models[i] = g
  }

  /** Draw vehicle `i` (null clears), advancing the spin by `dt` ms like FUN_00405300. */
  render(i: number | null, dt: number) {
    for (const m of this.models) if (m) m.visible = false
    const g = i === null ? null : this.models[i]
    if (i !== null) {
      if (g === undefined) void this.load(i)
      this.spin += dt
      if (this.spin > 10000) this.spin -= 10000
    }
    if (g) {
      const world = mul(mul(mul(mul(rotY(this.spin * 0.036 * (Math.PI / 180)), rotY(Math.PI / 4)), rotX(-Math.PI / 6)), translate(...POS[i!])), FLIP_Z)
      g.matrix.copy(toThree(world))
      g.matrixWorldNeedsUpdate = true
      g.visible = true
    }
    if (this.initialized) this.renderer.render(this.scene, this.camera)
  }

  /** Drawing-buffer pixels per 640x480 pixel (the front end's resolution multiple). */
  setResolution(n: number) {
    this.renderer.setPixelRatio(n)
  }

  dispose() {
    this.renderer.dispose()
  }
}
