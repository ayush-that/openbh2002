import * as THREE from 'three/webgpu'
import { deg } from '../constants'
import type { Target, World } from '../world'

// Parachute pool (objects 0x126-0x165, ring DAT_00447864) and prize crates (0x1c6-0x1d5, one ring of 4 per
// kind). Motion from FUN_004051c8 (decomp L4858-4892, L4902-4924); shooting a parachute from FUN_004154b7
// (L7171-7263). Crates hang 250 below the canopy, paratroopers 300 below.

/** 0 health (hdrop), 1 bullets (adrop), 2 cannon shells (pdrop), 3 missiles (mdrop). */
export type CrateKind = 0 | 1 | 2 | 3

const PARACHUTE_FIRST = 294
const CRATE_FIRST = 454
const POOL = 64
const PRIZE = ['health', 'bullets', 'cannon', 'missiles'] as const

interface Chute {
  node: THREE.Object3D
  active: boolean
  pos: THREE.Vector3
  yaw: number
  /** Pendulum angle (rotation about X) and swing velocity (B+0x58), deg and deg/frame. */
  pitch: number
  swing: number
  /** -1 soldier, else crate slot 0..15 (kind * 4 + ring). */
  payload: number
}

const _p = new THREE.Vector3()

export class Parachutes {
  private chutes: Chute[] = []
  private crates: THREE.Object3D[] = []
  /** Which parachute currently carries each crate slot (-1 none). */
  private crateOwner: number[] = []
  private next = 0
  private crateRing = [0, 0, 0, 0]

  constructor(world: World) {
    for (let i = 0; i < POOL; i++) this.chutes.push({ node: world.g3d.node(PARACHUTE_FIRST + i), active: false, pos: new THREE.Vector3(), yaw: 0, pitch: 0, swing: 0, payload: -1 })
    for (let i = 0; i < 16; i++) this.crates.push(world.g3d.node(CRATE_FIRST + i))
  }

  reset(world: World) {
    this.next = 0
    this.crateRing = [0, 0, 0, 0]
    this.crateOwner = new Array<number>(16).fill(-1)
    for (const c of this.chutes) {
      c.active = false
      c.node.visible = false
    }
    for (const n of this.crates) n.visible = false
    this.chutes.forEach((c, i) => world.targets.push(this.target(c, i)))
  }

  /** C130 drop: a parachute at the plane, pitched 45 deg, carrying a paratrooper or a crate. */
  drop(world: World, pos: THREE.Vector3, yaw: number, payload: 'soldier' | CrateKind) {
    const i = this.next
    this.next = (this.next + 1) % POOL
    const c = this.chutes[i]
    if (c.active && c.payload < 0) {
      // The ring wraps onto a paratrooper still in the air. In BH2.exe the trooper is a soldier allocated at drop time
      // that survives the parachute reuse, so he must not vanish (the enemy meter counts him): let him fall on his own.
      _p.set(0, -300, 0).applyMatrix4(c.node.matrix)
      world.soldiers.spawn(world, _p.clone(), c.yaw, { paratrooper: true })
    }
    c.active = true
    c.pos.copy(pos)
    c.yaw = yaw
    c.pitch = 45
    c.swing = 0
    c.node.visible = true
    if (payload === 'soldier') {
      c.payload = -1
    } else {
      const slot = payload * 4 + this.crateRing[payload]
      this.crateRing[payload] = (this.crateRing[payload] + 1) & 3
      // The original simply re-parents a reused crate; the old parachute keeps its payload index.
      this.crateOwner[slot] = i
      c.payload = slot
      this.crates[slot].visible = true
    }
    this.place(i)
  }

  update(world: World) {
    for (let i = 0; i < POOL; i++) {
      const c = this.chutes[i]
      if (!c.active) continue
      // Pendulum from 45 deg: swing = -pitch * 0.008 + swing * 0.992; then fall 10 u/f.
      c.swing = -c.pitch * 0.008 + c.swing * 0.992
      c.pitch += c.swing
      c.pos.y -= 10
      this.place(i)
      const { x, y, z } = c.pos
      const ground = Math.abs(x) < 15000 && Math.abs(z) < 15000 ? world.groundY(x, z) : 0
      if (y - 300 >= ground) continue
      c.active = false
      c.node.visible = false
      if (c.payload < 0) {
        world.soldiers.spawn(world, new THREE.Vector3(x, ground, z), c.yaw, { paratrooper: true })
      } else if (this.crateOwner[c.payload] === i) {
        // A crate that reaches the ground is lost: only shooting the parachute gives the prize.
        this.crateOwner[c.payload] = -1
        this.crates[c.payload].visible = false
      }
    }
  }

  /** Canopy pose, and the crate parent-composed 250 below it (swinging with it). */
  private place(i: number) {
    const c = this.chutes[i]
    c.node.position.copy(c.pos)
    c.node.rotation.set(c.pitch * deg, c.yaw * deg, 0, 'YXZ')
    if (c.payload < 0 || this.crateOwner[c.payload] !== i) return
    const crate = this.crates[c.payload]
    c.node.updateMatrix()
    crate.position.copy(_p.set(0, -250, 0).applyMatrix4(c.node.matrix))
    crate.quaternion.copy(c.node.quaternion)
  }

  /** Read-only, for tools (the E2E bot): where local point `local` of the parachute at `slot` will be in `frames` frames. */
  predict(slot: number, frames: number, local: THREE.Vector3, out = new THREE.Vector3()) {
    const c = this.chutes[slot - PARACHUTE_FIRST]
    if (!c) return out.set(0, 0, 0)
    let pitch = c.pitch, swing = c.swing
    for (let f = 0; f < frames; f++) {
      swing = -pitch * 0.008 + swing * 0.992
      pitch += swing
    }
    const e = new THREE.Euler(pitch * deg, c.yaw * deg, 0, 'YXZ')
    return out.copy(local).applyEuler(e).add(c.pos).setY(out.y - 10 * frames)
  }

  /** Read-only, for tools (the E2E bot): what shooting the parachute at this target slot gives, or 'trooper'. */
  payloadAt(slot: number): 'trooper' | (typeof PRIZE)[number] | 'none' {
    const i = slot - PARACHUTE_FIRST, c = this.chutes[i]
    if (!c || c.payload < 0) return 'trooper'
    return c.payload !== 15 ? PRIZE[c.payload >> 2] : 'none'
  }

  private target(c: Chute, i: number): Target {
    return {
      slot: PARACHUTE_FIRST + i,
      shape: 'parachute',
      node: c.node,
      alive: () => c.active,
      hit: (world, _zone, _weapon, point) => {
        if (!c.active) return
        c.active = false
        c.node.visible = false
        if (c.payload < 0) {
          // Paratrooper shot with his parachute.
          world.reduceEnemyMeter(1)
          world.effects.spawn('blood', point)
          return
        }
        if (this.crateOwner[c.payload] === i) {
          this.crateOwner[c.payload] = -1
          this.crates[c.payload].visible = false
        }
        // Original quirk: the missile test is `payload < 0x1d5`, so the last missile crate (ring slot 3)
        // gives nothing at all (no prize, no sound, no ammo-out reset).
        if (c.payload !== 15) world.prize(PRIZE[c.payload >> 2])
        world.effects.spawn('explodeF', point, { scale: 4 })
      },
    }
  }
}
