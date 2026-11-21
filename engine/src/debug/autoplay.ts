import * as THREE from 'three/webgpu'
import type { Game } from '../game/game'
import type { Target, World } from '../game/world'
import { GRAVITY, MOUNT, OUTCOME_FRAMES, PITCH_MAX, PITCH_MIN, SHAPE, deg } from '../game/constants'
import { forward, right } from '../game/player'
import type { Parachutes } from '../game/enemies/parachutes'

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
  bot: { framesWithTarget: number; framesFiring: number; missilesCalled: number; bombersCalled: boolean; engaged: Record<string, number> }
  frameMs: { rafAvg: number; rafP95: number; rafWorst: number; simAvg: number; simWorst: number; stepAvg: number; stepWorst: number; renderAvg: number; renderWorst: number }
  /** At the end: live targets and soldiers, to diagnose timeouts. */
  remaining: { targets: { shape: string; slot: number; pos: number[] }[]; soldiers: number; soldierRanges?: number[] }
  errors: string[]
  screenshot?: string
  /** Sanity problems seen during play (NaN positions, units under the terrain or far off the map), first 20. */
  anomalies: string[]
  /** Real time for the level and how many loop calls came from rAF vs the hidden-tab pump. */
  wall: { ms: number; rafCalls: number; pumpCalls: number }
  /** Set when the game itself started this level from the previous one's cleared banner: ticks from 'cleared' to the new level. */
  transitionTicks?: number
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
  /** Parachutes: what shooting it gives. */
  payload?: ReturnType<Parachutes['payloadAt']>
  /** Centre of the vital hit zone (part 0, a bullet kill) for aircraft. */
  vital?: THREE.Vector3
}

