import * as THREE from 'three/webgpu'
import type { DirectionGroup, LevelUnit } from '../../formats/level'
import { deg, type ShapeKind } from '../constants'
import type { EnemySystem, Target, World } from '../world'
import type { CrateKind, Parachutes } from './parachutes'

// Aircraft from BH2.exe: AI and flight in FUN_004051c8 (C130 L3152, JET L3555, BOMBER L4132, COBRA L4247,
// CH53 L6235), fire-flag spawns, hits and kills in FUN_004154b7 (L7087-7605, L9785-9984), destruction in
// FUN_004232fa (shot down) and FUN_004237f2 (ground crash). State numbers and constants follow the
// original; see docs/re/gameplay.md §5.4-5.8 and docs/dev/air.md.

export type AirType = 'JET' | 'BOMBER' | 'COBRA' | 'CH53' | 'C130'

const FIRST: Record<AirType, number> = { C130: 210, JET: 117, BOMBER: 133, COBRA: 142, CH53: 178 }
const COUNT: Record<AirType, number> = { C130: 8, JET: 16, BOMBER: 9, COBRA: 12, CH53: 8 }
const SHAPE: Record<AirType, ShapeKind> = { C130: 'c130', JET: 'jet', BOMBER: 'bomber', COBRA: 'cobra', CH53: 'ch53' }
/** Hit-flash (ExplodeF) size for bullet hits. */
const FLASH: Record<AirType, number> = { C130: 2.5, JET: 2.5, BOMBER: 2.5, COBRA: 1, CH53: 1 }
/** Attached parts: [object offset, spin x, spin y, spin z] in deg/frame (A+0x68..0x70). */
const PARTS: Record<AirType, [number, number, number, number][]> = {
  C130: [[8, 0, 0, -34], [16, 0, 0, -36], [24, 0, 0, 35], [32, 0, 0, 33]],
  JET: [],
  BOMBER: [],
  COBRA: [[12, 0, 55, 0], [24, -40, 0, 0]],
  CH53: [[8, 0, 0, 0], [16, 0, 25, 0], [24, -40, 0, 0]],
}
const SHADOW_FIRST: Partial<Record<AirType, number>> = { COBRA: 274, CH53: 286 }
/** Update order of the original's per-type loops. */
const ORDER: AirType[] = ['C130', 'JET', 'BOMBER', 'COBRA', 'CH53']
const DIR_CODE: Record<string, number> = { North: 1, South: 2, East: 3, West: 4 }
const DIR_YAW = [0, 180, 0, 90, 270]
const R2D = 57.2957795
/** Debris objects 0x218-0x289. */
const DEBRIS = 114
/** Triangles per debris chunk (the original splits the display list every 40 commands). */
const CHUNK_TRIS = 60

interface Part {
  node: THREE.Object3D
  rot: THREE.Vector3
  spin: THREE.Vector3
}

interface Shadow {
  node: THREE.Object3D
  meshes: { attr: THREE.BufferAttribute; xz: Float32Array }[]
}

interface C130Load {
  passes: number
  far: boolean
  troops1: number
  troops2: number
  /** hdrop, adrop, pdrop, mdrop as given, and the counts left on this pass. */
  load: number[]
  drops: number[]
}

interface Craft {
  type: AirType
  index: number
  node: THREE.Object3D
  parts: Part[]
  shadow: Shadow | null
  active: boolean
  /** Initialised (state 1 has run): visible and hittable. */
  live: boolean
  state: number
  counter: number
  pos: THREE.Vector3
  fwd: THREE.Vector3
  pitch: number
  yaw: number
  roll: number
  /** Jet crash roll velocity (A+0x70): the AI rewrites roll every frame, so it only adds a fixed offset. */
  rollSpin: number
  speed: number
  accel: number
  maxSpeed: number
  /** B+0x34..0x3c: attack aim point, wander target, landing zone, jet target altitude. */
  target: THREE.Vector3
  yawRateS: number
  yawRateT: number
  pitchS: number
  pitchT: number
  vS: number
  vT: number
  fall: number
  hp: number
  /** Jets: B+0x6c, never set in BH2.exe, so the missile branch never runs. */
  missiles: number
  fire: 0 | 1 | 2
  c130: C130Load
}

interface Chunk {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  renderOrder: number
}

interface Debris {
  mesh: THREE.Mesh
  active: boolean
  pos: THREE.Vector3
  vel: THREE.Vector3
  rot: THREE.Vector3
  spin: THREE.Vector3
}

export type EngineDistances = Record<'jet' | 'c130' | 'bomber' | 'cobra' | 'ch53', number>

const wrap180 = (a: number) => (a > 180 ? a - 360 : a < -180 ? a + 360 : a)
const wrap360 = (a: number) => (a > 360 ? a - 360 : a < -360 ? a + 360 : a)
/** acos(-dz / d) in degrees, negated when dx > 0: the yaw that faces (dx, dz). */
const heading = (dx: number, dz: number) => Math.atan2(-dx, -dz) * R2D
const inBox = (p: THREE.Vector3, r: number) => Math.abs(p.x) < r && Math.abs(p.z) < r
/** Heightmap lookup used by the crash tests: 0 off the ±15000 map. */
const groundOr0 = (w: World, x: number, z: number) => (Math.abs(x) < 15000 && Math.abs(z) < 15000 ? w.groundY(x, z) : 0)
const _v = new THREE.Vector3()
const _a = new THREE.Vector3()

export class AirSystem implements EnemySystem {
  readonly types = ['JET', 'BOMBER', 'COBRA', 'CH53', 'C130'] as const
  readonly parachutes: Parachutes
  private crafts: Craft[] = []
  private bySlot = new Map<number, Craft>()
  private debris: Debris[] = []
  private chunkCache = new Map<AirType, Chunk[]>()
  /** Global hover-wobble angles DAT_00447830..3c, advanced 4.1/6/9.5/12.2 deg per frame. */
  private wobble = [0, 0, 0, 0]
  private bombRing = 0
  private rocketRing = 0
  private bomberYaw = 0

