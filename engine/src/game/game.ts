import * as THREE from 'three/webgpu'
import type { GameFS } from '../vfs'
import { levelFileName, parseLevel, type LevelUnit } from '../formats/level'
import { CAMERA, EYE, FRAME_MS, HANDGUN_ROUNDS, OBJ, OUTCOME_FRAMES, deg } from './constants'
import { Input } from './input'
import { Player } from './player'
import { Projectiles } from './projectiles'
import type { World } from './world'

// Runs one game: level loading/reset (FUN_00429201), the per-frame order of WinMain, spawn countdowns
// (FUN_004050f1), win/lose (FUN_004021c4), and a fixed 29 ms simulation with interpolated rendering.

interface Pending {
  slot: number
  unit: LevelUnit
  counter: number
}

interface NodeState {
  p: THREE.Vector3
  q: THREE.Quaternion
}

export interface GameEvents {
  /** Shield reached 0 and the 150-frame banner finished. */
  onGameOver?(level: number): void
  /** ESC. */
  onQuit?(level: number): void
}

export class Game {
  readonly world: World
  readonly input: Input
  readonly player: Player
  readonly camera: THREE.PerspectiveCamera
  private fs: GameFS
  private levels = new Map<number, string>()
  private pending: Pending[] = []
  private acc = 0
  private last = 0
  private prev = new Map<THREE.Object3D, NodeState>()
  private cur = new Map<THREE.Object3D, NodeState>()
  private prevAim = { yaw: 0, pitch: 0, shake: 0 }
  events: GameEvents = {}
  /** Systems updated after projectiles each frame (effects, HUD). */
  late: { update(w: World): void }[] = []

  constructor(world: World, fs: GameFS, canvas: HTMLElement) {
    this.world = world
    this.fs = fs
    this.input = new Input(canvas)
    this.player = new Player(this.input)
    world.projectiles = new Projectiles()
    this.camera = new THREE.PerspectiveCamera(CAMERA.vfov, 4 / 3, CAMERA.near, CAMERA.far * 2)
  }

  async preload() {
    await Promise.all(
      Array.from({ length: 99 }, (_, i) => i + 1).map(async (n) => {
        const path = `BH2Game/${levelFileName(n)}`
        if (this.fs.has(path)) this.levels.set(n, await this.fs.text(path))
      }),
    )
  }

  /** Full per-level reset, like FUN_00429201. */
  startLevel(n: number) {
    const w = this.world
    // Above 99 the original loads Level_(n%10 + 91), so 109, 119, ... ask for the missing Level_100 and crash.
    // Deliberate deviation: those levels play Level_99 instead.
    const file = n > 99 ? (n % 10) + 91 : n
    const text = this.levels.get(file) ?? (file === 100 ? this.levels.get(99) : undefined)
    if (!text) throw new Error(`Level ${n} not found`)
    const level = parseLevel(text)
    w.levelNumber = n
    w.level = level
    w.frame = 0
    w.daytime = level.daytime
    if (level.ammo) {
      w.player.ammo.bullets = level.ammo.bullets
      w.player.ammo.cannon = level.ammo.projectiles
      w.player.ammo.missiles = level.ammo.missiles
      w.player.ammo.flares = level.ammo.flares
    }
    w.player.ammo.handgun = HANDGUN_ROUNDS
    if (level.aggression) w.aggression = { ...level.aggression }
    w.player.shield = 100
    w.player.shake = 0
    w.player.ammoOutCounter = 150
    w.player.bombersAvailable = level.bombers
    w.enemyMeter = w.enemyMeterInitial = level.killQuota
    w.outcome = 'playing'
    w.outcomeTimer = 0
    w.projectiles.reset()
    w.effects.reset(w)
    w.targets = []
    for (const s of w.enemies) s.reset(w)
    this.applyDayNight()
    this.player.reset(w)

    this.pending = []
    for (const g of level.groups) {
      for (const unit of g.units) {
        if (!unit.spawns) continue
        if (unit.delay === null) this.spawn(unit.slot, unit)
        else this.pending.push({ slot: unit.slot, unit, counter: unit.delay })
      }
    }
    this.snapshot(true)
  }

  private spawn(slot: number, unit: LevelUnit) {
    const type = unit.slotType
    if (!type) return
    this.world.enemySystem(type)?.spawn(this.world, slot, unit)
  }

  private applyDayNight() {
    const w = this.world, g = w.g3d, day = w.daytime
    g.node(OBJ.skyDay).visible = day
    g.node(OBJ.skyNight).visible = !day
    g.node(OBJ.foliageDay).visible = day
    g.node(OBJ.foliageNight).visible = !day
    g.node(OBJ.crosshair).visible = w.level.crosshair
    this.onDayNight?.(day)
  }

