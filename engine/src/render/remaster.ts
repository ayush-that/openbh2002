import * as THREE from 'three/webgpu'
import {
  acesFilmicToneMapping, agxToneMapping, cameraPosition, cameraViewMatrix, exp, float, getViewPosition, length, luminance,
  materialColor, matcapUV, max, mix, mrt, neutralToneMapping, normalWorld, output, pass, positionWorld, reference, sRGBTransferEOTF,
  sRGBTransferOETF, screenUV, sin, smoothstep, step, texture, time, uniform, uv, vec2, vec3, vec4, vertexColor,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { smaa } from 'three/addons/tsl/display/SMAANode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js'
import type { GameFS } from '../vfs'
import type { G3DScene } from './g3dscene'
import type { Terrain } from '../world/terrain'
import { TERRAIN } from '../world/config'
import { OBJ } from '../game/constants'

// Two visual modes over the same scene and assets (docs/dev/remaster.md).
// - faithful: the scene as built (gamma-space lighting, Geometry.3D terrain), drawn with renderer.render.
// - remaster: per-material linear-space twins, heightmap terrain with procedural detail, cascaded sun shadows,
//   depth haze, selective bloom, tone mapping and AA through a RenderPipeline.
// ColorManagement stays disabled in both modes (main.ts). That makes every built-in colour-space node a no-op,
// so the remaster does its own conversions: sRGB decode in each material's colorNode and tone mapping plus sRGB
// encode at the end of the pipeline. Faithful materials are never modified; remaster materials are separate
// objects swapped onto meshes, so switching back and forth costs no recompiles after the first time.

export type VisualModeName = 'faithful' | 'remaster'
type AA = 'msaa' | 'smaa' | 'fxaa' | 'none'
type ToneMap = 'neutral' | 'agx' | 'aces'

export interface RemasterSettings {
  /** Heightmap terrain with detail texturing instead of Geometry.3D terrain objects 10..18. */
  terrain: boolean
  /** Linear lighting with sRGB decode, tone mapping and sRGB output. Off = raw gamma values like faithful. */
  color: boolean
  toneMapping: ToneMap
  exposure: number
  /** Cascaded sun shadows (replaces the original projected blob shadows). */
  shadows: boolean
  shadowMapSize: number
  /** Cascades fitted to the view (>= 2), or 1 for one fixed map over the battlefield (the camera never moves). */
  shadowCascades: number
  /** Distance haze toward the sky horizon colour. 0..1 = maximum blend at the horizon. */
  haze: number
  /** Bloom strength on additive (screen-blended) effects: explosions, tracers, flares, fire. 0 = off. */
  bloom: number
  aa: AA
  /** Vignette strength. 0 = off. */
  vignette: number
  /** Animated glints on the sea band of the sky walls. */
  water: boolean
  /** Multiplier on the capped device pixel ratio (the adaptive quality controller drives it). */
  renderScale: number
  /** Cap on devicePixelRatio. */
  maxPixelRatio: number
  /** Cap on drawing-buffer pixels (8.3 M = 3840 x 2160). Applies in both modes. */
  maxPixels: number
  /** Terrain LOD: a chunk at distance d uses vertex stride s when s x terrainLod <= d. 0 = full detail. */
  terrainLod: number
  /** Bloom buffer size as a fraction of the CSS-pixel size. */
  bloomResolution: number
}

export const DEFAULT_SETTINGS: RemasterSettings = {
  terrain: true,
  color: true,
  toneMapping: 'neutral',
  exposure: 1,
  shadows: true,
  shadowMapSize: 2048,
  shadowCascades: 3,
  haze: 0.4,
  bloom: 0.5,
  aa: 'smaa',
  vignette: 0.18,
  water: true,
  renderScale: 1,
  maxPixelRatio: 2,
  maxPixels: 3840 * 2160,
  terrainLod: 4000,
  bloomResolution: 0.5,
}

export interface VisualModeOptions {
  renderer: THREE.WebGPURenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  g3d: G3DScene
  terrain: Terrain
  fs: GameFS
  /** main.ts lights used by the faithful mode. */
  sun: THREE.DirectionalLight
  ambient: THREE.AmbientLight
  settings?: Partial<RemasterSettings>
}

interface Horizon {
  /** Linear haze colour. */
  color: THREE.Color
  /** Sky wall v (0 top, 1 bottom) where the painted sea begins. */
  sea: number
}

const SKY_IDS = [OBJ.skyDay, OBJ.skyNight]

type V2 = THREE.Node<'vec2'>
type V3 = THREE.Node<'vec3'>
type V4 = THREE.Node<'vec4'>

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

export class VisualMode {
  readonly settings: RemasterSettings
  mode: VisualModeName = 'faithful'
  /** Frame timing for the last ~120 frames and draw stats of the last frame. */
  readonly stats = { fps: 0, ms: 0, calls: 0, triangles: 0 }

  private o: VisualModeOptions
  private day = true
  private faithfulK: number
  private scenePass: ReturnType<typeof pass> | null = null
  private rsun = new THREE.DirectionalLight(0xffffff, 0)
  private hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0)
  private csm: CSMShadowNode | null = null
  private pipeline: THREE.RenderPipeline | null = null
  private shadowKey = ''
  private sunDir = new THREE.Vector3()
  private pipelineKey = ''
  private toRemaster = new Map<THREE.Material, THREE.Material>()
  private toFaithful = new Map<THREE.Material, THREE.Material>()
  private materialsKey = ''
  private noBloom = new Set<THREE.Material>()
  private skyWalls = new Map<THREE.Material, number>()
  private fakeShadows: THREE.Mesh[] = []
  private terrainMaterial: THREE.Material | null = null
  private horizonDay: Horizon
  private horizonNight: Horizon
  private closeTex: THREE.Texture
  private farTex: THREE.Texture
  readonly detailTex: THREE.Texture
  private detailAvg: number
  private frameTimes: number[] = []
  private warmed = new Set<VisualModeName>()
  private lastNow = 0

  private uHaze = uniform(new THREE.Color())
  private uHazeAmount = uniform(0.5)
  private uExposure = uniform(1)
  private uVignette = uniform(0.2)
  private uSunGlint = uniform(1)

  private constructor(o: VisualModeOptions, day: Horizon, night: Horizon) {
    this.o = o
    this.settings = { ...DEFAULT_SETTINGS, ...o.settings }
    this.faithfulK = o.sun.intensity * 2
    this.closeTex = o.terrain.closeTex
    this.farTex = o.terrain.farTex
    this.horizonDay = day
    this.horizonNight = night
    // A repeating copy of the close aerial photo is the detail source (the base copy clamps at the map edge).
    this.detailTex = this.closeTex.clone()
    this.detailTex.wrapS = this.detailTex.wrapT = THREE.RepeatWrapping
    this.detailTex.needsUpdate = true
    const data = (this.closeTex.image as { data: Uint8Array }).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    this.detailAvg = sum / (data.length / 4) / 255

    // Remaster sun: Geometry.3D light 0 direction, cascaded shadows fitted to the view out to the battlefield edge.
    const sunDef = o.g3d.geo.objects[0].lights.find((l) => l.type === 'distant')
    this.sunDir.set(...(sunDef?.direction ?? [-1, 2, 1])).normalize()
    this.rsun.position.copy(this.sunDir).multiplyScalar(1000)
    this.rsun.visible = false
    this.hemi.visible = false
    o.scene.add(this.rsun, this.rsun.target, this.hemi)

    for (const id of SKY_IDS) {
      const sea = id === OBJ.skyDay ? day.sea : night.sea
      o.g3d.node(id).traverse((m) => {
        if (!(m instanceof THREE.Mesh)) return
        const pos = m.geometry.getAttribute('position')
        let ymin = Infinity
        for (let i = 0; i < pos.count; i++) ymin = Math.min(ymin, pos.getY(i))
        if (ymin < 4000) this.skyWalls.set(m.material as THREE.Material, sea)
      })
    }
    o.g3d.node(OBJ.crosshair).traverse((m) => m instanceof THREE.Mesh && this.noBloom.add(m.material as THREE.Material))

    // Shadow flags: opaque and colour-keyed models cast (the shadow pass honours the key's alpha); opaque models
    // receive. Sky, terrain tiles, crosshair and the original blob shadows do neither.
    const skip = new Set<number>([...SKY_IDS, OBJ.crosshair])
    for (let id = OBJ.terrainFirst; id <= OBJ.terrainLast; id++) skip.add(id)
    for (const obj of o.g3d.geo.objects) {
      if (!obj.label?.includes('Shadow')) continue
      skip.add(obj.id)
      o.g3d.node(obj.id).traverse((m) => m instanceof THREE.Mesh && this.fakeShadows.push(m))
    }
    for (const [id, node] of o.g3d.nodes) {
      if (skip.has(id)) continue
      for (const m of node.children) {
        if (!(m instanceof THREE.Mesh)) continue
        const mat = m.material as THREE.Material
        m.castShadow = !mat.transparent
        m.receiveShadow = !mat.transparent && mat.alphaTest === 0
      }
    }
    for (let id = OBJ.terrainFirst; id <= OBJ.terrainLast; id++) o.g3d.node(id).traverse((m) => (m.receiveShadow = true))
  }

  static async create(o: VisualModeOptions) {
    const cyl = await Promise.all(
      ['SkyCylinder1', 'SkyCylinder2', 'SkyCylinder3', 'SkyCylinderN1', 'SkyCylinderN2'].map((n) => o.fs.read(`BH2Game/${n}.t24`)),
    )
    const day = horizon(cyl.slice(0, 3), 1)
    const night = horizon(cyl.slice(3), 2.2)
    return new VisualMode(o, day, night)
  }

  /** Change the render scale without touching materials or the pipeline (cheap; for the adaptive controller). */
  setRenderScale(scale: number) {
    this.settings.renderScale = scale
    this.applyPixelRatio()
  }

  /** Device pixel ratio after the DPR cap, render scale and pixel cap. */
  targetPixelRatio() {
    const s = this.settings, size = this.o.renderer.getSize(new THREE.Vector2())
    const pr = Math.min(devicePixelRatio || 1, s.maxPixelRatio) * s.renderScale
    const cap = Math.sqrt(s.maxPixels / Math.max(1, size.x * size.y))
    return Math.max(0.25, Math.min(pr, cap))
  }

  private applyPixelRatio() {
    const { renderer } = this.o, pr = this.targetPixelRatio()
    if (Math.abs(renderer.getPixelRatio() - pr) > 1e-3) renderer.setPixelRatio(pr)
    this.bloomNode?.setResolutionScale(Math.min(1, this.settings.bloomResolution / renderer.getPixelRatio()))
  }

  /**
   * Compile the pipelines of every mesh in the scene (hidden ones included: enemies, effects, debris models)
   * for the current mode, so their first appearance does not stall a frame. Uses proxy meshes in a detached
   * group; the scene itself is not modified, so the render loop may keep running meanwhile.
   */
  async warmup() {
    const { renderer, scene, camera, terrain } = this.o
    const group = new THREE.Group()
    const seen = new Set<string>()
    const remaster = this.mode === 'remaster'
    scene.traverse((m) => {
      if (!(m instanceof THREE.Mesh) || Array.isArray(m.material) || !m.geometry.getAttribute('position')) return
      if (m.parent === terrain.group && !remaster) return
      const mat = remaster ? this.remasterOf(m.material) : (this.toFaithful.get(m.material) ?? m.material)
      if (!mat) return
      const inst = m instanceof THREE.InstancedMesh
      const key = `${mat.id}|${inst}|${Object.keys(m.geometry.attributes).join()}|${!!m.geometry.index}|${m.castShadow}|${m.receiveShadow}`
      if (seen.has(key)) return
      seen.add(key)
      const p = inst ? new THREE.InstancedMesh(m.geometry, mat, 1) : new THREE.Mesh(m.geometry, mat)
      p.frustumCulled = false
      p.castShadow = m.castShadow
      p.receiveShadow = m.receiveShadow
      group.add(p)
    })
    const rt = renderer.getRenderTarget(), mrtNode = renderer.getMRT()
    if (remaster && this.scenePass) {
      renderer.setRenderTarget(this.scenePass.renderTarget)
      renderer.setMRT(this.scenePass.getMRT())
    }
    // compileAsync captures the render target and MRT synchronously and yields between work items, so restore
    // them before awaiting. It re-applies the captured MRT at every yield, so render() resets both each frame.
    const done = renderer.compileAsync(group, camera, scene)
    renderer.setRenderTarget(rt)
    renderer.setMRT(mrtNode)
    await done
    return seen.size
  }

  /** Change settings at runtime. Material, shadow and pipeline changes rebuild lazily on the next remaster frame. */
  set(patch: Partial<RemasterSettings>) {
    Object.assign(this.settings, patch)
    if (this.mode === 'remaster') this.applyRemaster()
  }

  setMode(mode: VisualModeName) {
    this.mode = mode
    if (mode === 'remaster') this.applyRemaster()
    else this.applyFaithful()
  }

  toggle() {
    this.setMode(this.mode === 'faithful' ? 'remaster' : 'faithful')
  }

  /** Call from game.onDayNight (replaces main.ts's handler: it also drives the faithful lights). */
  setDayNight(day: boolean) {
    this.day = day
    if (this.mode === 'remaster') this.applyRemaster()
    else this.applyFaithful()
  }

  /** Draw one frame in place of renderer.render(scene, camera). */
  render() {
    const now = performance.now()
    if (this.lastNow) {
      this.frameTimes.push(now - this.lastNow)
      if (this.frameTimes.length > 120) this.frameTimes.shift()
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
      this.stats.ms = avg
      this.stats.fps = 1000 / avg
    }
    this.lastNow = now
    const { renderer, scene, camera, terrain } = this.o
    this.applyPixelRatio()
    // First frame in each mode: compile the hidden meshes' pipelines in the background (WebGL2 compiles
    // synchronously, so the first enemy, explosion or debris of each kind would otherwise stall 50-170 ms).
    if (!this.warmed.has(this.mode)) {
      this.warmed.add(this.mode)
      void this.warmup()
    }
    const info = renderer.info
    info.autoReset = false
    info.reset()
    renderer.setRenderTarget(null)
    renderer.setMRT(null)
    if (this.mode === 'faithful') {
      renderer.render(scene, camera)
    } else {
      if (terrain.group.visible) terrain.updateLod(camera.position, this.settings.terrainLod)
      this.swapVisible()
      this.pipeline!.render()
    }
    this.stats.calls = info.render.drawCalls
    this.stats.triangles = info.render.triangles
    info.autoReset = true
  }

  // ------------------------------------------------------------------ modes

  private terrainNodes(visible: boolean) {
    for (let id = OBJ.terrainFirst; id <= OBJ.terrainLast; id++) this.o.g3d.node(id).visible = visible
  }

  private applyFaithful() {
    const { sun, ambient, terrain } = this.o
    this.applyPixelRatio()
    this.terrainNodes(true)
    terrain.group.visible = false
    this.rsun.visible = this.hemi.visible = false
    this.rsun.castShadow = false
    // Same as main.ts: half-Lambert sun + ambient by day, a faint ambient at night.
    sun.visible = this.day
    ambient.visible = true
    ambient.intensity = this.day ? this.faithfulK / 2 : 0.06 * Math.PI
    for (const m of this.fakeShadows) m.visible = true
    this.applyFaithfulMaterials()
  }

  private applyRemaster() {
    const s = this.settings, { renderer, sun, ambient, terrain } = this.o

    const key = `${s.color}|${s.water}|${s.aa === 'msaa'}`
    if (key !== this.materialsKey) {
      // Rebuild twins when a setting baked into them changes. Put faithful materials back first.
      this.applyFaithfulMaterials()
      this.toRemaster.clear()
      this.toFaithful.clear()
      this.terrainMaterial = null
      this.materialsKey = key
    }

    this.terrainNodes(!s.terrain)
    terrain.group.visible = s.terrain
    if (s.terrain) {
      terrain.build()
      this.terrainMaterial ??= this.buildTerrainMaterial()
      for (const m of terrain.group.children) {
        if (!(m instanceof THREE.Mesh)) continue
        m.material = this.terrainMaterial
      }
    }

    // Lighting in linear units: a sunlit up-facing surface lands near its albedo; shade keeps roughly 40% (sky light).
    sun.visible = false
    ambient.visible = false
    this.rsun.visible = this.hemi.visible = true
    if (this.day) {
      this.rsun.color.setRGB(1, 0.96, 0.88)
      this.rsun.intensity = 2.8
      this.hemi.color.setRGB(0.62, 0.74, 0.95)
      this.hemi.groundColor.setRGB(0.42, 0.38, 0.28)
      this.hemi.intensity = 1
    } else {
      // Moonlight: faint and blue, so the night stays dark and flares and the searchlight carry the scene.
      this.rsun.color.setRGB(0.55, 0.65, 1)
      this.rsun.intensity = 0.09
      this.hemi.color.setRGB(0.3, 0.38, 0.6)
      this.hemi.groundColor.setRGB(0.06, 0.06, 0.08)
      this.hemi.intensity = 0.05
    }
    this.rsun.castShadow = s.shadows
    if (s.shadows) {
      renderer.shadowMap.enabled = true
      // r187 removed PCFSoftShadowMap (it falls back to PCF with a warning).
      renderer.shadowMap.type = THREE.PCFShadowMap
    }
    for (const m of this.fakeShadows) m.visible = !s.shadows

    const h = this.day ? this.horizonDay : this.horizonNight
    this.uHaze.value.copy(h.color)
    this.uHazeAmount.value = s.haze
    this.uExposure.value = s.exposure
    this.uVignette.value = s.vignette
    this.uSunGlint.value = this.day ? 1 : 0.6

    this.configureShadows()
    const pkey = [s.color, s.toneMapping, s.haze > 0, s.bloom > 0, s.aa, s.vignette > 0].join('|')
    if (!this.pipeline || pkey !== this.pipelineKey) this.buildPipeline(pkey)
    else if (this.bloomNode) this.bloomNode.strength.value = s.bloom
    this.applyPixelRatio()

    this.swapAll()
  }

  private applyFaithfulMaterials() {
    this.o.scene.traverse((m) => {
      if (!(m instanceof THREE.Mesh)) return
      const f = this.toFaithful.get(m.material as THREE.Material)
      if (f) m.material = f
    })
  }

  private configureShadows() {
    const { shadowMapSize: size, shadowCascades: cascades } = this.settings, sh = this.rsun.shadow
    const key = `${size}|${cascades}`
    if (key === this.shadowKey) return
    this.shadowKey = key
    this.csm?.dispose()
    this.csm = null
    sh.map?.dispose()
    sh.map = null
    sh.mapSize.set(size, size)
    sh.bias = -0.0002
    sh.normalBias = 2
    const cam = sh.camera
    if (cascades > 1) {
      // Light-space depth must hold the view frustum slice plus aircraft above it (lightMargin).
      cam.near = 1
      cam.far = 60000
      this.csm = new CSMShadowNode(this.rsun, { cascades, maxFar: 14000, mode: 'practical', lightMargin: 9000 })
      this.csm.fade = true
      ;(sh as unknown as { shadowNode: unknown }).shadowNode = this.csm
    } else {
      // One map over the battlefield around the bunker: ground units fight inside ~11000 units.
      delete (sh as unknown as { shadowNode?: unknown }).shadowNode
      const r = 11000
      this.rsun.position.copy(this.sunDir).multiplyScalar(20000)
      cam.left = cam.bottom = -r
      cam.right = cam.top = r
      cam.near = 1000
      cam.far = 40000
      cam.updateProjectionMatrix()
    }
    // Lit materials bake the light's shadow setup at compile time.
    for (const m of this.toRemaster.values()) m.needsUpdate = true
    if (this.terrainMaterial) this.terrainMaterial.needsUpdate = true
  }

  // ------------------------------------------------------------------ materials

  private swapAll() {
    this.o.scene.traverse((m) => m instanceof THREE.Mesh && this.swap(m))
  }

  /** Meshes created after the switch (debris, projectile models, lazily cloned nodes) get their twin here. */
  private swapVisible() {
    this.o.scene.traverseVisible((m) => m instanceof THREE.Mesh && this.swap(m))
  }

  private swap(m: THREE.Mesh) {
    const mat = m.material
    if (Array.isArray(mat) || this.toFaithful.has(mat) || mat === this.terrainMaterial) return
    const r = this.remasterOf(mat)
    if (r) m.material = r
  }

  /** The remaster twin of a faithful material (built and cached on first use); remaster materials map to themselves. */
  private remasterOf(mat: THREE.Material) {
    if (this.toFaithful.has(mat) || mat === this.terrainMaterial) return mat
    let r = this.toRemaster.get(mat)
    if (!r) {
      if (!mat.visible) return null
      const built = this.twin(mat)
      if (!built) return null
      r = built
      this.toRemaster.set(mat, r)
      this.toFaithful.set(r, mat)
    }
    return r
  }

  private lin(rgb: V3): V3 {
    return this.settings.color ? (sRGBTransferEOTF(rgb) as V3) : rgb
  }

  /** Linear-space copy of a g3d/effects material. Null for materials it does not understand. */
  private twin(src: THREE.Material): THREE.Material | null {
    const any = src as THREE.Material & {
      colorNode?: THREE.Node | null
      map?: THREE.Texture | null
      matcap?: THREE.Texture | null
      vertexColors?: boolean
      color?: THREE.Color
    }
    let base: V4
    let lit = false
    if (src instanceof THREE.MeshMatcapNodeMaterial) {
      if (!src.matcap) return null
      base = vec4(texture(src.matcap, matcapUV))
    } else if (src instanceof THREE.MeshLambertNodeMaterial || src instanceof THREE.MeshBasicNodeMaterial) {
      lit = src instanceof THREE.MeshLambertNodeMaterial
      if (any.colorNode) base = vec4(any.colorNode as V4)
      else if (any.map) base = vec4(texture(any.map)).mul(vec4(reference('color', 'color', src), 1))
      else base = vec4(materialColor, 1)
      if (any.vertexColors) base = vec4(base.rgb.mul(vertexColor().rgb), base.a)
    } else {
      return null
    }

    // Darken (mode 2) computes dst x (1 - src) on gamma values; in linear space that factor is (1 - src)^2.2.
    const darken = src.blending === THREE.CustomBlending && src.blendSrc === THREE.ZeroFactor && src.blendDst === THREE.OneMinusSrcColorFactor
    let rgb = darken && this.settings.color ? (vec3(1).sub(vec3(1).sub(base.rgb).pow(2.2)) as V3) : this.lin(base.rgb)
    const sea = this.skyWalls.get(src)
    if (sea !== undefined && this.settings.water) rgb = rgb.add(this.seaGlint(rgb, sea))

    const m = lit ? new THREE.MeshStandardNodeMaterial({ roughness: 0.78, metalness: 0 }) : new THREE.MeshBasicNodeMaterial()
    m.name = `${src.name}|remaster`
    m.colorNode = vec4(rgb, base.a)
    m.side = src.side
    m.transparent = src.transparent
    m.depthTest = src.depthTest
    m.depthWrite = src.depthWrite
    m.alphaTest = src.alphaTest
    m.blending = src.blending
    m.blendEquation = src.blendEquation
    m.blendSrc = src.blendSrc
    m.blendDst = src.blendDst
    m.blendSrcAlpha = src.blendSrcAlpha
    m.blendDstAlpha = src.blendDstAlpha
    m.visible = src.visible
    m.fog = false
    if (src.alphaTest > 0 && this.settings.aa === 'msaa') m.alphaToCoverage = true
    // Colour-keyed foliage quads face the camera; light them like the ground they stand on (normal up).
    if (lit && src.alphaTest > 0) m.normalNode = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz

    // Bloom source: additive (screen) effects emit their own colour; darken/multiply effects apply the same
    // factor to the glow buffer so smoke still dims explosions behind it. Everything else writes 0 (global MRT).
    if (src.blending === THREE.CustomBlending && !this.noBloom.has(src)) {
      m.mrtNode = mrt({ emissive: vec4(rgb, 1) })
    }
    return m
  }

  /** Sun or moon glints on the sea painted at the bottom of the sky walls (v > sea). */
  private seaGlint(rgb: V3, sea: number) {
    const v = uv().y
    const s = v.sub(sea).div(1 - sea).clamp(0, 1)
    const mask = smoothstep(sea + 0.004, sea + 0.02, v)
    // Perspective: waves crowd toward the horizon. u spans one wall panel; 40 full periods keep seams invisible.
    const x = uv().x.mul(Math.PI * 2 * 40)
    const y = float(6).div(s.add(0.06))
    const t = time
    const w1 = sin(x.add(y.mul(1.7)).add(t.mul(1.3)))
    const w2 = sin(x.mul(1.9).sub(y.mul(2.3)).sub(t.mul(1.7)))
    const w3 = sin(x.mul(0.6).add(y.mul(3.1)).add(t.mul(0.8)))
    const sparkle = max(w1.mul(w2).mul(w3), 0).pow(6)
    const band = sin(y.mul(0.9).sub(t.mul(0.6))).mul(0.5).add(0.5)
    const lum = luminance(rgb)
    const amount = sparkle.mul(0.14).add(band.mul(0.03)).mul(lum.mul(2.5).add(0.04)).mul(this.uSunGlint)
    return vec3(amount.mul(mask))
  }

  private buildTerrainMaterial() {
    const close = this.closeTex, far = this.farTex, det = this.detailTex
    const e = TERRAIN.closeExtent, lo = (1 - e) / 2, hi = lo + e
    const u = uv()
    const inClose = step(lo, u.x).mul(step(u.x, hi)).mul(step(lo, u.y)).mul(step(u.y, hi))
    const baseRgb = this.lin(mix(texture(far, u), texture(close, u.sub(lo).div(e)), inClose).rgb)

    // Detail: the aerial photo itself, re-sampled at two small world scales, as a luminance ratio around 1.
    // A: 2.4 units/texel (clumps, rocks), B: rotated, 0.7 units/texel (grain). Both fade out with distance.
    const wp = positionWorld.xz
    const avg = this.detailAvg
    const dist = length(positionWorld.sub(cameraPosition))
    const fadeA = float(1).sub(smoothstep(1500, 7000, dist))
    const fadeB = float(1).sub(smoothstep(600, 2200, dist))
    const ca = Math.cos(0.65), sa = Math.sin(0.65)
    const uvA = (p: V2) => p.div(2500)
    const uvB = (p: V2) => vec2(p.x.mul(ca).sub(p.y.mul(sa)), p.x.mul(sa).add(p.y.mul(ca))).div(720)
    const h = (f: (p: V2) => V2, p: V2) => luminance(texture(det, f(p)).rgb).div(avg)
    const hA = h(uvA, wp), hB = h(uvB, wp)
    const detail = float(1).add(hA.sub(1).mul(0.42).mul(fadeA)).mul(float(1).add(hB.sub(1).mul(0.3).mul(fadeB))).clamp(0.55, 1.6)

    // Normal perturbation from the same height field (world-space finite differences, no screen derivatives).
    const ex = vec2(3, 0), ez = vec2(0, 3), fx = vec2(1, 0), fz = vec2(0, 1)
    const gA = vec2(h(uvA, wp.add(ex)).sub(hA), h(uvA, wp.add(ez)).sub(hA)).div(3).mul(fadeA).mul(14)
    const gB = vec2(h(uvB, wp.add(fx)).sub(hB), h(uvB, wp.add(fz)).sub(hB)).mul(fadeB).mul(5)
    const g = gA.add(gB)
    const nWorld = vec3(normalWorld.x.sub(g.x), normalWorld.y, normalWorld.z.sub(g.y)).normalize()

    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 })
    m.name = 'terrain|remaster'
    m.colorNode = vec4(baseRgb.mul(detail), 1)
    m.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize()
    m.fog = false
    return m
  }

  // ------------------------------------------------------------------ post

  private bloomNode: ReturnType<typeof bloom> | null = null

  private buildPipeline(key: string) {
    const s = this.settings, { renderer, scene, camera } = this.o
    this.pipeline?.dispose()
    const scenePass = pass(scene, camera, { samples: s.aa === 'msaa' ? 4 : 0 })
    this.scenePass = scenePass
    if (s.bloom > 0) {
      const m = mrt({ output, emissive: vec4(0, 0, 0, 1) })
      m.setBlendMode('emissive', new THREE.BlendMode(THREE.MaterialBlending))
      scenePass.setMRT(m)
      scenePass.getTexture('emissive').type = THREE.UnsignedByteType
    }
    let color = scenePass.getTextureNode('output').rgb

    if (s.haze > 0) {
      // Radial distance from the eye; the sky is drawn without depth, so depth 1 means "no geometry".
      const depth = scenePass.getTextureNode('depth').r
      const viewPos = getViewPosition(screenUV, depth, uniform(camera.projectionMatrixInverse))
      const dist = length(viewPos)
      const worldDir = uniform(camera.matrixWorld).mul(vec4(viewPos, 0)).xyz.normalize()
      const k = float(1).sub(exp(max(dist.sub(3000), 0).div(-16000)))
      const up = float(1).sub(smoothstep(0.02, 0.45, worldDir.y))
      const f = k.mul(up).mul(this.uHazeAmount).mul(float(1).sub(step(0.999999, depth)))
      color = mix(color, this.uHaze, f)
    }
    if (s.bloom > 0) {
      // The glow is soft anyway: it runs at a fraction of the CSS-pixel size (applyPixelRatio), not of the device size.
      this.bloomNode = bloom(scenePass.getTextureNode('emissive'), s.bloom, 0.3, 0)
      color = color.add(this.bloomNode.rgb)
    } else this.bloomNode = null

    let out = color
    if (s.color) {
      const tm = s.toneMapping === 'agx' ? agxToneMapping : s.toneMapping === 'aces' ? acesFilmicToneMapping : neutralToneMapping
      out = sRGBTransferOETF(tm(color, this.uExposure)) as V3
    }
    if (s.vignette > 0) {
      const d = length(screenUV.sub(0.5)).mul(1.414)
      out = out.mul(float(1).sub(smoothstep(0.5, 1.15, d).mul(this.uVignette)))
    }
    let final: V4 = vec4(out, 1)
    if (s.aa === 'smaa') final = smaa(final) as unknown as V4
    else if (s.aa === 'fxaa') final = fxaa(final) as unknown as V4

    const p = new THREE.RenderPipeline(renderer)
    p.outputColorTransform = false
    p.outputNode = final
    this.pipeline = p
    this.pipelineKey = key
  }
}

