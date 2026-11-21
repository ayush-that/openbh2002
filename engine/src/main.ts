import * as THREE from 'three/webgpu'
import './style.css'
import { openDevFS, type GameFS } from './vfs'
import { chooseGameFS } from './ui/import'
import { initAnalytics, track } from './analytics'
import { parseGeometry3D } from './formats/geometry3d'
import { parseShapeData } from './formats/shapedata'
import { G3DScene } from './render/g3dscene'
import { Terrain } from './world/terrain'
import { FlyCam } from './debug/flycam'
import { Collision } from './game/collision'
import { World } from './game/world'
import { Game } from './game/game'
import { CAMERA, OBJ } from './game/constants'
import { DebugHud } from './debug/hud'
import { createFrontend } from './frontend'
import { startAutoplay } from './debug/autoplay'
import { VisualMode } from './render/remaster'
import { Quality, rendererParameters } from './render/quality'
import { Hud } from './game/hud'
import { installFx } from './game/install-fx'
import { installAir } from './game/enemies/install-air'
import { installGround } from './game/enemies/install-ground'
import { TouchControls } from './ui/touch'
import { enterImmersive, onViewportChange } from './ui/viewport'

// The original does all lighting math in gamma space (16-bit framebuffer, no sRGB). Match it.
THREE.ColorManagement.enabled = false
initAnalytics()

const app = document.querySelector<HTMLDivElement>('#app')!
const params = new URLSearchParams(location.search)
/** ?mute: no game sound, menu music or clicks (testing). */
const mute = params.has('mute')

/** Device pixels per CSS pixel are capped at 2 and to a 4K pixel budget, then scaled by the render scale. */
/** Horizontal half-angle of the original 4:3 view (HFOV 53.13 deg). */
const TAN_HALF_HFOV = Math.tan((CAMERA.vfov / 2) * THREE.MathUtils.DEG2RAD) * (4 / 3)

/** VFOV 41.11 deg at 4:3 and wider (wider screens see more to the sides); narrower screens keep HFOV 53.13 deg. */
function fitCamera(camera: THREE.PerspectiveCamera, aspect: number) {
  camera.aspect = aspect
  camera.fov = aspect >= 4 / 3 ? CAMERA.vfov : 2 * Math.atan(TAN_HALF_HFOV / aspect) * THREE.MathUtils.RAD2DEG
  camera.updateProjectionMatrix()
}

