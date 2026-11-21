// HMap<N>x<N>.hmap: 8-bit heights. MMap<N>x<N>.mmap: 8-bit terrain material (value >> 4 = TerrainCloseNN index - 1).

export interface Grid8 {
  size: number
  data: Uint8Array
}

export function decodeGrid8(name: string, data: Uint8Array): Grid8 {
  const m = /(\d+)x(\d+)\.[hm]map$/i.exec(name)
  const size = m ? +m[1] : Math.sqrt(data.byteLength)
  if (!Number.isInteger(size) || size * size !== data.byteLength) throw new Error(`${name}: not a square 8-bit grid`)
  return { size, data }
}
