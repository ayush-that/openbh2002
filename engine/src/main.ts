import * as THREE from 'three/webgpu'
import './style.css'
import { openDevFS, openPickedFS, type GameFS } from './vfs'
import { parseGeometry3D, type Geometry3D } from './formats/geometry3d'
import { G3DScene } from './render/g3dscene'
import { Terrain } from './world/terrain'
import { FlyCam } from './debug/flycam'

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

/** Which Geometry.3D objects are part of the static scene. Everything else is a pooled runtime object. */
function staticIds(geo: Geometry3D, night: boolean) {
  const ids = new Set<number>([night ? 9 : 8, 19, 20, 21, 22, 532, night ? 534 : 533, 535])
  for (let id = 10; id <= 18; id++) ids.add(id)
  // Keep ancestors visible so children can show.
  for (const id of [...ids]) {
    let o = geo.objects[id]
    while (o?.parent != null) {
      ids.add(o.parent)
      o = geo.objects[o.parent]
    }
  }
  return ids
}

async function start(fs: GameFS) {
  app.innerHTML = ''
  const renderer = new THREE.WebGPURenderer({ antialias: true })
  await renderer.init()
  renderer.setPixelRatio(devicePixelRatio)
  renderer.setSize(innerWidth, innerHeight)
  app.appendChild(renderer.domElement)

  const night = params.get('time') === 'night'
  let remaster = params.get('mode') === 'remaster'

  const geo = parseGeometry3D(await fs.text('BH2Game/Geometry.3D'))
  const [g3d, terrain] = await Promise.all([G3DScene.load(fs, geo), Terrain.load(fs)])

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(night ? 0x02040a : 0x5a7cc0)
  scene.add(g3d.root, terrain.group)

  // PROVISIONAL: SandBags are modeled at y 0..106 but the ground at the origin is ~608, so the game must lift them.
  g3d.node(532).position.y = terrain.heightAt(0, 0)

  const visible = staticIds(geo, night)
  for (const [id, node] of g3d.nodes) node.visible = visible.has(id)

  // Lighting from Geometry.3D object 0 (LightDistant). Ambient level is PROVISIONAL.
  const sunDef = geo.objects[0].lights.find((l) => l.type === 'distant')
  const sun = new THREE.DirectionalLight(0xffffff, sunDef ? sunDef.intensity / 255 : 1)
  if (sunDef) sun.position.set(...sunDef.direction).normalize()
  scene.add(sun, new THREE.AmbientLight(0xffffff, night ? 0.25 : 0.55))

  const applyMode = () => {
    for (let id = 10; id <= 18; id++) g3d.node(id).visible = !remaster
    terrain.group.visible = remaster
  }
  applyMode()
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyT') {
      remaster = !remaster
      applyMode()
    }
  })

  // PROVISIONAL camera: at the weapon Mount (0, 800, 0), looking north (-Z). FOV pending RE.
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 5, 80000)
  camera.position.set(0, 860, 40)
  const fly = new FlyCam(camera, renderer.domElement)
  fly.speed = 1500
  fly.lookAt(0, 800, -1000)

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })

  const timer = new THREE.Timer()
  renderer.setAnimationLoop(() => {
    timer.update()
    fly.update(Math.min(timer.getDelta(), 0.1))
    renderer.render(scene, camera)
  })
  Object.assign(window, { __bh: { renderer, scene, camera, terrain, g3d, fly, geo, backend: renderer.backend.constructor.name } })
}

start((await openDevFS()) ?? (await pickFolder())).catch((e) => {
  app.innerHTML = `<pre class="error">${(e as Error).stack ?? e}</pre>`
})