async function start(fs: GameFS) {
  app.innerHTML = ''
  const renderer = new THREE.WebGPURenderer(rendererParameters(params)) // ?webgl forces WebGL2
  await renderer.init()
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace
  app.appendChild(renderer.domElement)

  // ---- Viewport: every size, rotation and fullscreen change goes through resize() ----
  // Pixel ratio and render scale are owned by VisualMode/Quality (src/render), which apply them every frame.
  const onAspect: ((aspect: number) => void)[] = []
  const resize = () => {
    const w = Math.max(1, app.clientWidth), h = Math.max(1, app.clientHeight)
    renderer.setSize(w, h)
    for (const f of onAspect) f(w / h)
  }
  resize()

  // ---- Scene ----
  const [geoText, shapeText, mmap] = await Promise.all([
    fs.text('BH2Game/Geometry.3D'),
    fs.text('BH2Game/ShapeData'),
    fs.read('BH2Game/MMap1501x1501.mmap'),
  ])
  const geo = parseGeometry3D(geoText)
  const shapes = parseShapeData(shapeText)
  const [g3d, terrain] = await Promise.all([G3DScene.load(fs, geo), Terrain.load(fs)])

  const scene = new THREE.Scene()
  scene.add(g3d.root, terrain.group)
  // Everything that is not part of the static scene starts hidden; systems show what they spawn.
  const always = new Set<number>([OBJ.mount, OBJ.aaMount, 21, 22, OBJ.m60, OBJ.cannon, OBJ.pistol, 27, OBJ.sandbags])
  for (let id = OBJ.terrainFirst; id <= OBJ.terrainLast; id++) always.add(id)
  for (const [id, node] of g3d.nodes) node.visible = always.has(id)
  // PROVISIONAL until confirmed: SandBags are modeled at y 0..106 but the ground at the origin is 608.
  g3d.node(OBJ.sandbags).position.y = terrain.heightAt(0, 0)

  // Sun: half-Lambert (n.L + 1) / 2 x 300/255 with no ambient term = ambient k/2 + directional k/2.
  const sunDef = geo.objects[0].lights.find((l) => l.type === 'distant')
  // Three.js Lambert divides by PI (physically based); the original does not, so scale by PI.
  const k = ((sunDef ? sunDef.intensity : 255) / 255) * Math.PI
  const sun = new THREE.DirectionalLight(0xffffff, k / 2)
  if (sunDef) sun.position.set(...sunDef.direction).normalize()
  const ambient = new THREE.AmbientLight(0xffffff, k / 2)
  scene.add(sun, ambient)

  // ---- Game systems ----
  const world = new World({ g3d, terrain, mmap, shapes, collision: new Collision(shapes) })
  const game = new Game(world, fs, renderer.domElement)
  onAspect.push((a) => fitCamera(game.camera, a))
  const vm = await VisualMode.create({ renderer, scene, camera: game.camera, g3d, terrain, fs, sun, ambient })
  game.onDayNight = (day) => vm.setDayNight(day)
  const quality = new Quality({ renderer, vm, g3d, terrain })
  // ?mode wins, then the player's last Shift+T choice, then the device recommendation.
  const storedMode = localStorage.getItem('bh.mode')
  const mode = params.get('mode') ?? storedMode ?? quality.recommendedMode
  vm.setMode(mode === 'remaster' ? 'remaster' : 'faithful')
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyT' && e.shiftKey) {
      vm.toggle()
      track('visual_mode_changed', { mode: vm.mode })
      localStorage.setItem('bh.mode', vm.mode)
    }
  })
  installGround(world, fs)
  installAir(world)
  const fx = await installFx(world, game, scene, fs)
  await game.preload()

  // ---- UI: HUD, touch controls, debug overlay, menus ----
  // Input.update consumes the touch turn after Player.update each game frame.
  game.late.push(new Hud(renderer.domElement, game, fs), game.input)
  const touch = new TouchControls(app, game)
  const hud = new DebugHud(app, world, game, params.has('debug'))
  const fe = await createFrontend(app, fs, mute)
  if (mute) world.sound.enabled = false

  // ---- Game flow: menu <-> play ----
  const setPlaying = (on: boolean) => {
    world.paused = !on
    touch.setPlaying(on)
  }
  const play = (o: { level: number; mouseTight: boolean; mouseReverse: boolean; sound: boolean }) => {
    world.player.mouseTight = o.mouseTight
    world.player.mouseReverse = o.mouseReverse
    world.sound.enabled = o.sound && !mute
    game.startLevel(o.level)
    setPlaying(true)
    // Pointer lock is mouse-only; touch play goes fullscreen and asks for landscape where supported.
    if (game.input.mode === 'touch') enterImmersive()
    else Promise.resolve(renderer.domElement.requestPointerLock()).catch(() => {})
  }
  const ended = (status: 0 | 1) => (level: number) => {
    track(status === 0 ? 'game_over' : 'game_quit', { level })
    setPlaying(false)
    world.sound.stopAll()
    document.exitPointerLock()
    fe.gameEnded({ status, level })
    void fe.show().then(play)
  }
  game.events = { onGameOver: ended(0), onQuit: ended(1) }
  // Analytics: one event per level start, and a clear whenever the game advances in-process.
  const startLevel = game.startLevel.bind(game)
  game.startLevel = (n: number) => {
    if (world.outcome === 'cleared') track('level_cleared', { level: world.levelNumber })
    startLevel(n)
    track('level_started', { level: n, night: !world.daytime, mode: vm.mode })
  }
  // Class names are minified in production builds, so read the backend flag instead.
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2'
  track('game_loaded', { backend, preset: quality.preset, mode: vm.mode, input: game.input.mode })
  // Browsers swallow Esc while the mouse is captured and release the capture instead: treat that as Esc.
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && !world.paused && game.input.mode === 'mouse') game.events.onQuit?.(world.levelNumber)
  })
  game.startLevel(Number(params.get('level') ?? 1))
  const auto = params.get('autoplay')
  const record = params.get('record')
  if (record) {
    // Video tooling (engine/docs/dev/video.md): ?record=launch plays the scripted launch shot list into artifacts/video.
    world.paused = true
    void import('./debug/cinematic').then(({ recordLaunch }) =>
      recordLaunch({ game, renderer, vm, sound: world.sound, frontend: fe, name: record }),
    )
  } else if (auto) {
    // E2E: ?autoplay=1-5,9&seed=42&speed=4 plays levels through the real input path and writes artifacts/e2e reports.
    const levels = auto.split(',').flatMap((s) => {
      const [a, b = a] = s.split('-').map(Number)
      return Array.from({ length: b - a + 1 }, (_, i) => a + i)
    })
    world.paused = false
    startAutoplay(game, {
      levels,
      seed: Number(params.get('seed') ?? 1),
      speed: Number(params.get('speed') ?? 1),
      timeoutFrames: params.has('timeout') ? Number(params.get('timeout')) : undefined,
      renderer,
      onDone: (r) => console.log('autoplay done', r),
    })
  } else if (params.has('level')) setPlaying(true)
  else {
    setPlaying(false)
    void fe.show().then(play)
  }

  const fly = params.has('fly') ? new FlyCam(new THREE.PerspectiveCamera(60, 1, 10, 80000), renderer.domElement) : null
  if (fly) {
    fly.speed = 1500
    onAspect.push((a) => {
      fly.camera.aspect = a
      fly.camera.updateProjectionMatrix()
    })
  }
  onViewportChange(app, resize)
  resize()

  // ---- Frame loop ----
  const timer = new THREE.Timer()
  renderer.setAnimationLoop((now) => {
    timer.update()
    if (fly) {
      fly.update(Math.min(timer.getDelta(), 0.1))
      renderer.render(scene, fly.camera)
      return
    }
    if (!quality.beginFrame(now)) return // frame pacing: skip simulation and render together
    game.frame(now)
    fx.render(game.alpha)
    hud.update()
    touch.update()
    vm.render()
    quality.endFrame()
  })
  Object.assign(window, { __bh: { renderer, scene, world, game, g3d, terrain, geo, vm, quality, touch, resize, backend } })
}

start((await openDevFS()) ?? (await openDevFS('https://gamedata.ayushworks.com/')) ?? (await chooseGameFS(app))).catch((e) => {
  app.innerHTML = `<pre class="error">${(e as Error).stack ?? e}</pre>`
})