  constructor(world: World, parachutes: Parachutes) {
    this.parachutes = parachutes
    for (const type of ORDER) {
      for (let i = 0; i < COUNT[type]; i++) {
        const id = FIRST[type] + i
        const c = this.newCraft(world, type, i, id)
        this.crafts.push(c)
        this.bySlot.set(id, c)
      }
    }
    const root = new THREE.Group()
    root.name = 'air-debris'
    world.g3d.root.add(root)
    for (let i = 0; i < DEBRIS; i++) {
      const mesh = new THREE.Mesh()
      mesh.visible = false
      mesh.rotation.order = 'YXZ'
      root.add(mesh)
      this.debris.push({ mesh, active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Vector3(), spin: new THREE.Vector3() })
    }
  }

  private newCraft(world: World, type: AirType, index: number, id: number): Craft {
    const shadowId = SHADOW_FIRST[type]
    return {
      type,
      index,
      node: world.g3d.node(id),
      parts: PARTS[type].map(([off, sx, sy, sz]) => ({ node: world.g3d.node(id + off), rot: new THREE.Vector3(), spin: new THREE.Vector3(sx, sy, sz) })),
      shadow: shadowId === undefined ? null : this.newShadow(world.g3d.node(shadowId + index)),
      active: false,
      live: false,
      state: 0,
      counter: 0,
      pos: new THREE.Vector3(),
      fwd: new THREE.Vector3(0, 0, -1),
      pitch: 0,
      yaw: 0,
      roll: 0,
      rollSpin: 0,
      speed: 0,
      accel: 0,
      maxSpeed: 0,
      target: new THREE.Vector3(),
      yawRateS: 0,
      yawRateT: 0,
      pitchS: 0,
      pitchT: 0,
      vS: 0,
      vT: 0,
      fall: 0,
      hp: 0,
      missiles: 0,
      fire: 0,
      c130: { passes: 0, far: false, troops1: 0, troops2: 0, load: [0, 0, 0, 0], drops: [0, 0, 0, 0] },
    }
  }

  private newShadow(node: THREE.Object3D): Shadow {
    const meshes: Shadow['meshes'] = []
    for (const o of node.children) {
      if (!(o instanceof THREE.Mesh)) continue
      const attr = (o.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute
      const xz = new Float32Array(attr.count * 2)
      for (let k = 0; k < attr.count; k++) {
        xz[k * 2] = attr.getX(k)
        xz[k * 2 + 1] = attr.getZ(k)
      }
      // Vertices are moved onto the terrain every frame, so the build-time bounds no longer apply.
      o.frustumCulled = false
      meshes.push({ attr, xz })
    }
    return { node, meshes }
  }

  reset(world: World) {
    for (const c of this.crafts) {
      c.active = false
      c.live = false
      c.state = 0
      c.target.set(0, 0, 0)
      this.hide(c)
      world.targets.push(this.targetFor(c))
    }
    for (const d of this.debris) {
      d.active = false
      d.mesh.visible = false
    }
    this.parachutes.reset(world)
  }

  /** A level slot's Delay ran out (or it is present at start): active with state 1, initialised next frame. */
  spawn(_world: World, slot: number, unit: LevelUnit) {
    const c = this.bySlot.get(slot)
    if (!c) return
    this.activate(c)
    if (c.type === 'C130') {
      const p = unit.c130
      c.c130 = {
        passes: p?.passes ?? 127,
        far: p?.far ?? false,
        troops1: p?.troops1 ?? 0,
        troops2: p?.troops2 ?? 0,
        load: p ? [p.hdrop, p.adrop, p.pdrop, p.mdrop] : [0, 0, 0, 0],
        drops: [0, 0, 0, 0],
      }
    }
  }

  /** 'b' key (WinMain): one random common heading, all nine bombers active. */
  callBombers(world: World) {
    this.bomberYaw = (world.rand() >> 7) * 1.40625
    for (const c of this.crafts) if (c.type === 'BOMBER') this.activate(c)
  }

  private activate(c: Craft) {
    c.active = true
    c.live = false
    c.state = 1
    c.counter = 0
    c.yawRateS = c.yawRateT = c.pitchS = c.pitchT = c.vS = c.vT = c.fall = 0
    c.accel = c.rollSpin = 0
    c.missiles = 0
  }

  /**
   * Engine-loop distances for FUN_00424aef: per class, min over active aircraft of max(|x|, |z|)
   * (Infinity when none). The sound module plays Jet/C130 when d < 30001 at -d/8, and Bomber/Cobra/CH53
   * when d < 18001 at -d/4 (DirectSound hundredths of dB).
   */
  engineDistances(): EngineDistances {
    const d: EngineDistances = { jet: Infinity, c130: Infinity, bomber: Infinity, cobra: Infinity, ch53: Infinity }
    for (const c of this.crafts) {
      if (!c.active || !c.live) continue
      const key = c.type.toLowerCase() as keyof EngineDistances
      d[key] = Math.min(d[key], Math.max(Math.abs(c.pos.x), Math.abs(c.pos.z)))
    }
    return d
  }

  update(world: World) {
    for (const c of this.crafts) {
      if (!c.active) continue
      c.fire = 0
      if (c.type === 'C130') this.c130(world, c)
      else if (c.type === 'JET') this.jet(world, c)
      else if (c.type === 'BOMBER') this.bomber(world, c)
      else if (c.type === 'COBRA') this.cobra(world, c)
      else this.ch53(world, c)
      if (!c.active) {
        this.hide(c)
        continue
      }
      c.live = true
      this.pose(c)
      if (c.fire) this.fire(world, c)
    }
    this.parachutes.update(world)
    this.updateDebris()
    this.updateShadows(world)
    const inc = [4.1, 6, 9.5, 12.2]
    for (let k = 0; k < 4; k++) {
      this.wobble[k] += inc[k]
      if (this.wobble[k] > 360) this.wobble[k] -= 360
    }
  }

  // ---------------------------------------------------------------- shared helpers

  private dirYaw(w: World, group: DirectionGroup) {
    let code = DIR_CODE[w.level.directions[group] ?? ''] ?? 0
    if (code === 0) code = (w.rand() >> 13) + 1
    return DIR_YAW[code]
  }

  /** Air spawn: F out along the arrival direction, L sideways; the craft faces the origin. */
  private place(c: Craft, lateral: number, out: number) {
    const y = c.yaw * deg
    c.pos.x = Math.sin(y) * out + Math.cos(y) * lateral
    c.pos.z = Math.cos(y) * out - Math.sin(y) * lateral
  }

  /** Forward = -(matrix back column) for identity, Z(roll), X(pitch), Y(yaw). */
  private forward(c: Craft) {
    const p = c.pitch * deg, y = c.yaw * deg
    c.fwd.set(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p))
  }

