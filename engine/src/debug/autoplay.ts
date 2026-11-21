import * as THREE from 'three/webgpu'
import type { Game } from '../game/game'
import type { Target, World } from '../game/world'
import { GRAVITY, MOUNT, PITCH_MAX, PITCH_MIN, deg } from '../game/constants'
import { forward } from '../game/player'

// End-to-end play-test bot. It plays real levels through the real loop: each tick it reads the world,
// then drives only what a player can touch (game.input cursor and button, typed keys as KeyboardEvents).
// Instrumentation wraps a few methods for counting and restores them when done. See docs/dev/e2e.md.

type Shot = 'gun' | 'handgun' | 'cannon' | 'missile' | 'flare'
type Result = 'cleared' | 'destroyed' | 'timeout'

export interface LevelReport {
  level: number
  seed: number
  daytime: boolean
  result: Result
  frames: number
  shield: { min: number; final: number; every50: number[] }
  meter: { start: number; end: number; every50: number[] }
  /** Targets the player hit that then died, by shape; soldiers that went from alive to dying. */
  kills: Record<string, number>
  /** Enemy meter reduction by the function that called reduceEnemyMeter. */
  meterBySource: Record<string, number>
  shots: Record<Shot, number>
  /** Target.hit calls by weapon, plus bullets that killed a soldier. */
  hits: Record<'bullet' | 'shell' | 'missile' | 'soldier', number>
  /** Shield lost, keyed by the calling functions of World.damagePlayer (callee < caller). */
  damageBySource: Record<string, number>
  prizes: Record<string, number>
  ammo: { start: Record<string, number>; end: Record<string, number> }
  bot: { framesWithTarget: number; framesFiring: number; missilesCalled: number; bombersCalled: boolean }
  frameMs: { rafAvg: number; rafP95: number; rafWorst: number; simAvg: number; simWorst: number; renderAvg: number; renderWorst: number }
  /** At the end: live targets and soldiers, to diagnose timeouts. */
  remaining: { targets: { shape: string; slot: number; pos: number[] }[]; soldiers: number }
  errors: string[]
  screenshot?: string
}

export interface AutoplayReport {
  startedAt: string
  finishedAt: string
  /** True while the run is in progress (written to latest.json after each level). */
  partial: boolean
  seed: number
  levels: number[]
  speed: number
  url: string
  userAgent: string
  backend?: string
  viewport: number[]
  results: LevelReport[]
  errors: string[]
  artifact?: string
}

export interface AutoplayOptions {
  levels: number[]
  seed?: number
  timeoutFrames?: number
  /** Simulation speed multiplier through the real loop (the loop caps catch-up at 8 ticks per render). */
  speed?: number
  /** Enables level-end screenshots; defaults to window.__bh.renderer. */
  renderer?: THREE.WebGPURenderer
  onDone(report: AutoplayReport): void
}

interface SoldierView {
  active: boolean
  state: number
  x: number
  y: number
  z: number
}

interface Contact {
  key: object
  kind: string
  pos: THREE.Vector3
  vel: THREE.Vector3
}

const M = new THREE.Vector3(MOUNT.x, MOUNT.y, MOUNT.z)
const AIR = new Set(['jet', 'cobra', 'c130', 'ch53'])
const GROUND = new Set(['tank', 'apc'])
/** Rough half-size used for the fire tolerance cone. */
const SIZE: Record<string, number> = { tank: 140, apc: 140, jet: 220, cobra: 220, ch53: 320, c130: 450, parachute: 160, soldier: 22 }
/** Lower = engaged first (multiplies distance). */
const PRIORITY: Record<string, number> = { jet: 0.5, cobra: 0.5, tank: 0.7, apc: 0.6, ch53: 0.8, c130: 0.9, parachute: 1.1, soldier: 1 }
const WEAPON = {
  gun: { speed: 500, gravity: GRAVITY, muzzle: 220 },
  handgun: { speed: 400, gravity: GRAVITY, muzzle: 100 },
  cannon: { speed: 400, gravity: GRAVITY, muzzle: 265 },
  missile: { speed: 280, gravity: 0, muzzle: 0 },
}

