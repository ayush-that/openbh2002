import * as THREE from 'three/webgpu'
import { texture, uv, step, mix } from 'three/tsl'
import type { GameFS } from '../vfs'
import { decodeGrid8, type Grid8 } from '../formats/heightmap'
import { loadTileGrid } from '../render/textures'
import { TERRAIN } from './config'

interface Chunk {
  mesh: THREE.Mesh
  /** Index ranges per entry of TERRAIN.lodSteps: surface plus skirts. */
  lods: { start: number; count: number }[]
  box: THREE.Box3
  lod: number
}

/**
 * Heightmap terrain (remaster only). Chunks are built on demand: `build()` finishes synchronously,
 * `buildInBackground()` builds in small time slices. Each chunk holds one vertex grid and one index buffer
 * with every LOD (`TERRAIN.lodSteps`); `updateLod` picks a range by distance. Skirts hang from chunk edges
 * so neighbours at different LODs never show cracks.
 */
export class Terrain {
  readonly group = new THREE.Group()
  readonly grid: Grid8
  readonly farTex: THREE.Texture
  readonly closeTex: THREE.Texture
  private material: THREE.Material
  private chunks: Chunk[] = []
  private next = 0
  private background: Promise<void> | null = null
  private lodKey = ''

  private constructor(grid: Grid8, farTex: THREE.Texture, closeTex: THREE.Texture) {
    this.grid = grid
    this.farTex = farTex
    this.closeTex = closeTex
    const e = TERRAIN.closeExtent, lo = (1 - e) / 2, hi = lo + e
    const u = uv()
    const inClose = step(lo, u.x).mul(step(u.x, hi)).mul(step(lo, u.y)).mul(step(u.y, hi))
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
    material.colorNode = mix(texture(farTex, u), texture(closeTex, u.sub(lo).div(e)), inClose)
    this.material = material
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
    const [grid, farTex, closeTex] = await Promise.all([
      fs.read(TERRAIN.heightmap).then((d) => decodeGrid8(TERRAIN.heightmap, d)),
      loadTileGrid(fs, TERRAIN.far.grid, TERRAIN.far.files),
      loadTileGrid(fs, TERRAIN.close.grid, TERRAIN.close.files),
    ])
    return new Terrain(grid, farTex, closeTex)
  }

  private get chunkCount() {
    const n = Math.ceil((this.grid.size - 1) / TERRAIN.chunkCells)
    return n * n
  }

  get built() {
    return this.next >= this.chunkCount
  }

  /** Build every remaining chunk now. */
  build() {
    while (!this.built) this.buildChunk()
  }

  /** Build the remaining chunks in slices of about `sliceMs`, yielding to the frame loop in between. */
  buildInBackground(sliceMs = 4) {
    this.background ??= (async () => {
      while (!this.built) {
        const end = performance.now() + sliceMs
        while (!this.built && performance.now() < end) this.buildChunk()
        await new Promise((r) => setTimeout(r, 0))
      }
    })()
    return this.background
  }

  /**
   * Pick each chunk's LOD from its distance to the eye: a chunk at distance d uses the largest step s with
   * s x lodDistance <= d, so triangles keep about the same screen size. lodDistance <= 0 = full detail.
   */
  updateLod(eye: THREE.Vector3, lodDistance: number) {
    const key = `${eye.x}|${eye.y}|${eye.z}|${lodDistance}|${this.next}`
    if (key === this.lodKey) return
    this.lodKey = key
    const steps = TERRAIN.lodSteps
    for (const c of this.chunks) {
      const d = c.box.distanceToPoint(eye)
      let lod = 0
      while (lodDistance > 0 && lod + 1 < c.lods.length && steps[lod + 1] * lodDistance <= d) lod++
      if (lod === c.lod) continue
      c.lod = lod
      c.mesh.geometry.setDrawRange(c.lods[lod].start, c.lods[lod].count)
    }
  }

  /** Triangles drawn at full detail vs the current LOD selection (all chunks, before frustum culling). */
  triangleCounts() {
    let full = 0, current = 0
    for (const c of this.chunks) {
      full += c.lods[0].count / 3
      current += c.lods[c.lod].count / 3
    }
    return { full, current }
  }

  private buildChunk() {
    const cells = this.grid.size - 1, n = TERRAIN.chunkCells, per = Math.ceil(cells / n)
    const cx = (this.next % per) * n, cz = Math.floor(this.next / per) * n
    this.next++
    const chunk = this.chunk(cx, cz, Math.min(n, cells - cx), Math.min(n, cells - cz))
    chunk.mesh.material = this.material
    chunk.mesh.receiveShadow = true
    this.chunks.push(chunk)
    this.group.add(chunk.mesh)
  }

