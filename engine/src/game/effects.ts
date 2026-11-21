import * as THREE from 'three/webgpu'
import { clamp, float, instancedDynamicBufferAttribute, mix, texture, uv, vec2, vec4 } from 'three/tsl'
import type { GameFS } from '../vfs'
import type { G3DScene } from '../render/g3dscene'
import { decodeRaw24, toRGBA } from '../formats/raw24'
import { imageTexture } from '../render/textures'
import { forward } from './player'
import type { Projectile } from './projectiles'
import type { EffectKind, Effects, World } from './world'
import { deg } from './constants'

// Billboard effects, projectile visuals and ejected casings (FUN_004154b7 §11, FUN_0042ffec billboards,
// docs/re/architecture.md §3.7). Particle state advances once per game frame in update(); render(alpha)
// only interpolates positions and rebuilds the instance buffers.

/** D3D7 SetTexture modes used by effects (see g3dscene.ts). */
type Mode = 2 | 3 | 4 | 5

interface Quad {
  x0: number
  x1: number
  y0: number
  y1: number
}

const centered = (h: number): Quad => ({ x0: -h, x1: h, y0: -h, y1: h })

/** One instanced quad mesh per billboard template (one draw call). Frames are rows of a vertical strip. */
class SpriteBatch {
  readonly mesh: THREE.InstancedMesh
  private fx: THREE.InstancedBufferAttribute
  private n = 0
  private m = new THREE.Matrix4()
  private s = new THREE.Vector3()

  constructor(map: THREE.Texture, frames: number, frameH: number, quad: Quad, mode: Mode, capacity: number, uvMax: [number, number] = [1, 1]) {
    const g = new THREE.BufferGeometry()
    const { x0, x1, y0, y1 } = quad
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x0, y1, 0, x0, y0, 0, x1, y0, 0, x1, y1, 0]), 3))
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 1, 1]), 2))
    g.setIndex([0, 1, 2, 0, 2, 3])
    // Per instance: frame index, brightness (vertex intensity, drives fades under modes 2/5), u mirror.
    this.fx = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.fx.setUsage(THREE.DynamicDrawUsage)
    const fx = instancedDynamicBufferAttribute(this.fx, 'vec3' as const)
    const [uMax, vMax] = uvMax
    const u0 = uv().x.mul(uMax)
    const e = 0.5 / frameH
    const v = fx.x.add(clamp(uv().y.oneMinus().mul(vMax), e, vMax - e)).div(frames)
    const t = texture(map, vec2(mix(u0, float(uMax).sub(u0), fx.z), v))

    const mat = new THREE.MeshBasicNodeMaterial()
    mat.colorNode = vec4(t.rgb.mul(fx.y), t.a)
    mat.side = THREE.DoubleSide
    mat.fog = false
    if (mode === 4) {
      mat.alphaTest = 0.5
    } else {
      mat.transparent = true
      mat.depthWrite = false
      mat.blending = THREE.CustomBlending
      mat.blendEquation = THREE.AddEquation
      // Keep the framebuffer alpha: with the colour factors applied to alpha, darken (dst x (1 - srcAlpha))
      // writes alpha 0 and the canvas turns transparent (black page background).
      mat.blendSrcAlpha = THREE.ZeroFactor
      mat.blendDstAlpha = THREE.OneFactor
      if (mode === 2) [mat.blendSrc, mat.blendDst] = [THREE.ZeroFactor, THREE.OneMinusSrcColorFactor]
      if (mode === 3) [mat.blendSrc, mat.blendDst] = [THREE.ZeroFactor, THREE.SrcColorFactor]
      if (mode === 5) [mat.blendSrc, mat.blendDst] = [THREE.OneFactor, THREE.OneMinusSrcColorFactor]
    }
    this.mesh = new THREE.InstancedMesh(g, mat, capacity)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2
    this.mesh.count = 0
  }

  begin() {
    this.n = 0
  }

  push(pos: THREE.Vector3, q: THREE.Quaternion, sx: number, sy: number, frame: number, brightness: number, mirror = false) {
    if (this.n >= this.mesh.instanceMatrix.count) return
    this.m.compose(pos, q, this.s.set(sx, sy, sx))
    this.mesh.setMatrixAt(this.n, this.m)
    this.fx.setXYZ(this.n, frame, brightness, mirror ? 1 : 0)
    this.n++
  }

  end() {
    this.mesh.count = this.n
    this.mesh.instanceMatrix.needsUpdate = true
    this.fx.needsUpdate = true
  }
}

