import * as THREE from 'three/webgpu'
import type { Direction, LevelUnit, ObjectType } from '../../formats/level'
import { deg } from '../constants'
import type { EnemySystem, Target, World } from '../world'
import type { SoldierPool } from './soldiers'

// TANK and APC1/2/3 from FUN_004051c8 (tank loop L1897, APC loop L2278, avoidance L2785/L2968, terrain
// following L6055, shadows L6177), their weapons as consumed in FUN_004154b7 (fire flags L9647-9790) and
// their destruction (L7990-8130, L10925-11000, FUN_004237f2). Geometry.3D ids equal the exe object indices.

type Kind = 'TANK' | 'APC1' | 'APC2' | 'APC3'

const TANK_FIRST = 37
const APC_FIRST = 73
const SHADOW_FIRST = 250
/** MISSILE instances 472..479: the APC3 rocket pods (first rocket 472 + k, second 476 + k). */
const POD_FIRST = 472
const DEBRIS_MAX = 114
const DEBRIS_TRIS = 40
const DIRECTION: Record<Direction, number> = { North: 1, South: 2, East: 3, West: 4 }
const BUNKER_CORNERS = [
  [-200, -200],
  [-200, 200],
  [200, 200],
  [200, -200],
] as const

interface Thrown {
  vx: number
  vy: number
  vz: number
  yawSpin: number
  rollSpin: number
}

interface Vehicle {
  id: number
  kind: Kind
  tank: boolean
  active: boolean
  /** B+0x00 AI state. */
  state: number
  /** B+0x04, compared unsigned while the barrel aims. */
  counter: number
  /** B+0x08 APC troop drop timer. */
  dropTimer: number
  speed: number
  accel: number
  maxSpeed: number
  yawRate: number
  yawRateTarget: number
  /** B+0x34..0x3c target point. */
  tx: number
  ty: number
  tz: number
  /** B+0x64 = 1: troops aboard. */
  troops: boolean
  /** B+0x6c APC3 rockets left. */
  ammo: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
  fwdX: number
  fwdZ: number
  turretYaw: number
  barrelPitch: number
  rampPitch: number
  radarSpin: number
  /** Barrel fire request (B[barrel]+0x60 = 1). */
  fire: boolean
  pods: [boolean, boolean]
  thrown: Thrown | null
  hull: THREE.Object3D
  turret: THREE.Object3D | null
  barrel: THREE.Object3D | null
  ramp: THREE.Object3D | null
  radar: THREE.Object3D | null
  shadow: THREE.Object3D
}

interface Piece {
  mesh: THREE.Mesh
  vx: number
  vy: number
  vz: number
  spin: THREE.Vector3
  angles: THREE.Vector3
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _q = new THREE.Quaternion()

export class GroundSystem implements EnemySystem {
  readonly types: readonly ObjectType[] = ['TANK', 'APC1', 'APC2', 'APC3']
  private vehicles: Vehicle[] = []
  private soldiers: SoldierPool
  private shadowBase = new Map<THREE.BufferAttribute, Float32Array>()
  private debrisGroup = new THREE.Group()
  private debrisChunks = new Map<THREE.BufferGeometry, THREE.BufferGeometry[]>()
  private debris: Piece[] = []