  private chunk(x0: number, z0: number, w: number, d: number): Chunk {
    const { size, data } = this.grid
    const { cellSize: cs, heightScale: hs } = TERRAIN
    const half = (size - 1) / 2
    const vw = w + 1, vd = d + 1

    // Heights are 8-unit steps, so gentle far slopes show contour stripes under a low sun. Normals come from a
    // 5x5 box-blurred copy of the heights (render only; heightAt and vertex positions use the raw heights).
    const r = 2, pad = r + 1, bw = vw + 2 * pad, bd = vd + 2 * pad
    const raw = (i: number, j: number) => data[THREE.MathUtils.clamp(j, 0, size - 1) * size + THREE.MathUtils.clamp(i, 0, size - 1)]
    const rowBlur = new Float32Array(bw * bd), blur = new Float32Array(bw * bd)
    for (let j = 0; j < bd; j++) {
      for (let i = 0; i < bw; i++) {
        let s = 0
        for (let k = -r; k <= r; k++) s += raw(x0 - pad + i + k, z0 - pad + j)
        rowBlur[j * bw + i] = s / (2 * r + 1)
      }
    }
    for (let j = r; j < bd - r; j++) {
      for (let i = 0; i < bw; i++) {
        let s = 0
        for (let k = -r; k <= r; k++) s += rowBlur[(j + k) * bw + i]
        blur[j * bw + i] = s / (2 * r + 1)
      }
    }
    const B = (i: number, j: number) => blur[(j + pad) * bw + i + pad] * hs

    const skirtCount = 2 * vw + 2 * vd, total = vw * vd + skirtCount
    const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), uvs = new Float32Array(total * 2)
    const n = new THREE.Vector3()
    let ymin = Infinity, ymax = -Infinity
    for (let j = 0; j < vd; j++) {
      for (let i = 0; i < vw; i++) {
        const gi = x0 + i, gj = z0 + j, k = j * vw + i, y = raw(gi, gj) * hs
        ymin = Math.min(ymin, y)
        ymax = Math.max(ymax, y)
        pos[k * 3] = (gi - half) * cs
        pos[k * 3 + 1] = y
        pos[k * 3 + 2] = (gj - half) * cs
        n.set(B(i - 1, j) - B(i + 1, j), 2 * cs, B(i, j - 1) - B(i, j + 1)).normalize()
        n.toArray(nrm, k * 3)
        uvs[k * 2] = gi / (size - 1)
        uvs[k * 2 + 1] = gj / (size - 1)
      }
    }
    // Skirt vertices: copies of the edge vertices lowered by the chunk's height range (the largest possible
    // LOD error), same normal and uv so a crack is filled with matching colour.
    const depth = ymax - ymin + 2 * hs
    const edges = [
      { base: vw * vd, len: vw, at: (t: number) => t }, // north (j = 0)
      { base: vw * vd + vw, len: vw, at: (t: number) => (vd - 1) * vw + t }, // south
      { base: vw * vd + 2 * vw, len: vd, at: (t: number) => t * vw }, // west (i = 0)
      { base: vw * vd + 2 * vw + vd, len: vd, at: (t: number) => t * vw + vw - 1 }, // east
    ]
    for (const e of edges) {
      for (let t = 0; t < e.len; t++) {
        const src = e.at(t), dst = e.base + t
        pos.copyWithin(dst * 3, src * 3, src * 3 + 3)
        pos[dst * 3 + 1] -= depth
        nrm.copyWithin(dst * 3, src * 3, src * 3 + 3)
        uvs.copyWithin(dst * 2, src * 2, src * 2 + 2)
      }
    }

    // One index buffer, LOD after LOD. Skirts are emitted with both windings (visible from either side).
    const samples = (len: number, s: number) => {
      const out: number[] = []
      for (let t = 0; t < len; t += s) out.push(t)
      if (out[out.length - 1] !== len) out.push(len)
      return out
    }
    const idx: number[] = []
    const lods: Chunk['lods'] = []
    for (const s of TERRAIN.lodSteps) {
      if (lods.length && s > Math.max(w, d)) break
      const start = idx.length
      const xs = samples(w, s), zs = samples(d, s)
      for (let b = 0; b + 1 < zs.length; b++) {
        for (let a = 0; a + 1 < xs.length; a++) {
          const p = zs[b] * vw + xs[a], q = zs[b] * vw + xs[a + 1], c = zs[b + 1] * vw + xs[a], e = zs[b + 1] * vw + xs[a + 1]
          idx.push(p, c, q, q, c, e)
        }
      }
      for (const e of edges) {
        const ts = e.len === vw ? xs : zs
        for (let a = 0; a + 1 < ts.length; a++) {
          const p = e.at(ts[a]), q = e.at(ts[a + 1]), p2 = e.base + ts[a], q2 = e.base + ts[a + 1]
          idx.push(p, q, p2, q, q2, p2, p, p2, q, q, p2, q2)
        }
      }
      lods.push({ start, count: idx.length - start })
    }

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    g.setIndex(new THREE.BufferAttribute(total < 65536 ? new Uint16Array(idx) : new Uint32Array(idx), 1))
    g.setDrawRange(lods[0].start, lods[0].count)
    g.computeBoundingSphere()
    const box = new THREE.Box3(
      new THREE.Vector3((x0 - half) * cs, ymin, (z0 - half) * cs),
      new THREE.Vector3((x0 + w - half) * cs, ymax, (z0 + d - half) * cs),
    )
    return { mesh: new THREE.Mesh(g, this.material), lods, box, lod: 0 }
  }
}