/** Returned by EffectSystem.spawn: move `pos` each frame to make an effect follow something (burning soldier). */
export interface EffectHandle {
  active: boolean
  pos: THREE.Vector3
  prev: THREE.Vector3
  vel: THREE.Vector3
  sx: number
  sy: number
  /** Brightness (particle intensity). */
  b: number
  /** Next frame index (the original's u16 billboard counter) and the one shown this frame. */
  counter: number
  frame: number
  age: number
  /** Looping effects: frames left (-1 = forever). */
  life: number
  mirror: boolean
}

interface PoolSpec {
  batch: SpriteBatch
  capacity: number
  /** Animation length; 1 for static particles. */
  frames: number
  loop?: boolean
  yawOnly?: boolean
  /** Per-frame motion/fade; return false to deactivate. */
  step?: (p: EffectHandle, w: World) => boolean
}

/** Fixed-size round-robin pool like the original particle arrays (new spawns overwrite the oldest slot). */
class Pool {
  readonly items: EffectHandle[]
  private next = 0
  readonly spec: PoolSpec

  constructor(spec: PoolSpec) {
    this.spec = spec
    this.items = Array.from({ length: spec.capacity }, () => ({
      active: false, pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(),
      sx: 1, sy: 1, b: 1, counter: 0, frame: 0, age: 0, life: -1, mirror: false,
    }))
  }

  spawn(at: THREE.Vector3, sx: number, sy: number, b = 1) {
    const i = this.next
    this.next = (this.next + 1) % this.items.length
    const p = this.items[i]
    p.active = true
    p.pos.copy(at)
    p.prev.copy(at)
    p.vel.set(0, 0, 0)
    p.sx = sx
    p.sy = sy
    p.b = b
    p.counter = p.frame = 0
    p.age = 0
    p.life = -1
    // The original templates alternate mirrored UVs between consecutive slots (ExplodeV, Fire).
    p.mirror = (i & 1) === 1
    return p
  }

  update(w: World) {
    const { frames, loop, step } = this.spec
    for (const p of this.items) {
      if (!p.active) continue
      p.prev.copy(p.pos)
      p.age++
      p.pos.add(p.vel)
      if (step && !step(p, w)) {
        p.active = false
        continue
      }
      if (frames <= 1) continue
      // Shown frame is the counter before the increment; a once-only effect switches off in the same
      // update that would show its last frame, so the last frame is never drawn (as in BH2.exe).
      p.frame = p.counter++
      if (p.counter >= frames) {
        if (loop) p.counter = 0
        else p.active = false
      }
      if (p.life > 0 && --p.life === 0) p.active = false
    }
  }

  clear() {
    for (const p of this.items) p.active = false
  }
}

interface Casing {
  node: THREE.Object3D
  vel: THREE.Vector3
  spin: THREE.Vector3
  rot: THREE.Vector3
  drag: number
  active: boolean
}

interface Sheet {
  map: THREE.Texture
  frames: number
  h: number
}

const SET = { explodeV: 0, explodeF: 1, explodeA: 2, fire: 3, dirt: 4, blood: 5 } as const
const SLOT = { flare: 8, tracer: 9, smoke: 11, grenade: 17 } as const
/** Geometry.3D models drawn for projectiles (MISSILE is also used for APC3 rockets, objects 0x1d8-0x1df). */
const MODEL = { missile: 470, rocket: 480, bomb: 496 } as const
const CASINGS = [29, 30, 31, 32, 33, 34]
const HANDGUN_CASING = 36 // 0x23 is never used (index increment bug in the original)

