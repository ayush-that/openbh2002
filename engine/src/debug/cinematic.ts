import * as THREE from 'three/webgpu'
import type { Game } from '../game/game'
import type { Target, World } from '../game/world'
import { FRAME_MS, GRAVITY, MOUNT, PITCH_MAX, PITCH_MIN, deg } from '../game/constants'
import { forward } from '../game/player'
import { Recorder, type RecordingResult } from './recorder'

// Cinematic bot and shot runner for the launch video (docs/dev/video.md). Like autoplay it plays through the real
// input path only (game.input cursor/button and KeyboardEvents), but aims like a person: a damped spring on yaw
// and pitch with a little overshoot, capped speed and acceleration, a dwell on each target and a short hold after
// a kill. Target choice favours what is already near the view so the action stays on screen.

export interface CinematicOptions {
  /** Kinds engaged first: tank, apc, jet, cobra, ch53, c130, parachute, crate (parachute carrying a prize), soldier. */
  prefer: string[]
  /** Kinds never engaged. */
  avoid: string[]
  /** Fire a missile at jets (and tanks once the cannon is empty). */
  missiles: boolean
  /** Keep a flare up at night. */
  flares: boolean
  /** 'auto': call the bomber strike when 5+ soldiers are alive. */
  bombers: 'auto' | 'never'
  /** Recording safety only: keep the shield at 100 (no visible cheat, off by default). */
  god: boolean
}

const DEFAULTS: CinematicOptions = { prefer: [], avoid: [], missiles: true, flares: true, bombers: 'never', god: false }

interface Contact {
  key: object
  kind: string
  pos: THREE.Vector3
  vel: THREE.Vector3
}

interface SoldierView {
  active: boolean
  state: number
  x: number
  y: number
  z: number
}

const M = new THREE.Vector3(MOUNT.x, MOUNT.y, MOUNT.z)
const GROUND = new Set(['tank', 'apc'])
const SIZE: Record<string, number> = { tank: 140, apc: 140, jet: 220, cobra: 220, ch53: 320, c130: 450, parachute: 160, crate: 160, soldier: 22 }
const PRIORITY: Record<string, number> = { jet: 0.6, cobra: 0.6, tank: 0.7, apc: 0.7, ch53: 0.8, c130: 1.2, parachute: 1.1, crate: 0.9, soldier: 1 }
const WEAPON = {
  gun: { speed: 500, gravity: GRAVITY, muzzle: 220, range: 12000 },
  handgun: { speed: 400, gravity: GRAVITY, muzzle: 100, range: 5000 },
  cannon: { speed: 400, gravity: GRAVITY, muzzle: 265, range: 11000 },
  missile: { speed: 280, gravity: 0, muzzle: 0, range: 9000 },
}
type Weapon = keyof typeof WEAPON
/** Prize crates (4 kinds x ring of 4), hanging 250 below their canopy. */
const CRATE_FIRST = 454
const CRATES = 16

/** Spring per tick: natural frequency 8 rad/s, damping 0.7 (about 5% overshoot), speed and acceleration caps. */
const OMEGA = 8 * (FRAME_MS / 1000)
const ZETA = 0.7
const VMAX = 4 // deg per tick (about 140 deg/s)
const AMAX = 0.35 // deg per tick^2

/** Soldiers that can still be shot (same test as autoplay). */
const aliveSoldiers = (w: World) => ((w.soldiers as unknown as { list?: SoldierView[] }).list ?? []).filter((s) => s.active && s.state > 1 && s.state < 0x2a)
const wrapYaw = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180
const clamp = THREE.MathUtils.clamp