  /** Smoothed-rate flight shared by C130, jet and bomber (0.08 / 0.92). */
  private fly(c: Craft, rollFactor: number) {
    c.yawRateS = c.yawRateT * 0.08 + c.yawRateS * 0.92
    c.pitchS = c.pitchT * 0.08 + c.pitchS * 0.92
    c.roll = c.yawRateS * rollFactor
    c.pitch += c.pitchS
    c.yaw = wrap180(c.yaw + c.yawRateS)
    this.forward(c)
    c.pos.addScaledVector(c.fwd, c.speed)
  }

  /** Helicopter attitude and motion (cobra, CH53): smoothing 0.05 / 0.95, nose down with speed, hover wobble. */
  private heliAttitude(c: Craft, rollFactor: number, wobble: number, pitchKill: boolean) {
    c.yawRateS = c.yawRateT * 0.05 + c.yawRateS * 0.95
    c.pitchS = c.pitchT * 0.05 + c.pitchS * 0.95
    // A pitch offset beyond 22 deg cancels its target (takes effect from the next frame).
    if (pitchKill && Math.abs(c.pitchS) > 22) c.pitchT = 0
    c.pitch = c.speed * -0.05 + c.pitchS
    const prev = c.yaw
    c.yaw = wrap180(c.yaw + c.yawRateS)
    // Deviation: the original uses the raw yaw difference, so crossing ±180 gives a one-frame roll spike.
    c.roll = wrap180(c.yaw - prev) * rollFactor
    if (wobble > 0) {
      const [s0, s1, s2, s3] = this.wobble.map((a) => Math.sin(a * deg))
      const k = 1 / (c.speed + 1)
      c.roll += (s2 + s3) * k * 2
      c.pitch += (s0 + s2 + s1) * k * wobble
      c.pos.y += (s0 + s1) * k * 2
      c.pos.x += (s0 + s2) * k * 2
      c.pos.z += (s1 + s2) * k * 2
    }
    this.forward(c)
    c.speed += c.accel
    if (c.speed > c.maxSpeed) {
      c.speed = c.maxSpeed
      c.accel = 0
    }
    if (c.speed < 0) {
      c.speed = 0
      c.accel = 0
    }
  }

  /** Steer toward the target in the attack/landing alignment states. Returns true once within 0.5 deg (heading snapped). */
  private align(c: Craft, limitStep: boolean) {
    const dx = c.target.x - c.pos.x, dz = c.target.z - c.pos.z
    const want = heading(dx, dz)
    const err = wrap180(want - c.yaw)
    if (Math.abs(err) >= 0.5) {
      if (Math.abs(err) < 32) {
        const r = err * 0.0625
        if (!limitStep || Math.abs(r - c.yawRateS) <= 0.125) c.yawRateS = r
        else c.yawRateS += r - c.yawRateS > 0 ? 0.125 : -0.125
      }
      return false
    }
    c.yawRateT = 0
    c.yawRateS = 0
    c.yaw = wrap180(want)
    return true
  }

  private turnSign(c: Craft) {
    return wrap180(heading(c.target.x - c.pos.x, c.target.z - c.pos.z) - c.yaw) < 0 ? -2 : 2
  }

  /** Planar alignment of the forward vector with the wander target (states 3). */
  private facing(c: Craft) {
    _v.set(c.target.x - c.pos.x, 0, c.target.z - c.pos.z).normalize()
    _a.set(c.fwd.x, 0, c.fwd.z).normalize()
    return _v.dot(_a)
  }

  private smoke(w: World, c: Craft, scale: number) {
    if (w.frame & 1) return
    const x = c.pos.x + (w.rand() >> 8) - 64, y = c.pos.y + (w.rand() >> 9) - 32, z = c.pos.z + (w.rand() >> 8) - 64
    w.effects.spawn('smokeBlack', new THREE.Vector3(x, y, z), { scale })
  }

  // ---------------------------------------------------------------- C130 (L3152)

  private c130(w: World, c: Craft) {
    const s = c.c130
    switch (c.state) {
      case 0:
        c.active = false
        return
      case 1: {
        c.pitch = 0
        c.roll = 0
        c.pos.y = (w.rand() >> 4) + 4000
        c.speed = 140
        c.hp = 8
        c.state = 2
        c.parts.forEach((p) => p.rot.set(0, 0, 0))
        const code = DIR_CODE[w.level.directions.c130 ?? ''] ?? 0
        c.yaw = code === 0 ? (w.rand() >> 7) * 1.40625 : DIR_YAW[code]
        const out = (w.rand() >> 1) + 32000
        let lateral = (w.rand() >> 2) - 4096
        if (s.far) lateral += lateral >= 0 ? 4096 : -4096
        this.place(c, lateral, out)
        break
      }
      case 2: {
        // Drop zone: inside the 5000 box (9000 with "far"); reload this pass's crates.
        if (inBox(c.pos, s.far ? 9000 : 5000)) {
          c.counter = 1
          c.state = 3
          s.drops = [...s.load]
        }
        break
      }
      case 3:
        c.counter--
        if (c.counter < 1 && Math.hypot(c.pos.x, c.pos.z) > 800) this.drop(w, c)
        break
      case 4:
        if (!inBox(c.pos, 48000.0001)) {
          s.passes--
          if (s.passes === 0) c.state = 0
          else {
            c.yaw += 180
            c.state = 2
          }
        }
        break
      case 5:
        c.pitchT = -0.5
        c.state = 6
        break
      case 6:
        this.smoke(w, c, 0.4)
        if (c.pitch < -20) c.pitchT = 0
        if (c.pos.y < groundOr0(w, c.pos.x, c.pos.z) + 100) {
          this.crash(w, c)
          return
        }
        break
    }
    c.yawRateS = c.yawRateT * 0.08 + c.yawRateS * 0.92
    c.pitchS = c.pitchT * 0.08 + c.pitchS * 0.92
    c.pitch += c.pitchS
    c.yaw = wrap180(c.yaw + c.yawRateS)
    this.forward(c)
    c.pos.addScaledVector(c.fwd, c.speed)
  }