const _v = new THREE.Vector3()
const _d = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _yaw = new THREE.Quaternion()
const _e = new THREE.Euler()
const NOSE = new THREE.Vector3(0, 0, -1)

export class EffectSystem implements Effects {
  readonly group = new THREE.Group()
  private world: World
  private camera: THREE.Camera
  private batches: SpriteBatch[] = []
  private pools: Pool[] = []
  private explodeV!: Pool
  private hitFlash!: Pool
  private muzzle!: Pool
  private explodeA!: Pool
  private fire!: Pool
  private dust!: Pool
  private blood!: Pool
  private smokeWhite!: Pool
  private smokeBlack!: Pool
  private debris!: Pool
  private tracers!: SpriteBatch
  private shells!: SpriteBatch
  private flares!: SpriteBatch
  private grenades!: SpriteBatch
  private flames!: SpriteBatch
  private models = new Map<keyof typeof MODEL, THREE.Object3D[]>()
  private casings: Casing[] = []
  private handgunCasing!: Casing
  private nextCasing = 0
  /** Last ground explosion, to tell blast debris from bullet dust (both arrive as 'dirt'). */
  private lastBlast = { pos: new THREE.Vector3(), frame: -1 }

  private constructor(world: World, camera: THREE.Camera) {
    this.world = world
    this.camera = camera
  }

  static async load(world: World, camera: THREE.Camera, fs: GameFS) {
    const fx = new EffectSystem(world, camera)
    await fx.build(world.g3d, fs)
    return fx
  }

