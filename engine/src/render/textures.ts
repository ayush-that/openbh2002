import * as THREE from 'three/webgpu'
import type { GameFS } from '../vfs'
import { decodeRaw24, toRGBA, type RawImage } from '../formats/raw24'

export interface TextureOptions {
  colorKey?: boolean
  repeat?: boolean
}

export function imageTexture(width: number, height: number, rgba: Uint8Array, opts: TextureOptions = {}) {
  const tex = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 16
  tex.wrapS = tex.wrapT = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

export async function loadRaw24(fs: GameFS, path: string): Promise<RawImage> {
  return decodeRaw24(path, await fs.read(path))
}

export async function loadRaw24Texture(fs: GameFS, path: string, opts: TextureOptions = {}) {
  const img = await loadRaw24(fs, path)
  return imageTexture(img.width, img.height, toRGBA(img, opts.colorKey), opts)
}

/** Stitch a row-major grid of equally sized tiles into one texture. Null tiles stay black. */
export async function loadTileGrid(fs: GameFS, grid: number, file: (i: number) => string | null) {
  const paths = Array.from({ length: grid * grid }, (_, i) => file(i))
  const tiles = await Promise.all(paths.map((p) => (p ? loadRaw24(fs, p) : null)))
  const first = tiles.find((t) => t)!
  const tw = first.width, th = first.height, w = tw * grid, h = th * grid
  const out = new Uint8Array(w * h * 4)
  tiles.forEach((t, i) => {
    if (!t) return
    if (t.width !== tw || t.height !== th) throw new Error(`${paths[i]}: tile size mismatch`)
    const ox = (i % grid) * tw, oy = Math.floor(i / grid) * th
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const s = (y * tw + x) * 3, d = ((oy + y) * w + ox + x) * 4
        out[d] = t.rgb[s]
        out[d + 1] = t.rgb[s + 1]
        out[d + 2] = t.rgb[s + 2]
        out[d + 3] = 255
      }
    }
  })
  return imageTexture(w, h, out)
}
