import * as THREE from 'three/webgpu'
import type { GameFS } from '../../vfs'
import { decodeRaw24, rawScale } from '../../formats/raw24'
import { deg } from '../constants'
import type { Soldiers, World } from '../world'
import type { Projectile } from '../projectiles'

// The 96-soldier pool (objects 0x166-0x1c5 = Geometry.3D 358..453): walking, strafing, rifle and grenade
// attacks, burning and deaths from FUN_004051c8 (decomp L4894-6052), plus the hit handling that lives in
// FUN_004154b7: bullet ray kill (FUN_00424897), explosion kills (thrown) and the burn event (DAT_00447900).
// Frames index the two `Film` sheets of Geometry.3D concatenated (set 0 then set 1), 128x128 each.

const FIRST_ID = 358
const COUNT = 96
const FRAME = 128
const COLS = 16
const FIRES = 12
/** Burn effect billboard (Fire object 528): Vertices -140..140 x 0..360, drawn at scale 0.25 x 0.5. */
const FIRE_W = 140
const FIRE_H = 360
const FIRE_FRAMES = 38
const DAY_TINT = 0xd7d7d7
const NIGHT_TINT = 0x282828

interface Soldier {
  id: number
  node: THREE.Object3D
  uv: THREE.BufferAttribute
  shownFrame: number
  active: boolean
  state: number
  /** Sprite frame (u16 in the billboard table 0x45fc74). */
  frame: number
  counter: number
  x: number
  y: number
  z: number
  dirX: number
  dirZ: number
  speed: number
  /** Thrown (states >= 0x46) velocity. */
  vx: number
  vy: number
  vz: number
  yaw: number
  roll: number
  rollSpin: number
  /** State when shot (B+0x78), picks the death animation. */
  saved: number
  /** Burn effect slot (B+0x70). */
  fire: number
}

interface Fire {
  mesh: THREE.Mesh
  uv: THREE.BufferAttribute
  active: boolean
  frame: number
  sx: number
  sy: number
  x: number
  y: number
  z: number
}

const _v = new THREE.Vector3()