  constructor(world: World, soldiers: SoldierPool) {
    this.soldiers = soldiers
    const g = world.g3d
    for (let i = 0; i < 24; i++) {
      const tank = i < 12
      const id = tank ? TANK_FIRST + i : APC_FIRST + i - 12
      const kind: Kind = tank ? 'TANK' : id < 77 ? 'APC1' : id < 81 ? 'APC2' : 'APC3'
      const opt = (ok: boolean, n: number) => (ok ? g.node(n) : null)
      const v: Vehicle = {
        id, kind, tank, active: false, state: 1, counter: 0, dropTimer: 0, speed: 0, accel: 0, maxSpeed: 20,
        yawRate: 0, yawRateTarget: 0, tx: 0, ty: 0, tz: 0, troops: true, ammo: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0,
        fwdX: 0, fwdZ: -1, turretYaw: 0, barrelPitch: 0, rampPitch: 0, radarSpin: 0, fire: false, pods: [false, false], thrown: null,
        hull: g.node(id),
        turret: opt(tank || kind !== 'APC1', tank ? id + 12 : id + 20),
        barrel: opt(tank || kind !== 'APC1', tank ? id + 24 : id + 28),
        ramp: opt(!tank, id + 12),
        radar: opt(kind === 'APC3', id + 32),
        shadow: g.node(SHADOW_FIRST + i),
      }
      this.vehicles.push(v)
      for (const m of meshes(v.shadow)) {
        const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute
        this.shadowBase.set(pos, Float32Array.from(pos.array as Float32Array))
        // Vertices are moved onto the terrain every frame; the y = 0 bounds no longer apply.
        m.frustumCulled = false
      }
    }
    this.debrisGroup.name = 'ground-debris'
    g.root.add(this.debrisGroup)
  }

  reset(world: World) {
    for (const v of this.vehicles) {
      Object.assign(v, { active: false, state: 1, speed: 0, accel: 0, yawRate: 0, yawRateTarget: 0, troops: true, fire: false })
      Object.assign(v, { pitch: 0, roll: 0, turretYaw: 0, barrelPitch: 0, rampPitch: 0, pods: [false, false] })
      if (v.thrown && v.turret) {
        // Re-attach a turret blown off in the previous level.
        v.hull.add(v.turret)
        v.turret.position.set(0, 0, 0)
      }
      v.thrown = null
      this.hide(world, v)
      world.targets.push(this.target(v))
    }
    for (const p of this.debris) p.mesh.visible = false
    this.soldiers.reset()
  }

  spawn(_world: World, slot: number, _unit: LevelUnit) {
    const v = this.vehicles.find((x) => x.id === slot)
    if (!v || v.active) return
    // Active with state 1: initialised on the next AI frame, like FUN_004050f1.
    v.active = true
    v.state = 1
  }

  update(world: World) {
    for (const v of this.vehicles) if (v.active && v.tank) this.tankAI(world, v)
    for (const v of this.vehicles) if (v.active && !v.tank) this.apcAI(world, v)
    for (const v of this.vehicles) if (v.active && v.tank && (v.state === 3 || v.state === 0xc)) this.avoid(world, v, 0xc)
    for (const v of this.vehicles) if (v.active && !v.tank && (v.state === 3 || v.state === 0x11)) this.avoid(world, v, 0x11)
    this.soldiers.update(world)
    for (const v of this.vehicles) {
      if (v.active) this.follow(world, v)
      this.shadow(world, v)
    }
    for (const v of this.vehicles) {
      if (v.thrown) this.fly(v)
      if (!v.active) continue
      this.pose(v)
      v.hull.updateMatrixWorld(true)
      this.weapons(world, v)
    }
    this.updateDebris()
  }

  /** Engine loops (FUN_00424aef): Tank and Truck play while d = max(|x|,|z|) of the nearest moving unit < 6501, volume -d. */
  engineLoops(): { name: 'Tank' | 'Truck'; volumeDb: number }[] {
    const out: { name: 'Tank' | 'Truck'; volumeDb: number }[] = []
    for (const tank of [true, false]) {
      let d = Infinity
      for (const v of this.vehicles) {
        if (v.tank !== tank || !v.active || v.state === 0) continue
        d = Math.min(d, Math.max(Math.trunc(Math.abs(v.x)), Math.trunc(Math.abs(v.z))))
      }
      if (d < 6501) out.push({ name: tank ? 'Tank' : 'Truck', volumeDb: -d })
    }
    return out
  }

