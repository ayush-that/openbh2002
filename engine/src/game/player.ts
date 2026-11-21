import * as THREE from 'three/webgpu'
import { MOUNT, OBJ, PITCH_MAX, PITCH_MIN, deg } from './constants'
import type { Input } from './input'
import type { Projectile } from './projectiles'
import type { World } from './world'

// Player turret: aim (WinMain), weapon timing (WinMain fire counters) and weapon spawns (FUN_004154b7 §4).

const mount = new THREE.Vector3(MOUNT.x, MOUNT.y, MOUNT.z)

export function forward(yaw: number, pitch: number, out = new THREE.Vector3()) {
  const y = yaw * deg, p = pitch * deg
  return out.set(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p))
}

export function right(yaw: number, out = new THREE.Vector3()) {
  const y = yaw * deg
  return out.set(Math.cos(y), 0, -Math.sin(y))
}

export class Player {
  private input: Input
  private prevCy = 0
  /** WinMain DAT_0044784c: shared fire-timing counter. */
  private counter = 0
  /** Handgun/flare: one shot per click. */
  private clickLatch = false
  /** Missile rails: loaded flag and the missile in flight. */
  rails: [boolean, boolean] = [false, false]
  private railMissile: [Projectile | null, Projectile | null] = [null, null]
  /** Cosmetic recoil counters for the twin barrels and the cannon. */
  private recoil = { left: 0, right: 0, cannon: 0 }

  constructor(input: Input) {
    this.input = input
  }

  reset(w: World) {
    this.counter = 0
    this.rails = [false, false]
    this.railMissile = [null, null]
    this.loadRails(w)
    const p = w.player
    // When the level gives no bullets you start on the handgun.
    p.weapon = p.ammo.bullets > 0 ? 0 : 2
  }

  private loadRails(w: World) {
    for (const i of [0, 1] as const) {
      const m = this.railMissile[i]
      if (m && !m.dead) continue
      this.railMissile[i] = null
      if (!this.rails[i] && w.player.ammo.missiles > 0) {
        this.rails[i] = true
        if (!w.player.infiniteAmmo) w.player.ammo.missiles--
      }
    }
  }

  keys(w: World, keys: string[]) {
    const p = w.player
    for (const k of keys) {
      if (k === ' ') {
        if (p.weapon === 0) p.weapon = 1
        else if (p.weapon === 1) p.weapon = p.ammo.bullets <= 0 && p.ammo.handgun > 0 ? 2 : 0
        else p.weapon = 0
      } else if (k === 'g') p.weapon = 2
      else if (k === 'a') p.mouseTight = !p.mouseTight
      else if (k === 'i' || k === 'r') p.mouseReverse = !p.mouseReverse
      else if (k === '1') p.infiniteAmmo = !p.infiniteAmmo
      else if (k === '2') p.godMode = !p.godMode
      else if (k === '=') w.enemyMeter = 0
      else if (k === 'm' && w.outcome === 'playing') this.fireMissile(w)
      else if (k === 'f' && w.outcome === 'playing') this.fireFlare(w)
      else if (k === 'b' && p.bombersAvailable && w.outcome === 'playing') {
        p.bombersAvailable = false
        w.callBombers?.()
      }
    }
  }

  update(w: World) {
    const p = w.player
    const { cx, cy } = this.input
    // Yaw: rate control from horizontal offset. Pitch: change of the clamped vertical offset x 0.2.
    if (!p.mouseTight) p.yaw -= cx * 0.02
    else p.yaw -= Math.abs(cx / 20) * cx * 0.002
    const dy = cy - this.prevCy
    this.prevCy = cy
    p.pitch += p.mouseReverse ? dy * 0.2 : -dy * 0.2
    p.pitch = THREE.MathUtils.clamp(p.pitch, PITCH_MIN, PITCH_MAX)
    p.yaw = ((p.yaw % 360) + 360) % 360
    if (Math.abs(p.shake) >= 0.1) p.shake *= -0.85
    else p.shake = 0

    this.fire(w)
    this.loadRails(w)
    this.ammoOut(w)
    this.pose(w)
  }

