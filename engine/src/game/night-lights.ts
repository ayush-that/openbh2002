import * as THREE from 'three/webgpu'
import { EYE } from './constants'
import type { World } from './world'

// Night lights (docs/re/architecture.md §3.6, notes 20 §8/§12, notes 30 §2.7).
// - Geometry.3D lights 2..5 follow falling flares: range 5000, intensity 600/255, linear falloff.
// - Light 1 is the searchlight at the eye along the view: cos cutoff 0.98, intensity 200/255. On at night
//   when the level has "Spotlight", off while shield < 26.
// Lights are created once and switched by intensity: changing the light count would recompile every
// lit material. Intensities are scaled by PI because Three.js Lambert divides by PI (see main.ts).

const FLARE_LIGHTS = 4
const _dir = new THREE.Vector3()

export class NightLights {
  private world: World
  private camera: THREE.Camera
  private flares: THREE.PointLight[] = []
  private spot: THREE.SpotLight
  private flareK: number
  private spotK: number

  constructor(scene: THREE.Scene, world: World, camera: THREE.Camera) {
    this.world = world
    this.camera = camera
    const lights = world.g3d.geo.objects.flatMap((o) => o.lights)
    const point = lights.find((l) => l.type === 'point')
    const spot = lights.find((l) => l.type === 'spot')
    this.flareK = ((point?.intensity ?? 600) / 255) * Math.PI
    this.spotK = ((spot?.intensity ?? 200) / 255) * Math.PI
    for (let i = 0; i < FLARE_LIGHTS; i++) {
      // DEVIATION: Three.js range falloff is (1 - (d/r)^4)^2, not the original's linear 1 - d/r
      // (decay 0 keeps the inverse-square term out). Brighter at mid range; same cutoff at 5000.
      const l = new THREE.PointLight(0xffffff, 0, point?.range ?? 5000, 0)
      this.flares.push(l)
      scene.add(l)
    }
    // Spot: s = 1 - (1 - cos) / (1 - cosCut) in the original; penumbra 1 gives smoothstep(cosCut, 1, cos).
    // Range is stored but not applied by the original, so distance 0 and no decay.
    this.spot = new THREE.SpotLight(0xffffff, 0, 0, Math.acos(spot?.cosCutoff ?? 0.98), 1, 0)
    this.spot.position.set(EYE.x, EYE.y, EYE.z)
    scene.add(this.spot, this.spot.target)
  }

  /** Call before rendering, with the same interpolation factor as the effects. */
  render(alpha: number) {
    const w = this.world
    const night = !w.daytime
    let k = 0
    for (const p of w.projectiles.list) {
      // A flare lights up once it becomes the slow falling light (after 20 frames).
      if (p.kind !== 'flare' || p.dead || k >= FLARE_LIGHTS) continue
      if (!(p.age > 20 && p.vel.y < 0 && p.vel.x === 0 && p.vel.z === 0)) continue
      const l = this.flares[k++]
      l.position.lerpVectors(p.prev, p.pos, alpha)
      l.intensity = night ? this.flareK : 0
    }
    for (; k < FLARE_LIGHTS; k++) this.flares[k].intensity = 0

    const on = night && w.level?.spotlight && w.player.shield >= 26
    this.spot.intensity = on ? this.spotK : 0
    if (on) {
      _dir.set(0, 0, -1).applyQuaternion(this.camera.quaternion)
      this.spot.target.position.copy(this.spot.position).addScaledVector(_dir, 1000)
      this.spot.target.updateMatrixWorld()
    }
  }
}