  private async build(g3d: G3DScene, fs: GameFS) {
    const sheets = new Map<number, Sheet>()
    await Promise.all(
      g3d.geo.animations
        .filter((a) => a.kind === 'Animated')
        .map(async (a) => {
          // Higher-resolution copies of the sheet (integer multiple of the declared size) load as is.
          const img = decodeRaw24(a.file, await fs.read(`BH2Game/${a.file}`), a.width, a.height * a.frameCount)
          const map = imageTexture(img.width, img.height, toRGBA(img))
          // Original: no mipmaps. Mipmapping a strip would also bleed neighbouring frames.
          map.generateMipmaps = false
          map.minFilter = THREE.LinearFilter
          // WebGPU rejects anisotropic samplers without linear mipmap filtering.
          map.anisotropy = 1
          sheets.set(a.set, { map, frames: a.frameCount, h: img.height / a.frameCount })
        }),
    )
    const statics = new Map<number, THREE.Texture>()
    await Promise.all(
      Object.values(SLOT).map(async (slot) => {
        const t = g3d.geo.textures.find((x) => x.slot === slot)
        if (!t) throw new Error(`Geometry.3D texture slot ${slot} missing`)
        const img = decodeRaw24(t.file, await fs.read(`BH2Game/${t.file}`), t.width, t.height)
        const map = imageTexture(img.width, img.height, toRGBA(img, t.kind === 'ColorKeyed'))
        if (t.kind === 'ColorKeyed') {
          map.magFilter = map.minFilter = THREE.NearestFilter
          map.anisotropy = 1
        }
        statics.set(slot, map)
      }),
    )
    const sheet = (set: number) => {
      const s = sheets.get(set)
      if (!s) throw new Error(`Geometry.3D animation set ${set} missing`)
      return s
    }
    const batch = (map: THREE.Texture, frames: number, h: number, quad: Quad, mode: Mode, capacity: number, uvMax?: [number, number]) => {
      const b = new SpriteBatch(map, frames, h, quad, mode, capacity, uvMax)
      this.batches.push(b)
      this.group.add(b.mesh)
      return b
    }
    const animated = (set: number, quad: Quad, mode: Mode, capacity: number) => {
      const s = sheet(set)
      return batch(s.map, s.frames, s.h, quad, mode, capacity)
    }
    const pool = (spec: PoolSpec) => {
      const p = new Pool(spec)
      this.pools.push(p)
      return p
    }
    const night = () => !this.world.daytime

    // Animated pools (slot counts from the original arrays, §11 of notes 20).
    const v = sheet(SET.explodeV), f = sheet(SET.explodeF), a = sheet(SET.explodeA)
    this.explodeV = pool({ batch: animated(SET.explodeV, { x0: -400, x1: 400, y0: 0, y1: 800 }, 3, 8), capacity: 8, frames: v.frames })
    const flashBatch = animated(SET.explodeF, centered(100), 5, 64)
    this.hitFlash = pool({ batch: flashBatch, capacity: 8, frames: f.frames })
    this.muzzle = pool({ batch: flashBatch, capacity: 8, frames: 5 })
    this.flames = flashBatch
    this.explodeA = pool({ batch: animated(SET.explodeA, centered(200), 5, 8), capacity: 8, frames: a.frames })
    this.fire = pool({ batch: animated(SET.fire, { x0: -140, x1: 140, y0: 0, y1: 360 }, 5, 12), capacity: 12, frames: sheet(SET.fire).frames, loop: true, yawOnly: true })
    this.dust = pool({ batch: animated(SET.dirt, { x0: -40, x1: 40, y0: 0, y1: 100 }, 5, 8), capacity: 8, frames: sheet(SET.dirt).frames })
    this.blood = pool({ batch: animated(SET.blood, centered(100), 5, 4), capacity: 4, frames: sheet(SET.blood).frames })

    // Smoke pools: SMOKEWHITE ±100 screen, SMOKEBLACK ±200 darken (also carries blast debris in slots 120..155).
    const smoke = statics.get(SLOT.smoke)!
    this.smokeWhite = pool({
      batch: batch(smoke, 1, 64, centered(100), 5, 120),
      capacity: 120,
      frames: 1,
      step: (p) => {
        p.pos.y -= 2
        p.sx += 0.015
        p.sy += 0.015
        p.b -= night() ? 0.004 : 0.016
        return p.age < 60
      },
    })
    const blackBatch = batch(smoke, 1, 64, centered(200), 2, 156)
    this.smokeBlack = pool({
      batch: blackBatch,
      capacity: 120,
      frames: 1,
      step: (p) => {
        p.sx += 0.015
        p.sy += 0.015
        p.b -= 0.016
        return p.age < 60
      },
    })
    this.debris = pool({
      batch: blackBatch,
      capacity: 36,
      frames: 1,
      step: (p) => {
        // pos += vel already applied; the original adds a constant 3 to y every frame.
        p.pos.y += 3
        p.vel.x *= 0.75
        p.vel.y *= 0.85
        p.vel.z *= 0.75
        p.b -= 0.02
        return p.age < 51
      },
    })

    // Projectile billboards.
    const tracer = statics.get(SLOT.tracer)!
    this.tracers = batch(tracer, 1, 32, centered(15), 5, 256)
    this.shells = batch(tracer, 1, 32, centered(15), 5, 32)
    this.flares = batch(statics.get(SLOT.flare)!, 1, 128, centered(15), 5, 8)
    this.grenades = batch(statics.get(SLOT.grenade)!, 1, 64, { x0: -8, x1: 8, y0: -15, y1: 15 }, 4, 32, [31 / 63, 57 / 63])

    for (const k of Object.keys(MODEL) as (keyof typeof MODEL)[]) this.models.set(k, [])

    const casing = (id: number, drag: number): Casing => ({
      node: g3d.node(id), vel: new THREE.Vector3(), spin: new THREE.Vector3(), rot: new THREE.Vector3(), drag, active: false,
    })
    this.casings = CASINGS.map((id) => casing(id, 0.97))
    this.handgunCasing = casing(HANDGUN_CASING, 0.99)
  }