  /** Read-only, for tools (the E2E bot): vehicle type and whether troops are still aboard, by target slot. */
  vehicleAt(slot: number): { kind: Kind; troops: boolean } | null {
    const v = this.vehicles.find((x) => x.id === slot)
    return v ? { kind: v.kind, troops: v.troops } : null
  }

  private target(v: Vehicle): Target {
    return {
      slot: v.id,
      shape: v.tank ? 'tank' : 'apc',
      node: v.hull,
      alive: () => v.active,
      wrecked: () => v.active && v.tank && v.state === 0,
      engineOn: () => v.active && v.state !== 0,
      hit: (w, _zone, weapon, point) => {
        // Bullets only flash on tanks and APCs; any shell or missile destroys them.
        if (weapon === 'bullet') w.effects.spawn('explodeF', point.clone(), { scale: 1 })
        else if (v.tank) this.killTank(w, v, point)
        else this.killApc(w, v)
      },
    }
  }

  // ---------------------------------------------------------------- AI

  private tankAI(w: World, v: Vehicle) {
    switch (v.state) {
      case 1:
        this.init(w, v)
        break
      case 2:
        v.accel = 0.5
        v.state = 3
        break
      case 3: {
        const r = w.rand() >> 6
        if (r === 310 || r === 311) this.wander(w, v)
        if (r > 319 && r <= w.aggression.tank + 320) {
          v.accel = -0.5
          v.state = 7
        }
        this.boxCheck(w, v)
        break
      }
      case 4:
        this.turnBack(v)
        this.relax(v)
        break
      case 5:
        this.backInside(v)
        break
      case 6:
        this.wanderTick(v)
        break
      case 7:
        if (v.speed === 0) this.aimAt(v, 860, 8)
        break
      case 8:
        if (this.aimTurret(v)) v.state = 9
        break
      case 9:
        if (this.aimBarrel(v)) {
          v.counter = 75
          v.state = 10
        }
        break
      case 10:
        if (--v.counter === 15) v.fire = true
        if (v.counter === 0) v.state = 11
        break
      case 11:
        v.accel = 0.5
        v.state = 3
        break
    }
    this.drive(v)
    if (v.state === 3) this.relax(v)
  }

  private apcAI(w: World, v: Vehicle) {
    switch (v.state) {
      case 1:
        this.init(w, v)
        break
      case 2:
        v.dropTimer = (w.rand() >> 8) + 400
        v.accel = 0.5
        v.state = 3
        break
      case 3: {
        const r = w.rand() >> 6
        const wandering = r === 320 || r === 321
        if (wandering) this.wander(w, v)
        if (this.boxCheck(w, v)) break
        if (v.troops) {
          if (--v.dropTimer < 0 || Math.hypot(v.x, v.z) < 2800) v.state = 7
          break
        }
        // Only APC2 gets the gun attack (APC1 is parked for good once it has unloaded); APC3 only fires rockets.
        if (!wandering && v.kind !== 'APC3') {
          const g = w.rand() >> 6
          if (g > 319 && g <= w.aggression.tank + 320) {
            v.accel = -0.5
            v.state = 0xc
          }
        }
        if (!wandering && v.ammo > 0 && v.kind === 'APC3') {
          const g = w.rand() >> 6
          if (g > 159 && g < 164) {
            v.accel = -0.5
            v.state = 0xc
          }
        }
        break
      }
      case 4:
        this.turnBack(v)
        break
      case 5:
        this.backInside(v)
        break
      case 6:
        this.wanderTick(v)
        break
      case 7:
        if (Math.abs(v.x) > 10000 || Math.abs(v.z) > 10000) v.state = 3
        else {
          v.accel = -0.5
          v.state = 8
        }
        break
      case 8:
        if (v.speed === 0) v.state = 9
        break
      case 9:
        v.rampPitch += 2
        if (v.rampPitch === 120) {
          v.counter = 90
          v.troops = false
          v.state = 10
          this.unload(w, v)
        }
        break
      case 10:
        if (--v.counter === 0) v.state = v.kind === 'APC1' ? 0 : 0xb
        break
      case 0xb:
        v.rampPitch -= 2
        if (v.rampPitch === 0) {
          v.accel = 0.5
          v.state = 3
        }
        break
      case 0xc:
        if (v.speed === 0) this.aimAt(v, v.kind === 'APC3' ? 840 : 860, 0xd)
        break
      case 0xd:
        if (this.aimTurret(v)) v.state = 0xe
        break
      case 0xe:
        if (this.aimBarrel(v)) {
          v.counter = 60
          v.state = v.kind === 'APC3' ? 0x12 : 0xf
        }
        break
      case 0xf:
        // Four-round burst.
        v.counter--
        if (v.counter === 20 || v.counter === 18 || v.counter === 16 || v.counter === 14) v.fire = true
        if (v.counter === 0) v.state = 0x10
        break
      case 0x10:
        v.accel = 0.5
        v.state = 3
        break
      case 0x12:
        if (--v.counter === 20) {
          v.ammo--
          v.fire = true
        }
        if (v.counter === 0) v.state = 0x10
        break
    }
    this.drive(v)
    if (v.state === 3 && v.kind !== 'APC1') this.relax(v)
  }