  /** One drop every 8 frames: rand>>12 picks a crate (0..3) or troops (4..7); an empty pick falls back in order troops, h, a, p, m. */
  private drop(w: World, c: Craft) {
    const s = c.c130
    const has = (k: number) => (k === 4 ? s.troops1 > 0 : s.drops[k] > 0)
    let t = w.rand() >> 12
    if (t > 3) t = 4
    if (!has(t)) {
      t = [4, 0, 1, 2, 3].find(has) ?? -1
      if (t < 0) {
        // Pass empty: the second wave of troops becomes the next pass's load.
        c.state = 4
        s.troops1 = s.troops2
        s.troops2 = 0
        return
      }
    }
    if (t === 4) {
      this.parachutes.drop(c.pos, c.yaw, 'soldier')
      s.troops1--
    } else {
      this.parachutes.drop(c.pos, c.yaw, t as CrateKind)
      s.drops[t]--
    }
    c.counter = 8
  }

  // ---------------------------------------------------------------- JET (L3555)

  private jet(w: World, c: Craft) {
    const p = c.pos
    switch (c.state) {
      case 0:
        c.active = false
        return
      case 1: {
        p.y = (w.rand() >> 3) + 2000
        c.pitch = c.yaw = c.roll = 0
        c.speed = (w.rand() >> 10) + 160
        c.hp = 4
        const lateral = (w.rand() >> 1) - 8192, out = (w.rand() >> 1) + 32000
        c.yaw = this.dirYaw(w, 'jet')
        this.place(c, lateral, out)
        c.state = 2
        break
      }
      case 2: {
        const r = w.rand() >> 6
        const near = inBox(p, 20000)
        if (r === 100 && near) {
          c.yawRateT = ((w.rand() >> 12) - 3.5) * 0.75
          c.counter = (w.rand() >> 9) + 30
          c.state = 5
        }
        if (r === 300 && near) {
          c.yawRateT = (w.rand() >> 13) - 1.5
          c.counter = (w.rand() >> 9) + 30
          c.state = 7
          if (p.y > 6000) c.pitchT = -1
          if (p.y < 4000) c.pitchT = 1
        }
        if (r === 400) {
          c.target.y = (w.rand() >> 4) + 2000
          c.pitchT = c.target.y <= p.y ? -1 : 1
          c.state = 8
        }
        // Attack: (b+1)/512 per frame, only while more than 16000 out on either axis.
        if (r > 499 && r <= w.aggression.jet + 500 && !inBox(p, 16000.0001)) {
          c.target.set(0, 800, 0)
          c.yawRateT = this.turnSign(c)
          c.counter = 180
          c.state = 9
        }
        break
      }
      case 3:
        if (this.facing(c) > 0.99) {
          c.state = 4
          c.yawRateT = 0
        }
        break
      case 4:
        if (inBox(p, 25000)) c.state = 2
        break
      case 5:
        if (--c.counter === 0) {
          c.state = 6
          c.yawRateT = 0
        }
        break
      case 6:
        if (Math.abs(c.pitch) < 0.5) {
          c.pitch = 0
          c.state = 2
        }
        if (Math.abs(c.pitch) < 5) {
          c.pitch *= 0.75
          c.pitchS = c.pitchT = 0
        }
        break
      case 7:
        if (Math.abs(c.pitch) > 20) c.pitchS = c.pitchT = 0
        if (p.y < 2500) c.counter = 1
        if (--c.counter < 1) {
          c.state = 6
          c.yawRateT = 0
          if (c.pitch > 1) c.pitchT = -1
          if (c.pitch < -1) c.pitchT = 1
        }
        break
      case 8:
        if (Math.abs(c.pitch) > 10) c.pitchS = c.pitchT = 0
        if (c.pitch <= 0 && p.y <= c.target.y) {
          c.pitchT = 1
          c.state = 6
        }
        if (c.pitch > 0 && c.target.y <= p.y) {
          c.pitchT = -1
          c.state = 6
        }
        break
      case 9:
        if (--c.counter === 0) {
          c.yawRateT = 0
          c.state = 2
        } else if (this.align(c, false)) {
          const r = w.rand()
          if (r < 0x2000 && c.missiles !== 0) {
            c.state = 10
            c.counter = 8
          } else c.state = 0xc
        }
        break
      case 10:
        if (Math.hypot(c.target.x - p.x, c.target.z - p.z) < 12000) c.state = 0xb
        break
      case 0xb:
        if ((c.counter & 3) === 0) {
          c.fire = 2
          c.missiles--
        }
        if (--c.counter === 0) c.state = 2
        break
      case 0xc: {
        // Dive: pitch target -|asin(dy/d)| (radians used as a rate, an original quirk), gun once lined up.
        const d = p.distanceTo(c.target)
        let a = Math.asin((c.target.y - p.y) / d)
        if (a > 0) a = -a
        c.pitchT = a - 0.05
        if (Math.abs(c.pitch - a * 57.29578) < 0.5) {
          c.pitchS = c.pitchT = 0
          c.state = 0xd
        }
        if (d < 6000 || p.y < 1800) {
          c.pitchT = 1.5
          c.state = 0xe
        }
        break
      }
      case 0xd:
        if ((c.counter & 1) === 0) c.fire = 1
        if (--c.counter < 1) {
          c.pitchT = 1
          c.state = 0xe
        }
        if (p.y < 1800 || (c.pitch < -25 && p.y < 5000)) {
          c.pitchT = 1.5
          c.state = 0xe
        }
        break
      case 0xe:
        if (c.pitch > 15) c.pitchT = 0
        if (p.y > 2200) {
          c.pitchT = 0
          c.state = 7
        }
        break
      case 0xf:
        c.yawRateT = (w.rand() >> 13) - 1.5
        c.pitchT = -((w.rand() >> 14) + 1)
        c.rollSpin = (w.rand() >> 11) - 7.5
        c.state = 0x10
        break
      case 0x10:
        this.smoke(w, c, 0.6)
        if (c.pitch < -20) c.pitchT = 0
        if (p.y < groundOr0(w, p.x, p.z) + 100) {
          this.crash(w, c)
          return
        }
        break
    }
    this.fly(c, 30)
    if (c.state === 2 && !inBox(p, 25000.0001)) {
      // Wandered out of the 25000 box: turn back toward a random point within ±4096.
      c.state = 3
      c.yawRateT = w.rand() < 0x4001 ? -2 : 2
      c.pitchT = 0
      c.target.x = (w.rand() >> 2) - 4096
      c.target.z = (w.rand() >> 2) - 4096
    }
    if (p.y < 2240 && c.state < 0xc) {
      // Terrain pull-up: ground 4000 ahead (800 off the map) + 200.
      const ax = p.x + c.fwd.x * 4000, az = p.z + c.fwd.z * 4000
      const h = Math.abs(ax) >= 15000 || Math.abs(az) >= 15000 ? 800 : w.groundY(ax, az)
      if (p.y < h + 200) {
        c.state = 0xe
        c.pitchT = 1
        c.yawRateT = 0
      }
    }
  }

