import type { GameFS } from '../vfs'
import type { ShapeKind } from './constants'
import type { Sound, World } from './world'

// DirectSound replacement on Web Audio (docs/re/architecture.md §4, gameplay.md §8, FUN_0042ac3c,
// FUN_00424aef). Each WAV gets the original number of duplicate buffers ("voices"), cycled round robin.
// As in DirectSound, Play() on a voice that is still playing does nothing (no restart).

/** Voice counts in FUN_0042ac3c load order. Ricocht4.wav is never loaded. */
const VOICES: Record<string, number> = {
  AntiAir: 10, MachineGun: 10, Prize: 1, Metalbig: 1, Metalshort: 1, Ricocht1: 1, Ricocht2: 1, Ricocht3: 2,
  Pistol: 2, Rifle: 4, Missile: 2, CannonClose: 2, CannonFar: 2, ExClose: 4, ExFar: 4, ExMuffle: 6, ExHit: 2,
  ExBig: 1, Soldead1: 1, Soldead2: 1, Soldead3: 1, Soldead4: 1,
}

export const ENGINES = ['Tank', 'Truck', 'Jet', 'Bomber', 'Cobra', 'CH53', 'C130'] as const
export type EngineName = (typeof ENGINES)[number]

/** One candidate engine loop this frame. The loudest candidate per name wins. */
export interface EngineSource {
  name: EngineName
  /** DirectSound hundredths of dB (0 full, negative quieter). */
  volumeDb: number
}

/** Called once per frame from SoundSystem.update; returns the engines it wants audible. */
export type EngineProvider = (world: World) => EngineSource[]

/** Audible range and volume divisor per loop (FUN_00424aef): d = max(|x|, |z|), truncated. */
const ENGINE_RANGE: Record<EngineName, { max: number; shift: number }> = {
  Tank: { max: 6501, shift: 0 },
  Truck: { max: 6501, shift: 0 },
  Jet: { max: 30001, shift: 3 },
  C130: { max: 30001, shift: 3 },
  Bomber: { max: 18001, shift: 2 },
  Cobra: { max: 18001, shift: 2 },
  CH53: { max: 18001, shift: 2 },
}

/** Engine loop volume for a unit at (x, z), or null when out of range. Enemy modules can use this directly. */
export function engineSource(name: EngineName, x: number, z: number): EngineSource | null {
  const d = Math.max(Math.trunc(Math.abs(x)), Math.trunc(Math.abs(z)))
  const r = ENGINE_RANGE[name]
  return d < r.max ? { name, volumeDb: -(d >> r.shift) } : null
}

const SHAPE_ENGINE: Partial<Record<ShapeKind, EngineName>> = {
  tank: 'Tank', apc: 'Truck', jet: 'Jet', bomber: 'Bomber', cobra: 'Cobra', ch53: 'CH53', c130: 'C130',
}

/** Default provider: live registered targets (world.targets) by collision shape. */
export const targetEngines: EngineProvider = (w) => {
  const out: EngineSource[] = []
  for (const t of w.targets) {
    const name = SHAPE_ENGINE[t.shape]
    if (!name || !t.alive() || !t.node.visible || t.engineOn?.() === false) continue
    const e = t.node.matrixWorld.elements
    const s = engineSource(name, e[12], e[14])
    if (s) out.push(s)
  }
  return out
}

/** DirectSound volume (hundredths of dB, -10000..0) to linear gain. */
export const dbToGain = (db: number) => Math.pow(10, Math.max(-10000, Math.min(0, db)) / 2000)

interface Voice {
  gain: GainNode
  src: AudioBufferSourceNode | null
}

export class SoundSystem implements Sound {
  enabled = true
  readonly ctx: AudioContext
  /** Engine loop providers. Enemy modules push one, e.g. `sound.engineSources.push((w) => [...])`. */
  readonly engineSources: EngineProvider[] = [targetEngines]
  /** Buffer starts per sound name (debug/verification). */
  readonly starts: Record<string, number> = {}
  /** WAVs that failed to load or decode. */
  readonly failed: string[] = []
  readonly master: GainNode
  private buffers = new Map<string, AudioBuffer>()
  private voices = new Map<string, Voice[]>()
  private next = new Map<string, number>()
  private loops = new Map<EngineName, Voice>()

  private constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.connect(ctx.destination)
  }

  static async load(fs: GameFS) {
    const s = new SoundSystem(new AudioContext())
    const names = [...Object.keys(VOICES), ...ENGINES]
    await Promise.all(
      names.map(async (name) => {
        try {
          const bytes = await fs.read(`BH2Game/${name}.wav`)
          s.buffers.set(name, await s.ctx.decodeAudioData(bytes.slice().buffer))
        } catch (e) {
          s.failed.push(name)
          console.warn(`[sound] ${name}.wav: ${(e as Error).message}`)
        }
      }),
    )
    for (const [name, n] of Object.entries(VOICES)) s.voices.set(name, Array.from({ length: n }, () => s.voice()))
    for (const name of ENGINES) s.loops.set(name, s.voice())
    return s
  }

  private voice(): Voice {
    const gain = this.ctx.createGain()
    gain.connect(this.master)
    return { gain, src: null }
  }

  /** Browser autoplay policy: resume the context on the first user gesture. */
  unlock(target: EventTarget = window) {
    const resume = () => {
      if (this.ctx.state === 'running') return
      void this.ctx.resume()
    }
    for (const ev of ['pointerdown', 'keydown']) target.addEventListener(ev, resume)
  }

  private get live() {
    return this.enabled && this.ctx.state === 'running'
  }

  private start(v: Voice, name: string, loop: boolean) {
    const buf = this.buffers.get(name)
    if (!buf) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.loop = loop
    src.connect(v.gain)
    src.onended = () => {
      if (v.src === src) v.src = null
    }
    src.start()
    v.src = src
    this.starts[name] = (this.starts[name] ?? 0) + 1
  }

  private stop(v: Voice) {
    if (!v.src) return
    const src = v.src
    v.src = null
    src.onended = null
    src.stop()
    src.disconnect()
  }

  play(name: string, opts: { volumeDb?: number } = {}) {
    if (!this.live) return
    const list = this.voices.get(name)
    if (!list) return
    const i = this.next.get(name) ?? 0
    this.next.set(name, (i + 1) % list.length)
    const v = list[i]
    // SetVolume applies even when the voice is busy; Play then does nothing.
    v.gain.gain.value = dbToGain(opts.volumeDb ?? 0)
    if (!v.src) this.start(v, name, false)
  }

  /** Engine loops (FUN_00424aef), once per game frame: nearest unit per type sets the loop volume. */
  update(world: World) {
    if (!this.live) return
    const best = new Map<EngineName, number>()
    for (const provider of this.engineSources) {
      for (const s of provider(world)) best.set(s.name, Math.max(best.get(s.name) ?? -Infinity, s.volumeDb))
    }
    for (const [name, v] of this.loops) {
      const db = best.get(name)
      if (db === undefined) {
        this.stop(v)
        continue
      }
      v.gain.gain.value = dbToGain(db)
      if (!v.src) this.start(v, name, true)
    }
  }

  stopAll() {
    for (const list of this.voices.values()) for (const v of list) this.stop(v)
    for (const v of this.loops.values()) this.stop(v)
  }
}