  /** State 1: show the parts and pick a spawn point on the level's side, retrying until the MMap allows it. */
  private init(w: World, v: Vehicle) {
    v.hull.visible = true
    if (v.turret) v.turret.visible = true
    if (v.barrel) v.barrel.visible = true
    v.turretYaw = 0
    v.barrelPitch = 0
    if (v.ramp) {
      v.ramp.visible = true
      v.rampPitch = 0
    }
    if (v.kind === 'APC2' || v.kind === 'APC3') v.ammo = 2
    if (v.radar) {
      v.radar.visible = true
      v.radarSpin = (w.rand() >> 12) + 4
      v.pods = [true, true]
    }
    v.maxSpeed = 20
    v.troops = true
    v.state = 2
    const name = w.level.directions[v.tank ? 'tank' : 'apc']
    const dir = name ? DIRECTION[name] : (w.rand() >> 13) + 1
    for (let tries = 0; tries < 100000; tries++) {
      let x: number, z: number
      if (dir === 1 || dir === 2) {
        x = (w.rand() >> 1) - 8192
        z = dir === 1 ? -(w.rand() >> 4) - 7500 : (w.rand() >> 4) + 7500
      } else {
        x = dir === 3 ? (w.rand() >> 4) + 7500 : -(w.rand() >> 4) - 7500
        z = (w.rand() >> 1) - 8192
      }
      v.yaw = [180, 0, 90, 270][dir - 1]
      if (w.validGround(x, z)) {
        v.x = x
        v.z = z
        break
      }
    }
  }

  private wander(w: World, v: Vehicle) {
    v.yawRateTarget = (w.rand() >> 11) - 7.5
    v.counter = (w.rand() >> 9) + 30
    v.state = 6
  }

  private wanderTick(v: Vehicle) {
    if (--v.counter === 0) {
      v.yawRateTarget = 0
      v.state = 3
    }
  }

  /** Outside the +-10000 box: turn back toward a random point within +-2048. */
  private boxCheck(w: World, v: Vehicle) {
    if (Math.abs(v.x) <= 10000 && Math.abs(v.z) <= 10000) return false
    v.tx = (w.rand() >> 3) - 2048
    v.tz = (w.rand() >> 3) - 2048
    const err = wrap180(heading(v.tx - v.x, v.tz - v.z) - v.yaw)
    v.yawRateTarget = err < 0 ? -24 : 24
    v.state = 4
    return true
  }