const wrapYaw = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180

function caller(depth: number) {
  const lines = (new Error().stack ?? '').split('\n').slice(1).filter((l) => !l.includes('autoplay'))
  return lines
    .slice(0, depth)
    .map((l) => {
      const m = /at (?:async )?([\w$.<>]+)? ?\(?(?:.*\/)?([\w.-]+?)(?:\?[^:]*)?:\d+:\d+\)?/.exec(l.trim())
      return m ? `${m[1] ?? '?'}@${m[2]}` : l.trim()
    })
    .join(' < ')
}

function bump<K extends string>(rec: Record<K, number>, k: K, n = 1) {
  rec[k] = (rec[k] ?? 0) + n
}

export function startAutoplay(game: Game, opts: AutoplayOptions) {
  const w: World = game.world
  const input = game.input
  const seed = opts.seed ?? 1
  const timeout = opts.timeoutFrames ?? 20000
  const speed = Math.max(1, opts.speed ?? 1)
  const bh = (window as unknown as { __bh?: { renderer?: THREE.WebGPURenderer; backend?: string } }).__bh
  const renderer = opts.renderer ?? bh?.renderer
  const startedAt = new Date().toISOString()
  const results: LevelReport[] = []
  const globalErrors: string[] = []
  const uploads: Promise<unknown>[] = []

  let index = -1
  let L!: LevelReport
  let raf: number[] = [], sim: number[] = [], rend: number[] = []
  let phase: 'play' | 'shot' | 'done' = 'play'
  let shotDone = false
  let target: Contact | null = null
  let lastMissile = -1000, lastFlare = -1000
  const prevPos = new Map<object, THREE.Vector3>()
  const targetInfo = new Map<Target, { orig: Target['hit']; wasAlive: boolean; hit: boolean }>()
  // A destroyed tank stays active as a wreck (state 0), so alive() stays true: remember the killing hit.
  let wrecks = new WeakSet<Target>()
  const live = (t: Target) => t.alive() && !wrecks.has(t)
  const soldierState = new Map<SoldierView, number>()
  const seenProjectiles = new WeakSet<object>()

  const soldiers = () => (w.soldiers as unknown as { list?: SoldierView[] }).list ?? []
  const killable = (s: SoldierView) => s.active && s.state > 1 && s.state < 0x2a

  // ------------------------------------------------------------------ instrumentation

  const err = (msg: string) => {
    globalErrors.push(msg)
    L?.errors.push(msg)
  }
  const origConsoleError = console.error
  console.error = (...args: unknown[]) => {
    err(args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' '))
    origConsoleError.apply(console, args)
  }
  const onError = (e: ErrorEvent) => err(`onerror: ${e.message} @ ${e.filename}:${e.lineno}`)
  const onRejection = (e: PromiseRejectionEvent) => err(`unhandledrejection: ${String(e.reason?.stack ?? e.reason)}`)
  addEventListener('error', onError)
  addEventListener('unhandledrejection', onRejection)

  const proto = Object.getPrototypeOf(w) as World
  const wr = w as unknown as Record<string, unknown>
  wr.reduceEnemyMeter = (amount: number) => {
    const before = w.enemyMeter
    proto.reduceEnemyMeter.call(w, amount)
    if (L && before > w.enemyMeter) bump(L.meterBySource, caller(1), before - w.enemyMeter)
  }
  wr.damagePlayer = (amount: number) => {
    const before = w.player.shield
    proto.damagePlayer.call(w, amount)
    if (L && before > w.player.shield) bump(L.damageBySource, caller(2), before - w.player.shield)
  }
  wr.prize = (kind: Parameters<World['prize']>[0]) => {
    if (L) bump(L.prizes, kind)
    proto.prize.call(w, kind)
  }
  const soldierPool = w.soldiers
  const origRayKill = soldierPool.rayKill
  soldierPool.rayKill = (...a) => {
    const r = origRayKill.apply(soldierPool, a)
    if (r && L) L.hits.soldier++
    return r
  }

  const origStep = game.step
  const origFrame = game.frame
  let lastReal = 0, virt = 0
  game.frame = (now: number) => {
    if (lastReal) {
      raf.push(now - lastReal)
      virt += (now - lastReal) * speed
    } else virt = now
    lastReal = now
    const t0 = performance.now()
    origFrame.call(game, virt)
    sim.push(performance.now() - t0)
  }
  game.step = () => {
    origStep.call(game)
    try {
      tick()
    } catch (e) {
      err(`autoplay: ${(e as Error).stack ?? e}`)
    }
  }
  const origRender = renderer?.render
  if (renderer && origRender) {
    renderer.render = (...a: Parameters<THREE.WebGPURenderer['render']>) => {
      const t0 = performance.now()
      const out = origRender.apply(renderer, a)
      rend.push(performance.now() - t0)
      if (phase === 'shot' && !shotDone) {
        shotDone = true
        // Read back in the same task as the render, before the WebGPU canvas texture is presented.
        const name = `level-${L.level}-${L.result}-${startedAt.replace(/[:.]/g, '-')}.png`
        const lr = L
        const src = renderer.domElement, k = Math.min(1, 1280 / src.width)
        const shot = Object.assign(document.createElement('canvas'), { width: Math.round(src.width * k), height: Math.round(src.height * k) })
        shot.getContext('2d')!.drawImage(src, 0, 0, shot.width, shot.height)
        uploads.push(
          new Promise<Blob | null>((res) => shot.toBlob(res, 'image/png'))
            .then((b) => (b ? fetch(`/__shot?name=${name}`, { method: 'POST', body: b }) : Promise.reject(new Error('toBlob returned null'))))
            .then((r) => r.json())
            .then((j: { path?: string; error?: string }) => (lr.screenshot = j.path ?? `error: ${j.error}`))
            .catch((e) => (lr.screenshot = `error: ${(e as Error).message}`)),
        )
      }
      return out
    }
  }

  // ------------------------------------------------------------------ level flow

  const ammo = () => ({ ...w.player.ammo })

  function beginLevel() {
    index++
    if (index >= opts.levels.length) return finish()
    const level = opts.levels[index]
    const s = seed + level
    w.rng.seed(s)
    w.paused = false
    game.startLevel(level)
    phase = 'play'
    shotDone = false
    target = null
    prevPos.clear()
    targetInfo.clear()
    wrecks = new WeakSet()
    soldierState.clear()
    raf = []
    sim = []
    rend = []
    L = {
      level, seed: s, daytime: w.daytime, result: 'timeout', frames: 0,
      shield: { min: w.player.shield, final: w.player.shield, every50: [] },
      meter: { start: w.enemyMeter, end: w.enemyMeter, every50: [] },
      kills: {}, meterBySource: {}, shots: { gun: 0, handgun: 0, cannon: 0, missile: 0, flare: 0 },
      hits: { bullet: 0, shell: 0, missile: 0, soldier: 0 }, damageBySource: {}, prizes: {},
      ammo: { start: ammo(), end: {} },
      bot: { framesWithTarget: 0, framesFiring: 0, missilesCalled: 0, bombersCalled: false },
      frameMs: { rafAvg: 0, rafP95: 0, rafWorst: 0, simAvg: 0, simWorst: 0, renderAvg: 0, renderWorst: 0 },
      remaining: { targets: [], soldiers: 0 }, errors: [],
    }
    results.push(L)
  }

  function endLevel(result: Result) {
    input.button = false
    input.cx = 0
    L.result = result
    L.frames = w.frame
    L.shield.final = w.player.shield
    L.meter.end = w.enemyMeter
    L.ammo.end = ammo()
    const stat = (a: number[]) => {
      const s = [...a].sort((x, y) => x - y)
      const r = (n: number) => Math.round(n * 100) / 100
      return { avg: r(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)), p95: r(s[Math.floor(s.length * 0.95)] ?? 0), worst: r(s[s.length - 1] ?? 0) }
    }
    const r = stat(raf.slice(1)), si = stat(sim.slice(1)), re = stat(rend.slice(1))
    L.frameMs = { rafAvg: r.avg, rafP95: r.p95, rafWorst: r.worst, simAvg: si.avg, simWorst: si.worst, renderAvg: re.avg, renderWorst: re.worst }
    const v = new THREE.Vector3()
    L.remaining.targets = w.targets
      .filter(live)
      .map((t) => ({ shape: t.shape, slot: t.slot, pos: t.node.getWorldPosition(v).toArray().map(Math.round) }))
    L.remaining.soldiers = soldiers().filter((s) => s.active && s.state > 0 && s.state < 0x2a).length
    for (const [t, info] of targetInfo) t.hit = info.orig
    uploads.push(post(report(true)))
    phase = renderer ? 'shot' : 'play'
    if (!renderer) beginLevel()
  }

  async function finish() {
    phase = 'done'
    game.step = origStep
    game.frame = origFrame
    if (renderer && origRender) renderer.render = origRender
    delete wr.reduceEnemyMeter
    delete wr.damagePlayer
    delete wr.prize
    soldierPool.rayKill = origRayKill
    console.error = origConsoleError
    removeEventListener('error', onError)
    removeEventListener('unhandledrejection', onRejection)
    input.button = false
    input.cx = 0
    w.paused = true
    await Promise.all(uploads)
    const r = report(false)
    ;(window as unknown as { __autoplayReport: AutoplayReport }).__autoplayReport = r
    r.artifact = await post(r)
    opts.onDone(r)
  }

  function report(partial: boolean): AutoplayReport {
    return {
      startedAt, finishedAt: new Date().toISOString(), partial, seed, levels: opts.levels, speed, url: location.href,
      userAgent: navigator.userAgent, backend: bh?.backend, viewport: [innerWidth, innerHeight, devicePixelRatio],
      results, errors: globalErrors,
    }
  }

  /** Final reports get a timestamped file; partial ones (after each level) only refresh latest.json. */
  async function post(r: AutoplayReport) {
    try {
      const res = await fetch(r.partial ? '/__report?partial=1' : '/__report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) })
      const j = (await res.json()) as { path?: string; error?: string }
      return j.path ?? `error: ${j.error}`
    } catch (e) {
      return `error: ${(e as Error).message}`
    }
  }

  // ------------------------------------------------------------------ per tick (after Game.step)

  function tick() {
    if (phase === 'done') return
    if (phase === 'shot') {
      if (shotDone) beginLevel()
      return
    }
    observe()
    if (w.outcome !== 'playing') return endLevel(w.outcome)
    if (w.frame >= timeout) return endLevel('timeout')
    decide()
  }

  function observe() {
    const p = w.player
    L.shield.min = Math.min(L.shield.min, p.shield)
    if (w.frame % 50 === 0) {
      L.shield.every50.push(p.shield)
      L.meter.every50.push(Math.round(w.enemyMeter * 10) / 10)
    }
    for (const t of w.targets) {
      let info = targetInfo.get(t)
      if (!info) {
        const orig = t.hit
        const rec = { orig, wasAlive: false, hit: false }
        t.hit = (world, zone, weapon, point) => {
          L.hits[weapon]++
          if (t.shape === 'tank' && weapon !== 'bullet' && !wrecks.has(t)) {
            wrecks.add(t)
            bump(L.kills, 'tank')
          }
          rec.hit = true
          orig.call(t, world, zone, weapon, point)
        }
        targetInfo.set(t, (info = rec))
      }
      const alive = t.alive()
      if (info.wasAlive && !alive && info.hit) bump(L.kills, t.shape)
      if (!alive) info.hit = false
      info.wasAlive = alive
    }
    for (const s of soldiers()) {
      const was = soldierState.get(s)
      if (was !== undefined && was > 1 && was < 0x2a && !killable(s)) bump(L.kills, 'soldier')
      soldierState.set(s, s.active ? s.state : 0)
    }
    for (const pr of w.projectiles.list) {
      if (!pr.fromPlayer || seenProjectiles.has(pr)) continue
      seenProjectiles.add(pr)
      const k: Shot | null = pr.kind === 'bullet' ? (p.weapon === 2 ? 'handgun' : 'gun') : pr.kind === 'shell' ? 'cannon' : pr.kind === 'missile' ? 'missile' : pr.kind === 'flare' ? 'flare' : null
      if (k) L.shots[k]++
    }
  }

  function key(k: string) {
    dispatchEvent(new KeyboardEvent('keydown', { key: k }))
  }

  function contacts(): Contact[] {
    const out: Contact[] = []
    const seen = new Set<object>()
    const add = (key: object, kind: string, pos: THREE.Vector3) => {
      seen.add(key)
      const prev = prevPos.get(key)
      const vel = prev && prev.distanceTo(pos) < 1500 ? pos.clone().sub(prev) : new THREE.Vector3()
      prevPos.set(key, pos.clone())
      out.push({ key, kind, pos, vel })
    }
    for (const t of w.targets) {
      // Friendly bombers are never engaged.
      if (!live(t) || t.shape === 'bomber') continue
      const pos = t.node.getWorldPosition(new THREE.Vector3())
      if (GROUND.has(t.shape)) pos.y += 80
      add(t, t.shape, pos)
    }
    for (const s of soldiers()) if (killable(s)) add(s, 'soldier', new THREE.Vector3(s.x, s.y + 70, s.z))
    for (const k of prevPos.keys()) if (!seen.has(k)) prevPos.delete(k)
    return out
  }

  /** Straight-line terrain check from the mount to 95% of the way to p. */
  function clear(p: THREE.Vector3) {
    for (let f = 0.1; f <= 0.95; f += 0.05) {
      const x = M.x + (p.x - M.x) * f, y = M.y + (p.y - M.y) * f, z = M.z + (p.z - M.z) * f
      if (w.groundY(x, z) > y + 10) return false
    }
    return true
  }

  function weaponFor(kind: string): keyof typeof WEAPON | null {
    const a = w.player.ammo
    const railsLoaded = game.player.rails[0] || game.player.rails[1]
    if (GROUND.has(kind)) return a.cannon > 0 ? 'cannon' : railsLoaded ? 'missile' : null
    if (a.bullets > 0) return 'gun'
    if (a.handgun > 0 && (kind === 'soldier' || kind === 'parachute')) return 'handgun'
    return a.cannon > groundAlive() && kind !== 'soldier' ? 'cannon' : null
  }

  const groundAlive = () => w.targets.filter((t) => GROUND.has(t.shape) && live(t)).length
  /** Missiles not needed for live tanks and APCs once the cannon is used up. */
  function spareMissiles() {
    const rails = game.player.rails.filter(Boolean).length
    return w.player.ammo.missiles + rails - Math.max(0, groundAlive() - w.player.ammo.cannon)
  }

  const RANGE: Record<keyof typeof WEAPON, number> = { gun: 14000, handgun: 5000, cannon: 12000, missile: 9000 }

  /** Aim point (from the mount) that intercepts c with the given projectile, and the flight time. */
  function lead(c: Contact, wpn: keyof typeof WEAPON) {
    const { speed, gravity, muzzle } = WEAPON[wpn]
    let t = Math.max(1, (c.pos.distanceTo(M) - muzzle) / speed)
    const aim = new THREE.Vector3()
    for (let i = 0; i < 6; i++) {
      aim.copy(c.pos).addScaledVector(c.vel, t)
      aim.y += (gravity * t * (t - 1)) / 2
      t = Math.max(1, (aim.distanceTo(M) - muzzle) / speed)
    }
    return { aim, t }
  }

  function decide() {
    const p = w.player
    const list = contacts()
    const view = forward(p.yaw, p.pitch)
    let best: Contact | null = null, bestScore = Infinity, curScore = Infinity
    for (const c of list) {
      const wpn = weaponFor(c.kind)
      if (!wpn) continue
      const d = c.pos.distanceTo(M)
      if (d > RANGE[wpn] || d < 450) continue
      if ((GROUND.has(c.kind) || c.kind === 'soldier') && !clear(c.pos)) continue
      const close = c.kind === 'soldier' && d < 1500 ? 0.3 : 1
      const ang = Math.acos(THREE.MathUtils.clamp(view.dot(c.pos.clone().sub(M).normalize()), -1, 1)) / deg
      const score = d * PRIORITY[c.kind] * close + ang * 30
      if (target && c.key === target.key) curScore = score
      if (score < bestScore) {
        bestScore = score
        best = c
      }
    }
    if (target && curScore < Infinity && curScore <= bestScore * 1.5) best = list.find((c) => c.key === target!.key) ?? best
    target = best

    if (!w.daytime && p.ammo.flares > 0 && w.projectiles.count('flare') === 0 && w.frame - lastFlare > 150) {
      lastFlare = w.frame
      key('f')
    }
    if (p.bombersAvailable && soldiers().filter(killable).length >= 6) {
      L.bot.bombersCalled = true
      key('b')
    }
    if (!target) {
      input.button = false
      input.cx = 0
      return
    }
    L.bot.framesWithTarget++
    const wpn = weaponFor(target.kind)!
    const want: 0 | 1 | 2 = wpn === 'cannon' ? 1 : wpn === 'handgun' ? 2 : 0
    let switching = false
    if (wpn !== 'missile' && p.weapon !== want) {
      key(want === 2 ? 'g' : ' ')
      switching = true
    }

    const { aim } = lead(target, wpn)
    const dir = aim.clone().sub(M)
    const dist = dir.length()
    dir.normalize()
    const yaw = Math.atan2(-dir.x, -dir.z) / deg
    const pitch = THREE.MathUtils.clamp(Math.asin(dir.y) / deg, PITCH_MIN, PITCH_MAX)

    // Yaw is rate controlled (yaw -= cx * 0.02 per tick): one tick of exact correction, clamped like the cursor.
    input.cx = THREE.MathUtils.clamp(-wrapYaw(yaw - p.yaw) / 0.02, -320, 319)
    // Pitch follows cursor deltas (pitch -= dy * 0.2; Player's previous y is the current input.cy). When the cursor is pinned at an edge, sweep it to the
    // other edge once so the pitch clamp re-anchors the mapping, as a player re-gripping the mouse would.
    const cy0 = input.cy
    let cy = cy0 - (pitch - p.pitch) * 5
    if (cy < -240 && input.cy <= -239) cy = 239
    else if (cy > 239 && input.cy >= 239) cy = -240
    input.cy = THREE.MathUtils.clamp(cy, -240, 239)

    const nyaw = p.yaw - input.cx * 0.02
    const npitch = THREE.MathUtils.clamp(p.pitch - (input.cy - cy0) * 0.2, PITCH_MIN, PITCH_MAX)
    const err = Math.acos(THREE.MathUtils.clamp(forward(nyaw, npitch).dot(dir), -1, 1))
    const tol = Math.atan(SIZE[target.kind] / dist) * (wpn === 'gun' ? 1.5 : 1)
    const onTarget = err < tol

    if (wpn === 'missile') {
      input.button = false
      if (onTarget && w.frame - lastMissile > 45) {
        lastMissile = w.frame
        L.bot.missilesCalled++
        key('m')
      }
      return
    }
    // Missiles on aircraft in range when a rail is loaded and the ground vehicles do not need them.
    if (AIR.has(target.kind) && spareMissiles() > 0 && dist < 9000 && err < 5 * deg && (game.player.rails[0] || game.player.rails[1]) && w.frame - lastMissile > 45) {
      lastMissile = w.frame
      L.bot.missilesCalled++
      key('m')
    }
    const fire = onTarget && !switching
    // The handgun fires once per click: release every other tick.
    input.button = fire && (wpn !== 'handgun' || !input.button)
    if (input.button) L.bot.framesFiring++
  }

  beginLevel()
}
