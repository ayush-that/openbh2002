import * as THREE from 'three/webgpu'
import './style.css'
import { openDevFS, openPickedFS, type GameFS } from './vfs'
import { parseGeometry3D } from './formats/geometry3d'
import { parseShapeData } from './formats/shapedata'
import { G3DScene } from './render/g3dscene'
import { Terrain } from './world/terrain'
import { FlyCam } from './debug/flycam'
import { Collision } from './game/collision'
import { World } from './game/world'
import { Game } from './game/game'
import { OBJ } from './game/constants'
import { DebugHud } from './debug/hud'
import { Hud } from './game/hud'
import { installFx } from './game/install-fx'
import { installAir } from './game/enemies/install-air'
import { installGround } from './game/enemies/install-ground'

// The original does all lighting math in gamma space (16-bit framebuffer, no sRGB). Match it.
THREE.ColorManagement.enabled = false

const app = document.querySelector<HTMLDivElement>('#app')!
const params = new URLSearchParams(location.search)

function pickFolder(): Promise<GameFS> {
  app.innerHTML = `
    <div class="picker">
      <h1>OpenBH2002</h1>
      <p>Select your Beach Head 2002 folder. Files stay on your computer.</p>
      <label class="button">Choose folder<input type="file" webkitdirectory hidden></label>
      <p class="error" hidden></p>
    </div>`
  const input = app.querySelector<HTMLInputElement>('input')!
  const error = app.querySelector<HTMLParagraphElement>('.error')!
  return new Promise((resolve) => {
    input.addEventListener('change', () => {
      try {
        resolve(openPickedFS(input.files ?? []))
      } catch (e) {
        error.hidden = false
        error.textContent = (e as Error).message
      }
    })
  })
}

async function start(fs: GameFS) {
  app.innerHTML = ''
  const renderer = new THREE.WebGPURenderer({ antialias: true })
  await renderer.init()
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace
  renderer.setPixelRatio(devicePixelRatio)
  renderer.setSize(innerWidth, innerHeight)
  app.appendChild(renderer.domElement)

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

  let remaster = params.get('mode') === 'remaster'
  const applyMode = () => {
    for (let id = OBJ.terrainFirst; id <= OBJ.terrainLast; id++) g3d.node(id).visible = !remaster
    terrain.group.visible = remaster
  }
  applyMode()
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyT' && e.shiftKey) {
      remaster = !remaster
      applyMode()
    }
  })

  const world = new World({ g3d, terrain, mmap, shapes, collision: new Collision(shapes) })
  const game = new Game(world, fs, renderer.domElement)
  game.onDayNight = (day) => {
    sun.visible = day
    // Night: the sun is off and there is no ambient term, so lit geometry relies on flares and the spotlight.
    ambient.intensity = day ? k / 2 : 0.06 * Math.PI
  }
  installGround(world, fs)
  installAir(world)
  const fx = await installFx(world, game, scene, fs)
  await game.preload()
  game.late.push(new Hud(renderer.domElement, game, fs))
  const hud = new DebugHud(app, world, game, params.has('debug'))
  game.events = {
    onGameOver: (n) => hud.message(`DESTROYED on level ${n}. Click to restart.`, () => game.startLevel(n)),
    onQuit: (n) => hud.message(`Quit on level ${n}. Click to continue.`, () => (world.paused = false)),
  }
  game.startLevel(Number(params.get('level') ?? 1))

  const fly = params.has('fly') ? new FlyCam(new THREE.PerspectiveCamera(60, 1, 10, 80000), renderer.domElement) : null
  if (fly) fly.speed = 1500

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight)
    for (const c of [game.camera, fly?.camera]) {
      if (!c) continue
      c.aspect = innerWidth / innerHeight
      c.updateProjectionMatrix()
    }
  }
  addEventListener('resize', resize)
  resize()

  const timer = new THREE.Timer()
  renderer.setAnimationLoop((now) => {
    timer.update()
    if (fly) {
      fly.update(Math.min(timer.getDelta(), 0.1))
      renderer.render(scene, fly.camera)
      return
    }
    game.frame(now)
    fx.render(game.alpha)
    hud.update()
    renderer.render(scene, game.camera)
  })
  Object.assign(window, { __bh: { renderer, scene, world, game, g3d, terrain, geo, backend: renderer.backend.constructor.name } })
}

start((await openDevFS()) ?? (await pickFolder())).catch((e) => {
  app.innerHTML = `<pre class="error">${(e as Error).stack ?? e}</pre>`
})
