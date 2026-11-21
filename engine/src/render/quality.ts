import * as THREE from 'three/webgpu'
import type { G3DScene } from './g3dscene'
import type { RemasterSettings, VisualMode, VisualModeName } from './remaster'
import type { Terrain } from '../world/terrain'

// Device presets and adaptive resolution (docs/dev/performance.md).
// - Presets pick remaster features, terrain LOD, texture anisotropy and resolution limits.
// - The controller measures GPU time per frame, CPU time per frame and late frames from rAF intervals, and moves the render scale between the preset's bounds
//   to hold the target frame rate. A dead band (60%..90% of the budget) and a few consecutive windows of
//   evidence keep it from oscillating. The simulation is untouched: Game.frame runs fixed 29 ms steps from
//   real time, whatever the render rate.

export type Preset = 'low' | 'medium' | 'high' | 'ultra'
export const PRESET_NAMES: Preset[] = ['low', 'medium', 'high', 'ultra']

export interface PresetDef {
  remaster: Partial<RemasterSettings>
  anisotropy: number
  /** Render scale bounds for the adaptive controller. */
  minScale: number
  maxScale: number
}

export const PRESETS: Record<Preset, PresetDef> = {
  low: {
    remaster: { shadows: false, bloom: 0, aa: 'fxaa', maxPixelRatio: 1, terrainLod: 1200, bloomResolution: 0.25 },
    anisotropy: 2,
    minScale: 0.5,
    maxScale: 1,
  },
  medium: {
    remaster: { shadows: true, shadowCascades: 1, shadowMapSize: 2048, bloom: 0.5, bloomResolution: 0.25, aa: 'fxaa', maxPixelRatio: 1.5, terrainLod: 2500 },
    anisotropy: 4,
    minScale: 0.6,
    maxScale: 1,
  },
  high: {
    remaster: { shadows: true, shadowCascades: 3, shadowMapSize: 2048, bloom: 0.5, bloomResolution: 0.5, aa: 'smaa', maxPixelRatio: 2, terrainLod: 4000 },
    anisotropy: 8,
    // High is the default on every device, so let weak GPUs trade resolution for frame rate.
    minScale: 0.5,
    maxScale: 1,
  },
  ultra: {
    remaster: { shadows: true, shadowCascades: 4, shadowMapSize: 4096, bloom: 0.5, bloomResolution: 0.5, aa: 'smaa', maxPixelRatio: 2, terrainLod: 8000 },
    anisotropy: 16,
    minScale: 0.75,
    maxScale: 1,
  },
}

export interface DeviceProfile {
  backend: 'webgpu' | 'webgl2'
  /** Lower-case adapter description ('' when the browser hides it). */
  gpu: string
  mobile: boolean
  software: boolean
  cores: number
  /** GB, Chromium only (0 = unknown). */
  memory: number
  /** Screen size in device pixels. */
  screenPixels: number
  /**
   * GPU time source. 'queue': WebGPU, submit-to-completion time (queue.onSubmittedWorkDone). Per-pass
   * timestamps are not used there: tile-based GPUs overlap passes, so their sum overstates the frame several
   * times. 'timer': WebGL2 EXT_disjoint_timer_query (sequential, so the sum is valid). 'none': rAF only.
   */
  gpuTiming: 'queue' | 'timer' | 'none'
}

/** WebGPURenderer parameters. `?webgl` forces the WebGL2 backend. Timestamps are used only on WebGL2. */
export function rendererParameters(params = new URLSearchParams(location.search)) {
  return { antialias: true, forceWebGL: params.has('webgl'), trackTimestamp: true }
}

