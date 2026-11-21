import type { World } from '../world'
import { AirSystem, type EngineDistances } from './air'
import { Parachutes } from './parachutes'

/**
 * Registers the aircraft system (JET, BOMBER, COBRA, CH53, C130, with the parachute pool) and the
 * player's bomber strike. Call once after the World exists and before the first `startLevel`.
 */
export function installAir(world: World): void {
  const air = new AirSystem(world, new Parachutes(world))
  world.enemies.push(air)
  world.callBombers = () => air.callBombers(world)
}

/**
 * Engine-loop input for the sound module (FUN_00424aef): per class, the distance max(|x|, |z|) of the
 * nearest active aircraft, Infinity when none (or when the air system is not installed).
 * Jet and C130 loops play when d < 30001 at volume -d/8; Bomber, Cobra and CH53 when d < 18001 at -d/4.
 */
export function airEngineDistances(world: World): EngineDistances {
  const air = world.enemies.find((s): s is AirSystem => s instanceof AirSystem)
  return air ? air.engineDistances() : { jet: Infinity, c130: Infinity, bomber: Infinity, cobra: Infinity, ch53: Infinity }
}
