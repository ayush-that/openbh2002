import * as THREE from 'three/webgpu'
import { GRAVITY, MOUNT } from './constants'
import type { Target, World } from './world'

// Projectile simulation from FUN_004154b7 (docs/re/gameplay.md §4-5, notes 20 §5). Pure logic:
// visuals (tracers, shells, flares, missile models, flames) are drawn by the Effects system from `list`.

export type ProjectileKind =
  | 'bullet' // player guns, handgun, APC2 MGs, jet and cobra guns (500 u/f, g 0.16)
  | 'shell' // player cannon (400) and tank shells (500), g 0.16
  | 'missile' // player guided missile, 280 u/f, lifetime 130
  | 'rocket' // cobra rocket, 280 straight, lifetime 100
  | 'apcRocket' // APC3 rocket, 280 straight, lifetime 130
  | 'bomb' // jet/bomber bomb
  | 'grenade' // soldier grenade, g 1.0
  | 'flare' // player flare (night light)

export interface Projectile {
  kind: ProjectileKind
  pos: THREE.Vector3
  vel: THREE.Vector3
  /** Previous position, for ray tests and render interpolation. */
  prev: THREE.Vector3
  /** Frames left (missiles, rockets) or age (flares). */
  life: number
  age: number
  fromPlayer: boolean
  /** Bomb horizontal speed (falls 1/frame). */
  hspeed: number
  /** Missile homing lock (for visuals/debug). */
  locked: boolean
  dead: boolean
}

const AIR = new Set(['jet', 'bomber', 'cobra', 'c130'])
const GROUND = new Set(['tank', 'apc'])
const _dir = new THREE.Vector3()
const _to = new THREE.Vector3()
const mount = new THREE.Vector3(MOUNT.x, MOUNT.y, MOUNT.z)

export class Projectiles {
  list: Projectile[] = []

  reset() {
    this.list = []
  }

  fire(kind: ProjectileKind, pos: THREE.Vector3, vel: THREE.Vector3, opts: { fromPlayer?: boolean; life?: number; hspeed?: number } = {}) {
    const p: Projectile = {
      kind,
      pos: pos.clone(),
      vel: vel.clone(),
      prev: pos.clone(),
      life: opts.life ?? 0,
      age: 0,
      fromPlayer: opts.fromPlayer ?? false,
      hspeed: opts.hspeed ?? 0,
      locked: false,
      dead: false,
    }
    this.list.push(p)
    return p
  }

  count(kind: ProjectileKind) {
    return this.list.filter((p) => p.kind === kind && !p.dead).length
  }

  update(w: World) {
    for (const p of this.list) {
      if (p.dead) continue
      p.prev.copy(p.pos)
      p.age++
      switch (p.kind) {
        case 'bullet':
          this.bullet(w, p)
          break
        case 'shell':
          this.shell(w, p)
          break
        case 'missile':
          this.missile(w, p)
          break
        case 'rocket':
        case 'apcRocket':
          this.rocket(w, p)
          break
        case 'bomb':
          this.bomb(w, p)
          break
        case 'grenade':
          this.grenade(w, p)
          break
        case 'flare':
          this.flare(w, p)
          break
      }
      if (Math.abs(p.pos.x) > 60000 || Math.abs(p.pos.z) > 60000 || p.pos.y < -2000) p.dead = true
    }
    this.list = this.list.filter((p) => !p.dead)
  }

  private below(w: World, p: Projectile) {
    return p.pos.y < w.groundY(p.pos.x, p.pos.z)
  }

  /** Ray test along the step just taken. */
  private rayHit(w: World, p: Projectile, length: number, filter: (t: Target) => boolean) {
    _dir.subVectors(p.pos, p.prev)
    const step = _dir.length()
    if (step < 1e-6) return null
    _dir.divideScalar(step)
    return w.collision.ray(w.targets, p.prev, _dir, Math.max(length, step), filter)
  }

  private bullet(w: World, p: Projectile) {
    p.pos.add(p.vel)
    p.vel.y -= GRAVITY
    if (p.pos.distanceTo(mount) < 300 && (!p.fromPlayer || p.age > 1)) {
      // Any bullet, including the player's own falling back, costs 1 shield.
      w.damagePlayer(1)
      p.dead = true
      return
    }
    if (p.fromPlayer) {
      const y = p.prev.y
      const hit = this.rayHit(w, p, 500, (t) => t.shape === 'ch53' || t.shape === 'parachute' || (y >= 750 ? AIR.has(t.shape) : GROUND.has(t.shape)))
      // Soldiers are tested below 750 before vehicles in the original.
      if (y < 750 && w.soldiers.rayKill(w, p.prev, _dir.subVectors(p.pos, p.prev).normalize(), 500)) {
        p.dead = true
        return
      }
      if (hit) {
        hit.target.hit(w, hit.zone, 'bullet', hit.point)
        p.dead = true
        return
      }
    }
    if (this.below(w, p)) {
      w.effects.spawn('dirt', p.pos)
      p.dead = true
    }
  }

  private shell(w: World, p: Projectile) {
    p.pos.add(p.vel)
    p.vel.y -= GRAVITY
    if (p.pos.distanceTo(mount) < 250 && (!p.fromPlayer || p.age > 1)) {
      w.damagePlayer(5)
      p.dead = true
      return
    }
    if (p.fromPlayer) {
      const y = p.prev.y
      const hit = this.rayHit(w, p, 400, (t) => t.shape === 'ch53' || t.shape === 'parachute' || (y >= 750 ? AIR.has(t.shape) : GROUND.has(t.shape)))
      if (hit) {
        hit.target.hit(w, hit.zone, 'shell', hit.point)
        p.dead = true
        return
      }
    }
    if (this.below(w, p)) {
      this.groundBlast(w, p.pos, 400)
      w.sound.play('ExMuffle')
      p.dead = true
    }
  }

