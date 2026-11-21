import * as THREE from 'three/webgpu'
import { texture, uv, step, mix } from 'three/tsl'
import type { GameFS } from '../vfs'
import { decodeGrid8, type Grid8 } from '../formats/heightmap'
import { loadTileGrid } from '../render/textures'
import { TERRAIN } from './config'

export class Terrain {
  readonly group = new THREE.Group()
  readonly grid: Grid8
  private constructor(grid: Grid8) {
    this.grid = grid
  }

  get size() {
    return (this.grid.size - 1) * TERRAIN.cellSize
  }

  /** Bilinear terrain height at world (x, z); world origin is the map center. */
  heightAt(x: number, z: number) {
    const { size, data } = this.grid
    const fx = THREE.MathUtils.clamp(x / TERRAIN.cellSize + (size - 1) / 2, 0, size - 1.001)
    const fz = THREE.MathUtils.clamp(z / TERRAIN.cellSize + (size - 1) / 2, 0, size - 1.001)
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j
    const h = (a: number, b: number) => data[b * size + a]
    const top = h(i, j) * (1 - tx) + h(i + 1, j) * tx
    const bottom = h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx
    return (top * (1 - tz) + bottom * tz) * TERRAIN.heightScale
  }

  static async load(fs: GameFS) {
    const grid = decodeGrid8(TERRAIN.heightmap, await fs.read(TERRAIN.heightmap))
    const [farTex, closeTex] = await Promise.all([
      loadTileGrid(fs, TERRAIN.far.grid, TERRAIN.far.files),
      loadTileGrid(fs, TERRAIN.close.grid, TERRAIN.close.files),
    ])
    const t = new Terrain(grid)
    t.build(farTex, closeTex)
    return t
  }

  private build(farTex: THREE.Texture, closeTex: THREE.Texture) {
    const e = TERRAIN.closeExtent, lo = (1 - e) / 2, hi = lo + e
    const u = uv()
    const inClose = step(lo, u.x).mul(step(u.x, hi)).mul(step(lo, u.y)).mul(step(u.y, hi))
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
    material.colorNode = mix(texture(farTex, u), texture(closeTex, u.sub(lo).div(e)), inClose)

    const { size } = this.grid
    const cells = size - 1, step_ = TERRAIN.chunkCells
    for (let cz = 0; cz < cells; cz += step_) {
      for (let cx = 0; cx < cells; cx += step_) {
        const mesh = new THREE.Mesh(this.chunk(cx, cz, Math.min(step_, cells - cx), Math.min(step_, cells - cz)), material)
        mesh.receiveShadow = true
        this.group.add(mesh)
      }
    }
  }

  private chunk(x0: number, z0: number, w: number, d: number) {
    const { size, data } = this.grid
    const { cellSize: cs, heightScale: hs } = TERRAIN
    const half = (size - 1) / 2
    const vw = w + 1, vd = d + 1
    const pos = new Float32Array(vw * vd * 3), nrm = new Float32Array(vw * vd * 3), uvs = new Float32Array(vw * vd * 2)
    const H = (i: number, j: number) => data[THREE.MathUtils.clamp(j, 0, size - 1) * size + THREE.MathUtils.clamp(i, 0, size - 1)] * hs
    const n = new THREE.Vector3()
    for (let j = 0; j < vd; j++) {
      for (let i = 0; i < vw; i++) {
        const gi = x0 + i, gj = z0 + j, k = j * vw + i
        pos.set([(gi - half) * cs, H(gi, gj), (gj - half) * cs], k * 3)
        n.set(H(gi - 1, gj) - H(gi + 1, gj), 2 * cs, H(gi, gj - 1) - H(gi, gj + 1)).normalize()
        nrm.set([n.x, n.y, n.z], k * 3)
        uvs.set([gi / (size - 1), gj / (size - 1)], k * 2)
      }
    }
    const idx = new Uint32Array(w * d * 6)
    let p = 0
    for (let j = 0; j < d; j++) {
      for (let i = 0; i < w; i++) {
        const a = j * vw + i, b = a + 1, c = a + vw, e = c + 1
        idx.set([a, c, b, b, c, e], p)
        p += 6
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    g.setIndex(new THREE.BufferAttribute(idx, 1))
    g.computeBoundingSphere()
    return g
  }
}
