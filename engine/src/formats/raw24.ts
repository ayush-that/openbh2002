// .t24 / .r24: headerless 24-bit RGB, rows top to bottom.
// Dimensions come from the "<W>x<H>" suffix in the file name, else 256x256.

export interface RawImage {
  width: number
  height: number
  rgb: Uint8Array
}

/**
 * Integer upscale factor k of a higher-resolution copy: `byteLength` is exactly `bytes` x k x k (k >= 2).
 * 1 for original files. UVs are normalised, so a k-times larger texture drops in unchanged.
 */
export function rawScale(byteLength: number, bytes: number) {
  const k = Math.round(Math.sqrt(byteLength / bytes))
  return k >= 2 && bytes * k * k === byteLength ? k : 1
}

export function raw24Size(name: string, byteLength: number): { width: number; height: number } {
  const m = /(\d+)\.?x(\d+)\.[tr]24$/i.exec(name)
  const [width, height] = m ? [+m[1], +m[2]] : [256, 256]
  if (width * height * 3 !== byteLength) {
    const k = rawScale(byteLength, width * height * 3)
    if (k > 1) return { width: width * k, height: height * k }
    const side = Math.sqrt(byteLength / 3)
    if (Number.isInteger(side)) return { width: side, height: side }
    throw new Error(`${name}: ${byteLength} bytes does not match ${width}x${height}x3`)
  }
  return { width, height }
}

/** Pass width/height when known (Geometry.3D texture table); otherwise they are inferred from the name. */
export function decodeRaw24(name: string, data: Uint8Array, width?: number, height?: number): RawImage {
  if (width && height) {
    if (data.byteLength < width * height * 3) throw new Error(`${name}: ${data.byteLength} bytes is less than ${width}x${height}x3`)
    const k = rawScale(data.byteLength, width * height * 3)
    return { width: width * k, height: height * k, rgb: data }
  }
  return { ...raw24Size(name, data.byteLength), rgb: data }
}

/** Expand to RGBA. With colorKey, pure black (0,0,0) becomes fully transparent, as in D3D7 source color keying. */
export function toRGBA(img: RawImage, colorKey = false): Uint8Array {
  const out = new Uint8Array(img.width * img.height * 4)
  for (let i = 0, j = 0, n = img.width * img.height * 3; i < n; i += 3, j += 4) {
    const r = img.rgb[i], g = img.rgb[i + 1], b = img.rgb[i + 2]
    out[j] = r
    out[j + 1] = g
    out[j + 2] = b
    out[j + 3] = colorKey && r === 0 && g === 0 && b === 0 ? 0 : 255
  }
  return out
}