export function detectDevice(renderer: THREE.WebGPURenderer): DeviceProfile {
  const backend = renderer.backend as unknown as {
    isWebGPUBackend?: boolean
    device?: GPUDevice & { adapterInfo?: { vendor: string; architecture: string; description: string } }
    gl?: WebGL2RenderingContext
    disjoint?: unknown
    trackTimestamp?: boolean
  }
  let gpu = ''
  if (backend.isWebGPUBackend) {
    const info = backend.device?.adapterInfo
    if (info) gpu = `${info.vendor} ${info.architecture} ${info.description}`
  } else if (backend.gl) {
    const ext = backend.gl.getExtension('WEBGL_debug_renderer_info')
    gpu = String(backend.gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : backend.gl.RENDERER) ?? '')
  }
  gpu = gpu.trim().toLowerCase()
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile: boolean } }
  const coarse = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches
  const mobile = nav.userAgentData?.mobile ?? (coarse || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent))
  const dpr = devicePixelRatio || 1
  return {
    backend: backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
    gpu,
    mobile: mobile || /mali|adreno|powervr|apple gpu.*(iphone|ipad)/.test(gpu),
    software: /swiftshader|llvmpipe|softpipe|software|basic render/.test(gpu),
    cores: navigator.hardwareConcurrency || 4,
    memory: nav.deviceMemory ?? 0,
    screenPixels: Math.round(screen.width * dpr * screen.height * dpr),
    gpuTiming: backend.isWebGPUBackend ? 'queue' : backend.trackTimestamp && backend.disjoint ? 'timer' : 'none',
  }
}

/**
 * Default visual mode and preset: remaster at high everywhere. Adaptive render scale keeps weaker devices
 * smooth by lowering resolution. Only software renderers (no GPU) fall back to faithful + low.
 */
export function recommend(d: DeviceProfile): { mode: VisualModeName; preset: Preset } {
  if (d.software) return { mode: 'faithful', preset: 'low' }
  return { mode: 'remaster', preset: 'high' }
}

export interface QualityOptions {
  renderer: THREE.WebGPURenderer
  vm: VisualMode
  g3d: G3DScene
  terrain: Terrain
  preset?: Preset
  adaptive?: boolean
  /** Fixed target frame rate; default 60, raised to 120 on high-refresh desktops when there is headroom. */
  targetFps?: number
}

const WINDOW_MS = 500
const RATES = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240]

export class Quality {
  readonly device: DeviceProfile
  preset: Preset
  adaptive: boolean
  targetFps: number
  readonly stats = { gpuMs: NaN, cpuMs: 0, lateFrames: 0, refreshHz: 60, scale: 1, pixelRatio: 1, pixels: 0, renderedFps: 0 }

  private o: QualityOptions
  private fixedTarget: boolean
  private intervals: number[] = []
  private lastRaf = 0
  private lastRender = 0
  private frameStart = 0
  private win = { start: 0, frames: 0, cpu: 0, late: 0, gpu: 0, gpuFrames: 0, invalid: false }
  private gpuFrames = 0
  private resolving = false
  private gpu: GPUDevice | null
  private over = 0
  private fast = 0
  private lastUp = -Infinity
  private scaleAt60 = 1
  private lastChange = 0
  private probeWait = 5000
  private no120Until = 0

  constructor(o: QualityOptions) {
    this.o = o
    this.device = detectDevice(o.renderer)
    const backend = o.renderer.backend as unknown as { device?: GPUDevice; trackTimestamp: boolean }
    this.gpu = backend.device ?? null
    // WebGPU uses queue completion instead; skip the per-pass timestamp writes.
    if (this.device.gpuTiming === 'queue') backend.trackTimestamp = false
    const rec = recommend(this.device)
    this.preset = o.preset ?? rec.preset
    this.adaptive = o.adaptive ?? true
    this.fixedTarget = o.targetFps !== undefined
    this.targetFps = o.targetFps ?? 60
    this.setPreset(this.preset)
    // Desktop: build the remaster terrain in the background so the first switch has no stall. Mobile builds it
    // only when the remaster is first enabled (~116 MB of vertex and index data).
    if (!this.device.mobile) setTimeout(() => void o.terrain.buildInBackground(), 2000)
  }

  /** Recommended visual mode for this device. */
  get recommendedMode() {
    return recommend(this.device).mode
  }