  // ---------------------------------------------------------------- BOMBER (L4132, friendly)

  private bomber(w: World, c: Craft) {
    switch (c.state) {
      case 0:
        c.active = false
        return
      case 1: {
        c.pos.y = (w.rand() >> 4) + 2240
        c.pitch = c.roll = c.yaw = 0
        c.speed = 200
        c.hp = 4
        const lateral = (w.rand() >> 2) - 4096, out = w.rand() * 4 + 65000
        c.yaw = this.bomberYaw
        this.place(c, lateral, out)
        c.state = 2
        break
      }
      case 2:
        if (Math.hypot(c.pos.x, c.pos.z) < 18000) {
          // rand>>10 can be 0: the counter then never hits 0 and that bomber never drops (original quirk).
          c.counter = w.rand() >> 10
          c.state = 3
        }
        break
      case 3:
        if (--c.counter === 0) {
          c.counter = 32
          c.state = 4
        }
        break
      case 4:
        if ((c.counter & 7) === 0) c.fire = 2
        if (--c.counter === 0) c.state = 5
        break
      case 5:
        if (!inBox(c.pos, 60000.0001)) c.active = false
        break
    }
    this.fly(c, 35)
  }

  // ---------------------------------------------------------------- COBRA (L4247)

  private cobra(w: World, c: Craft) {
    const p = c.pos
    switch (c.state) {
      case 0:
        c.active = false
        return
      case 1: {
        c.pitch = c.yaw = c.roll = 0
        c.parts.forEach((q) => q.rot.set(0, 0, 0))
        c.parts[0].spin.set(0, 55, 0)
        c.maxSpeed = 140
        c.accel = 0
        c.speed = 140
        c.hp = 8
        c.state = 2
        p.y = (w.rand() >> 5) + 1500
        const lateral = (w.rand() >> 1) - 8192, out = (w.rand() >> 1) + 32000
        c.yaw = this.dirYaw(w, 'cobra')
        this.place(c, lateral, out)
        break
      }
      case 2: {
        const r = w.rand() >> 7
        if (r === 20 && inBox(p, 15000)) {
          c.yawRateT = (w.rand() >> 13) - 1.5
          c.counter = (w.rand() >> 7) + 30
          c.state = 5
        }
        if (r === 30) {
          c.target.y = (w.rand() >> 5) + 1000
          c.vT = c.target.y <= p.y ? -1 : 1
          c.state = 6
        }
        // Gun attack: (c+1)/256 per frame inside |x| <= 12000, -12000 <= z <= 3000, outside the 4000 box.
        if (r > 39 && r <= w.aggression.heliGun + 40) {
          const zone = Math.abs(p.x) <= 12000 && p.z <= 3000 && p.z >= -12000 && !inBox(p, 4000.0001)
          if (zone && c.speed >= 130) {
            c.target.x = c.target.z = 0
            c.yawRateT = this.turnSign(c)
            c.pitchT = 25
            c.accel = -2
            c.state = 0xb
          }
        }
        // Rocket attack: fixed 4/256 per frame outside the 10000 box (heli rocket aggression is never read).
        if (r > 49 && r < 54 && !inBox(p, 10000.0001) && c.speed >= 130) {
          c.target.x = c.target.z = 0
          c.yawRateT = this.turnSign(c)
          c.counter = 150
          c.state = 9
        }
        break
      }
      case 3:
        if (this.facing(c) > 0.98) {
          c.state = 4
          c.yawRateT = 0
        }
        break
      case 4:
        if (inBox(p, 20000)) c.state = 2
        break
      case 5:
        if (--c.counter === 0) {
          c.state = 2
          c.yawRateT = 0
        }
        break
      case 6:
        // Both tests cover every case, so an altitude change lasts one frame (original behaviour).
        if (p.y <= c.target.y || c.target.y <= p.y) {
          c.vT = 0
          c.state = 2
        }
        break
      case 7:
        if (--c.counter === 0) {
          c.counter = 60
          c.accel = 2
          c.pitchT = -25
          c.state = 8
        }
        break
      case 8:
        if (--c.counter === 0) c.state = 2
        break
      case 9:
        if (--c.counter === 0) {
          c.yawRateT = 0
          c.state = 2
        } else if (this.align(c, false)) {
          c.state = 10
          c.counter = 34
        }
        break
      case 10:
        // 4 rockets, 8 frames apart.
        if ((c.counter & 7) === 0) c.fire = 2
        if (--c.counter === 0) c.state = 2
        break
      case 0xb:
        if (this.align(c, false)) {
          c.state = 0xc
          c.counter = (w.rand() >> 9) + 60
        }
        break
      case 0xc:
        // Hover, then pick a jittered aim point around the bunker.
        if (--c.counter === 0) {
          c.target.x = (w.rand() >> 7) - 128
          c.target.y = (w.rand() >> 7) + 672
          c.target.z = (w.rand() >> 7) - 128
          c.counter = (w.rand() >> 10) + 16
          c.state = 0xd
        }
        break
      case 0xd:
        if ((c.counter & 3) === 0) c.fire = 1
        if (--c.counter === 0) {
          c.counter = 60
          c.accel = 2
          c.pitchT = -25
          c.state = 8
        }
        break
      case 0xe:
        c.accel = -1
        c.vT = -1
        c.yawRateT = w.rand() >> 13
        c.pitchT = (w.rand() >> 10) - 16
        c.state = 0xf
        c.fall = 0
        break
      case 0xf: {
        this.smoke(w, c, 0.4)
        const rotor = c.parts[0].spin
        rotor.y = Math.max(20, rotor.y - 0.25)
        c.fall -= 1
        p.y += c.fall
        if (p.y < groundOr0(w, p.x, p.z) + 200) {
          this.crash(w, c)
          return
        }
        break
      }
    }
    this.heliAttitude(c, c.speed * 0.215, c.speed < 30 ? 1.5 : 0, c.state < 9 || c.state > 10)
    p.x += c.fwd.x * c.speed
    c.vS = c.vT * 0.1 + c.vS * 0.9
    // Original quirk: climb rate is scaled by the forward vector's y.
    p.y += c.fwd.y * c.vS
    p.z += c.fwd.z * c.speed
    if (c.state === 2 && !inBox(p, 20000.0001)) {
      c.state = 3
      c.yawRateT = w.rand() < 0x4001 ? -2 : 2
      c.target.x = (w.rand() >> 4) - 1024
      c.target.z = (w.rand() >> 4) - 1024
    }
  }

