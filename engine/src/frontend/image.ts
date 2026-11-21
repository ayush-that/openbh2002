// Image decoders for the front-end art (Fichas/*): TGA (types 2/3/10/11, 8/24/32-bit), 8-bit x3 PCX, and
// GIF through the browser. Output is top-down RGBA.

export interface Pic {
  width: number
  height: number
  data: Uint8ClampedArray
}

export function decodeTGA(b: Uint8Array): Pic {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const idLen = b[0], cmapType = b[1], type = b[2]
  if (cmapType !== 0 || ![2, 3, 10, 11].includes(type)) throw new Error(`TGA: unsupported type ${type} (colour map ${cmapType})`)
  const width = v.getUint16(12, true), height = v.getUint16(14, true), bpp = b[16], desc = b[17]
  const px = bpp >> 3
  if (![1, 3, 4].includes(px)) throw new Error(`TGA: unsupported ${bpp} bpp`)
  const n = width * height
  const raw = new Uint8Array(n * px)
  let o = 18 + idLen
  if (type < 8) {
    if (o + raw.length > b.length) throw new Error('TGA: truncated')
    raw.set(b.subarray(o, o + raw.length))
  } else {
    for (let i = 0; i < raw.length && o < b.length; ) {
      const h = b[o++], count = (h & 0x7f) + 1
      if (h & 0x80) {
        for (let k = 0; k < count; k++) raw.set(b.subarray(o, o + px), i + k * px)
        o += px
      } else {
        raw.set(b.subarray(o, o + count * px), i)
        o += count * px
      }
      i += count * px
    }
  }
  const data = new Uint8ClampedArray(n * 4)
  const topDown = (desc & 0x20) !== 0
  let anyAlpha = false
  for (let y = 0; y < height; y++) {
    const sy = topDown ? y : height - 1 - y
    for (let x = 0; x < width; x++) {
      const s = (sy * width + x) * px, d = (y * width + x) * 4
      if (px === 1) {
        data[d] = data[d + 1] = data[d + 2] = raw[s]
        data[d + 3] = 255
      } else {
        data[d] = raw[s + 2]
        data[d + 1] = raw[s + 1]
        data[d + 2] = raw[s]
        data[d + 3] = px === 4 ? raw[s + 3] : 255
        if (px === 4 && raw[s + 3]) anyAlpha = true
      }
    }
  }
  // Several 32-bit files (ini01..04, fin01..04) have an all-zero alpha channel yet draw opaque in bh2.ews.
  if (px === 4 && !anyAlpha) for (let i = 3; i < data.length; i += 4) data[i] = 255
  return { width, height, data }
}

/** ZSoft PCX v5, RLE, 8 bits x 3 planes (the only kind the menu ships). */
export function decodePCX(b: Uint8Array): Pic {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b[0] !== 10 || b[2] !== 1 || b[3] !== 8) throw new Error('PCX: unsupported format')
  const width = v.getUint16(8, true) - v.getUint16(4, true) + 1
  const height = v.getUint16(10, true) - v.getUint16(6, true) + 1
  const planes = b[65], bpl = v.getUint16(66, true)
  const line = new Uint8Array(planes * bpl)
  const data = new Uint8ClampedArray(width * height * 4)
  const pal = planes === 1 && b.length > 769 && b[b.length - 769] === 12 ? b.subarray(b.length - 768) : null
  let o = 128
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < line.length && o < b.length; ) {
      const c = b[o++]
      if ((c & 0xc0) === 0xc0) {
        const val = b[o++]
        for (let k = c & 0x3f; k > 0 && i < line.length; k--) line[i++] = val
      } else line[i++] = c
    }
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4
      if (pal) {
        const p = line[x] * 3
        data[d] = pal[p]
        data[d + 1] = pal[p + 1]
        data[d + 2] = pal[p + 2]
      } else {
        data[d] = line[x]
        data[d + 1] = line[bpl + x]
        data[d + 2] = line[2 * bpl + x]
      }
      data[d + 3] = 255
    }
  }
  return { width, height, data }
}

export async function decodeBrowserImage(b: Uint8Array, mime: string): Promise<Pic> {
  const bmp = await createImageBitmap(new Blob([b.slice().buffer], { type: mime }))
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  const g = c.getContext('2d')!
  g.drawImage(bmp, 0, 0)
  bmp.close()
  const id = g.getImageData(0, 0, c.width, c.height)
  return { width: id.width, height: id.height, data: id.data }
}

export async function decodeImage(name: string, b: Uint8Array): Promise<Pic> {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'tga') return decodeTGA(b)
  if (ext === 'pcx') return decodePCX(b)
  if (ext === 'gif') return decodeBrowserImage(b, 'image/gif')
  throw new Error(`Unsupported image: ${name}`)
}

/** Use the luminance of `mask` as alpha (bh2.ews pairs metralleta*.pcx with metralletaa.gif). */
export function applyAlphaMask(pic: Pic, mask: Pic): Pic {
  if (pic.width !== mask.width || pic.height !== mask.height) throw new Error('alpha mask size mismatch')
  const data = new Uint8ClampedArray(pic.data)
  for (let i = 0; i < data.length; i += 4) data[i + 3] = mask.data[i]
  return { width: pic.width, height: pic.height, data }
}

export function picCanvas(pic: Pic): OffscreenCanvas {
  const c = new OffscreenCanvas(pic.width, pic.height)
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pic.data), pic.width, pic.height), 0, 0)
  return c
}