  private turnBack(v: Vehicle) {
    const dx = v.tx - v.x, dz = v.tz - v.z
    const d = Math.hypot(dx, dz) || 1, f = Math.hypot(v.fwdX, v.fwdZ) || 1
    if ((v.fwdZ / f) * (dz / d) + (v.fwdX / f) * (dx / d) > 0.99) {
      v.state = 5
      v.yawRateTarget = 0
    }
  }

  private backInside(v: Vehicle) {
    // Original quirk: the z test is not absolute.
    if (Math.abs(v.x) < 10000 && v.z < 10000) v.state = 3
  }

  private aimAt(v: Vehicle, y: number, next: number) {
    v.tx = 0
    v.ty = y
    v.tz = 0
    v.state = next
  }

  /** Turret yaw toward the target at 1.5 deg/frame. True once within 0.25 deg. */
  private aimTurret(v: Vehicle) {
    let err = wrap180(heading(v.tx - v.x, v.tz - v.z) - v.yaw) - v.turretYaw
    if (Math.abs(err) <= 0.25) {
      v.counter = 0
      return true
    }
    err = THREE.MathUtils.clamp(err, -1.5, 1.5)
    v.turretYaw += err
    return false
  }

  /** Barrel pitch 0.5 deg/frame until aligned (cos >= 0.9996) or it reverses (unsigned counter compare). */
  private aimBarrel(v: Vehicle) {
    const barrel = v.barrel!
    this.pose(v)
    v.hull.updateMatrixWorld(true)
    const e = barrel.matrixWorld.elements
    const fx = -e[8], fy = -e[9], fz = -e[10]
    barrel.getWorldPosition(_a)
    const dx = v.tx - _a.x, dy = v.ty - _a.y, dz = v.tz - _a.z
    const inv = 1 / (Math.hypot(dx, dy, dz) || 1)
    if (dz * inv * fz + dy * inv * fy + dx * inv * fx >= 0.9996) return true
    const prev = v.counter >>> 0
    if (dy * inv <= fy) {
      v.barrelPitch -= 0.5
      v.counter--
    } else {
      v.barrelPitch += 0.5
      v.counter++
    }
    return prev !== 0 && v.counter >>> 0 < prev
  }

  /** Turret and barrel drift back to straight ahead while patrolling. */
  private relax(v: Vehicle) {
    if (v.turretYaw !== 0) v.turretYaw -= THREE.MathUtils.clamp(v.turretYaw, -1.5, 1.5)
    if (v.barrelPitch !== 0) {
      const p = v.barrelPitch
      v.barrelPitch -= p > 1 ? 0.5 : p < -1 ? -0.5 : p
    }
  }

  /** Shared motion: smoothed yaw rate, acceleration clamp, forward step. */
  private drive(v: Vehicle) {
    v.yawRate = v.yawRateTarget * 0.1 + v.yawRate * 0.9
    v.yaw = wrap180(v.yaw + v.yawRate * v.speed * 0.0035)
    v.speed += v.accel
    if (v.speed > v.maxSpeed) {
      v.speed = v.maxSpeed
      v.accel = 0
    }
    if (v.speed < 0) {
      v.speed = 0
      v.accel = 0
    }
    v.fwdX = -Math.sin(v.yaw * deg)
    v.fwdZ = -Math.cos(v.yaw * deg)
    v.x += v.fwdX * v.speed
    v.z += v.fwdZ * v.speed
  }

  /** Swerve +-12 from vehicles within the 1500 box ahead (cos > 0.95) and the bunker corners (cos > 0.9). */
  private avoid(w: World, v: Vehicle, avoidState: number) {
    let nearest = 40000
    const check = (px: number, pz: number, cos: number) => {
      const dx = px - v.x, dz = pz - v.z
      if (Math.abs(dx) >= 1500 || Math.abs(dz) >= 1500) return
      const d = Math.hypot(dx, dz)
      if (!(d > 0) || (v.fwdZ * dz) / d + (v.fwdX * dx) / d <= cos) return
      if (v.state !== avoidState) {
        v.yawRateTarget = w.rand() < 0x4000 ? -12 : 12
        v.state = avoidState
      }
      nearest = Math.min(nearest, d)
    }
    const order = v.tank ? [false, true] : [true, false]
    for (const tanks of order) for (const o of this.vehicles) if (o.tank === tanks && o.active && o !== v) check(o.x, o.z, 0.95)
    for (const [cx, cz] of BUNKER_CORNERS) check(cx, cz, 0.9)
    if (v.state === avoidState && nearest === 40000) {
      v.yawRateTarget = 0
      v.state = 3
    }
  }

