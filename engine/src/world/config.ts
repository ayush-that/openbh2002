// World constants. PROVISIONAL values are placeholders until confirmed from the original exe.

export const TERRAIN = {
  heightmap: 'BH2Game/HMap1501x1501.hmap',
  /** World units per heightmap cell. Confirmed: matches Geometry.3D terrain (30000 units / 1500 cells). */
  cellSize: 20,
  /** World units per height step (0-255). Confirmed: Geometry.3D terrain heights = hmap * 8 (mean error 0). */
  heightScale: 8,
  /** 4x4 high-detail aerial photo covering the center third of the map (confirmed by seamless stitching). */
  close: { grid: 4, files: (i: number) => `BH2Game/TerrainClose${String(i + 1).padStart(2, '0')}.t24` },
  /** 3x3 low-detail photo of the whole map, center slot (5) unused (confirmed by seamless stitching). */
  far: { grid: 3, files: (i: number) => (i === 4 ? null : `BH2Game/TerrainFar${i + 1}.t24`) },
  /** Fraction of the map (centered) covered by the close texture. Confirmed: Geometry.3D Terrain5 spans -5000..5000. */
  closeExtent: 1 / 3,
  /** Cells per mesh chunk, for frustum culling. */
  chunkCells: 100,
  /** Rows run along +Z, columns along +X, origin at the map center (confirmed against Geometry.3D). */
}