  spawn(kind: EffectKind, p: THREE.Vector3, opts: { scale?: number; velocity?: THREE.Vector3; frames?: number } = {}) {
    const w = this.world
    const s = opts.scale ?? 1
    let e: EffectHandle
    switch (kind) {
      case 'explodeV':
        e = this.explodeV.spawn(p, s, s)
        this.lastBlast.pos.copy(p)
        this.lastBlast.frame = w.frame
        break
      case 'explodeF':
        // Muzzle flashes reuse the first 5 ExplodeF frames in their own pool. Callers can pass
        // frames: 5 explicitly; otherwise sizes below 1 (player guns 0.15/0.25/0.6) are muzzle flashes.
        e = ((opts.frames ?? (s < 1 ? 5 : 16)) <= 5 ? this.muzzle : this.hitFlash).spawn(p, s, s)
        break
      case 'explodeA':
        e = this.explodeA.spawn(p, s, s)
        break
      case 'fire': {
        // Burning soldiers: xz 0.25, y 0.5, random start frame 0..31, loops (frames = lifetime).
        const sx = opts.scale ?? 0.25
        e = this.fire.spawn(p, sx, sx * 2)
        e.counter = w.rand() >> 10
        e.life = opts.frames ?? 150
        break
      }
      case 'dirt':
        if (this.lastBlast.frame === w.frame && this.lastBlast.pos.equals(p)) {
          // Blast debris (shell/missile/bomb impacts): darken quads thrown up and out.
          e = this.debris.spawn(p, s, s)
          e.pos.x += (w.rand() - 16384) * 0.004
          e.pos.z += (w.rand() - 16384) * 0.004
          e.prev.copy(e.pos)
          e.vel.set((w.rand() - 16384) * 0.004, w.rand() * 0.003, (w.rand() - 16384) * 0.004)
        } else {
          // Bullet dust puff on the ground, half brightness by day, quarter at night.
          _v.set(p.x, w.groundY(p.x, p.z), p.z)
          e = this.dust.spawn(_v, s, s, w.daytime ? 0.5 : 0.25)
        }
        break
      case 'blood':
        e = this.blood.spawn(p, s, s)
        break
      case 'smokeWhite':
        e = this.smokeWhite.spawn(p, opts.scale ?? 0.2, opts.scale ?? 0.2, w.daytime ? 1 : 0.25)
        break
      case 'smokeBlack':
        e = this.smokeBlack.spawn(p, opts.scale ?? 0.4, opts.scale ?? 0.4)
        break
    }
    if (opts.velocity) e.vel.copy(opts.velocity)
    return e
  }

  update(w: World) {
    for (const p of this.pools) p.update(w)
    for (const p of w.projectiles.list) {
      // Missile smoke trail: one puff per frame at the position before this frame's move.
      if (p.kind === 'missile') this.spawn('smokeWhite', p.prev)
      if (p.fromPlayer && p.kind === 'bullet' && p.age === 1) this.eject(w)
    }
    this.updateCasings()
  }

  /** Spent casings: alt guns (MachineGun) and the handgun eject one per shot; the twin gun does not. */
  private eject(w: World) {
    const pl = w.player
    const alt = pl.weapon === 0 && w.level.altGun !== 0
    if (!alt && pl.weapon !== 2) return
    const c = alt ? this.casings[(this.nextCasing = (this.nextCasing + 1) % this.casings.length)] : this.handgunCasing
    const yaw = pl.yaw * deg
    const fwd = forward(pl.yaw, pl.pitch, _d)
    const ex = Math.cos(yaw) * 16384, ey = w.rand(), ez = -Math.sin(yaw) * 16384
    const k = 6 / Math.hypot(ex, ey, ez)
    c.vel.set(ex * k, ey * k, ez * k)
    const reach = alt ? 45 : 90
    c.node.position.set(c.vel.x * 2 + fwd.x * reach, fwd.y * reach + (alt ? 810 : 800), c.vel.z * 2 + fwd.z * reach)
    const shift = alt ? 10 : 9
    c.spin.set((w.rand() - 0x4000) >> shift, (w.rand() - 0x4000) >> shift, (w.rand() - 0x4000) >> shift)
    c.rot.set(0, 0, 0)
    c.active = true
    c.node.visible = true
  }

