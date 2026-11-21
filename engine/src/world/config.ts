// World constants. PROVISIONAL values are placeholders until confirmed from the original exe.

export const TERRAIN = {
  heightmap: 'BH2Game/HMap1501x1501.hmap',
  /** World units per heightmap cell. PROVISIONAL */
  cellSize: 1,
  /** World units per height step (0-255). PROVISIONAL */
  heightScale: 0.35,
  /** 4x4 high-detail aerial photo covering the center third of the map (confirmed by seamless stitching). */
  close: { grid: 4, files: (i: number) => `BH2Game/TerrainClose${String(i + 1).padStart(2, '0')}.t24` },
  /** 3x3 low-detail photo of the whole map, center slot (5) unused (confirmed by seamless stitching). */
  far: { grid: 3, files: (i: number) => (i === 4 ? null : `BH2Game/TerrainFar${i + 1}.t24`) },
  /** Fraction of the map (centered) covered by the close texture. PROVISIONAL (center third) */
  closeExtent: 1 / 3,
  /** Cells per mesh chunk, for frustum culling. */
  chunkCells: 100,
}

export const SKY = {
  day: { cylinder: 'BH2Game/SkyCylinder1.t24', clouds: 'BH2Game/Sky1.t24' },
  night: { cylinder: 'BH2Game/SkyCylinderN1.t24', clouds: 'BH2Game/SkyN1.t24' },
}
