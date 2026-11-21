import * as THREE from 'three/webgpu'
import './style.css'
import { openDevFS, openPickedFS, type GameFS } from './vfs'
import { Terrain } from './world/terrain'
import { Sky } from './world/sky'
import { FlyCam } from './debug/flycam'

const app = document.querySelector<HTMLDivElement>('#app')!

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
  renderer.setPixelRatio(devicePixelRatio)
  renderer.setSize(innerWidth, innerHeight)
  app.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x5a7cc0)
  scene.fog = new THREE.Fog(0x9fb4d8, 150, 800)
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x6b5a3a, 1.2))
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.position.set(1, 2, 0.5)
  scene.add(sun)

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 4000)
  const [terrain, sky] = await Promise.all([Terrain.load(fs), Sky.load(fs)])
  scene.add(terrain.group, sky.group)
  camera.position.set(0, terrain.heightAt(0, 0) + 40, 120)
  camera.lookAt(0, terrain.heightAt(0, 0), 0)
  const fly = new FlyCam(camera, renderer.domElement)

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })

  const timer = new THREE.Timer()
  renderer.setAnimationLoop(() => {
    timer.update()
    fly.update(Math.min(timer.getDelta(), 0.1))
    sky.follow(camera)
    renderer.render(scene, camera)
  })
  Object.assign(window, { __bh: { renderer, scene, camera, terrain, fly, sky, backend: renderer.backend.constructor.name } })
}

start((await openDevFS()) ?? (await pickFolder())).catch((e) => {
  app.innerHTML = `<pre class="error">${(e as Error).stack ?? e}</pre>`
})