  /** APC state 9: six soldiers leave by the ramp, about 10 frames apart. */
  private unload(w: World, v: Vehicle) {
    for (let k = 0, off = 110; k < 6; k++, off -= 60) {
      _b.set(v.x - v.fwdX * off, v.y + 40, v.z - v.fwdZ * off)
      w.soldiers.spawn(w, _b, v.yaw + 180, { stagger: off - 130 })
    }
  }

  // ------------------------------------------------------------ terrain, shadows, pose

  /** Pitch and roll from 4 height samples (+-150 forward, +-100 sideways); y = mean height. */
  private follow(w: World, v: Vehicle) {
    const s = Math.sin(v.yaw * deg), c = Math.cos(v.yaw * deg)
    const h = (a: number, b: number) => w.groundY(v.x + s * a + c * b, v.z + c * a - s * b)
    const fr = h(-150, 100), fl = h(-150, -100), bl = h(150, -100), br = h(150, 100)
    const front = (fr + fl) / 2, back = (br + bl) / 2
    v.pitch = (Math.acos(300 / Math.hypot(front - back, 300)) / deg) * (front < back ? -1 : 1)
    const left = (fl + bl) / 2, right = (fr + br) / 2
    v.roll = (Math.acos(200 / Math.hypot(right - left, 200)) / deg) * (right < left ? -1 : 1)
    v.y = (right + left) / 2
  }

  /** Shadow follows the vehicle within the 14000 box; each vertex sits 12 above the ground. */
  private shadow(w: World, v: Vehicle) {
    const on = v.active && Math.abs(v.x) < 14000 && Math.abs(v.z) < 14000
    v.shadow.visible = on
    if (!on) return
    v.shadow.position.set(v.x, 0, v.z)
    v.shadow.rotation.set(0, v.yaw * deg, 0)
    const s = Math.sin(v.yaw * deg), c = Math.cos(v.yaw * deg)
    for (const m of meshes(v.shadow)) {
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute
      const base = this.shadowBase.get(pos)
      if (!base) continue
      const arr = pos.array as Float32Array
      for (let i = 0; i < arr.length; i += 3) {
        const lx = base[i], lz = base[i + 2]
        arr[i + 1] = w.groundY(v.x + lx * c + lz * s, v.z - lx * s + lz * c) + 12
      }
      pos.needsUpdate = true
    }
  }

  private pose(v: Vehicle) {
    v.hull.position.set(v.x, v.y, v.z)
    v.hull.rotation.set(v.pitch * deg, v.yaw * deg, v.roll * deg, 'YXZ')
    if (v.turret && !v.thrown) v.turret.rotation.set(0, v.turretYaw * deg, 0)
    v.barrel?.rotation.set(v.barrelPitch * deg, 0, 0)
    v.ramp?.rotation.set(v.rampPitch * deg, 0, 0)
    if (v.radar) v.radar.rotation.y = (v.radar.rotation.y + v.radarSpin * deg) % (Math.PI * 2)
  }

  private hide(w: World, v: Vehicle) {
    for (const n of [v.hull, v.turret, v.barrel, v.ramp, v.radar, v.shadow]) if (n) n.visible = false
    if (v.kind === 'APC3') for (const k of [0, 4]) w.g3d.node(POD_FIRST + k + v.id - 81).visible = false
  }

  // ---------------------------------------------------------------- weapons