  // ---------------------------------------------------------------- CH53 (L6235)

  private ch53(w: World, c: Craft) {
    const p = c.pos
    const ramp = c.parts[0].rot
    switch (c.state) {
      case 0:
        c.active = false
        return
      case 1: {
        c.pitch = c.yaw = c.roll = 0
        c.parts.forEach((q) => q.rot.set(0, 0, 0))
        c.parts[1].spin.set(0, 25, 0)
        c.maxSpeed = 140
        c.accel = 0
        c.speed = 140
        c.hp = 8
        c.state = 2
        p.y = (w.rand() >> 6) + 2500
        const lateral = (w.rand() >> 1) - 8192, out = (w.rand() >> 1) + 32000
        c.yaw = this.dirYaw(w, 'ch53')
        this.place(c, lateral, out)
        break
      }
      case 2:
        this.pickLandingZone(w, c)
        c.state = 3
        break
      case 3:
        if (inBox(p, 20000)) c.state = 4
        break
      case 4: {
        const dx = c.target.x - p.x, dz = c.target.z - p.z
        if (Math.abs(dx) >= 4800 && Math.abs(dz) >= 4800) break
        // Deviation: the original divides dz by a stale local here; we use the true heading.
        c.yawRateT = this.turnSign(c)
        c.counter = 1
        c.state = 5
        break
      }
      case 5:
        if (this.approach(w, c, true)) break
        if (this.align(c, true)) c.state = 6
        break
      case 6:
        this.approach(w, c, false)
        break
      case 7:
        ramp.x += 2
        if (ramp.x >= 35) {
          c.state = 8
          this.unload(w, c)
        }
        break
      case 8:
        if (--c.counter === 0) c.state = 9
        break
      case 9:
        ramp.x -= 2
        if (ramp.x <= 0) {
          c.vT = 1
          c.state = 10
        }
        break
      case 10:
        if (p.y > 1500) {
          c.yawRateT = c.yaw > 0 ? -1 : 1
          c.accel = 2
          c.pitchT = -25
          c.state = 0xb
        }
        break
      case 0xb:
        if (p.y > 4000) {
          c.yawRateT = 0
          c.vT = 0
          c.state = 0xc
        }
        break
      case 0xc:
        if (!inBox(p, 60000.0001)) c.state = 0
        break
      case 0xd:
        c.accel = -1
        c.vT = -1
        c.yawRateT = w.rand() >> 13
        c.pitchT = (w.rand() >> 10) - 16
        c.state = 0xe
        c.fall = 0
        break
      case 0xe: {
        this.smoke(w, c, 0.4)
        const rotor = c.parts[1].spin
        rotor.y = Math.max(20, rotor.y - 0.25)
        c.fall -= 1
        p.y += c.fall
        if (p.y < groundOr0(w, p.x, p.z) + 300) {
          c.hp = 0
          this.crash(w, c)
          return
        }
        break
      }
    }
    this.heliAttitude(c, 30, c.speed < 30 && (c.state < 7 || c.state > 9) ? 1 : 0, true)
    p.x += c.fwd.x * c.speed
    c.vS = c.vS * 0.9 + c.vT
    p.y += c.vS
    p.z += c.fwd.z * c.speed
  }

  /** Landing zone 2500..12740 out on both axes, valid MMap ground, at least 1000 from lower-index CH53 zones. */
  private pickLandingZone(w: World, c: Craft) {
    const axis = () => {
      const v = (w.rand() >> 6) * 40
      return v - 10240 < 1 ? v - 12740 : v - 7740
    }
    // Iteration cap is ours (the original loops until it succeeds).
    for (let tries = 0; tries < 10000; tries++) {
      let x = 0, z = 0
      for (let k = 0; k < 10000; k++) {
        x = axis()
        z = axis()
        if (w.validGround(x, z)) break
      }
      c.target.x = x
      c.target.z = z
      const clash = this.crafts.some((o) => o.type === 'CH53' && o.index < c.index && Math.hypot(o.target.x - x, o.target.z - z) < 1000)
      if (!clash) return
    }
  }