  /** Hook for the renderer to switch lighting. */
  onDayNight?: (day: boolean) => void

  /** One 29 ms game frame in WinMain order. */
  step() {
    const w = this.world
    const keys = this.input.takeKeys()
    for (const k of keys) {
      if (k === 'p') w.paused = !w.paused
      if (k === 's') {
        w.sound.enabled = !w.sound.enabled
        if (!w.sound.enabled) w.sound.stopAll()
      }
      if (k === 'Escape') this.events.onQuit?.(w.levelNumber)
    }
    if (w.paused) return
    this.player.keys(w, keys)
    this.player.update(w)
    for (const s of w.enemies) s.update(w)
    w.g3d.root.updateMatrixWorld()
    w.projectiles.update(w)
    w.effects.update(w)
    for (const s of this.late) s.update(w)
    this.outcome()
    w.sound.update(w)
    for (const p of this.pending) {
      if (p.counter > 0 && --p.counter === 0) this.spawn(p.slot, p.unit)
    }
    this.pending = this.pending.filter((p) => p.counter > 0)
    w.frame++
  }

  private outcome() {
    const w = this.world
    if (w.outcome === 'playing') {
      if (w.player.godMode) w.player.shield = 100
      if (w.player.shield < 1) w.outcome = 'destroyed'
      else if (w.enemyMeter < 0.0001) w.outcome = 'cleared'
      return
    }
    if (++w.outcomeTimer < OUTCOME_FRAMES) return
    if (w.outcome === 'cleared') this.startLevel(w.levelNumber + 1)
    else {
      w.outcome = 'playing'
      w.paused = true
      this.events.onGameOver?.(w.levelNumber)
    }
  }

  /** Advance the simulation by real time and pose the scene for rendering at the interpolated moment. */
  frame(now: number) {
    if (!this.last) this.last = now
    this.acc = Math.min(this.acc + (now - this.last), FRAME_MS * 8)
    this.last = now
    while (this.acc >= FRAME_MS) {
      this.acc -= FRAME_MS
      this.restore()
      this.step()
      this.snapshot(false)
    }
    this.interpolate(this.acc / FRAME_MS)
  }

  private capture(map: Map<THREE.Object3D, NodeState>) {
    this.world.g3d.root.traverse((o) => {
      let s = map.get(o)
      if (!s) map.set(o, (s = { p: new THREE.Vector3(), q: new THREE.Quaternion() }))
      s.p.copy(o.position)
      s.q.copy(o.quaternion)
    })
  }

  private snapshot(reset: boolean) {
    const p = this.world.player
    ;[this.prev, this.cur] = [this.cur, this.prev]
    this.capture(this.cur)
    if (reset) this.capture(this.prev)
    this.prevAim = reset ? { yaw: p.yaw, pitch: p.pitch, shake: p.shake } : this.aim
    this.aim = { yaw: p.yaw, pitch: p.pitch, shake: p.shake }
  }
  private aim = { yaw: 0, pitch: 0, shake: 0 }

  /** Undo interpolation so the simulation continues from exact tick state. */
  private restore() {
    for (const [o, s] of this.cur) {
      o.position.copy(s.p)
      o.quaternion.copy(s.q)
    }
  }

  private interpolate(a: number) {
    for (const [o, c] of this.cur) {
      const p = this.prev.get(o)
      if (!p || p.p.distanceToSquared(c.p) > 4000 * 4000) continue
      o.position.lerpVectors(p.p, c.p, a)
      o.quaternion.slerpQuaternions(p.q, c.q, a)
    }
    let dyaw = this.aim.yaw - this.prevAim.yaw
    if (dyaw > 180) dyaw -= 360
    if (dyaw < -180) dyaw += 360
    const yaw = this.prevAim.yaw + dyaw * a + this.aim.shake
    const pitch = this.prevAim.pitch + (this.aim.pitch - this.prevAim.pitch) * a
    this.camera.position.set(EYE.x, EYE.y, EYE.z)
    this.camera.rotation.set(pitch * deg, yaw * deg, 0, 'YXZ')
    // Keep the weapon mount in step with the interpolated view.
    this.world.g3d.node(OBJ.mount).rotation.set(pitch * deg, yaw * deg, 0, 'YXZ')
    this.alpha = a
  }

  /** Interpolation factor of the last rendered frame (0..1), for effects that interpolate themselves. */
  alpha = 0
}
