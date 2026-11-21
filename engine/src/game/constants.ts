// Constants confirmed from BH2.exe (see docs/re/*.md). All rates are per 29 ms game frame.

/** Busy-wait cap in WinMain: frames are at least 29 ms apart (~34.5 fps). */
export const FRAME_MS = 29

export const EYE = { x: 0, y: 820, z: 0 }
export const MOUNT = { x: 0, y: 800, z: 0 }

export const CAMERA = { vfov: 41.11, near: 10, far: 32700 }

export const PITCH_MIN = -25
export const PITCH_MAX = 80
export const START_YAW = 180

export const CAPS = { bullets: 500, cannon: 20, missiles: 20, flares: 20, shield: 100 }
export const HANDGUN_ROUNDS = 15

export const GRAVITY = 0.16

/** Frames between the cleared/destroyed banner and the next level or game over. */
export const OUTCOME_FRAMES = 150

/** Geometry.3D object ids. */
export const OBJ = {
  sun: 0,
  spotlight: 1,
  skyDay: 8,
  skyNight: 9,
  terrainFirst: 10,
  terrainLast: 18,
  mount: 19,
  aaMount: 20,
  m60: 23,
  cannon: 24,
  mortor: 25,
  pistol: 26,
  flaregun: 28,
  sandbags: 532,
  foliageDay: 533,
  foliageNight: 534,
  crosshair: 535,
} as const

/** ShapeData object index per collision type (file order). */
export const SHAPE = { tank: 0, apc: 1, jet: 2, bomber: 3, cobra: 4, ch53: 5, c130: 6, parachute: 7 } as const
export type ShapeKind = keyof typeof SHAPE

/** Bounding-sphere radius checked before the polygon ray test (FUN_004154b7). */
export const HIT_RADIUS: Record<ShapeKind, number> = {
  tank: 500,
  apc: 500,
  jet: 670,
  bomber: 1100,
  cobra: 590,
  ch53: 900,
  c130: 1270,
  parachute: 700,
}

export const deg = Math.PI / 180