  /** Within 4830 of the zone: flare once (decelerate, nose up, sink), then descend and land 338 above ground. Returns true when it changed state. */
  private approach(w: World, c: Craft, steering: boolean) {
    const p = c.pos
    if (Math.hypot(c.target.x - p.x, c.target.z - p.z) >= 4830) return false
    if (c.counter === 1) {
      c.accel = -2
      c.pitchT = 25
      c.vT = -2.3
      c.counter = 0
    }
    const g = groundOr0(w, p.x, p.z)
    const h = p.y - g
    if (steering) {
      if (h < 700) {
        c.vT = -0.25
        c.yawRateT = c.yawRateS = 0
        c.state = 6
        return true
      }
      return false
    }
    if (h < 338) {
      p.y = g + 338
      c.counter = 90
      c.speed = 0
      c.vT = c.vS = 0
      c.state = 7
    } else if (h < 700) c.vT = -0.25
    return false
  }

  /** Six soldiers at y-270 behind the ramp, offsets 290..-110, facing away; stagger = -(offset - 310). */
  private unload(w: World, c: Craft) {
    const yaw = wrap180(c.yaw + 180)
    for (let k = 0, off = 290; k < 6; k++, off -= 80) {
      const at = new THREE.Vector3(c.pos.x - c.fwd.x * off, c.pos.y - 270, c.pos.z - c.fwd.z * off)
      w.soldiers.spawn(w, at, yaw, { stagger: 310 - off })
    }
  }

  // ---------------------------------------------------------------- fire flags (FUN_004154b7 L9785)

  private fire(w: World, c: Craft) {
    const m = c.node.matrix.elements
    const right = new THREE.Vector3(m[0], m[1], m[2]), up = new THREE.Vector3(m[4], m[5], m[6])
    if (c.fire === 1) {
      // Gun: jets fwd x 801 - up x 50, jitter ±32; cobras fwd x 601 - up x 190, jitter ±64. 500 u/f.
      const cobra = c.type === 'COBRA'
      const at = c.pos.clone().addScaledVector(c.fwd, cobra ? 601 : 801).addScaledVector(up, cobra ? -190 : -50)
      const shift = cobra ? 8 : 9, off = cobra ? 64 : 32
      const aim = new THREE.Vector3(
        (w.rand() >> shift) + c.target.x - off,
        (w.rand() >> shift) + c.target.y - off,
        (w.rand() >> shift) + c.target.z - off,
      )
      w.projectiles.fire('bullet', at, aim.sub(at).normalize().multiplyScalar(500))
    } else if (c.type === 'COBRA') {
      const side = (this.rocketRing & 1) === 1 ? -105 : 105
      this.rocketRing = (this.rocketRing + 1) % 12
      const at = c.pos.clone().addScaledVector(up, -165).addScaledVector(right, side)
      w.projectiles.fire('rocket', at, c.fwd.clone().multiplyScalar(280), { life: 100 })
    } else {
      // Bomb: horizontal speed = plane speed (falls 1/frame), alternating ±40 lateral.
      const side = (this.bombRing & 1) === 1 ? -40 : 40
      this.bombRing = (this.bombRing + 1) % 24
      const at = c.pos.clone().addScaledVector(right, side)
      const vel = new THREE.Vector3(c.fwd.x, 0, c.fwd.z).normalize().multiplyScalar(c.speed)
      w.projectiles.fire('bomb', at, vel, { hspeed: c.speed })
    }
  }

  // ---------------------------------------------------------------- damage (FUN_004154b7 L7087-7605)

  private targetFor(c: Craft): Target {
    return {
      slot: FIRST[c.type] + c.index,
      shape: SHAPE[c.type],
      node: c.node,
      alive: () => c.active && c.live,
      hit: (w, zone, weapon, point) => this.hit(w, c, zone, weapon, point),
    }
  }

  private hit(w: World, c: Craft, zone: number, weapon: 'bullet' | 'shell' | 'missile', point: THREE.Vector3) {
    if (!c.active || !c.live) return
    if (weapon !== 'bullet') return this.kill(w, c)
    w.effects.spawn('explodeF', point, { scale: FLASH[c.type] })
    // Friendly bombers: any hit destroys, no meter change.
    if (c.type === 'BOMBER') return this.kill(w, c)
    if (zone === 0) return this.kill(w, c)
    const dmg = zone === 1 ? 2 : zone === 2 ? 1 : 0
    if (dmg && c.hp > 0) {
      c.hp -= dmg
      if (c.hp < 1) this.hpOut(w, c)
    }
  }

  /** HP gone: enter the crash state (the meter drops when it hits the ground, CH53 immediately). */
  private hpOut(w: World, c: Craft) {
    if (c.type === 'JET') c.state = 0xf
    else if (c.type === 'COBRA') c.state = 0xe
    else if (c.type === 'C130') c.state = 5
    else if (c.type === 'CH53') {
      if (c.state < 8) w.reduceEnemyMeter(6)
      c.state = 0xd
    }
  }

  private troopsAboard(c: Craft) {
    return c.c130.troops1 + c.c130.troops2
  }

  /** Destroyed in the air by a vital hit, shell or missile (FUN_004232fa): ExplodeA, debris, ExFar. */
  private kill(w: World, c: Craft) {
    if (c.type === 'JET' || c.type === 'COBRA') w.reduceEnemyMeter(10)
    else if (c.type === 'C130') w.reduceEnemyMeter(this.troopsAboard(c))
    else if (c.type === 'CH53' && c.state < 8) w.reduceEnemyMeter(6)
    // A CH53 destroyed while landed or unloading sets nearby soldiers on fire.
    if (c.type === 'CH53' && (c.state === 7 || c.state === 8)) w.soldiers.burnWithin(w, c.pos, 600)
    c.hp = 0
    this.destroy(w, c, true)
    w.sound.play('ExFar')
  }