export class SoldierPool implements Soldiers {
  private list: Soldier[] = []
  private fires: Fire[] = []
  /** DAT_00447d20: next pool index, reset per level. */
  private next = 0
  private nextFire = 0
  /** Grenades live in an 8-slot ring (0x462ee0, DAT_00447870): a 9th throw replaces the oldest. */
  private grenades: (Projectile | null)[] = new Array(8).fill(null)
  private nextGrenade = 0
  private frameCount = 0
  private atlasW = COLS * FRAME
  private atlasH = FRAME
  private material = new THREE.MeshBasicNodeMaterial({ color: DAY_TINT, alphaTest: 0.5, side: THREE.DoubleSide })
  private fireMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide })
  private fireGroup = new THREE.Group()

  constructor(world: World, fs: GameFS) {
    this.material.visible = false
    const fm = this.fireMaterial
    fm.visible = false
    fm.transparent = true
    fm.depthWrite = false
    // Blend mode 5 as in g3dscene.ts.
    fm.blending = THREE.CustomBlending
    fm.blendEquation = THREE.AddEquation
    fm.blendSrc = THREE.OneFactor
    fm.blendDst = THREE.OneMinusSrcColorFactor
    this.fireGroup.name = 'soldier-fires'
    world.g3d.root.add(this.fireGroup)

    for (let i = 0; i < COUNT; i++) {
      const node = world.g3d.node(FIRST_ID + i)
      // The Geometry.3D quad samples a runtime texture slot (85 + i) that we do not have: replace it.
      for (const c of node.children) c.visible = false
      const { mesh, uv } = quad(-64, 64, 0, 127, this.material)
      node.add(mesh)
      node.visible = false
      this.list.push({
        id: FIRST_ID + i, node, uv, shownFrame: -1, active: false, state: 0, frame: 0, counter: 0,
        x: 0, y: 0, z: 0, dirX: 0, dirZ: 0, speed: 0, vx: 0, vy: 0, vz: 0, yaw: 0, roll: 0, rollSpin: 0, saved: 0, fire: -1,
      })
    }
    for (let i = 0; i < FIRES; i++) {
      const { mesh, uv } = quad(-FIRE_W, FIRE_W, 0, FIRE_H, this.fireMaterial)
      mesh.renderOrder = 1
      mesh.visible = false
      this.fireGroup.add(mesh)
      this.fires.push({ mesh, uv, active: false, frame: 0, sx: 0.25, sy: 0.5, x: 0, y: 0, z: 0 })
    }
    void this.load(world, fs)
  }

  private async load(world: World, fs: GameFS) {
    const films = world.g3d.geo.animations.filter((a) => a.kind === 'Film').sort((a, b) => a.set - b.set)
    const files = await Promise.all(films.map((f) => fs.read(`BH2Game/${f.file}`)))
    this.frameCount = films.reduce((n, f) => n + f.frameCount, 0)
    this.atlasH = Math.ceil(this.frameCount / COLS) * FRAME
    // Higher-resolution copies (every dimension, including the unused rows of each frame, times an integer)
    // fill a proportionally larger atlas; UVs stay in atlasW/atlasH units.
    const scales = films.map((film, k) => rawScale(files[k].byteLength, film.width * film.rowsPerFrameInFile * film.frameCount * 3))
    const K = Math.min(...scales), C = FRAME * K
    const W = this.atlasW * K, H = this.atlasH * K
    const rgba = new Uint8Array(W * H * 4)
    let f = 0
    films.forEach((film, k) => {
      const fk = scales[k], step = fk / K
      const data = files[k], rowBytes = film.width * fk * 3, frameBytes = rowBytes * film.rowsPerFrameInFile * fk
      for (let i = 0; i < film.frameCount; i++, f++) {
        const ox = (f % COLS) * C, oy = Math.floor(f / COLS) * C
        // Only the first `height` rows of each frame are uploaded (Film keyword).
        for (let y = 0; y < film.height * K; y++) {
          for (let x = 0; x < film.width * K; x++) {
            const s = i * frameBytes + y * step * rowBytes + x * step * 3, d = ((oy + y) * W + ox + x) * 4
            const r = data[s], g = data[s + 1], b = data[s + 2]
            rgba[d] = r
            rgba[d + 1] = g
            rgba[d + 2] = b
            // Colour key black after the 24 -> 16-bit conversion (RGB565), as the 16-bit surface sees it.
            rgba[d + 3] = r < 8 && g < 4 && b < 8 ? 0 : 255
          }
        }
      }
    })
    this.material.map = pointTexture(rgba, W, H, THREE.NearestFilter)
    this.material.visible = true
    this.material.needsUpdate = true
    for (const s of this.list) s.shownFrame = -1

    const fire = world.g3d.geo.animations.find((a) => a.kind === 'Animated' && a.set === 3)
    if (!fire) return
    const { width: fw, height: fh, rgb: img } = decodeRaw24(fire.file, await fs.read(`BH2Game/${fire.file}`), fire.width, fire.height * fire.frameCount)
    const frgba = new Uint8Array(fw * fh * 4)
    for (let i = 0, j = 0; i < fw * fh * 3; i += 3, j += 4) {
      frgba[j] = img[i]
      frgba[j + 1] = img[i + 1]
      frgba[j + 2] = img[i + 2]
      frgba[j + 3] = 255
    }
    this.fireMaterial.map = pointTexture(frgba, fw, fh, THREE.LinearFilter)
    this.fireMaterial.visible = true
    this.fireMaterial.needsUpdate = true
  }

  reset() {
    this.next = 0
    this.nextFire = 0
    this.grenades.fill(null)
    this.nextGrenade = 0
    for (const s of this.list) {
      s.active = false
      s.node.visible = false
      s.fire = -1
    }
    for (const f of this.fires) {
      f.active = false
      f.mesh.visible = false
    }
  }

  /** Allocate like DAT_00447d20 (sequential, never wraps in the original). */
  private alloc(): Soldier | null {
    if (this.next < COUNT) return this.list[this.next++]
    // Deviation: BH2.exe would run past the pool into the crate objects; reuse a free slot instead. Corpses (state 0)
    // stay active until the player looks up (> 20 deg pitch), so after 96 spawns the pool is usually full of them:
    // reuse a corpse too, otherwise every later soldier is dropped and the enemy meter can never reach 0.
    return this.list.find((s) => !s.active) ?? this.list.find((s) => s.state === 0) ?? null
  }

  /**
   * APC/CH53 troops pass `stagger` (the exit counter, offset - 130 for APCs): state 9, speed 6, then a 2.4/frame drop.
   * Paratroopers pass `paratrooper`: above ground they descend at 10/frame (frame 0xe6), then play the landing frames.
   * Without options the soldier starts walking on the ground (state 0x11).
   */
  spawn(world: World, p: THREE.Vector3, yaw: number, opts: { paratrooper?: boolean; stagger?: number } = {}) {
    const s = this.alloc()
    if (!s) {
      // All 96 alive: BH2.exe would write past the pool and the soldier would never be simulated, leaving the enemy
      // meter stuck above 0. Deviation: count him as gone so the level stays winnable.
      world.reduceEnemyMeter(1)
      return -1
    }
    s.active = true
    s.x = p.x
    s.y = p.y
    s.z = p.z
    s.dirX = -Math.sin(yaw * deg)
    s.dirZ = -Math.cos(yaw * deg)
    s.yaw = world.player.yaw
    s.roll = 0
    s.rollSpin = 0
    s.fire = -1
    s.counter = 0
    if (opts.paratrooper) {
      s.state = p.y > world.groundY(p.x, p.z) ? 1 : 2
      s.frame = 0xe6
      s.speed = 0
    } else if (opts.stagger !== undefined) {
      s.state = 9
      s.counter = opts.stagger
      s.frame = 0x57
      s.speed = 6
    } else {
      s.state = 0x11
      s.frame = 0x57
      s.speed = 4
    }
    return this.list.indexOf(s)
  }

  /** Only a soldier still hanging under his chute (state 1): ids are reused once a soldier dies. */
  remove(_world: World, id: number) {
    const s = this.list[id]
    if (s?.active && s.state === 1) s.active = false
  }

  /** FUN_00424897 plus the bullet kill in FUN_004154b7. Any soldier with state > 1 stops the bullet. */
  rayKill(world: World, origin: THREE.Vector3, dir: THREE.Vector3, length: number) {
    const yaw = Math.atan2(-dir.x, -dir.z), pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1))
    const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch)
    for (const s of this.list) {
      if (!s.active || s.state <= 1) continue
      const rx = s.x - origin.x, ry = s.y - origin.y, rz = s.z - origin.z
      const along = rx * dir.x + ry * dir.y + rz * dir.z
      const lateral = rx * cy - rz * sy
      const up = rx * sy * sp + ry * cp + rz * cy * sp
      // The ray must pass 10..130 above the feet, within 30 sideways.
      if (Math.abs(lateral) >= 30 || along <= 0 || along >= length || up >= -10 || up <= -130) continue
      if (s.state < 0x2a) {
        s.saved = s.state
        s.state = 0x3c
        world.reduceEnemyMeter(1)
        world.effects.spawn('blood', origin.clone())
        if (world.sound.enabled) {
          const r = world.rand() >> 12
          if (r === 0 || r === 2 || r === 4 || r === 6) world.sound.play(`Soldead${r / 2 + 1}`)
        }
      }
      return true
    }
    return false
  }

  /** Shell/missile (400) and bomb/rocket (500) ground blasts. blown = thrown into the air as in the original. */
  killWithin(world: World, p: THREE.Vector3, radius: number, blown: boolean) {
    for (const s of this.list) {
      if (!s.active || s.state <= 1 || s.state >= 0x2a) continue
      const dx = s.x - p.x, dz = s.z - p.z
      if (Math.hypot(dx, dz) >= radius) continue
      world.reduceEnemyMeter(1)
      if (!blown) {
        s.saved = s.state
        s.state = 0x3c
        continue
      }
      s.vx = dx * 0.05
      s.vz = dz * 0.05
      s.vy = world.rand() * 0.0005 + 20
      s.roll = 0
      s.rollSpin = (world.rand() - 16384) * 0.0005
      const r = world.rand() >> 12
      ;[s.frame, s.state] = r < 2 ? [0x8a, 0x46] : r < 4 ? [0x92, 0x47] : r < 6 ? [0x9a, 0x48] : r === 6 ? [0xde, 0x49] : [0x10e, 0x4a]
    }
  }

  /** Burn event (DAT_00447900): APC destroyed, CH53 killed while landed, aircraft fire events. Radius 600 in the original. */
  burnWithin(world: World, p: THREE.Vector3, radius = 600) {
    for (const s of this.list) {
      if (!s.active || s.state <= 0 || s.state >= 0x2a) continue
      if (Math.hypot(s.x - p.x, s.z - p.z) >= radius) continue
      if (s.state === 0x1e || s.state === 0x26) {
        s.active = false
        world.reduceEnemyMeter(1)
        continue
      }
      const k = this.nextFire
      this.nextFire = (k + 1) % FIRES
      const f = this.fires[k]
      f.active = true
      f.sx = 0.25
      f.sy = 0.5
      f.frame = world.rand() >> 10
      s.fire = k
      const st = s.state
      s.state = st < 0x15 || st > 0x1a ? 0x38 : st === 0x15 || st === 0x17 || st === 0x19 ? 0x32 : 0x35
    }
  }

  update(world: World) {
    this.material.color.setHex(world.daytime ? DAY_TINT : NIGHT_TINT)
    for (const s of this.list) {
      if (!s.active) continue
      this.think(world, s)
      if (s.state > 1 && s.state < 0x46) {
        s.x += s.dirX * s.speed
        s.z += s.dirZ * s.speed
        s.yaw = world.player.yaw
        if (s.state > 0x10) s.y = world.groundY(s.x, s.z)
        if (s.state > 0x31 && s.state < 0x3c && s.fire >= 0) {
          const f = this.fires[s.fire]
          f.x = s.x < 0 ? s.x + 5 : s.x - 5
          f.z = s.z < 0 ? s.z + 5 : s.z - 5
          if (s.state !== 0x34 && s.state !== 0x37 && s.state !== 0x3a && s.state !== 0x3b) f.y = s.y + 60
        }
      }
      if (s.state > 0x45) {
        if (s.y >= 0) {
          s.vx *= 0.98
          s.vz *= 0.98
          s.vy -= 2
          s.x += s.vx
          s.y += s.vy
          s.z += s.vz
        } else s.active = false
      }
      s.roll += s.rollSpin
    }
    for (const f of this.fires) if (f.active) f.frame = (f.frame + 1) % FIRE_FRAMES
    this.pose(world)
  }

  private think(w: World, s: Soldier) {
    switch (s.state) {
      case 0:
        // Corpse: removed once the player looks up more than 20 degrees (original culling quirk).
        if (w.player.pitch > 20) s.active = false
        break
      case 1:
        // Paratrooper still under the chute (the parachute falls 10/frame; the soldier hangs below it).
        s.frame = 0xe6
        s.y -= 10
        if (s.y < w.groundY(s.x, s.z)) {
          s.y = w.groundY(s.x, s.z)
          s.state = 2
        }
        break
      case 2:
        if (++s.frame > 0xef) this.walk(s)
        break
      case 5:
      case 9:
        // Leaving a CH53 (5) or APC (9): stagger counter, then drop to the ground.
        s.frame = 0x57
        if (s.counter < 6) s.counter += 6
        else {
          s.y -= s.state === 5 ? 2.6 : 2.4
          if (s.y < w.groundY(s.x, s.z)) s.state = 0x11
        }
        break
      case 0x11: {
        const near = Math.hypot(s.x, s.z) < 2500
        const tx = near ? 0 : (w.rand() >> 3) - 2048
        const tz = near ? 0 : (w.rand() >> 3) - 2048
        const dx = tx - s.x, dz = tz - s.z, d = Math.hypot(dx, dz) || 1
        s.dirX = dx / d
        s.dirZ = dz / d
        s.speed = 4
        s.state = 0x13
        if (Math.abs(s.x) > 2500 || Math.abs(s.z) > 2500) s.state = 0x12
        if (Math.abs(s.x) < 1200 && Math.abs(s.z) < 1200) s.state = 0x14
        this.walkFrame(s)
        break
      }
      case 0x12:
        if (Math.abs(s.x) < 2500 && Math.abs(s.z) < 2500) s.state = 0x11
        this.walkFrame(s)
        break
      case 0x13:
        this.walkFrame(s)
        if (Math.abs(s.x) >= 1200 || Math.abs(s.z) >= 1200) {
          const r = w.rand() >> 11
          if (s.frame === 0x58) {
            if (r === 2) this.go(s, 0xe, 0x15)
            if (r === 4) this.go(s, 1, 0x16)
            if (r === 6) this.go(s, 0x7d, 0x1d, 0)
          }
        } else s.state = 0x11
        break
      case 0x14:
        this.walkFrame(s)
        if (Math.hypot(s.x, s.z) >= 700) {
          const r = w.rand() >> 11
          if (s.frame === 0x58) {
            if (r === 1) this.go(s, 0xe, 0x15)
            if (r === 3) this.go(s, 1, 0x16)
            if (r === 5) this.go(s, 0x7d, 0x1d, 0)
            if (r === 9) this.go(s, 0x76, 0x20, 0)
            if (r === 13) this.go(s, 0x5d, 0x23, 0)
          }
        } else {
          s.speed = 0
          s.state = 0x24
        }
        break
      case 0x15:
        if (++s.frame > 0x13) {
          if (w.rand() < 10000) this.go(s, 0x33, 0x17)
          else this.go(s, 0x1b, 0x19, 8)
        }
        break
      case 0x16:
        if (++s.frame > 6) {
          if (w.rand() < 10000) this.go(s, 0x41, 0x18)
          else this.go(s, 0x27, 0x1a, 8)
        }
        break
      case 0x17:
        // Strafe around the bunker (tangent directions), then stop.
        this.circle(s, 1)
        if (s.frame === 0x40 && w.rand() > 28000) this.go(s, 0x15, 0x1b)
        else if (++s.frame > 0x40) s.frame = 0x33
        break
      case 0x18:
        this.circle(s, -1)
        if (s.frame === 0x4e && w.rand() > 28000) this.go(s, 8, 0x1c)
        else if (++s.frame > 0x4e) s.frame = 0x41
        break
      case 0x19:
        // Run around the bunker.
        this.circle(s, 1)
        if (s.frame === 0x1e && w.rand() > 28000) this.go(s, 0x15, 0x1b, 4)
        else if (++s.frame > 0x26) s.frame = 0x1b
        break
      case 0x1a:
        this.circle(s, -1)
        if (s.frame === 0x2f && w.rand() > 28000) this.go(s, 8, 0x1c, 4)
        else if (++s.frame > 0x32) s.frame = 0x27
        break
      case 0x1b:
        if (++s.frame > 0x1a) this.walk(s)
        break
      case 0x1c:
        if (++s.frame > 0xd) this.walk(s)
        break
      case 0x1d:
      case 0x25:
        // Stand up to fire (0x1d once, 0x25 near the bunker).
        if (++s.frame === 0x89) {
          s.counter = 60
          s.state++
        }
        break
      case 0x20:
      case 0x27:
        // Kneel to fire.
        if (++s.frame === 0x7c) {
          s.counter = 60
          s.state++
        }
        break
      case 0x1e:
      case 0x21:
        if (--s.counter === 15) this.shoot(w, s, s.state === 0x1e ? 80 : 100)
        if (s.counter === 0) s.state++
        break
      case 0x26:
      case 0x28:
        // Near the bunker: fire forever, a shot every 30..61 frames.
        if (--s.counter === 15) this.shoot(w, s, s.state === 0x26 ? 80 : 100)
        if (s.counter === 0) s.counter = (w.rand() >> 10) + 30
        break
      case 0x1f:
        if (--s.frame < 0x7d) this.walk(s)
        break
      case 0x22:
        if (--s.frame < 0x76) this.walk(s)
        break
      case 0x23:
        if (++s.frame > 0x75) this.walk(s)
        if (s.frame === 0x6b) this.grenade(w, s, 40)
        break
      case 0x24:
        if (s.frame === 0x58) {
          const r = w.rand() >> 13
          s.speed = 0
          if (r === 0) this.go(s, 0x7d, 0x25)
          if (r === 1 || r === 2) this.go(s, 0x76, 0x27)
          if (r === 3) {
            this.go(s, 0x5d, 0x29)
            s.counter = 90
          }
        }
        if (s.state === 0x24) this.walkFrame(s)
        break
      case 0x29:
        if (--s.counter < 1) {
          if (++s.frame > 0x75) {
            s.frame = 0x5d
            s.counter = 90
          }
          if (s.frame === 0x6b) this.grenade(w, s, -1)
        }
        break
      // Burning: run (0x32/0x35) or flail (0x38), collapse, then the fire dies down.
      case 0x32:
        this.go(s, 0x1b, 0x33, 8)
        s.counter = (w.rand() >> 12) + 4
        break
      case 0x33:
        this.circle(s, 1)
        if (++s.frame === 0x26 && --s.counter === 0) this.go(s, 0xf0, 0x34, 0)
        if (s.frame > 0x26 && s.frame !== 0xf0) s.frame = 0x1b
        break
      case 0x35:
        this.go(s, 0x27, 0x36, 8)
        s.counter = (w.rand() >> 12) + 6
        break
      case 0x36:
        this.circle(s, -1)
        if (++s.frame === 0x32 && --s.counter === 0) this.go(s, 0xff, 0x37, 0)
        if (s.frame > 0x32 && s.frame !== 0xff) s.frame = 0x27
        break
      case 0x38:
        this.go(s, (w.rand() >> 11) + 0x113, 0x39, 0)
        s.counter = (w.rand() >> 12) + 4
        break
      case 0x39:
        if (++s.frame === 0x121 && --s.counter === 0) s.state = 0x3a
        if (s.frame > 0x121) s.frame = 0x117
        break
      case 0x34:
      case 0x37:
      case 0x3a: {
        const end = s.state === 0x34 ? 0xfe : s.state === 0x37 ? 0x10d : 0x131
        if (++s.frame === end) {
          w.reduceEnemyMeter(1)
          s.state = 0x3b
        }
        if (s.fire >= 0) this.fires[s.fire].y -= end === 0x131 ? 4.375 : 4.65
        break
      }
      case 0x3b: {
        const f = s.fire >= 0 ? this.fires[s.fire] : null
        if (f) f.sy -= 0.01
        if (!f || f.sy < 0.02) {
          if (f) f.active = false
          s.state = 0
        }
        break
      }
      case 0x3c: {
        // Shot: death animation by what the soldier was doing.
        s.speed = 0
        const o = s.saved
        if (o === 0x17 || o === 0x19) this.go(s, 0xf0, 0x41)
        if (o === 0x18 || o === 0x1a) this.go(s, 0xff, 0x42)
        if (o === 0x1e || o === 0x26) this.go(s, 0xcf, 0x40)
        else if (o < 0x17 || o > 0x1a) {
          const r = w.rand() >> 13
          if (r < 2) this.go(s, 0xa2, 0x3d)
          if (r === 2) this.go(s, 0xb1, 0x3e)
          if (r > 2) this.go(s, 0xc0, 0x3f)
        }
        break
      }
      case 0x3d:
      case 0x3e:
      case 0x3f:
      case 0x40:
      case 0x41:
      case 0x42:
        if (++s.frame === DEATH_END[s.state - 0x3d]) s.state = 0
        break
      case 0x46:
      case 0x47:
      case 0x48:
      case 0x49:
      case 0x4a:
        s.frame = Math.min(s.frame + 1, BLOWN_END[s.state - 0x46])
        break
    }
  }

  private go(s: Soldier, frame: number, state: number, speed?: number) {
    s.frame = frame
    s.state = state
    if (speed !== undefined) s.speed = speed
  }

  private walk(s: Soldier) {
    s.frame = 0x57
    s.state = 0x11
  }

  private walkFrame(s: Soldier) {
    if (++s.frame > 0x5c) s.frame = 0x4f
  }

  /** Tangent to the circle around the bunker: sense 1 = (-z, x)/r, -1 = (z, -x)/r. */
  private circle(s: Soldier, sense: 1 | -1) {
    const r = Math.hypot(s.x, s.z) || 1
    s.dirX = (-s.z / r) * sense
    s.dirZ = (s.x / r) * sense
  }

  private shoot(w: World, s: Soldier, height: number) {
    const d = Math.hypot(s.x, s.z) || 1
    w.effects.spawn('explodeF', new THREE.Vector3(s.x - (s.x * 20) / d, s.y + height, s.z - (s.z * 20) / d), { scale: 0.3 })
    w.sound.play('Rifle')
    if (w.rand() > 24000) w.damagePlayer(1)
  }

  /** Thrown at a point around (0, 1024..2047, 0). speed < 0: the near-bunker loop's (rand>>11)+20. */
  private grenade(w: World, s: Soldier, speed: number) {
    const tx = (w.rand() >> 6) - 256 - s.x
    const ty = (w.rand() >> 5) + 1024 - s.y
    const tz = (w.rand() >> 6) - 256 - s.z
    const v = speed < 0 ? (w.rand() >> 11) + 20 : speed
    const k = v / (Math.hypot(tx, ty, tz) || 1)
    const old = this.grenades[this.nextGrenade]
    if (old) old.dead = true
    this.grenades[this.nextGrenade] = w.projectiles.fire('grenade', _v.set(s.x, s.y + 120, s.z), new THREE.Vector3(tx * k, ty * k, tz * k))
    this.nextGrenade = (this.nextGrenade + 1) & 7
  }

  private pose(w: World) {
    const max = Math.max(0, this.frameCount - 1)
    for (const s of this.list) {
      s.node.visible = s.active
      if (!s.active) continue
      s.node.position.set(s.x, s.y, s.z)
      s.node.rotation.set(0, s.yaw * deg, s.roll * deg)
      const f = Math.min(s.frame, max)
      if (f !== s.shownFrame && this.material.map) {
        s.shownFrame = f
        const u0 = ((f % COLS) * FRAME) / this.atlasW, v0 = (Math.floor(f / COLS) * FRAME) / this.atlasH
        setQuadUV(s.uv, u0, v0, u0 + FRAME / this.atlasW, v0 + FRAME / this.atlasH)
      }
    }
    for (const f of this.fires) {
      f.mesh.visible = f.active
      if (!f.active) continue
      f.mesh.position.set(f.x, f.y, f.z)
      f.mesh.rotation.set(0, w.player.yaw * deg, 0)
      f.mesh.scale.set(f.sx, Math.max(f.sy, 0.001), 1)
      const v0 = f.frame / FIRE_FRAMES
      setQuadUV(f.uv, 0, v0, 1, v0 + 1 / FIRE_FRAMES)
    }
  }
}