export class Cinematic {
  opts: CinematicOptions = { ...DEFAULTS }
  target: Contact | null = null
  /** Aim settled on the target for a few ticks. */
  locked = false
  readonly stats = { ticks: 0, firing: 0, missiles: 0, flares: 0, bombers: 0, kills: 0 }
  private game: Game
  private w: World
  private origStep: () => void
  private listeners = new Set<() => void>()
  private prevPos = new Map<object, THREE.Vector3>()
  private vYaw = 0
  private vPitch = 0
  /** Last desired aim (null: none yet this shot, so idle means holding the current view). */
  private lastAim: { key: object | null; yaw: number; pitch: number } | null = null
  private dwell = 0
  private hold = 0
  private steady = 0
  private anchorStep = 0
  private lastMissile = -1000
  private lastFlare = -1000

  constructor(game: Game, opts: Partial<CinematicOptions> = {}) {
    this.game = game
    this.w = game.world
    this.configure(opts)
    this.origStep = game.step
    game.step = () => {
      this.origStep.call(game)
      try {
        this.tick()
      } catch (e) {
        console.error('cinematic', e)
      }
    }
  }

  /** New preferences (per shot). Resets the target choice. */
  configure(opts: Partial<CinematicOptions>) {
    this.opts = { ...DEFAULTS, ...opts }
    this.target = null
    this.locked = false
    this.hold = this.dwell = this.steady = 0
    this.lastAim = null
    this.prevPos.clear()
    this.w.player.godMode = this.opts.god
  }

  /**
   * Re-grip the mouse: sweep the cursor so the pitch clamp pins the pitch, then set it so the 480-pixel cursor box
   * covers pitch -25..71 and the view starts at `pitch`. Visible as a jump, so call it while the recorder is paused.
   */
  reanchor(pitch = 4) {
    this.anchorStep = 1
    this.anchorPitch = pitch
  }
  private anchorPitch = 4