  private fire(w: World) {
    const p = w.player
    const held = this.input.button && w.outcome === 'playing'
    const fwd = forward(p.yaw, p.pitch), side = right(p.yaw)
    const use = (key: 'bullets' | 'cannon') => {
      if (!p.infiniteAmmo) p.ammo[key]--
    }
    if (p.weapon === 0 && w.level.altGun === 0) {
      if (held && p.ammo.bullets > 0) {
        if (this.counter === 0 || this.counter === 3) {
          const s = this.counter === 0 ? -30 : 30
          const at = mount.clone().addScaledVector(fwd, 220).addScaledVector(side, s)
          w.projectiles.fire('bullet', at, fwd.clone().multiplyScalar(500), { fromPlayer: true })
          w.effects.spawn('explodeF', at, { scale: 0.15 })
          w.sound.play('AntiAir')
          use('bullets')
          this.recoil[this.counter === 0 ? 'left' : 'right'] = 6
        }
      }
      this.counter = (this.counter + 1) % 7
    } else if (p.weapon === 0) {
      if (held && this.counter === 0 && p.ammo.bullets > 0) {
        const at = mount.clone().addScaledVector(fwd, 80).addScaledVector(side, 8)
        w.projectiles.fire('bullet', at, fwd.clone().multiplyScalar(500), { fromPlayer: true })
        w.effects.spawn('explodeF', at, { scale: 0.15 })
        w.sound.play('MachineGun')
        use('bullets')
      }
      this.counter = (this.counter + 1) % 3
    } else if (p.weapon === 1) {
      if (held && this.counter === 0 && p.ammo.cannon > 0) {
        const at = mount.clone().addScaledVector(fwd, 265)
        w.projectiles.fire('shell', at, fwd.clone().multiplyScalar(400), { fromPlayer: true })
        w.effects.spawn('explodeF', at, { scale: 0.6 })
        w.sound.play('CannonClose')
        use('cannon')
        this.counter = 1
        this.recoil.cannon = 8
      }
      if (this.counter > 0) this.counter++
      if (this.counter > 30) this.counter = 0
    } else {
      if (held && !this.clickLatch && p.ammo.handgun > 0 && this.counter === 0) {
        const at = mount.clone().addScaledVector(fwd, 100).addScaledVector(side, 5)
        w.projectiles.fire('bullet', at, fwd.clone().multiplyScalar(400), { fromPlayer: true })
        w.effects.spawn('explodeF', at, { scale: 0.25 })
        w.sound.play('Pistol')
        p.ammo.handgun-- // no cheat bypass in the original
        this.clickLatch = true
      }
      if (!this.input.button) this.clickLatch = false
      this.counter = (this.counter + 1) % 4
    }
  }

  private fireMissile(w: World) {
    if (!this.rails[0] && !this.rails[1]) return
    const i = this.rails[0] ? 0 : 1
    const p = w.player
    const fwd = forward(p.yaw, p.pitch), side = right(p.yaw)
    const at = mount.clone().addScaledVector(side, i === 0 ? -100 : 100)
    this.rails[i] = false
    this.railMissile[i] = w.projectiles.fire('missile', at, fwd.multiplyScalar(280), { fromPlayer: true, life: 130 })
    w.sound.play('Missile')
  }

  private fireFlare(w: World) {
    const p = w.player
    if (w.daytime || p.ammo.flares <= 0 || w.projectiles.count('flare') >= 4) return
    const speed = Math.abs(p.pitch) >= 60 ? (80 - Math.abs(p.pitch)) * 10 : 200
    const fwd = forward(p.yaw, p.pitch)
    w.projectiles.fire('flare', mount.clone().addScaledVector(fwd, 100), fwd.multiplyScalar(speed), { fromPlayer: true })
    if (!p.infiniteAmmo) p.ammo.flares--
    w.sound.play('Missile')
  }

  /** All ammo gone with enemies left: shield drops to 0 after 60 frames (150 -> 90). */
  private ammoOut(w: World) {
    const a = w.player.ammo
    const railsEmpty = !this.rails[0] && !this.rails[1]
    if (a.bullets <= 0 && a.cannon <= 0 && a.missiles <= 0 && railsEmpty && a.handgun <= 0 && w.enemyMeter > 0 && w.outcome === 'playing') {
      w.player.ammoOutCounter--
      if (w.player.ammoOutCounter < 90) w.player.shield = 0
    } else w.player.ammoOutCounter = 150
  }

  /** Mount rotation, visible weapon model and recoil (cosmetic). */
  private pose(w: World) {
    const p = w.player
    const m = w.g3d.node(OBJ.mount)
    m.rotation.set(p.pitch * deg, p.yaw * deg, 0, 'YXZ')
    const alt = w.level.altGun !== 0
    w.g3d.node(OBJ.aaMount).visible = p.weapon === 0 && !alt
    w.g3d.node(OBJ.m60).visible = p.weapon === 0 && alt
    w.g3d.node(OBJ.cannon).visible = p.weapon === 1
    w.g3d.node(OBJ.mortor).visible = false
    w.g3d.node(OBJ.pistol).visible = p.weapon === 2
    const kick = (c: number) => (c >= 5 ? 30 * (7 - c) : c > 0 ? 15 * c : 0)
    w.g3d.node(21).position.z = kick(this.recoil.left)
    w.g3d.node(22).position.z = kick(this.recoil.right)
    w.g3d.node(OBJ.cannon).position.z = this.recoil.cannon > 6 ? 36 * (9 - this.recoil.cannon) : Math.max(0, this.recoil.cannon - 1) * 12
    for (const k of ['left', 'right', 'cannon'] as const) if (this.recoil[k] > 0) this.recoil[k]--
  }
}
