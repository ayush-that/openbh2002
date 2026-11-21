import * as THREE from 'three/webgpu'
import type { G3DScene } from '../render/g3dscene'
import type { Terrain } from '../world/terrain'
import type { LevelScript, LevelUnit, ObjectType } from '../formats/level'
import type { ShapeData } from '../formats/shapedata'
import { Rng } from './rng'
import { CAPS, HANDGUN_ROUNDS, START_YAW, type ShapeKind } from './constants'
import type { Collision } from './collision'
import type { Projectiles } from './projectiles'

// Shared game state and the interfaces subsystems implement. One World per running game.

export type Weapon = 0 | 1 | 2 // main gun, cannon, handgun

export interface Ammo {
  bullets: number
  cannon: number
  missiles: number
  flares: number
  handgun: number
}

export class PlayerState {
  shield = 100
  yaw = START_YAW
  pitch = 0
  weapon: Weapon = 0
  ammo: Ammo = { bullets: 0, cannon: 0, missiles: 0, flares: 0, handgun: HANDGUN_ROUNDS }
  /** BeachheadIn line 3 ("a" key): 0 linear yaw rate, 1 quadratic. */
  mouseTight = false
  /** BeachheadIn line 4 ("i"/"r" keys). */
  mouseReverse = false
  infiniteAmmo = false
  godMode = false
  /** Yaw offset in degrees from heavy hits; decays x -0.85 per frame. */
  shake = 0
  bombersAvailable = false
  /** Frames left before ammo-out loss; reset to 150 by any prize. */
  ammoOutCounter = 150
}

/** Anything a projectile can hit with a ShapeData ray test. Registered by enemy systems. */
export interface Target {
  slot: number
  shape: ShapeKind
  node: THREE.Object3D
  /** Ray tests only consider live targets. */
  alive(): boolean
  /**
   * zone: ShapeData part index hit (0 vital, 1 -2 HP, 2 -1 HP for bullets).
   * weapon: what hit it. Cannon shells and missiles destroy any vehicle.
   */
  hit(world: World, zone: number, weapon: 'bullet' | 'shell' | 'missile', point: THREE.Vector3): void
}

/** Soldier pool, implemented by the ground AI. */
export interface Soldiers {
  /** Ray vs soldiers (FUN_00424897). Returns true and kills the first soldier hit. */
  rayKill(world: World, origin: THREE.Vector3, dir: THREE.Vector3, length: number): boolean
  /** Kill soldiers within radius (horizontal) of p. blown: thrown into the air (bombs, rockets). */
  killWithin(world: World, p: THREE.Vector3, radius: number, blown: boolean): void
  /** Spawn a ground soldier or paratrooper. */
  spawn(world: World, p: THREE.Vector3, yaw: number, opts?: { paratrooper?: boolean; stagger?: number }): void
}

export type EffectKind =
  | 'explodeV' // ground explosion, multiply, bottom anchored
  | 'explodeF' // hit flash / muzzle flash, screen
  | 'explodeA' // aircraft kill, screen
  | 'fire' // burning loop
  | 'dirt' // bullet ground hit
  | 'blood'
  | 'smokeWhite'
  | 'smokeBlack'

export interface Effects {
  spawn(kind: EffectKind, p: THREE.Vector3, opts?: { scale?: number; velocity?: THREE.Vector3; frames?: number }): void
  /** Tracer/shell/flare billboards follow projectiles; called by the projectile system each frame. */
  update(world: World): void
  reset(world: World): void
}

export interface Sound {
  /** volumeDb: DirectSound hundredths of dB (0 = full, negative quieter), as in the original. */
  play(name: string, opts?: { volumeDb?: number }): void
  /** Engine loops (FUN_00424aef): called once per frame. */
  update(world: World): void
  stopAll(): void
  enabled: boolean
}