  /** Called after every game tick (also while waiting); returns an unsubscribe function. */
  onTick(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Type a key through the same queue as the keyboard (the game reads it on the next tick). */
  key(k: string) {
    dispatchEvent(new KeyboardEvent('keydown', { key: k }))
    if (k === 'b') this.stats.bombers++
  }

  stop() {
    this.game.step = this.origStep
    this.release()
    this.w.player.godMode = false
    this.listeners.clear()
  }

  // ------------------------------------------------------------------ per tick

  private release() {
    const input = this.game.input
    input.button = false
    input.cx = 0
    this.vYaw = this.vPitch = 0
  }

  private tick() {
    const w = this.w
    if (w.paused) return
    if (this.opts.god) w.player.shield = 100
    if (w.outcome !== 'playing') this.release()
    else if (this.anchorStep) this.anchor()
    else this.decide()
    this.stats.ticks++
    for (const fn of [...this.listeners]) fn()
  }

  private anchor() {
    const input = this.game.input
    input.button = false
    input.cx = 0
    // Down, up, down by the full box (95.8 deg each) always ends pinned at PITCH_MIN with the cursor at the bottom edge.
    const seq = [-240, 239, -240, 239]
    if (this.anchorStep <= seq.length) input.cy = seq[this.anchorStep - 1]
    else {
      input.cy = Math.round(239 - (clamp(this.anchorPitch, PITCH_MIN, 70) - PITCH_MIN) / 0.2)
      this.anchorStep = -1
    }
    this.anchorStep++
    this.vYaw = this.vPitch = 0
  }

  private soldiers() {
    return aliveSoldiers(this.w)
  }

  private live(t: Target) {
    return t.alive() && !t.wrecked?.()
  }

  /** A parachute whose crate hangs below it. */
  private carriesCrate(t: Target) {
    const p = t.node.position
    for (let i = 0; i < CRATES; i++) {
      const c = this.w.g3d.node(CRATE_FIRST + i)
      if (c.visible && Math.abs(c.position.x - p.x) < 150 && Math.abs(c.position.z - p.z) < 150 && Math.abs(c.position.y - (p.y - 250)) < 150) return true
    }
    return false
  }

  private contacts(): Contact[] {
    const out: Contact[] = []
    const seen = new Set<object>()
    const add = (key: object, kind: string, pos: THREE.Vector3) => {
      seen.add(key)
      const prev = this.prevPos.get(key)
      const vel = prev && prev.distanceTo(pos) < 1500 ? pos.clone().sub(prev) : new THREE.Vector3()
      this.prevPos.set(key, pos.clone())
      out.push({ key, kind, pos, vel })
    }
    for (const t of this.w.targets) {
      if (!this.live(t) || t.shape === 'bomber') continue
      const pos = t.node.getWorldPosition(new THREE.Vector3())
      if (GROUND.has(t.shape)) pos.y += 80
      add(t, t.shape === 'parachute' && this.carriesCrate(t) ? 'crate' : t.shape, pos)
    }
    for (const s of this.soldiers()) add(s, 'soldier', new THREE.Vector3(s.x, s.y + 70, s.z))
    for (const k of this.prevPos.keys()) if (!seen.has(k)) this.prevPos.delete(k)
    return out
  }

  private clearLine(p: THREE.Vector3) {
    for (let f = 0.1; f <= 0.95; f += 0.05) {
      const x = M.x + (p.x - M.x) * f, y = M.y + (p.y - M.y) * f, z = M.z + (p.z - M.z) * f
      if (this.w.groundY(x, z) > y + 10) return false
    }
    return true
  }

  private weaponFor(kind: string): Weapon | null {
    const a = this.w.player.ammo
    const rails = this.game.player.rails[0] || this.game.player.rails[1]
    if (GROUND.has(kind)) return a.cannon > 0 ? 'cannon' : rails && this.opts.missiles ? 'missile' : null
    if (a.bullets > 0) return 'gun'
    if (a.handgun > 0 && (kind === 'soldier' || kind === 'parachute' || kind === 'crate')) return 'handgun'
    return null
  }

  private lead(c: Contact, wpn: Weapon) {
    const { speed, gravity, muzzle } = WEAPON[wpn]
    let t = Math.max(1, (c.pos.distanceTo(M) - muzzle) / speed)
    const aim = new THREE.Vector3()
    for (let i = 0; i < 6; i++) {
      aim.copy(c.pos).addScaledVector(c.vel, t)
      aim.y += (gravity * t * (t - 1)) / 2
      t = Math.max(1, (aim.distanceTo(M) - muzzle) / speed)
    }
    return aim
  }

  /** Pitch reachable without re-gripping: the cursor box limits how far the pitch can move each way. */
  private reachable(pitch: number) {
    const p = this.w.player, cy = this.game.input.cy
    return pitch <= Math.min(PITCH_MAX, p.pitch + (cy + 240) * 0.2) && pitch >= Math.max(PITCH_MIN, p.pitch - (239 - cy) * 0.2)
  }

  private choose(list: Contact[]) {
    const p = this.w.player
    const view = forward(p.yaw, p.pitch)
    const { prefer, avoid } = this.opts
    let best: Contact | null = null, bestScore = Infinity, curScore = Infinity
    for (const c of list) {
      if (avoid.includes(c.kind) || (c.kind === 'crate' && avoid.includes('parachute'))) continue
      const wpn = this.weaponFor(c.kind)
      if (!wpn) continue
      const d = c.pos.distanceTo(M)
      if (d > WEAPON[wpn].range || d < 450) continue
      if ((GROUND.has(c.kind) || c.kind === 'soldier') && !this.clearLine(c.pos)) continue
      const dir = c.pos.clone().sub(M).normalize()
      if (!this.reachable(Math.asin(dir.y) / deg)) continue
      const ang = Math.acos(clamp(view.dot(dir), -1, 1)) / deg
      const pref = prefer.includes(c.kind) || (c.kind === 'crate' && prefer.includes('parachute')) ? 0.3 : 1
      // Angle dominates so the camera pans to nearby action instead of whipping around.
      const score = (ang * 45 + d * 0.25 * (PRIORITY[c.kind] ?? 1)) * pref
      if (this.target && c.key === this.target.key) curScore = score
      if (score < bestScore) {
        bestScore = score
        best = c
      }
    }
    // Stick with the current target for at least ~1.3 s, and afterwards unless something is clearly better.
    if (curScore < Infinity && (this.dwell < 45 || curScore <= bestScore * 1.6)) best = list.find((c) => c.key === this.target!.key) ?? best
    if (best?.key !== this.target?.key) this.dwell = 0
    return best
  }

  private decide() {
    const w = this.w, p = w.player, input = this.game.input, o = this.opts
    const list = this.contacts()
    if (this.target && !list.some((c) => c.key === this.target!.key)) {
      // Target gone (usually destroyed): hold the aim a moment, like a player watching the explosion.
      this.stats.kills++
      this.target = null
      this.hold = 10
    }
    if (this.hold > 0) this.hold--
    else this.target = this.choose(list)
    this.dwell++

    if (o.flares && !w.daytime && p.ammo.flares > 0 && w.projectiles.count('flare') === 0 && w.frame - this.lastFlare > 150) {
      this.lastFlare = w.frame
      this.stats.flares++
      this.key('f')
    }
    if (o.bombers === 'auto' && p.bombersAvailable && this.soldiers().length >= 5) this.key('b')

    // Desired aim: the lead point on the target, or the last aim while holding / idle.
    const tg = this.target
    const wpn = tg ? this.weaponFor(tg.kind)! : null
    const last = this.lastAim
    let yawD = last?.yaw ?? p.yaw, pitchD = last?.pitch ?? p.pitch, dist = 1, dir: THREE.Vector3 | null = null
    if (tg && wpn) {
      const aim = this.lead(tg, wpn)
      dir = aim.sub(M)
      dist = dir.length()
      dir.normalize()
      yawD = Math.atan2(-dir.x, -dir.z) / deg
      pitchD = clamp(Math.asin(dir.y) / deg, PITCH_MIN, PITCH_MAX)
    }
    // Feed-forward of the target's angular motion (zero on a new target) so tracking does not lag.
    const same = !!tg && !!last && tg.key === last.key
    const ffY = same ? clamp(wrapYaw(yawD - last!.yaw), -VMAX, VMAX) : 0
    const ffP = same ? clamp(pitchD - last!.pitch, -VMAX, VMAX) : 0
    this.lastAim = { key: tg?.key ?? null, yaw: yawD, pitch: pitchD }
    // Hand tremor: a slow, tiny wobble (deterministic, so takes repeat).
    const f = w.frame
    yawD += 0.06 * Math.sin(f * 0.21) + 0.04 * Math.sin(f * 0.057 + 1)
    pitchD += 0.04 * Math.sin(f * 0.17 + 2)

    const spring = (err: number, v: number, ff: number) => {
      const a = clamp(OMEGA * OMEGA * err + 2 * ZETA * OMEGA * (ff - v), -AMAX, AMAX)
      return clamp(v + a, -VMAX, VMAX)
    }
    // Yaw is rate controlled: yaw -= cx * 0.02 per tick.
    this.vYaw = spring(wrapYaw(yawD - p.yaw), this.vYaw, ffY)
    input.cx = clamp(-this.vYaw / 0.02, -320, 319)
    this.vYaw = -input.cx * 0.02
    // Pitch follows cursor deltas (pitch -= dy * 0.2). Move the cursor only as far as the pitch can actually go.
    this.vPitch = spring(pitchD - p.pitch, this.vPitch, ffP)
    const np = clamp(p.pitch + this.vPitch, PITCH_MIN, PITCH_MAX)
    const cy0 = input.cy
    input.cy = clamp(cy0 - (np - p.pitch) / 0.2, -240, 239)
    this.vPitch = -(input.cy - cy0) * 0.2

    if (!tg || !wpn || !dir) {
      input.button = false
      this.locked = false
      return
    }
    const want: 0 | 1 | 2 = wpn === 'cannon' ? 1 : wpn === 'handgun' ? 2 : 0
    let switching = false
    if (wpn !== 'missile' && p.weapon !== want) {
      this.key(want === 2 ? 'g' : ' ')
      switching = true
    }
    const nyaw = p.yaw + this.vYaw, npitch = clamp(p.pitch + this.vPitch, PITCH_MIN, PITCH_MAX)
    const err = Math.acos(clamp(forward(nyaw, npitch).dot(dir), -1, 1))
    const tol = Math.atan((SIZE[tg.kind] ?? 150) / dist) * (wpn === 'gun' ? 1.5 : 1)
    const onTarget = err < tol
    this.steady = err < Math.max(tol * 2, 1.5 * deg) ? this.steady + 1 : 0
    this.locked = this.steady >= 5

    const rails = this.game.player.rails[0] || this.game.player.rails[1]
    if (wpn === 'missile') {
      input.button = false
      if (onTarget && w.frame - this.lastMissile > 45) this.missile()
      return
    }
    if (o.missiles && tg.kind === 'jet' && rails && dist < 9000 && err < 3 * deg && w.frame - this.lastMissile > 120) this.missile()
    const fire = onTarget && !switching
    input.button = fire && (wpn !== 'handgun' || !input.button)
    if (input.button) this.stats.firing++
  }

  private missile() {
    this.lastMissile = this.w.frame
    this.stats.missiles++
    this.key('m')
  }
}

// ==================================================================== shots

export interface ShotContext {
  game: Game
  w: World
  bot: Cinematic
  /** Ticks recorded so far in this shot. */
  ticks: number
  /** Prizes collected since the level started. */
  prizes: number
}

export interface Shot {
  name: string
  /** The front end's title screen (needs `frontend`), clicking PLAY at the end. */
  title?: boolean
  level?: number
  seed?: number
  mode?: 'remaster' | 'faithful'
  bot?: Partial<CinematicOptions>
  /** Checked every tick while fast-forwarding unrecorded. Default: the bot is locked on a target. */
  ready?: (s: ShotContext) => boolean
  /** Give up waiting after this many ticks and record anyway (default 3000). */
  maxWait?: number
  /** Recorded length in seconds of game time (the maximum when `until` is set). */
  seconds: number
  /** Ends the shot early, after `tail` more seconds. */
  until?: (s: ShotContext) => boolean
  tail?: number
  /** First recorded tick (e.g. call the bombers). */
  onStart?: (s: ShotContext) => void
}

const ticksOf = (s: number) => Math.round((s * 1000) / FRAME_MS)
const near = (w: World, kind: string, d: number) =>
  w.targets.some((t) => t.shape === kind && t.alive() && !t.wrecked?.() && t.node.getWorldPosition(new THREE.Vector3()).distanceTo(M) < d)
const aiming = (s: ShotContext, ...kinds: string[]) => s.bot.locked && !!s.bot.target && kinds.includes(s.bot.target.kind)

/** Launch video: title, day armour, jets with a missile, a C130 prize drop, a close tank kill, the bomber strike, night with flares, a cleared level. */
export const LAUNCH_SHOTS: Shot[] = [
  { name: 'title', title: true, seconds: 3.5 },
  { name: 'armour', level: 10, seed: 10, bot: { prefer: ['tank', 'apc', 'cobra'] }, ready: (s) => aiming(s, 'tank', 'apc', 'cobra'), seconds: 6 },
  { name: 'jets', level: 28, seed: 28, bot: { prefer: ['jet'] }, ready: (s) => aiming(s, 'jet'), seconds: 6 },
  {
    name: 'prize', level: 13, seed: 13, bot: { prefer: ['crate'], avoid: ['c130'] }, ready: (s) => aiming(s, 'crate'), maxWait: 6000,
    seconds: 7, until: (s) => s.prizes > 0, tail: 1.2,
  },
  { name: 'close-kill', level: 17, seed: 17, bot: { prefer: ['tank'], avoid: ['jet', 'cobra', 'c130', 'soldier'] }, ready: (s) => aiming(s, 'tank') && near(s.w, 'tank', 4000), maxWait: 6000, seconds: 4 },
  {
    name: 'bombers', level: 18, seed: 18, bot: { prefer: ['soldier'] }, ready: (s) => s.bot.locked && aliveSoldiers(s.w).length >= 4,
    maxWait: 6000, seconds: 6, onStart: (s) => s.bot.key('b'),
  },
  { name: 'night', level: 23, seed: 23, bot: { prefer: ['cobra', 'ch53', 'apc'] }, seconds: 7, onStart: (s) => s.w.projectiles.count('flare') || s.bot.key('f') },
  {
    name: 'cleared', level: 1, seed: 1, bot: {}, ready: (s) => s.bot.locked && s.w.enemyMeter <= s.w.enemyMeterInitial * 0.12, maxWait: 15000,
    seconds: 12, until: (s) => s.w.outcome === 'cleared', tail: 2.5,
  },
]

export interface RunShotsOptions {
  game: Game
  renderer: THREE.WebGPURenderer
  vm?: { render(): void; setMode?(m: 'remaster' | 'faithful'): void }
  sound?: unknown
  /** Front end, for the title shot (main.ts's createFrontend result). */
  frontend?: { show(): Promise<unknown> }
  shots?: Shot[]
  name?: string
  /** Fast-forward multiplier while waiting (the game caps catch-up at 8 ticks per render). */
  fastForward?: number
}

/** Click-to-start overlay when the page has no user activation yet (audio needs one). Not captured: it is not a canvas. */
function gesture() {
  if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) return Promise.resolve()
  const el = Object.assign(document.createElement('div'), { textContent: 'Click to start recording' })
  el.style.cssText = 'position:fixed;inset:0;display:grid;place-content:center;font:22px system-ui;color:#eee;background:#000a;z-index:100;cursor:pointer'
  document.body.append(el)
  return new Promise<void>((r) =>
    el.addEventListener('pointerdown', () => {
      el.remove()
      r()
    }, { once: true }),
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/** Play a shot list through the cinematic bot and record it. Waiting and level changes are cut (recorder paused). */
export async function runShots(o: RunShotsOptions): Promise<RecordingResult> {
  const { game } = o
  const w = game.world
  const shots = o.shots ?? LAUNCH_SHOTS
  await gesture()
  const rec = new Recorder({ renderer: o.renderer, game, vm: o.vm, sound: o.sound, name: o.name ?? 'launch' })
  const bot = new Cinematic(game)
  const sound = w.sound as { enabled: boolean; stopAll(): void }
  const events = game.events
  game.events = {}
  // Fast-forward through the real loop by scaling the time passed to game.frame.
  let scale = 1, lastReal = 0, virt = 0
  const origFrame = game.frame
  game.frame = (now: number) => {
    virt = lastReal ? virt + (now - lastReal) * scale : now
    lastReal = now
    origFrame.call(game, virt)
  }
  let prizes = 0
  const wr = w as unknown as Record<string, unknown>
  const proto = Object.getPrototypeOf(w) as World
  wr.prize = (kind: Parameters<World['prize']>[0]) => {
    prizes++
    proto.prize.call(w, kind)
  }
  const log: string[] = []
  const ctx = (ticks: number): ShotContext => ({ game, w, bot, ticks, prizes })
  const waitTicks = (fn: (n: number) => boolean) =>
    new Promise<number>((res) => {
      let n = 0
      const off = bot.onTick(() => {
        if (fn(++n)) {
          off()
          res(n)
        }
      })
    })

  try {
    for (const shot of shots) {
      rec.pause()
      if (shot.title) {
        if (!o.frontend) {
          log.push(`${shot.name}: skipped (no frontend)`)
          continue
        }
        await titleShot(o.frontend, rec, shot.seconds, w)
        log.push(`${shot.name}: recorded`)
        continue
      }
      // Cut: set up the level unrecorded and silent, re-grip the mouse, then fast-forward until the shot is ready.
      sound.enabled = false
      sound.stopAll()
      o.vm?.setMode?.(shot.mode ?? 'remaster')
      if (shot.level !== undefined) {
        w.rng.seed(shot.seed ?? shot.level)
        game.startLevel(shot.level)
        prizes = 0
      }
      w.player.mouseTight = false
      w.player.mouseReverse = false
      w.paused = false
      bot.configure(shot.bot ?? {})
      bot.reanchor()
      scale = o.fastForward ?? 16
      const ready = shot.ready ?? ((s: ShotContext) => s.bot.locked)
      const waited = await waitTicks((n) => n > 8 && (ready(ctx(0)) || n >= (shot.maxWait ?? 3000)))
      scale = 1
      await waitTicks(() => true)
      sound.stopAll()
      sound.enabled = true
      await rec.resume()
      const max = ticksOf(shot.seconds)
      let tailLeft = -1
      shot.onStart?.(ctx(0))
      const recorded = await waitTicks((n) => {
        if (tailLeft < 0 && shot.until?.(ctx(n))) tailLeft = ticksOf(shot.tail ?? 0)
        if (tailLeft >= 0 && tailLeft-- <= 0) return true
        return n >= max
      })
      rec.pause()
      log.push(`${shot.name}: level ${w.levelNumber}, waited ${waited} ticks${waited >= (shot.maxWait ?? 3000) ? ' (NOT READY)' : ''}, recorded ${recorded} ticks`)
    }
  } finally {
    w.paused = true
    sound.stopAll()
    bot.stop()
    game.frame = origFrame
    game.events = events
    delete wr.prize
  }
  const result = await rec.stop()
  result.errors.unshift(...log)
  ;(window as unknown as { __recording: RecordingResult }).__recording = result
  console.log('recording done', result)
  return result
}

/** Title screen: skip the logos (Esc), let the menu music start, glide the cursor to the gun and click PLAY. */
async function titleShot(fe: { show(): Promise<unknown> }, rec: Recorder, seconds: number, w: World) {
  w.paused = true
  const roots = () => [...document.querySelectorAll<HTMLElement>('#app > div[tabindex="0"]')].filter((e) => e.style.display !== 'none')
  const before = roots()
  const done = fe.show()
  const root = roots().find((e) => !before.includes(e)) ?? roots().pop()
  const canvas = root?.querySelector('canvas')
  if (!root || !canvas) throw new Error('front end root not found')
  root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  const at = (x: number, y: number, type: string) => {
    const r = canvas.getBoundingClientRect()
    const init = { clientX: r.left + x * r.width, clientY: r.top + y * r.height, button: 0, bubbles: true, pointerType: 'mouse' }
    ;(type === 'pointerup' ? window : root).dispatchEvent(new PointerEvent(type, init))
  }
  const from = [0.62, 0.3], to = [0.56, 0.74]
  at(from[0], from[1], 'pointermove')
  // preludio.xm starts once the AudioWorklet has loaded.
  await sleep(1500)
  await rec.resume()
  const t0 = performance.now(), glide = [0.6, 2.2], click = seconds - 0.6
  await new Promise<void>((res) => {
    const step = () => {
      const t = (performance.now() - t0) / 1000
      const k = ease(clamp((t - glide[0]) / (glide[1] - glide[0]), 0, 1))
      // A small overshoot past the gun that settles back, like a hand on a mouse.
      const over = Math.sin(Math.PI * clamp((t - glide[1] + 0.35) / 0.6, 0, 1)) * 0.012
      at(from[0] + (to[0] - from[0]) * k + over, from[1] + (to[1] - from[1]) * k + over, 'pointermove')
      if (t >= click) return res()
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  at(to[0], to[1], 'pointerdown')
  await sleep(90)
  at(to[0], to[1], 'pointerup')
  await done
  rec.pause()
}

/** ?record=launch entry point (see docs/dev/video.md for the main.ts wiring). */
export function recordLaunch(o: RunShotsOptions) {
  return runShots({ shots: LAUNCH_SHOTS, ...o })
}
