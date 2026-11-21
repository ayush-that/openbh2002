// .t24 / .r24: headerless 24-bit RGB, rows top to bottom.
// Dimensions come from the "<W>x<H>" suffix in the file name, else 256x256.

export interface RawImage {
  width: number
  height: number
  rgb: Uint8Array
}

export function raw24Size(name: string, byteLength: number): { width: number; height: number } {
  const m = /(\d+)\.?x(\d+)\.[tr]24$/i.exec(name)
  const [width, height] = m ? [+m[1], +m[2]] : [256, 256]
  if (width * height * 3 !== byteLength) {
    const side = Math.sqrt(byteLength / 3)
    if (Number.isInteger(side)) return { width: side, height: side }
    throw new Error(`${name}: ${byteLength} bytes does not match ${width}x${height}x3`)
  }
  return { width, height }
}

export function decodeRaw24(name: string, data: Uint8Array): RawImage {
  return { ...raw24Size(name, data.byteLength), rgb: data }
}

/** Expand to RGBA. Black (0,0,0) becomes transparent when colorKey is set (sprites/effects). */
export function toRGBA(img: RawImage, colorKey = false): Uint8Array {
  const out = new Uint8Array(img.width * img.height * 4)
  for (let i = 0, j = 0; i < img.rgb.length; i += 3, j += 4) {
    const r = img.rgb[i], g = img.rgb[i + 1], b = img.rgb[i + 2]
    out[j] = r
    out[j + 1] = g
    out[j + 2] = b
    out[j + 3] = colorKey ? Math.max(r, g, b) : 255
  }
  return out
}