/** Last frame of the shot deaths 0x3d..0x42. */
const DEATH_END = [0xb0, 0xbf, 0xce, 0xdd, 0xfe, 0x10d]
/** Frame the thrown deaths 0x46..0x4a hold. */
const BLOWN_END = [0x91, 0x99, 0xa1, 0xe5, 0x112]

/** Upright quad facing +Z with a per-instance UV buffer (top-left, bottom-left, bottom-right, top-right). */
function quad(x0: number, x1: number, y0: number, y1: number, material: THREE.Material) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x0, y1, 0, x0, y0, 0, x1, y0, 0, x1, y1, 0]), 3))
  const uv = new THREE.BufferAttribute(new Float32Array(8), 2)
  uv.setUsage(THREE.DynamicDrawUsage)
  g.setAttribute('uv', uv)
  g.setIndex([0, 1, 2, 0, 2, 3])
  g.computeBoundingSphere()
  const mesh = new THREE.Mesh(g, material)
  return { mesh, uv }
}

function setQuadUV(uv: THREE.BufferAttribute, u0: number, v0: number, u1: number, v1: number) {
  uv.setXY(0, u0, v0)
  uv.setXY(1, u0, v1)
  uv.setXY(2, u1, v1)
  uv.setXY(3, u1, v0)
  uv.needsUpdate = true
}

function pointTexture(rgba: Uint8Array, w: number, h: number, filter: THREE.MagnificationTextureFilter) {
  const tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat)
  tex.colorSpace = THREE.NoColorSpace
  tex.magFilter = filter
  tex.minFilter = filter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}
