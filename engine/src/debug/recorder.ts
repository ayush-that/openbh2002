import * as THREE from 'three/webgpu'
import type { Game } from '../game/game'

// Dev-only video recorder (docs/dev/video.md). Renders the game at a fixed 1920x1080, composites the WebGPU canvas,
// the HUD canvas and any visible overlay canvases (the front-end menu) into one 2D canvas right after each render
// (a WebGPU canvas cannot be read after it is presented), mixes the game and menu Web Audio output, and records
// with MediaRecorder. Chunks are appended to artifacts/video/<name> through the dev server's POST /__video.

export interface RecorderOptions {
  renderer: THREE.WebGPURenderer
  game: Game
  /** Object whose render() draws a frame (VisualMode). Its render is wrapped; without it renderer.render is. */
  vm?: { render(): void }
  /** Game SoundSystem (world.sound): its ctx is the mixer and its master gain is tapped. */
  sound?: unknown
  /** File name prefix (letters, digits, - _ .). */
  name?: string
  width?: number
  height?: number
  fps?: number
  videoBitsPerSecond?: number
  /** Also play the audio through the speakers while the recorder exists (default false: recorder only). */
  speakers?: boolean
}

export interface RecordingResult {
  path: string
  mime: string
  bytes: number
  frames: number
  seconds: number
  errors: string[]
}