  private missile(w: World, p: Projectile) {
    p.life--
    if (p.life <= 0) {
      p.dead = true
      return
    }
    // Homing after 10 frames, only above 800: best aircraft within a cos >= 0.8 cone, max 5 deg/frame.
    p.locked = false
    if (p.life < 120 && p.pos.y > 800) {
      _dir.copy(p.vel).normalize()
      let best: Target | null = null, bestCos = 0.8
      for (const t of w.targets) {
        if (!t.alive() || !(AIR.has(t.shape) || t.shape === 'ch53')) continue
        t.node.getWorldPosition(_to).sub(p.pos).normalize()
        const c = _to.dot(_dir)
        if (c >= bestCos) {
          bestCos = c
          best = t
        }
      }
      if (best) {
        p.locked = true
        best.node.getWorldPosition(_to).sub(p.pos).normalize()
        const deg = 180 / Math.PI
        const pitch = Math.asin(THREE.MathUtils.clamp(_dir.y, -1, 1)) * deg
        const pitchT = Math.asin(THREE.MathUtils.clamp(_to.y, -1, 1)) * deg
        const yaw = Math.atan2(-_dir.x, -_dir.z) * deg
        let dyaw = Math.atan2(-_to.x, -_to.z) * deg - yaw
        dyaw = ((dyaw + 540) % 360) - 180
        const np = (pitch + THREE.MathUtils.clamp(pitchT - pitch, -5, 5)) / deg
        const ny = (yaw + THREE.MathUtils.clamp(dyaw, -5, 5)) / deg
        p.vel.set(-Math.sin(ny) * Math.cos(np), Math.sin(np), -Math.cos(ny) * Math.cos(np)).multiplyScalar(280)
      }
    }
    p.pos.add(p.vel)
    if (p.pos.y >= 800) {
      for (const t of w.targets) {
        if (!t.alive() || !(AIR.has(t.shape) || t.shape === 'ch53')) continue
        if (t.node.getWorldPosition(_to).distanceTo(p.pos) < 300) {
          t.hit(w, 0, 'missile', p.pos)
          p.dead = true
          return
        }
      }
    } else {
      const hit = this.rayHit(w, p, 280, (t) => GROUND.has(t.shape) || t.shape === 'ch53')
      if (hit) {
        hit.target.hit(w, hit.zone, 'missile', hit.point)
        p.dead = true
        return
      }
    }
    if (this.below(w, p)) {
      this.groundBlast(w, p.pos, 400)
      w.sound.play('ExMuffle')
      p.dead = true
    }
  }

  private rocket(w: World, p: Projectile) {
    p.life--
    p.pos.add(p.vel)
    if (p.kind === 'apcRocket' && p.pos.distanceTo(mount) < 300) {
      w.damagePlayer(5)
      p.dead = true
      return
    }
    if (this.below(w, p) || p.life <= 0) {
      if (this.below(w, p)) this.impact(w, p.pos)
      p.dead = true
    }
  }

  private bomb(w: World, p: Projectile) {
    p.hspeed = Math.max(0, p.hspeed - 1)
    const h = Math.hypot(p.vel.x, p.vel.z)
    if (h > 1e-6) {
      p.vel.x *= p.hspeed / h
      p.vel.z *= p.hspeed / h
    }
    p.vel.y -= 1.5
    p.pos.add(p.vel)
    if (this.below(w, p)) {
      this.impact(w, p.pos)
      p.dead = true
    }
  }

  /** Bomb/rocket ground impact: explosion, soldiers within 500 thrown, distance sound, -5 within 300 horizontal. */
  private impact(w: World, pos: THREE.Vector3) {
    this.groundBlast(w, pos, 500)
    const d = Math.max(Math.abs(pos.x), Math.abs(pos.z))
    w.sound.play(d <= 1000 ? 'ExClose' : d < 4000 ? 'ExFar' : 'ExMuffle')
    if (Math.hypot(pos.x, pos.z) < 300) w.damagePlayer(5)
  }

  /** Explosion at ground level; soldiers within the radius die thrown into the air. */
  private groundBlast(w: World, pos: THREE.Vector3, soldierRadius: number) {
    const at = new THREE.Vector3(pos.x, w.groundY(pos.x, pos.z), pos.z)
    w.effects.spawn('explodeV', at)
    if (Math.abs(pos.x) > 400 || Math.abs(pos.z) > 400) for (let i = 0; i < 6; i++) w.effects.spawn('dirt', at)
    w.soldiers.killWithin(w, at, soldierRadius, true)
  }

  private grenade(w: World, p: Projectile) {
    p.pos.add(p.vel)
    p.vel.y -= 1
    if (p.pos.distanceTo(mount) < 200) {
      w.damagePlayer(5)
      p.dead = true
      return
    }
    if (this.below(w, p)) {
      w.effects.spawn('explodeF', p.pos, { scale: 4 })
      p.dead = true
    }
  }

  private flare(w: World, p: Projectile) {
    p.pos.add(p.vel)
    if (p.vel.y >= 0) p.vel.y -= 2
    if (p.age > 20 && p.vel.y < 0) {
      p.vel.set(0, p.pos.y > 4000 ? -20 : -7.5, 0)
    }
    if (this.below(w, p)) p.dead = true
  }
}