  /** Ground impact while crashing (FUN_004237f2 path in FUN_004051c8). */
  private crash(w: World, c: Craft) {
    const p = c.pos
    if ((c.type === 'JET' || c.type === 'COBRA') && Math.abs(p.x) < 300 && Math.abs(p.z) < 300) w.damagePlayer(5)
    this.destroy(w, c, false)
    // Crash sites set nearby soldiers on fire (burn event after the crash, notes 20 §7; meaning inferred).
    w.soldiers.burnWithin(w, new THREE.Vector3(p.x, w.groundY(p.x, p.z), p.z), 600)
    if (c.type === 'JET' || c.type === 'COBRA') w.reduceEnemyMeter(10)
    else if (c.type === 'C130') w.reduceEnemyMeter(this.troopsAboard(c))
    // Original bug: the volume uses |z| for both terms of max(|x|, |z|).
    w.sound.play('ExBig', { volumeDb: Math.trunc(-0.15 * Math.abs(p.z)) })
  }

  private destroy(w: World, c: Craft, shotDown: boolean) {
    c.active = false
    this.hide(c)
    // The crash variant skips the explosion near the bunker.
    if (shotDown || Math.abs(c.pos.x) > 400 || Math.abs(c.pos.z) > 400) w.effects.spawn('explodeA', c.pos.clone(), { scale: 4 })
    this.shatter(w, c, shotDown)
  }

  // ---------------------------------------------------------------- debris

  /** Split the model into chunks; every destruction reuses (and so clears) the whole debris pool, as in the original. */
  private shatter(w: World, c: Craft, shotDown: boolean) {
    for (const d of this.debris) {
      d.active = false
      d.mesh.visible = false
    }
    const chunks = this.chunks(w, c.type)
    for (let k = 0; k < chunks.length && k < DEBRIS; k++) {
      const d = this.debris[k], ch = chunks[k]
      d.mesh.geometry = ch.geometry
      d.mesh.material = ch.material
      d.mesh.renderOrder = ch.renderOrder
      d.pos.copy(c.pos)
      d.rot.set(c.pitch, c.yaw, c.roll + c.rollSpin)
      const r = () => w.rand() - 0x4000
      if (shotDown) {
        d.spin.set(Math.trunc(r() / 2000), Math.trunc(r() / 2000), Math.trunc(r() / 2000))
        d.vel.x = Math.trunc(r() / 200)
        d.vel.z = Math.trunc(r() / 200)
        d.vel.y = Math.trunc(r() / 200)
      } else {
        d.spin.set(Math.trunc(r() / 1000), Math.trunc(r() / 1000), Math.trunc(r() / 1000))
        d.vel.x = Math.trunc(r() / 800)
        d.vel.z = Math.trunc(r() / 800)
        d.vel.y = Math.trunc(w.rand() / 500) + 20
      }
      d.active = true
      d.mesh.visible = true
      this.poseDebris(d)
    }
  }

  private chunks(w: World, type: AirType) {
    const cached = this.chunkCache.get(type)
    if (cached) return cached
    const list: Chunk[] = []
    for (const o of w.g3d.node(FIRST[type]).children) {
      if (!(o instanceof THREE.Mesh)) continue
      const g = o.geometry as THREE.BufferGeometry
      const tris = g.getAttribute('position').count / 3
      for (let t = 0; t < tris; t += CHUNK_TRIS) {
        const n = Math.min(CHUNK_TRIS, tris - t)
        const sub = new THREE.BufferGeometry()
        for (const name of Object.keys(g.attributes)) {
          const a = g.getAttribute(name) as THREE.BufferAttribute
          const step = a.itemSize * 3
          sub.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(t * step, (t + n) * step), a.itemSize))
        }
        sub.computeBoundingSphere()
        list.push({ geometry: sub, material: o.material as THREE.Material, renderOrder: o.renderOrder })
      }
    }
    this.chunkCache.set(type, list)
    return list
  }

  /** Debris: drag 0.98 on x/z, gravity 3, removed below y 0. */
  private updateDebris() {
    for (const d of this.debris) {
      if (!d.active) continue
      if (d.pos.y < 0) {
        d.active = false
        d.mesh.visible = false
        continue
      }
      d.vel.x *= 0.98
      d.vel.z *= 0.98
      d.vel.y -= 3
      d.pos.add(d.vel)
      d.rot.set(wrap360(d.rot.x + d.spin.x), wrap360(d.rot.y + d.spin.y), wrap360(d.rot.z + d.spin.z))
      this.poseDebris(d)
    }
  }

  private poseDebris(d: Debris) {
    d.mesh.position.copy(d.pos)
    d.mesh.rotation.set(d.rot.x * deg, d.rot.y * deg, d.rot.z * deg, 'YXZ')
  }

  // ---------------------------------------------------------------- scene

  private pose(c: Craft) {
    c.node.visible = true
    c.node.position.copy(c.pos)
    c.node.rotation.set(c.pitch * deg, c.yaw * deg, (c.roll + c.rollSpin) * deg, 'YXZ')
    c.node.updateMatrix()
    for (const q of c.parts) {
      q.rot.set(wrap360(q.rot.x + q.spin.x), wrap360(q.rot.y + q.spin.y), wrap360(q.rot.z + q.spin.z))
      q.node.visible = true
      q.node.rotation.set(q.rot.x * deg, q.rot.y * deg, q.rot.z * deg, 'YXZ')
    }
  }

  private hide(c: Craft) {
    c.node.visible = false
    for (const q of c.parts) q.node.visible = false
    if (c.shadow) c.shadow.node.visible = false
  }

  /** Helicopter shadows (0x112.., 0x11e..): yaw/x/z of the craft inside the 14000 box, each vertex at ground + 12. */
  private updateShadows(w: World) {
    for (const c of this.crafts) {
      const s = c.shadow
      if (!s) continue
      s.node.visible = c.active && c.live && inBox(c.pos, 14000)
      if (!s.node.visible) continue
      const y = c.yaw * deg, cos = Math.cos(y), sin = Math.sin(y)
      s.node.position.set(c.pos.x, 0, c.pos.z)
      s.node.rotation.set(0, y, 0)
      for (const { attr, xz } of s.meshes) {
        for (let k = 0; k < attr.count; k++) {
          const lx = xz[k * 2], lz = xz[k * 2 + 1]
          attr.setY(k, w.groundY(c.pos.x + cos * lx + sin * lz, c.pos.z - sin * lx + cos * lz) + 12)
        }
        attr.needsUpdate = true
      }
    }
  }
}