const MIME = [
  'video/mp4;codecs=avc1.64002A,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

type Connect = (this: AudioNode, dest: AudioNode | AudioParam, output?: number, input?: number) => AudioNode | void

export class Recorder {
  readonly W: number
  readonly H: number
  readonly mime: string
  private o: RecorderOptions
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private track: CanvasCaptureMediaStreamTrack
  private mix: AudioContext
  private dest: MediaStreamAudioDestinationNode
  private taps = new Map<BaseAudioContext, AudioNode>()
  private tapped = new Map<AudioNode, AudioNode>()
  /** Nodes taken off the speakers while recording; reconnected on stop. */
  private muted = new Set<AudioNode>()
  private origConnect: Connect | null = null
  private mr: MediaRecorder
  private state: 'idle' | 'recording' | 'paused' | 'stopped' = 'idle'
  private file: string
  private part = 0
  private bytes = 0
  private uploads: Promise<void> = Promise.resolve()
  private errors: string[] = []
  private frames = 0
  private lastCapture = 0
  private recordedMs = 0
  private resumedAt = 0
  private restore: (() => void)[] = []

  constructor(o: RecorderOptions) {
    this.o = o
    this.W = o.width ?? 1920
    this.H = o.height ?? 1080
    this.canvas.width = this.W
    this.canvas.height = this.H
    this.ctx = this.canvas.getContext('2d', { alpha: false })!
    this.track = this.canvas.captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack

    // Audio: the game's AudioContext mixes everything; other contexts (menu music) are bridged in through MediaStreams.
    const sound = o.sound as { ctx?: AudioContext; master?: AudioNode } | undefined
    this.mix = sound?.ctx ?? new AudioContext({ sampleRate: 48000 })
    this.dest = this.mix.createMediaStreamDestination()
    this.taps.set(this.mix, this.dest)
    if (sound?.master) {
      this.tap(sound.master)
      if (!o.speakers) this.mute(sound.master)
    }
    else if (sound) this.errors.push('sound.master not reachable: game audio is not recorded')
    this.patchConnect()

    this.mime = MIME.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
    const stream = new MediaStream([this.track, ...this.dest.stream.getAudioTracks()])
    this.mr = new MediaRecorder(stream, { mimeType: this.mime || undefined, videoBitsPerSecond: o.videoBitsPerSecond ?? 20_000_000, audioBitsPerSecond: 256_000 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.file = `${(o.name ?? 'take').replace(/[^\w.-]/g, '_')}-${stamp}.${this.mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`
    this.mr.ondataavailable = (e) => {
      if (e.data.size) this.upload(e.data)
    }
    this.mr.onerror = (e) => this.errors.push(`MediaRecorder: ${(e as ErrorEvent).message ?? e.type}`)
    this.hookRender()
  }

  /** Start (first call) or resume recording. Resolves once the audio mixer is running (or after 1 s). */
  async resume() {
    if (this.state === 'stopped') throw new Error('recorder stopped')
    if (this.mix.state !== 'running') {
      await Promise.race([this.mix.resume(), new Promise((r) => setTimeout(r, 1000))])
      if ((this.mix.state as AudioContextState) !== 'running') this.errors.push(`audio context ${this.mix.state}: needs a user gesture`)
    }
    if (this.state === 'idle') this.mr.start(1000)
    else if (this.state === 'paused') this.mr.resume()
    this.state = 'recording'
    this.resumedAt = performance.now()
    this.lastCapture = 0
  }

  pause() {
    if (this.state !== 'recording') return
    this.mr.pause()
    this.state = 'paused'
    this.recordedMs += performance.now() - this.resumedAt
  }

  get recording() {
    return this.state === 'recording'
  }

  /** Finish the file and restore the renderer, canvas and audio wiring. */
  async stop(): Promise<RecordingResult> {
    if (this.state === 'recording') this.recordedMs += performance.now() - this.resumedAt
    if (this.state !== 'idle' && this.state !== 'stopped') {
      const stopped = new Promise((r) => (this.mr.onstop = r))
      this.mr.stop()
      await stopped
    }
    this.state = 'stopped'
    await this.uploads
    this.dispose()
    return { path: `artifacts/video/${this.file}`, mime: this.mime, bytes: this.bytes, frames: this.frames, seconds: Math.round(this.recordedMs) / 1000, errors: this.errors }
  }

  // ------------------------------------------------------------------ internals

  private upload(blob: Blob) {
    const part = this.part++
    this.uploads = this.uploads.then(async () => {
      try {
        const r = await fetch(`/__video?name=${encodeURIComponent(this.file)}&part=${part}`, { method: 'POST', body: blob })
        const j = (await r.json()) as { bytes?: number; error?: string }
        if (!r.ok) throw new Error(j.error ?? r.statusText)
        this.bytes = j.bytes ?? this.bytes
      } catch (e) {
        this.errors.push(`upload part ${part}: ${(e as Error).message}`)
      }
    })
  }

  /** Mirror a node that feeds a context's speakers into the recording mix. */
  private tap(node: AudioNode) {
    if (this.tapped.has(node)) return
    let t = this.taps.get(node.context)
    if (!t) {
      // Another context (menu music): bridge it into the mixer context through a MediaStream.
      const out = (node.context as AudioContext).createMediaStreamDestination()
      this.mix.createMediaStreamSource(out.stream).connect(this.dest)
      this.taps.set(node.context, (t = out))
    }
    this.tapped.set(node, t)
    this.origConnect ? this.origConnect.call(node, t) : node.connect(t)
  }

  private mute(node: AudioNode) {
    try {
      node.disconnect(node.context.destination)
    } catch {
      // was not connected to the speakers
    }
    this.muted.add(node)
  }

  /** Nodes connected to any AudioDestinationNode while recording (e.g. the menu music, created on unlock) are tapped too. */
  private patchConnect() {
    const proto = AudioNode.prototype as unknown as { connect: Connect }
    const orig = proto.connect
    this.origConnect = orig
    const self = this
    proto.connect = function (this: AudioNode, dest, output?: number, input?: number) {
      if (!(dest instanceof AudioDestinationNode)) return orig.call(this, dest, output, input)
      self.tap(this)
      if (self.o.speakers) return orig.call(this, dest, output, input)
      self.muted.add(this)
      return dest
    }
    this.restore.push(() => {
      proto.connect = orig
      this.origConnect = null
    })
  }

  private hookRender() {
    const { renderer, vm } = this.o
    const self = this
    if (vm) {
      const own = Object.getOwnPropertyDescriptor(vm, 'render')
      const orig = vm.render
      vm.render = function (this: unknown) {
        self.fitRenderer()
        orig.call(vm)
        self.capture()
      }
      this.restore.push(() => (own ? Object.defineProperty(vm, 'render', own) : delete (vm as { render?: unknown }).render))
    } else {
      const orig = renderer.render
      renderer.render = (...a: Parameters<THREE.WebGPURenderer['render']>) => {
        this.fitRenderer()
        const out = orig.apply(renderer, a)
        this.capture()
        return out
      }
      this.restore.push(() => (renderer.render = orig))
    }
    const el = renderer.domElement
    const css = el.style.cssText
    this.restore.push(() => {
      el.style.cssText = css
      // main.ts's resize handler puts the renderer size and camera aspect back.
      dispatchEvent(new Event('resize'))
    })
  }

  /** Keep the drawing buffer at W x H (VisualMode may change the pixel ratio) and the canvas a centred 16:9 box. */
  private fitRenderer() {
    const { renderer, game } = this.o
    const pr = renderer.getPixelRatio(), el = renderer.domElement
    if (el.width !== this.W || el.height !== this.H) renderer.setSize(this.W / pr, this.H / pr, false)
    const bw = Math.min(innerWidth, (innerHeight * this.W) / this.H), bh = (bw * this.H) / this.W
    const box = { position: 'fixed', left: `${(innerWidth - bw) / 2}px`, top: `${(innerHeight - bh) / 2}px`, width: `${bw}px`, height: `${bh}px` }
    if (el.style.width !== box.width || el.style.height !== box.height || el.style.left !== box.left || el.style.position !== 'fixed') Object.assign(el.style, box)
    const aspect = this.W / this.H
    if (game.camera.aspect !== aspect) {
      game.camera.aspect = aspect
      game.camera.updateProjectionMatrix()
    }
  }

  /** Same task as the render: copy the WebGPU canvas before it is presented, then the 2D layers on top. */
  private capture() {
    if (this.state !== 'recording') return
    const now = performance.now()
    const fps = this.o.fps ?? 60
    if (this.lastCapture && now - this.lastCapture < 1000 / fps - 2) return
    this.lastCapture = now
    const { W, H, ctx } = this
    const g = this.o.renderer.domElement
    const gr = g.getBoundingClientRect()
    const sx = W / gr.width, sy = H / gr.height
    const map = (r: DOMRect) => [(r.left - gr.left) * sx, (r.top - gr.top) * sy, r.width * sx, r.height * sy] as const
    ctx.drawImage(g, 0, 0, W, H)
    // Overlay canvases (HUD, front end) in stacking order: parent z-index, own z-index, document order.
    const z = (e: Element | null) => Number((e && getComputedStyle(e).zIndex) || 0) || 0
    const layers = [...document.querySelectorAll('canvas')]
      .filter((c) => c !== g && c !== this.canvas && c.width > 0)
      .map((c, i) => ({ c, r: c.getBoundingClientRect(), pz: z(c.parentElement === g.parentElement ? null : c.parentElement), z: z(c), i }))
      .filter((l) => l.r.width > 0 && l.r.height > 0)
      .sort((a, b) => a.pz - b.pz || a.z - b.z || a.i - b.i)
    let filled: Element | null = null
    for (const l of layers) {
      const parent = l.c.parentElement
      if (parent && parent !== g.parentElement && parent !== filled) {
        filled = parent
        const bg = getComputedStyle(parent).backgroundColor
        if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) {
          ctx.fillStyle = bg
          ctx.fillRect(...map(parent.getBoundingClientRect()))
        }
      }
      ctx.drawImage(l.c, ...map(l.r))
    }
    this.track.requestFrame()
    this.frames++
  }

  private dispose() {
    for (const f of this.restore.reverse()) f()
    this.restore = []
    for (const [node, t] of this.tapped) node.disconnect(t)
    for (const node of this.muted) node.connect(node.context.destination)
    this.track.stop()
  }
}