  /** Fire requests and the loaded APC3 pods, using this frame's matrices (FUN_004154b7 step 13). */
  private weapons(w: World, v: Vehicle) {
    if (v.kind === 'APC3') this.posePods(w, v)
    if (!v.fire || !v.barrel) return
    v.fire = false
    const e = v.barrel.matrixWorld.elements
    const fwd = _a.set(-e[8], -e[9], -e[10]).normalize()
    const at = v.barrel.getWorldPosition(new THREE.Vector3())
    if (v.tank) {
      at.addScaledVector(fwd, 241)
      w.projectiles.fire('shell', at, fwd.clone().multiplyScalar(500), { fromPlayer: false })
      w.effects.spawn('explodeF', at.clone(), { scale: 2 })
      w.sound.play('CannonFar')
    } else if (v.kind === 'APC2') {
      at.addScaledVector(fwd, 201)
      w.projectiles.fire('bullet', at, fwd.clone().multiplyScalar(500), { fromPlayer: false })
    } else if (v.kind === 'APC3') {
      const pod = v.ammo !== 0 ? 0 : 1
      v.pods[pod] = false
      const p = v.barrel.localToWorld(new THREE.Vector3(pod === 0 ? -48 : 48, 0, 65))
      w.projectiles.fire('apcRocket', p, fwd.clone().multiplyScalar(280), { fromPlayer: false, life: 130 })
      w.g3d.node(POD_FIRST + pod * 4 + v.id - 81).visible = false
    }
  }

  /** Rockets ride the launcher at (-48, 0, 65) and (48, 0, 65) until fired. */
  private posePods(w: World, v: Vehicle) {
    v.barrel!.getWorldQuaternion(_q)
    for (const pod of [0, 1] as const) {
      const node = w.g3d.node(POD_FIRST + pod * 4 + v.id - 81)
      node.visible = v.pods[pod]
      if (!v.pods[pod]) continue
      v.barrel!.localToWorld(node.position.set(pod === 0 ? -48 : 48, 0, 65))
      node.quaternion.copy(_q)
    }
  }

  // ---------------------------------------------------------------- destruction

  private killTank(w: World, v: Vehicle, point: THREE.Vector3) {
    w.effects.spawn('explodeF', point.clone(), { scale: 4 })
    const live = v.state !== 0
    if (live) {
      v.barrelPitch = -20
      v.accel = -1
      w.reduceEnemyMeter(10)
    }
    w.sound.play('ExFar')
    if (live && v.turret) {
      // Turret blown off: detached at the hull position, its relative yaw becomes a world yaw (original quirk).
      w.g3d.root.add(v.turret)
      v.turret.position.set(v.x, v.y, v.z)
      v.turret.rotation.set(0, v.turretYaw * deg, 0)
      v.thrown = {
        yawSpin: (w.rand() - 16384) / 8000,
        rollSpin: (w.rand() - 16384) / 8000,
        vx: (w.rand() - 16384) / 1000,
        vz: (w.rand() - 16384) / 1000,
        vy: 40,
      }
    }
    // The wreck stays (active, state 0): it coasts to a stop and still stops shots.
    v.state = 0
  }

  private killApc(w: World, v: Vehicle) {
    this.soldiers.burnWithin(w, _b.set(v.x, v.y, v.z), 600)
    v.active = false
    if (v.troops) w.reduceEnemyMeter(6)
    if (v.kind !== 'APC1') w.reduceEnemyMeter(5)
    v.pods = [false, false]
    this.hide(w, v)
    this.shatter(w, v)
    w.sound.play('ExFar')
  }

  /** Turret flight: drag 0.98, gravity 3, removed below y 0. */
  private fly(v: Vehicle) {
    const t = v.thrown!, n = v.turret!
    if (!n.visible) return
    t.vx *= 0.98
    t.vz *= 0.98
    t.vy -= 3
    n.position.x += t.vx
    n.position.y += t.vy
    n.position.z += t.vz
    n.rotation.y += t.yawSpin * deg
    n.rotation.z += t.rollSpin * deg
    n.visible = n.position.y >= 0
  }