  set(patch: { preset?: Preset; adaptive?: boolean; targetFps?: number | null; renderScale?: number }) {
    if (patch.preset) this.setPreset(patch.preset)
    if (patch.adaptive !== undefined) this.adaptive = patch.adaptive
    if (patch.targetFps !== undefined) {
      this.fixedTarget = patch.targetFps !== null
      this.targetFps = patch.targetFps ?? 60
    }
    if (patch.renderScale !== undefined) this.setScale(patch.renderScale)
  }

  setPreset(preset: Preset) {
    const p = PRESETS[preset]
    this.preset = preset
    this.o.vm.set({ ...p.remaster, renderScale: THREE.MathUtils.clamp(this.o.vm.settings.renderScale, p.minScale, p.maxScale) })
    const { renderer, g3d, terrain, vm } = this.o
    const aniso = Math.min(p.anisotropy, renderer.getMaxAnisotropy())
    const webgl = !(renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend
    for (const t of [...g3d.allTextures(), terrain.farTex, terrain.closeTex, vm.detailTex]) {
      if (t.anisotropy === aniso || t.minFilter !== THREE.LinearMipmapLinearFilter) continue
      t.anisotropy = aniso
      // WebGPU samplers are keyed on anisotropy; WebGL sets it as a texture parameter at upload.
      if (webgl) t.needsUpdate = true
    }
  }

  /**
   * Call at the start of every animation frame. Returns false when this frame should be skipped to hold an
   * even targetFps on a faster display (e.g. 60 fps on 120 Hz). Skip both game.frame and vm.render then.
   */
  beginFrame(now: number) {
    if (this.lastRaf) {
      this.intervals.push(now - this.lastRaf)
      if (this.intervals.length > 120) this.intervals.shift()
      if (this.intervals.length >= 30) this.stats.refreshHz = this.estimateRefresh()
    }
    this.lastRaf = now
    const refreshMs = 1000 / this.stats.refreshHz, budget = 1000 / this.targetFps
    if (this.lastRender && now - this.lastRender < budget - refreshMs / 2) return false
    if (this.lastRender) {
      const dt = now - this.lastRender
      if (dt > 250) this.win.invalid = true // tab hidden, debugger, long load: not a performance signal
      else if (dt > budget * 1.5) this.win.late++
    }
    this.lastRender = now
    this.frameStart = performance.now()
    return true
  }

  /** Call after vm.render(). */
  endFrame() {
    const now = performance.now()
    this.win.cpu += now - this.frameStart
    this.win.frames++
    this.gpuFrames++
    const win = this.win
    if (this.gpu && this.device.gpuTiming === 'queue') {
      // When the GPU keeps up, it is idle at the start of the frame, so this is the frame's GPU time.
      void this.gpu.queue.onSubmittedWorkDone().then(() => {
        win.gpu += performance.now() - now
        win.gpuFrames++
      })
    } else if (this.device.gpuTiming === 'timer' && !this.resolving && this.gpuFrames >= 10) {
      // r187 resolves to the duration of the last frame in the batch.
      this.gpuFrames = 0
      this.resolving = true
      void this.o.renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then((ms) => {
        this.resolving = false
        if (typeof ms === 'number' && ms > 0) {
          win.gpu += ms
          win.gpuFrames++
        }
      })
    }
    if (!this.win.start) this.win.start = now
    if (now - this.win.start >= WINDOW_MS) this.evaluate(now)
  }

  private estimateRefresh() {
    const sorted = [...this.intervals].sort((a, b) => a - b)
    const hz = 1000 / sorted[Math.floor(sorted.length * 0.1)]
    return RATES.reduce((best, r) => (Math.abs(r - hz) < Math.abs(best - hz) ? r : best), 60)
  }

  private evaluate(now: number) {
    const w = this.win
    this.win = { start: now, frames: 0, cpu: 0, late: 0, gpu: 0, gpuFrames: 0, invalid: false }
    const s = this.stats
    s.cpuMs = w.cpu / Math.max(1, w.frames)
    s.gpuMs = w.gpuFrames ? w.gpu / w.gpuFrames : this.device.gpuTiming !== 'none' ? s.gpuMs : NaN
    s.lateFrames = w.late / Math.max(1, w.frames)
    s.renderedFps = (w.frames * 1000) / WINDOW_MS
    const r = this.o.renderer
    s.pixelRatio = r.getPixelRatio()
    const size = r.getDrawingBufferSize(new THREE.Vector2())
    s.pixels = size.x * size.y
    s.scale = this.o.vm.settings.renderScale
    if (!this.adaptive || w.invalid || w.frames < 5 || now - this.lastChange < WINDOW_MS * 1.5) return

    const budget = 1000 / this.targetFps
    const timed = !Number.isNaN(s.gpuMs)
    const load = Math.max(timed ? s.gpuMs : 0, s.cpuMs)
    // Late frames are the ground truth. GPU time is noisy: GPUs clock down when lightly loaded (which inflates
    // it), and WebGL2 timer queries on ANGLE/Metal read 20 ms for frames that hold 120 fps. So only queue time
    // (WebGPU) or CPU time far over budget triggers a cut, only "clearly fast" jumps up directly, and otherwise
    // resolution is probed upward one step at a time with exponential backoff.
    const trusted = this.device.gpuTiming === 'queue' ? load : s.cpuMs
    const over = s.lateFrames > 0.1 || trusted > budget * 1.3
    const fast = s.lateFrames === 0 && timed && load < budget * 0.6
    const probe = s.lateFrames === 0 && load < budget * 0.85 && now - this.lastChange > this.probeWait
    this.over = over ? this.over + 1 : 0
    this.fast = fast ? this.fast + 1 : 0
    const p = PRESETS[this.preset]

    if (this.over >= 2 || (over && s.lateFrames > 0.3)) {
      if (now - this.lastUp < 3000) this.probeWait = Math.min(60000, this.probeWait * 2)
      // A 120 fps target that cannot hold near full resolution goes back to 60 at the earlier scale.
      if (!this.fixedTarget && this.targetFps > 60 && (!timed || s.scale <= 0.9)) {
        this.targetFps = 60
        this.no120Until = now + this.probeWait * 6
        this.setScale(this.scaleAt60)
        return this.changed(now)
      }
      const f = load > 0 ? THREE.MathUtils.clamp(Math.sqrt((budget * 0.75) / load), 0.75, 0.95) : 0.9
      if (s.scale > p.minScale) {
        this.setScale(s.scale * f)
        return this.changed(now)
      }
      return
    }
    if (this.fast >= 3 || probe) {
      if (s.scale < p.maxScale) {
        const f = this.fast >= 3 ? THREE.MathUtils.clamp(Math.sqrt((budget * 0.75) / Math.max(load, 0.1)), 1, 1.1) : 1
        this.setScale(s.scale * f + 0.01)
        this.lastUp = now
        return this.changed(now)
      }
      // Full resolution with headroom on a high-refresh desktop: try 120.
      if (!this.fixedTarget && this.targetFps === 60 && !this.device.mobile && s.refreshHz >= 100 && now > this.no120Until) {
        this.scaleAt60 = s.scale
        this.targetFps = 120
        this.lastUp = now
        return this.changed(now)
      }
    }
  }

  private changed(now: number) {
    this.lastChange = now
    this.over = this.fast = 0
  }

  private setScale(scale: number) {
    const p = PRESETS[this.preset]
    // 0.05 steps (fewer render-target reallocations); a requested change always moves at least one step.
    const cur = this.o.vm.settings.renderScale
    let q = Math.round(scale * 20) / 20
    if (q === cur && scale !== cur) q += scale > cur ? 0.05 : -0.05
    q = THREE.MathUtils.clamp(q, p.minScale, p.maxScale)
    if (q !== cur) this.o.vm.setRenderScale(q)
  }
}
