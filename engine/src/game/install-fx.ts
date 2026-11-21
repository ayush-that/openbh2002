import type * as THREE from 'three/webgpu'
import type { GameFS } from '../vfs'
import { EffectSystem } from './effects'
import type { Game } from './game'
import { NightLights } from './night-lights'
import { SoundSystem } from './sound'
import type { World } from './world'

/**
 * Wires effects, night lights and sound into a running game: sets world.effects and world.sound and adds
 * the effect meshes and lights to the scene. Call render(game.alpha) after game.frame() and before rendering.
 */
export async function installFx(world: World, game: Game, scene: THREE.Scene, fs: GameFS) {
  const [effects, sound] = await Promise.all([EffectSystem.load(world, game.camera, fs), SoundSystem.load(fs)])
  const lights = new NightLights(scene, world, game.camera)
  scene.add(effects.group)
  world.effects = effects
  world.sound = sound
  sound.unlock(window)
  return {
    effects,
    sound,
    lights,
    render(alpha: number) {
      effects.render(alpha)
      lights.render(alpha)
    },
  }
}