  /** FUN_004237f2: big explosion away from the bunker, hull split into spinning chunks (debris ring reset). */
  private shatter(w: World, v: Vehicle) {
    if (Math.abs(v.x) > 400 || Math.abs(v.z) > 400) w.effects.spawn('explodeA', new THREE.Vector3(v.x, v.y, v.z), { scale: 4 })
    for (const p of this.debris) p.mesh.visible = false
    let n = 0
    for (const m of meshes(v.hull)) {
      for (const geo of this.chunks(m.geometry)) {
        if (n >= DEBRIS_MAX) return
        const p = this.piece(n++)
        p.mesh.geometry = geo
        p.mesh.material = m.material
        p.mesh.visible = true
        p.mesh.position.set(v.x, v.y, v.z)
        p.angles.set(v.pitch, v.yaw, v.roll)
        p.spin.set(Math.trunc((w.rand() - 0x4000) / 1000), Math.trunc((w.rand() - 0x4000) / 1000), Math.trunc((w.rand() - 0x4000) / 1000))
        p.vx = Math.trunc((w.rand() - 0x4000) / 800)
        p.vz = Math.trunc((w.rand() - 0x4000) / 800)
        p.vy = Math.trunc(w.rand() / 500) + 20
        p.mesh.rotation.set(p.angles.x * deg, p.angles.y * deg, p.angles.z * deg, 'YXZ')
      }
    }
  }

  private piece(i: number) {
    while (this.debris.length <= i) {
      const mesh = new THREE.Mesh()
      mesh.visible = false
      this.debrisGroup.add(mesh)
      this.debris.push({ mesh, vx: 0, vy: 0, vz: 0, spin: new THREE.Vector3(), angles: new THREE.Vector3() })
    }
    return this.debris[i]
  }

  /** Split a non-indexed hull geometry into small pieces (the exe splits the display list every 20 commands). */
  private chunks(g: THREE.BufferGeometry) {
    let out = this.debrisChunks.get(g)
    if (out) return out
    out = []
    const tris = g.getAttribute('position').count / 3
    for (let t = 0; t < tris; t += DEBRIS_TRIS) {
      const c = new THREE.BufferGeometry()
      const end = Math.min(tris, t + DEBRIS_TRIS)
      for (const name of ['position', 'normal', 'color', 'uv']) {
        const a = g.getAttribute(name) as THREE.BufferAttribute | undefined
        if (!a) continue
        const k = a.itemSize * 3
        c.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(t * k, end * k), a.itemSize))
      }
      c.computeBoundingSphere()
      out.push(c)
    }
    this.debrisChunks.set(g, out)
    return out
  }

  /** Debris: drag 0.98, gravity 3, spin per frame, removed below y 0. */
  private updateDebris() {
    for (const p of this.debris) {
      if (!p.mesh.visible) continue
      p.vx *= 0.98
      p.vz *= 0.98
      p.vy -= 3
      p.mesh.position.x += p.vx
      p.mesh.position.y += p.vy
      p.mesh.position.z += p.vz
      p.angles.add(p.spin)
      p.mesh.rotation.set(p.angles.x * deg, p.angles.y * deg, p.angles.z * deg, 'YXZ')
      if (p.mesh.position.y < 0) p.mesh.visible = false
    }
  }
}

/** The node's own meshes (not linked child objects). */
function meshes(node: THREE.Object3D) {
  return node.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh)
}

/** acos(-dz/d) with the sign of -dx: yaw that looks along (dx, dz). */
function heading(dx: number, dz: number) {
  return Math.atan2(-dx, -dz) / deg
}

function wrap180(a: number) {
  if (a > 180) a -= 360
  if (a < -180) a += 360
  return a
}