/** An enemy AI module owns a set of object types. */
export interface EnemySystem {
  types: readonly ObjectType[]
  /** Hide and reset all slots for a new level. */
  reset(world: World): void
  /** Activate a slot (its Delay elapsed, or present at start). */
  spawn(world: World, slot: number, unit: LevelUnit): void
  /** One game frame. */
  update(world: World): void
}

export type Outcome = 'playing' | 'cleared' | 'destroyed'

export interface WorldDeps {
  g3d: G3DScene
  terrain: Terrain
  mmap: Uint8Array
  shapes: ShapeData
  collision: Collision
}

const noopSound: Sound = { play() {}, update() {}, stopAll() {}, enabled: true }
const noopEffects: Effects = { spawn() {}, update() {}, reset() {} }
const noopSoldiers: Soldiers = { rayKill: () => false, killWithin() {}, spawn() {} }

export class World {
  frame = 0
  rng = new Rng()
  player = new PlayerState()
  levelNumber = 1
  level!: LevelScript
  daytime = false
  enemyMeter = 0
  enemyMeterInitial = 0
  aggression = { tank: 1, jet: 3, heliGun: 3, heliRocket: 3 }
  outcome: Outcome = 'playing'
  outcomeTimer = 0
  paused = false
  /** Set by the bomber system: launches the player's air strike ('b'). */
  callBombers?: () => void

  readonly g3d: G3DScene
  readonly terrain: Terrain
  readonly mmap: Uint8Array
  readonly shapes: ShapeData
  readonly collision: Collision
  projectiles!: Projectiles
  targets: Target[] = []
  enemies: EnemySystem[] = []
  soldiers: Soldiers = noopSoldiers
  effects: Effects = noopEffects
  sound: Sound = noopSound

  constructor(deps: WorldDeps) {
    this.g3d = deps.g3d
    this.terrain = deps.terrain
    this.mmap = deps.mmap
    this.shapes = deps.shapes
    this.collision = deps.collision
  }

  rand() {
    return this.rng.rand()
  }

  groundY(x: number, z: number) {
    return this.terrain.heightAt(x, z)
  }

  /** MMap byte < 0x20 marks valid ground for spawns, landing zones and drops. */
  validGround(x: number, z: number) {
    const col = Math.floor((x + 15000) * 0.05), row = Math.floor((z + 15000) * 0.05)
    if (col < 0 || row < 0 || col > 1500 || row > 1500) return false
    return this.mmap[row * 1501 + col] < 0x20
  }

  /** Shield damage with the original side effects (shake + ExHit on heavy hits, metal sounds on light ones). */
  damagePlayer(amount: number) {
    if (this.outcome !== 'playing') return
    const p = this.player
    if (!p.godMode) p.shield = Math.max(0, p.shield - amount)
    if (amount >= 5) {
      p.shake = 2
      this.sound.play('ExHit')
    } else {
      const r = this.rand() & 7
      this.sound.play(r < 2 ? 'Metalbig' : r < 4 ? 'Metalshort' : r < 5 ? 'Ricocht1' : r < 6 ? 'Ricocht2' : 'Ricocht3')
    }
  }

  reduceEnemyMeter(amount: number) {
    this.enemyMeter = Math.max(0, this.enemyMeter - amount)
  }

  prize(kind: 'health' | 'bullets' | 'cannon' | 'missiles' | 'none') {
    const p = this.player
    if (kind === 'health') p.shield = Math.min(CAPS.shield, p.shield + 15)
    if (kind === 'bullets') p.ammo.bullets = Math.min(CAPS.bullets, p.ammo.bullets + 50)
    if (kind === 'cannon') p.ammo.cannon = Math.min(CAPS.cannon, p.ammo.cannon + 4)
    if (kind === 'missiles') p.ammo.missiles = Math.min(CAPS.missiles, p.ammo.missiles + 2)
    p.ammoOutCounter = 150
    this.sound.play('Prize')
  }

  enemySystem(type: ObjectType) {
    return this.enemies.find((s) => s.types.includes(type))
  }
}