/** Haze colour and sea line from the sky cylinder textures: the band just above the painted sea. */
function horizon(files: Uint8Array[], lift: number): Horizon {
  const W = 256, H = 256
  const rowLum = (d: Uint8Array, y: number) => {
    let s = 0
    for (let x = 0; x < W; x++) s += d[(y * W + x) * 3] + d[(y * W + x) * 3 + 1] + d[(y * W + x) * 3 + 2]
    return s / W / 3
  }
  // The sea line is the sharpest luminance step in the lower third.
  let sea = 220, best = 0
  const d0 = files[0]
  for (let y = 170; y < H - 1; y++) {
    const step_ = Math.abs(rowLum(d0, y + 1) - rowLum(d0, y))
    if (step_ > best) [best, sea] = [step_, y + 1]
  }
  const c = [0, 0, 0]
  let n = 0
  for (const d of files) {
    for (let y = sea - 12; y < sea - 2; y++) {
      for (let x = 0; x < W; x++) {
        for (let k = 0; k < 3; k++) c[k] += d[(y * W + x) * 3 + k]
        n++
      }
    }
  }
  const color = new THREE.Color().setRGB(...(c.map((v) => Math.min(1, srgbToLinear(v / n / 255) * lift)) as [number, number, number]))
  return { color, sea: sea / H }
}

