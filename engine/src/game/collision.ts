import * as THREE from 'three/webgpu'
import type { ShapeData } from '../formats/shapedata'
import { HIT_RADIUS, SHAPE, type ShapeKind } from './constants'
import type { Target } from './world'

// Ray vs ShapeData hit polygons (FUN_00423d9d): nearest hit within length, returns the part ("zone") index.

interface Poly {
  zone: number
  normal: THREE.Vector3
  d: number
  /** 2D outline projected on the plane's dominant axis. */
  pts: Float64Array
  axis: 0 | 1 | 2
}

const _inv = new THREE.Matrix4()
const _o = new THREE.Vector3()
const _d = new THREE.Vector3()
const _c = new THREE.Vector3()
const _p = new THREE.Vector3()

export interface RayHit {
  target: Target
  zone: number
  distance: number
  point: THREE.Vector3
}

export class Collision {
  private polys = new Map<ShapeKind, Poly[]>()

  constructor(shapes: ShapeData) {
    for (const [kind, index] of Object.entries(SHAPE) as [ShapeKind, number][]) {
      const obj = shapes.objects[index]
      if (!obj) continue
      const list: Poly[] = []
      for (const part of obj.parts) {
        for (const poly of part.polygons) {
          const v = poly.vertices.map((p) => new THREE.Vector3(...p))
          if (v.length < 3) continue
          // Newell normal handles non-convex or slightly non-planar outlines.
          const n = new THREE.Vector3()
          for (let i = 0; i < v.length; i++) {
            const a = v[i], b = v[(i + 1) % v.length]
            n.x += (a.y - b.y) * (a.z + b.z)
            n.y += (a.z - b.z) * (a.x + b.x)
            n.z += (a.x - b.x) * (a.y + b.y)
          }
          if (n.lengthSq() < 1e-9) continue
          n.normalize()
          const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z)
          const axis: 0 | 1 | 2 = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2
          const pts = new Float64Array(v.length * 2)
          v.forEach((p, i) => {
            const [u, w] = axis === 0 ? [p.y, p.z] : axis === 1 ? [p.x, p.z] : [p.x, p.y]
            pts[i * 2] = u
            pts[i * 2 + 1] = w
          })
          list.push({ zone: part.index, normal: n, d: -n.dot(v[0]), pts, axis })
        }
      }
      this.polys.set(kind, list)
    }
  }

  /** Nearest hit among targets, from origin along unit dir, within length. */
  ray(targets: readonly Target[], origin: THREE.Vector3, dir: THREE.Vector3, length: number, filter?: (t: Target) => boolean): RayHit | null {
    let best: RayHit | null = null
    for (const t of targets) {
      if (!t.alive() || (filter && !filter(t))) continue
      t.node.getWorldPosition(_c)
      // Bounding sphere vs segment.
      const r = HIT_RADIUS[t.shape]
      const along = THREE.MathUtils.clamp(_p.subVectors(_c, origin).dot(dir), 0, length)
      if (_p.copy(dir).multiplyScalar(along).add(origin).distanceToSquared(_c) > r * r) continue
      const hit = this.rayTarget(t, origin, dir, length)
      if (hit && (!best || hit.distance < best.distance)) best = hit
    }
    return best
  }

  private rayTarget(t: Target, origin: THREE.Vector3, dir: THREE.Vector3, length: number): RayHit | null {
    const polys = this.polys.get(t.shape)
    if (!polys) return null
    _inv.copy(t.node.matrixWorld).invert()
    _o.copy(origin).applyMatrix4(_inv)
    _d.copy(dir).transformDirection(_inv)
    // transformDirection normalizes; recover the scale so distances stay in world units.
    const scale = new THREE.Vector3().copy(dir).multiplyScalar(length).add(origin).applyMatrix4(_inv).sub(_o).length() / length
    let bestT = Infinity, zone = -1
    for (const p of polys) {
      const denom = p.normal.dot(_d)
      if (Math.abs(denom) < 1e-9) continue
      const tt = -(p.normal.dot(_o) + p.d) / denom
      if (tt < 0 || tt > length * scale || tt >= bestT) continue
      _p.copy(_d).multiplyScalar(tt).add(_o)
      const [u, w] = p.axis === 0 ? [_p.y, _p.z] : p.axis === 1 ? [_p.x, _p.z] : [_p.x, _p.y]
      if (inside(p.pts, u, w)) {
        bestT = tt
        zone = p.zone
      }
    }
    if (zone < 0) return null
    const distance = bestT / scale
    return { target: t, zone, distance, point: dir.clone().multiplyScalar(distance).add(origin) }
  }
}

function inside(pts: Float64Array, x: number, y: number) {
  let c = false
  const n = pts.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1], xj = pts[j * 2], yj = pts[j * 2 + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
