import * as THREE from 'three/webgpu'

/** Debug free-fly camera: click to capture mouse, WASD + Q/E to move, Shift for speed. */
export class FlyCam {
  speed = 40
  private keys = new Set<string>()
  private yaw = 0
  private pitch = 0

  readonly camera: THREE.PerspectiveCamera
  private el: HTMLElement

  constructor(camera: THREE.PerspectiveCamera, el: HTMLElement) {
    this.camera = camera
    this.el = el
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
    this.yaw = e.y
    this.pitch = e.x
    el.addEventListener('click', () => el.requestPointerLock())
    addEventListener('keydown', (ev) => this.keys.add(ev.code))
    addEventListener('keyup', (ev) => this.keys.delete(ev.code))
    addEventListener('blur', () => this.keys.clear())
    addEventListener('mousemove', (ev) => {
      if (document.pointerLockElement !== this.el) return
      this.yaw -= ev.movementX * 0.002
      this.pitch = THREE.MathUtils.clamp(this.pitch - ev.movementY * 0.002, -1.55, 1.55)
    })
  }

  lookAt(x: number, y: number, z: number) {
    this.camera.lookAt(x, y, z)
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ')
    this.yaw = e.y
    this.pitch = e.x
  }

  update(dt: number) {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'))
    const k = (c: string) => (this.keys.has(c) ? 1 : 0)
    const move = new THREE.Vector3(k('KeyD') - k('KeyA'), k('KeyE') - k('KeyQ'), k('KeyS') - k('KeyW'))
    if (move.lengthSq() === 0) return
    move.normalize().multiplyScalar(this.speed * dt * (this.keys.has('ShiftLeft') ? 5 : 1))
    this.camera.position.add(move.applyQuaternion(this.camera.quaternion))
  }
}