const M = new THREE.Vector3(MOUNT.x, MOUNT.y, MOUNT.z)
const AIR = new Set(['jet', 'cobra', 'c130', 'ch53'])
const GROUND = new Set(['tank', 'apc'])
/** Rough half-size used for the fire tolerance cone. */
const SIZE: Record<string, number> = { tank: 140, apc: 140, jet: 220, cobra: 220, ch53: 320, c130: 450, parachute: 40, soldier: 22 }
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
  // Test runs are silent (they run in the user's browser next to other tabs); sound stays off after the run.
  w.sound.enabled = false
  w.sound.stopAll()

  let index = -1
  let L!: LevelReport
  let raf: number[] = [], sim: number[] = [], rend: number[] = [], steps: number[] = []
  // shot: waiting for the level-end screenshot; wait: letting the game run its own cleared -> next level transition.
  let phase: 'play' | 'shot' | 'wait' | 'done' = 'play'
  let endTicks = 0
  let shotDone = false
  let target: Contact | null = null
  let lastMissile = -1000, lastFlare = -1000, lastHandgun = 0, lastBullets = 0, lastFlight = 0
  let lastShotAt: object | null = null
  /** Targets with a round in flight toward them: frame until which the bot waits before firing at them again. */
  const held = new Map<object, number>()
  const prevPos = new Map<object, THREE.Vector3>()
  const targetInfo = new Map<Target, { orig: Target['hit']; wasAlive: boolean; hit: boolean }>()
  // A destroyed tank stays active as a wreck that still blocks shots: alive() stays true, wrecked() tells them apart.
  const live = (t: Target) => t.alive() && !t.wrecked?.()
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

  // Every level start (ours or the game's own transition) is seeded with seed + n, so each level replays alone.
  const origStart = game.startLevel
  game.startLevel = (n: number) => {
    w.rng.seed(seed + n)
    origStart.call(game, n)
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
    const t0 = performance.now()
    origStep.call(game)
    steps.push(performance.now() - t0)
    try {
      tick()
    } catch (e) {
      err(`autoplay: ${(e as Error).stack ?? e}`)
    }
  }
  // A hidden or occluded tab gets no rAF (another tab or window is in front): keep the real loop running from a
  // MessageChannel pump, without rendering, whenever no frame was rendered for 200 ms. Screenshots are skipped then.
  let lastRender = performance.now()
  const pump = new MessageChannel()
  pump.port1.onmessage = () => {
    if (phase === 'done') return
    const now = performance.now()
    if (!document.hidden && now - lastRender < 200) {
      setTimeout(() => pump.port2.postMessage(0), 100)
      return
    }
    if (phase === 'shot' && !shotDone) {
      shotDone = true
      L.screenshot = 'skipped: tab not rendering'
    }
    if (now - lastReal >= 8) {
      game.frame(now)
      if (L) L.wall.pumpCalls++
    }
    pump.port2.postMessage(0)
  }
  pump.port2.postMessage(0)
  const origRender = renderer?.render
  if (renderer && origRender) {
    renderer.render = (...a: Parameters<THREE.WebGPURenderer['render']>) => {
      const t0 = performance.now()
      lastRender = t0
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

  function beginLevel(startedByGame = false) {
    index++
    if (index >= opts.levels.length) return finish()
    const level = opts.levels[index]
    const s = seed + level
    if (!startedByGame) {
      w.paused = false
      game.startLevel(level)
    }
    phase = 'play'
    shotDone = false
    target = null
    // Cooldowns are in level frames, which restart at 0.
    lastMissile = lastFlare = -1000
    lastHandgun = w.player.ammo.handgun
    lastBullets = w.player.ammo.bullets
    lastShotAt = null
    held.clear()
    prevPos.clear()
    targetInfo.clear()
    soldierState.clear()
    raf = []
    sim = []
    rend = []
    steps = []
    L = {
      level, seed: s, daytime: w.daytime, result: 'timeout', frames: 0,
      shield: { min: w.player.shield, final: w.player.shield, every50: [] },
      meter: { start: w.enemyMeter, end: w.enemyMeter, every50: [] },
      kills: {}, meterBySource: {}, shots: { gun: 0, handgun: 0, cannon: 0, missile: 0, flare: 0 },
      hits: { bullet: 0, shell: 0, missile: 0, soldier: 0 }, damageBySource: {}, prizes: {},
      ammo: { start: ammo(), end: {} },
      bot: { framesWithTarget: 0, framesFiring: 0, missilesCalled: 0, bombersCalled: false, engaged: {} },
      frameMs: { rafAvg: 0, rafP95: 0, rafWorst: 0, simAvg: 0, simWorst: 0, stepAvg: 0, stepWorst: 0, renderAvg: 0, renderWorst: 0 },
      remaining: { targets: [], soldiers: 0 }, errors: [], anomalies: [], wall: { ms: performance.now(), rafCalls: 0, pumpCalls: 0 },
    }
    if (startedByGame) L.transitionTicks = endTicks
    results.push(L)
  }

  /** After the screenshot: a cleared level followed by the next number is left to the game's own 150-frame transition. */
  function nextLevel() {
    if (L.result === 'cleared' && opts.levels[index + 1] === L.level + 1) phase = 'wait'
    else beginLevel()
  }

  function endLevel(result: Result) {
    input.button = false
    input.cx = 0
    L.result = result
    L.frames = w.frame
    L.wall.ms = Math.round(performance.now() - L.wall.ms)
    L.wall.rafCalls = raf.length - L.wall.pumpCalls
    L.shield.final = w.player.shield
    L.meter.end = w.enemyMeter
    L.ammo.end = ammo()
    const stat = (a: number[]) => {
      const s = [...a].sort((x, y) => x - y)
      const r = (n: number) => Math.round(n * 100) / 100
      return { avg: r(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)), p95: r(s[Math.floor(s.length * 0.95)] ?? 0), worst: r(s[s.length - 1] ?? 0) }
    }
    const r = stat(raf.slice(1)), si = stat(sim.slice(1)), st = stat(steps.slice(1)), re = stat(rend.slice(1))
    L.frameMs = { rafAvg: r.avg, rafP95: r.p95, rafWorst: r.worst, simAvg: si.avg, simWorst: si.worst, stepAvg: st.avg, stepWorst: st.worst, renderAvg: re.avg, renderWorst: re.worst }
    const v = new THREE.Vector3()
    L.remaining.targets = w.targets
      .filter(live)
      .map((t) => ({ shape: t.shape, slot: t.slot, pos: t.node.getWorldPosition(v).toArray().map(Math.round) }))
    const left = soldiers().filter((s) => s.active && s.state > 0 && s.state < 0x2a)
    L.remaining.soldiers = left.length
    L.remaining.soldierRanges = left.map((s) => Math.round(Math.hypot(s.x, s.z)))
    for (const [t, info] of targetInfo) t.hit = info.orig
    uploads.push(post(report(true)))
    endTicks = 0
    phase = renderer ? 'shot' : 'play'
    if (!renderer) nextLevel()
  }

  async function finish() {
    phase = 'done'
    game.step = origStep
    game.frame = origFrame
    game.startLevel = origStart
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
    if (phase === 'shot' || phase === 'wait') {
      endTicks++
      if (phase === 'shot' && shotDone) nextLevel()
      if (phase !== 'wait') return
      if (w.levelNumber === L.level + 1 && w.outcome === 'playing') beginLevel(true)
      else if (endTicks > OUTCOME_FRAMES + 30) {
        err(`level ${L.level}: no transition to ${L.level + 1} after ${endTicks} ticks`)
        beginLevel()
      }
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
      sanity()
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
          const was = live(t)
          rec.hit = true
          orig.call(t, world, zone, weapon, point)
          if (was && t.wrecked?.()) bump(L.kills, t.shape)
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

  function sanity() {
    const bad = (m: string) => L.anomalies.length < 20 && !L.anomalies.some((a) => a.endsWith(m)) && L.anomalies.push(`f${w.frame} ${m}`)
    const v = new THREE.Vector3()
    for (const t of w.targets) {
      if (!t.alive()) continue
      t.node.getWorldPosition(v)
      const id = `${t.shape}#${t.slot}`
      if (![v.x, v.y, v.z].every(Number.isFinite)) bad(`${id} NaN position`)
      // A vehicle spawned this frame is placed by its first AI frame; until then it sits at the origin.
      else if (GROUND.has(t.shape) && (v.x !== 0 || v.z !== 0) && Math.abs(v.y - w.groundY(v.x, v.z)) > 150) bad(`${id} ${Math.round(v.y - w.groundY(v.x, v.z))} off the ground`)
      else if (t.shape !== 'bomber' && (Math.abs(v.x) > 70000 || Math.abs(v.z) > 70000)) bad(`${id} off the map`)
    }
    for (const s of soldiers()) {
      if (!s.active) continue
      if (![s.x, s.y, s.z].every(Number.isFinite)) bad('soldier NaN position')
      else if (s.state > 0x10 && s.state < 0x2a && Math.abs(s.y - w.groundY(s.x, s.z)) > 50) bad(`soldier state ${s.state} ${Math.round(s.y - w.groundY(s.x, s.z))} off the ground`)
      else if (Math.abs(s.x) > 16000 || Math.abs(s.z) > 16000) bad('soldier off the map')
    }
  }

  function key(k: string) {
    dispatchEvent(new KeyboardEvent('keydown', { key: k }))
  }

  function contacts(): Contact[] {
    const out: Contact[] = []
    const seen = new Set<object>()
    const add = (key: object, kind: string, pos: THREE.Vector3, extra: Partial<Contact> = {}) => {
      seen.add(key)
      const prev = prevPos.get(key)
      const vel = prev && prev.distanceTo(pos) < 1500 ? pos.clone().sub(prev) : new THREE.Vector3()
      prevPos.set(key, pos.clone())
      out.push({ key, kind, pos, vel, ...extra })
    }
    for (const t of w.targets) {
      // Friendly bombers are never engaged; nor are parked APC1s that already unloaded (harmless, worth nothing).
      if (!live(t) || t.shape === 'bomber' || !worthShooting(t)) continue
      // Aim at the ShapeData hit volume, not the node origin: the cobra and CH53 volumes hang below it and the
      // parachute's is the payload 180..300 below the canopy.
      const box = boxes.get(t.shape)!
      const pos = t.node.localToWorld(box.all.clone())
      add(t, t.shape, pos, { payload: t.shape === 'parachute' ? chutes?.payloadAt(t.slot) : undefined, vital: AIR.has(t.shape) ? t.node.localToWorld(box.vital.clone()) : undefined })
    }
    for (const s of soldiers()) if (killable(s)) add(s, 'soldier', new THREE.Vector3(s.x, s.y + 70, s.z))
    for (const k of prevPos.keys()) if (!seen.has(k)) prevPos.delete(k)
    return out
  }

  function shielded(p: THREE.Vector3, d: number) {
    const dir = p.clone().sub(M).normalize()
    return !!w.collision.ray(w.targets, M, dir, d, (t) => GROUND.has(t.shape))
  }

  /** Straight-line terrain check from the mount to 95% of the way to p. */
  function clear(p: THREE.Vector3) {
    for (let f = 0.1; f <= 0.95; f += 0.05) {
      const x = M.x + (p.x - M.x) * f, y = M.y + (p.y - M.y) * f, z = M.z + (p.z - M.z) * f
      if (w.groundY(x, z) > y + 10) return false
    }
    return true
  }

  type Wpn = keyof typeof WEAPON
  const air = w.enemies.find((e) => 'parachutes' in e) as unknown as { parachutes?: Parachutes; c130Load?(slot: number): { troops: number; crates: number } | null } | undefined
  const chutes = air?.parachutes
  const groundSys = w.enemies.find((e) => 'vehicleAt' in e) as unknown as { vehicleAt(slot: number): { kind: string; troops: boolean } | null } | undefined
  /** Hit-volume centres per shape (local): all parts, and part 0 (the vital zone), plus part 0's smallest half extent. */
  const boxes = new Map<string, { all: THREE.Vector3; vital: THREE.Vector3; vitalHalf: number; vitalPolys: THREE.Vector3[] }>()
  for (const [kind, i] of Object.entries(SHAPE)) {
    const parts = w.shapes.objects[i]?.parts ?? []
    const box = (ps: typeof parts) => new THREE.Box3().setFromPoints(ps.flatMap((p) => p.polygons.flatMap((q) => q.vertices.map((v) => new THREE.Vector3(...v)))))
    const all = box(parts), vital = box(parts.filter((p) => p.index === 0))
    const half = vital.getSize(new THREE.Vector3()).multiplyScalar(0.5)
    const vitalPolys = parts.filter((p) => p.index === 0).flatMap((p) => p.polygons.map((q) => q.vertices.reduce((a, v) => a.add(new THREE.Vector3(...v)), new THREE.Vector3()).divideScalar(q.vertices.length)))
    boxes.set(kind, { all: all.getCenter(new THREE.Vector3()), vital: vital.getCenter(new THREE.Vector3()), vitalHalf: Math.min(half.x, half.y, half.z), vitalPolys })
  }
  /** A point on the vital zone that a ray from the mount reaches first (other parts often shield the zone's centre). */
  function vitalAim(t: Target) {
    const box = boxes.get(t.shape)!
    const dir = new THREE.Vector3()
    for (const c of box.vitalPolys) {
      const p = t.node.localToWorld(c.clone())
      dir.subVectors(p, M)
      const len = dir.length()
      dir.divideScalar(len)
      if (w.collision.ray([t], M, dir, len + 400)?.zone === 0) return p
    }
    return t.node.localToWorld(box.vital.clone())
  }

  /** Tanks, APC2/3 (they shoot, and give 5 even when empty) and APC1s with troops aboard. */
  function worthShooting(t: Target) {
    if (t.shape !== 'apc') return true
    const v = groundSys?.vehicleAt(t.slot)
    return !v || v.kind !== 'APC1' || v.troops
  }
  const apc1Loaded = () => w.targets.filter((t) => t.shape === 'apc' && live(t) && groundSys?.vehicleAt(t.slot)?.kind === 'APC1' && worthShooting(t)).length
  /** Cannon shells and missiles (loaded rails included) for tanks and APCs. */
  const antiTank = () => w.player.ammo.cannon + w.player.ammo.missiles + game.player.rails.filter(Boolean).length
  const needAmmo = () => {
    const a = w.player.ammo
    return a.bullets < 150 || a.cannon < atNeed() + 2 || a.missiles + game.player.rails.filter(Boolean).length < 2
  }
  /** Supply crates in the air, aboard a C130, or on a C130 still to come in this level's script. */
  const cratesComing = () =>
    w.targets.some((t) => live(t) && ((t.shape === 'parachute' && chutes?.payloadAt(t.slot) !== 'trooper') || (t.shape === 'c130' && (air?.c130Load?.(t.slot)?.crates ?? 0) > 0))) ||
    w.level.groups.some((g) => g.units.some((u) => u.slotType === 'C130' && u.spawns && u.delay !== null && u.delay > w.frame))
  const railsLoaded = () => game.player.rails[0] || game.player.rails[1]
  /** Tanks and APC2/3 still to come in this level's script (they will need anti-tank rounds too). */
  const pendingGround = () =>
    w.level.groups.reduce((n, g) => n + g.units.filter((u) => (u.slotType === 'TANK' || u.slotType === 'APC2' || u.slotType === 'APC3') && u.spawns && u.delay !== null && u.delay > w.frame).length, 0)
  /** Ground units that need a shell or missile: live ones worth shooting plus scripted arrivals. */
  const groundAlive = () => w.targets.filter((t) => GROUND.has(t.shape) && live(t) && worthShooting(t)).length + pendingGround()
  /** Anti-tank rounds still needed: loaded APC1s count only while there are rounds for them too (otherwise they are left to unload). */
  function atNeed() {
    const all = groundAlive(), apc1 = apc1Loaded()
    return antiTank() >= all ? all : all - apc1
  }
  /** Cannon shells beyond what the live tanks and APCs need. */
  const spareCannon = () => w.player.ammo.cannon - atNeed()
  /** Missiles not needed for live tanks and APCs once the cannon is used up. */
  function spareMissiles() {
    const rails = game.player.rails.filter(Boolean).length
    return w.player.ammo.missiles + rails - Math.max(0, atNeed() - w.player.ammo.cannon)
  }
  /** Soldiers within a shell's 400 blast of c. */
  const crowd = (c: Contact, list: Contact[]) =>
    list.filter((o) => o.kind === 'soldier' && Math.hypot(o.pos.x - c.pos.x, o.pos.z - c.pos.z) < 380).length

  /** Weapon and engagement range for a contact, or null when nothing sensible can hit it. */
  function plan(c: Contact, list: Contact[]): { wpn: Wpn; range: number } | null {
    const a = w.player.ammo
    const d = c.pos.distanceTo(M)
    const missile = railsLoaded() && spareMissiles() > 0
    // With nothing else left, the handgun is the only way to shoot down supply crates (and running it dry ends the game).
    const dry = a.bullets <= 0 && a.cannon <= 0 && a.missiles <= 0 && !railsLoaded()
    // The last round never goes anywhere but a crate: firing it with nothing else left triggers the ammo-out loss.
    const reserve = dry && (a.handgun <= 1 || cratesComing())
    if (c.kind === 'c130') {
      // A C130 is only worth its troops; shooting it before it drops the crates throws the supplies away.
      const load = air?.c130Load?.((c.key as Target).slot)
      if (load && (load.troops === 0 || (load.crates > 0 && needAmmo()))) return null
    }
    if (GROUND.has(c.kind)) {
      // Short of anti-tank rounds: leave loaded APC1s to unload (their troops die to bullets) and save rounds for the rest.
      const v = c.kind === 'apc' ? groundSys?.vehicleAt((c.key as Target).slot) : null
      if (v?.kind === 'APC1' && antiTank() < groundAlive()) return null
      return a.cannon > 0 ? { wpn: 'cannon', range: 12000 } : railsLoaded() ? { wpn: 'missile', range: 9000 } : null
    }
    if (c.kind === 'soldier') {
      // Shell and missile ground blasts kill every soldier within 400: use them on groups, and on anyone once the guns are dry.
      const gunsDry = a.bullets <= 0 && (a.handgun <= 0 || d > 2500)
      if (spareCannon() > 0 && (crowd(c, list) >= 3 || gunsDry)) return { wpn: 'cannon', range: 9000 }
      if (a.bullets > 0) return { wpn: 'gun', range: 6000 }
      if (a.handgun > 0 && d < 2500 && !reserve) return { wpn: 'handgun', range: 2500 }
      if (a.cannon > 0) return { wpn: 'cannon', range: 9000 }
      // A homing missile is a sure aircraft kill (10): spend it on soldiers only in groups or with no aircraft left.
      const airLeft = list.some((o) => o.kind === 'jet' || o.kind === 'cobra' || o.kind === 'ch53')
      return missile && (crowd(c, list) >= 3 || !airLeft) ? { wpn: 'missile', range: 6000 } : null
    }
    if (c.kind === 'parachute') {
      if (c.payload === 'none') return null
      if (a.bullets > 0) return { wpn: 'gun', range: 7000 }
      if (a.handgun <= 0) return null
      return c.payload === 'trooper' ? (reserve ? null : { wpn: 'handgun', range: 2500 }) : { wpn: 'handgun', range: 7000 }
    }
    if (a.bullets > 0) return { wpn: 'gun', range: c.kind === 'c130' ? 10000 : 8000 }
    if (spareCannon() > 0) return { wpn: 'cannon', range: 8000 }
    if (missile && spareMissiles() > 1) return { wpn: 'missile', range: 9000 }
    return a.handgun > 0 && !reserve && c.kind !== 'c130' ? { wpn: 'handgun', range: 3000 } : null
  }

  /** Lower = engaged first (multiplies distance). */
  function priority(c: Contact, d: number) {
    const a = w.player.ammo
    if (c.kind === 'soldier') return d < 2500 ? 0.25 : 1
    if (c.kind === 'parachute') {
      if (c.payload === 'trooper') return 1.1
      const want =
        (c.payload === 'health' && w.player.shield < 80) ||
        (c.payload === 'bullets' && a.bullets < 150) ||
        (c.payload === 'cannon' && a.cannon < atNeed() + 4) ||
        (c.payload === 'missiles' && a.missiles < 4)
      return want ? 0.3 : 1.2
    }
    // Jets and cobras closing on the bunker (attack runs) come first.
    if ((c.kind === 'jet' || c.kind === 'cobra') && d < 10000 && c.vel.dot(M.clone().sub(c.pos).normalize()) > c.vel.length() * 0.7) return 0.3
    return PRIORITY[c.kind]
  }

  /** Aim point (from the mount) that intercepts c with the given projectile, and the flight time. */
  function lead(c: Contact, wpn: Wpn, at: THREE.Vector3) {
    const { speed, gravity, muzzle } = WEAPON[wpn]
    let t = Math.max(1, (at.distanceTo(M) - muzzle) / speed)
    const aim = new THREE.Vector3()
    // Parachute payloads swing on a pendulum: predict them exactly instead of extrapolating.
    const chute = c.kind === 'parachute' && chutes ? (c.key as Target).slot : 0
    for (let i = 0; i < 6; i++) {
      if (chute) chutes!.predict(chute, Math.round(t), boxes.get('parachute')!.all, aim)
      else aim.copy(at).addScaledVector(c.vel, t)
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
    const plans = new Map<Contact, { wpn: Wpn; range: number }>()
    for (const c of list) {
      const pl = plan(c, list)
      if (!pl) continue
      const d = c.pos.distanceTo(M)
      if (d > pl.range || d < 450) continue
      if ((GROUND.has(c.kind) || c.kind === 'soldier') && !clear(c.pos)) continue
      // Vehicles (wrecks included) stop bullets: skip soldiers standing behind one.
      if (c.kind === 'soldier' && (pl.wpn === 'gun' || pl.wpn === 'handgun') && shielded(c.pos, d)) continue
      plans.set(c, pl)
      const ang = Math.acos(THREE.MathUtils.clamp(view.dot(c.pos.clone().sub(M).normalize()), -1, 1)) / deg
      const score = (d * priority(c, d) + ang * 30) * ((held.get(c.key) ?? 0) > w.frame ? 3 : 1)
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
    const troops = list.filter((c) => c.kind === 'soldier')
    if (p.bombersAvailable && (troops.length >= 6 || troops.filter((c) => c.pos.distanceTo(M) < 2500).length >= 3)) {
      L.bot.bombersCalled = true
      key('b')
    }
    if (!target) {
      input.button = false
      input.cx = 0
      return
    }
    L.bot.framesWithTarget++
    const { wpn } = plans.get(target)!
    bump(L.bot.engaged, `${target.kind}:${wpn}`)
    const want: 0 | 1 | 2 = wpn === 'cannon' ? 1 : wpn === 'handgun' ? 2 : 0
    let switching = false
    if (wpn !== 'missile' && p.weapon !== want) {
      key(want === 2 ? 'g' : ' ')
      switching = true
    }

    // Blast weapons on soldiers aim at the feet. The default twin gun fires 30 to each side of the sight line and the soldier
    // ray test is 30 wide: aim 15 beside the soldier so the left barrel's line crosses him.
    const bulletOnAir = (wpn === 'gun' || wpn === 'handgun') && !!target.vital
    const at = bulletOnAir ? vitalAim(target.key as Target) : target.pos.clone()
    const blast = target.kind === 'soldier' && (wpn === 'cannon' || wpn === 'missile')
    if (blast) at.y -= 70
    const twin = target.kind === 'soldier' && wpn === 'gun' && w.level.altGun === 0
    if (twin) at.add(right(Math.atan2(-(at.x - M.x), -(at.z - M.z)) / deg).multiplyScalar(15))
    // Missiles leave from a rail 100 to the side (left rail first) and fly parallel to the sight line; homing only works on
    // aircraft, so shift the sight line for ground shots.
    if (wpn === 'missile' && !AIR.has(target.kind)) at.add(right(Math.atan2(-(at.x - M.x), -(at.z - M.z)) / deg).multiplyScalar(game.player.rails[0] ? 100 : -100))
    const { aim, t: flight } = lead(target, wpn, at)
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
    const size = blast ? 250 : twin ? 12 : wpn === 'handgun' && target.kind === 'parachute' ? 28 : wpn === 'handgun' && bulletOnAir ? Math.max(25, boxes.get(target.kind)!.vitalHalf) : SIZE[target.kind]
    // Loose gun cone (1.5x) only while bullets are plentiful; when scarce, aircraft shots wait for the vital zone.
    const scarce = p.ammo.bullets < 120
    const gunSize = wpn === 'gun' && bulletOnAir && scarce ? Math.max(40, boxes.get(target.kind)!.vitalHalf * 2) : size
    const tol = Math.atan(gunSize / dist) * (wpn === 'gun' && target.kind !== 'soldier' && !scarce ? 1.5 : 1)
    const onTarget = err < tol

    // Keys are handled before the aim moves (Player.keys runs before Player.update), so 'm' fires along the current aim.
    const errNow = Math.acos(THREE.MathUtils.clamp(forward(p.yaw, p.pitch).dot(dir), -1, 1))
    if (wpn === 'missile') {
      input.button = false
      if (errNow < tol && w.frame - lastMissile > 45) {
        lastMissile = w.frame
        L.bot.missilesCalled++
        key('m')
      }
      return
    }
    // Missiles on aircraft in range when a rail is loaded and the ground vehicles do not need them (with a margin for misses).
    const cadence = spareMissiles() > 6 ? 20 : 45
    if (AIR.has(target.kind) && (spareMissiles() > 2 || (p.ammo.bullets <= 0 && spareMissiles() > 1)) && dist < 9000 && errNow < 5 * deg && railsLoaded() && w.frame - lastMissile > cadence) {
      lastMissile = w.frame
      L.bot.missilesCalled++
      key('m')
    }
    // A round already on its way to this target will kill it or miss; with scarce ammo (and always on soldiers, whose
    // bodies stop later bullets) wait for it to arrive before firing again.
    const roundOut = p.ammo.bullets < lastBullets || p.ammo.handgun < lastHandgun
    if (roundOut && lastShotAt) held.set(lastShotAt, w.frame + Math.ceil(lastFlight) + 1)
    const careful = target.kind === 'soldier' || wpn === 'handgun' || p.ammo.bullets < 120
    // Cobras hover during gun attacks: with scarce rounds, shoot them only then (or up close).
    const patience = careful && target.kind === 'cobra' && target.vel.length() > 8 && dist > 2000
    const waiting = (careful && (held.get(target.key) ?? 0) > w.frame) || patience
    const fire = onTarget && !switching && !waiting
    // The handgun fires once per click, and only on its 4-tick counter: hold until the round leaves, then release one tick.
    const fired = p.ammo.handgun < lastHandgun
    lastHandgun = p.ammo.handgun
    lastBullets = p.ammo.bullets
    input.button = fire && (wpn !== 'handgun' || !fired)
    lastShotAt = input.button ? target.key : null
    lastFlight = flight
    if (input.button) L.bot.framesFiring++
  }

  beginLevel()
}