  private updateCasings() {
    for (const c of [...this.casings, this.handgunCasing]) {
      if (!c.active) continue
      const n = c.node
      if (n.position.y < 720) {
        c.active = false
        n.visible = false
        continue
      }
      c.vel.x *= c.drag
      c.vel.z *= c.drag
      c.vel.y -= 1
      n.position.add(c.vel)
      c.rot.add(c.spin)
      n.rotation.set(c.rot.x * deg, c.rot.y * deg, c.rot.z * deg, 'YXZ')
    }
  }

  reset() {
    for (const p of this.pools) p.clear()
    for (const c of [...this.casings, this.handgunCasing]) {
      c.active = false
      c.node.visible = false
    }
    for (const list of this.models.values()) for (const m of list) m.visible = false
    this.lastBlast.frame = -1
  }

  /** Pose all billboards and projectile models at interpolation factor alpha (0..1). Call before rendering. */
  render(alpha: number) {
    const cam = this.camera.quaternion
    _e.setFromQuaternion(cam, 'YXZ')
    _yaw.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, _e.y)
    for (const b of this.batches) b.begin()
    for (const pool of this.pools) {
      const q = pool.spec.yawOnly ? _yaw : cam
      for (const p of pool.items) {
        if (!p.active || p.b <= 0) continue
        pool.spec.batch.push(_v.lerpVectors(p.prev, p.pos, alpha), q, p.sx, p.sy, p.frame, p.b, p.mirror)
      }
    }
    const used = { missile: 0, rocket: 0, bomb: 0 }
    const night = !this.world.daytime
    for (const p of this.world.projectiles.list) {
      if (p.dead) continue
      const at = _v.lerpVectors(p.prev, p.pos, alpha)
      switch (p.kind) {
        case 'bullet':
          this.tracers.push(at, cam, 1.5, 1.5, 0, 1)
          break
        case 'shell':
          this.shells.push(at, cam, 2, 2, 0, 1)
          break
        case 'flare': {
          // Size 15 once it turns into the slow falling light (after 20 frames).
          const s = p.age > 20 && p.vel.y < 0 && p.vel.x === 0 && p.vel.z === 0 ? 15 : 1
          this.flares.push(at, cam, s, s, 0, 1)
          break
        }
        case 'grenade':
          this.grenades.push(at, cam, 1, 1, 0, night ? 0x40 / 255 : 1)
          break
        case 'missile':
          this.model('missile', used.missile++, at, p)
          break
        case 'apcRocket':
        case 'rocket':
          this.model(p.kind === 'rocket' ? 'rocket' : 'missile', p.kind === 'rocket' ? used.rocket++ : used.missile++, at, p)
          this.flame(at, p, cam)
          break
        case 'bomb':
          this.model('bomb', used.bomb++, at, p)
          break
      }
    }
    for (const [k, list] of this.models) for (let i = used[k]; i < list.length; i++) list[i].visible = false
    for (const b of this.batches) b.end()
  }

  /** Rocket flame: first 5 ExplodeF frames looping from frame 2, 200 ahead of the pre-move position (80 behind). */
  private flame(at: THREE.Vector3, p: Projectile, cam: THREE.Quaternion) {
    _d.copy(p.vel).normalize()
    const pos = _d.multiplyScalar(-80).add(at)
    this.flames.push(pos, cam, 1, 1, (p.age + 1) % 5, 1)
  }

  private model(kind: keyof typeof MODEL, i: number, at: THREE.Vector3, p: Projectile) {
    const list = this.models.get(kind)!
    if (!list[i]) {
      const m = this.world.g3d.node(MODEL[kind]).clone(true)
      m.traverse((o) => (o.visible = true))
      this.group.add(m)
      list[i] = m
    }
    const m = list[i]
    m.visible = true
    m.position.copy(at)
    if (p.vel.lengthSq() > 1e-6) m.quaternion.copy(_q.setFromUnitVectors(NOSE, _d.copy(p.vel).normalize()))
  }
}
