import * as THREE from 'three/webgpu'
import type { GameFS } from '../vfs'
import { loadRaw24Texture } from '../render/textures'
import { SKY } from './config'

/** Horizon panorama on a camera-centered cylinder. PROVISIONAL layout until confirmed from the exe. */
export class Sky {
  readonly group = new THREE.Group()

  static async load(fs: GameFS, night = false) {
    const cfg = night ? SKY.night : SKY.day
    const tex = await loadRaw24Texture(fs, cfg.cylinder, { repeat: true })
    tex.repeat.set(4, 1)
    const sky = new Sky()
    const geo = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true)
    const mat = new THREE.MeshBasicNodeMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
    const cyl = new THREE.Mesh(geo, mat)
    cyl.scale.set(900, 450, 900)
    cyl.position.y = 120
    cyl.renderOrder = -1
    cyl.frustumCulled = false
    sky.group.add(cyl)
    return sky
  }

  follow(camera: THREE.Camera) {
    this.group.position.set(camera.position.x, 0, camera.position.z)
  }
}
