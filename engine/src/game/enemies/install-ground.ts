import type { GameFS } from '../../vfs'
import type { World } from '../world'
import { GroundSystem } from './ground'
import { SoldierPool } from './soldiers'

/**
 * Tanks, APCs and the soldier pool. The pool is updated from GroundSystem.update (after the vehicle AI,
 * before terrain following, as in FUN_004051c8). The fs is needed for the soldier Film sheets and the
 * burn effect texture, which Geometry.3D fills at runtime. Returns the system so the sound module can
 * read `engineLoops()`.
 */
export function installGround(world: World, fs: GameFS): GroundSystem {
  const soldiers = new SoldierPool(world, fs)
  const ground = new GroundSystem(world, soldiers)
  world.soldiers = soldiers
  world.enemies.push(ground)
  return ground
}
