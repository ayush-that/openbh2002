// Read-only, case-insensitive view of the user's game folder.
// Paths are relative to the game root, using '/' separators (e.g. "BH2Game/Sky1.t24").
import { inflateSync } from 'fflate'

export interface GameFS {
  list(): string[]
  has(path: string): boolean
  read(path: string): Promise<Uint8Array>
  text(path: string): Promise<string>
}

const key = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase()
/** A texture may ship as lossless WebP named after the original (`Sky1.t24.webp`); it stands in for `Sky1.t24`. */
const PACKED = /\.(t24|r24|tga)\.webp$/i
const unpacked = (p: string) => (PACKED.test(p) ? p.slice(0, -5) : p)

abstract class BaseFS implements GameFS {
  protected index = new Map<string, string>()
  constructor(paths: string[]) {
    for (const p of paths) this.index.set(key(unpacked(p)), p)
  }
  list() {
    return [...this.index.values()].map(unpacked)
  }
  has(path: string) {
    return this.index.has(key(path))
  }
  protected resolve(path: string) {
    const real = this.index.get(key(path))
    if (!real) throw new Error(`Game file not found: ${path}`)
    return real
  }
  protected abstract raw(real: string): Promise<Uint8Array>
  async read(path: string) {
    const real = this.resolve(path)
    const data = await this.raw(real)
    return PACKED.test(real) ? unwebp(real, data) : data
  }
  async text(path: string) {
    // Original files are Windows-1252 with CRLF line endings.
    return new TextDecoder('windows-1252').decode(await this.read(path)).replace(/\r\n?/g, '\n')
  }
}

class HttpFS extends BaseFS {
  private base: string
  constructor(paths: string[], base: string) {
    super(paths)
    this.base = base
  }
  /** Retries dropped connections and server errors (common on mobile networks); a 404 fails at once. */
  async raw(real: string) {
    const url = this.base + real.split('/').map(encodeURIComponent).join('/')
    for (let attempt = 1; ; attempt++) {
      let status = 0
      try {
        const res = await fetch(url)
        status = res.status
        if (res.ok) return new Uint8Array(await res.arrayBuffer())
      } catch (e) {
        status = 0 // also a body cut off mid-download
        if (attempt >= 5) throw new Error(`Failed to load ${real}: ${(e as Error).message}`)
      }
      if (status && ((status < 500 && status !== 429) || attempt >= 5)) throw new Error(`Failed to load ${real}: ${status}`)
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)))
    }
  }
}

/** Decodes a packed texture back to the exact bytes of the original layout (raw RGB, or an uncompressed TGA). */
async function unwebp(real: string, data: Uint8Array) {
  const bmp = await createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'image/webp' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const { width, height } = bmp
  const g = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!
  g.drawImage(bmp, 0, 0)
  bmp.close()
  const px = g.getImageData(0, 0, width, height).data
  const tga = /\.tga\.webp$/i.test(real)
  const head = tga ? 18 : 0
  const out = new Uint8Array(head + width * height * 3)
  // Packed TGAs are opaque only: written back as type 2, 24-bit BGR, top-down.
  if (tga) out.set([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 24, 0x20])
  const [r, b] = tga ? [2, 0] : [0, 2]
  for (let i = 0, o = head; i < px.length; i += 4, o += 3) {
    out[o + r] = px[i]
    out[o + 1] = px[i + 1]
    out[o + b] = px[i + 2]
  }
  return out
}

/** One file from any source: a picked folder, a zip, an ISO, or browser storage. */
export interface Entry {
  path: string
  size: number
  read(): Promise<Uint8Array>
}

class EntryFS extends BaseFS {
  private entries = new Map<string, Entry>()
  constructor(entries: Entry[]) {
    super(entries.map((e) => e.path))
    for (const e of entries) this.entries.set(key(e.path), e)
  }
  raw(real: string) {
    return this.entries.get(key(real))!.read()
  }
}

/** Dev server copy, if the gamedata middleware is running. */
export async function openDevFS(base = '/gamedata/'): Promise<GameFS | null> {
  try {
    const res = await fetch(base + '__index.json')
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null
    return new HttpFS(await res.json(), base)
  } catch {
    return null
  }
}

// ---- Sources ----

const blobBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer())

/** Loose files; `path` defaults to webkitRelativePath (folder picker) or the bare name. */
export function fileEntries(files: Iterable<File>, pathOf = (f: File) => f.webkitRelativePath || f.name): Entry[] {
  return [...files].map((f) => ({ path: pathOf(f), size: f.size, read: () => blobBytes(f) }))
}

/** Zip archive, read lazily from its central directory (no full load into memory). */
export async function zipEntries(file: Blob): Promise<Entry[]> {
  const tailLen = Math.min(file.size, 65557)
  const tail = await blobBytes(file.slice(file.size - tailLen))
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { eocd = i; break }
  if (eocd < 0) throw new Error('Not a valid zip file.')
  const ev = new DataView(tail.buffer, eocd)
  let count = ev.getUint16(10, true)
  let cdSize = ev.getUint32(12, true)
  let cdOff = ev.getUint32(16, true)
  if (cdOff === 0xffffffff || count === 0xffff) {
    // Zip64: locator sits right before the EOCD record.
    const lv = new DataView(tail.buffer, eocd - 20)
    if (lv.getUint32(0, true) !== 0x07064b50) throw new Error('Unsupported zip file.')
    const rec = new DataView((await blobBytes(file.slice(Number(lv.getBigUint64(8, true)), Number(lv.getBigUint64(8, true)) + 56))).buffer)
    count = Number(rec.getBigUint64(32, true))
    cdSize = Number(rec.getBigUint64(40, true))
    cdOff = Number(rec.getBigUint64(48, true))
  }
  const cd = await blobBytes(file.slice(cdOff, cdOff + cdSize))
  const v = new DataView(cd.buffer)
  const utf8 = new TextDecoder()
  const latin = new TextDecoder('windows-1252')
  const out: Entry[] = []
  for (let p = 0, n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
    const flags = v.getUint16(p + 8, true)
    const method = v.getUint16(p + 10, true)
    let csize = v.getUint32(p + 20, true)
    let size = v.getUint32(p + 24, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    let local = v.getUint32(p + 42, true)
    const name = (flags & 0x800 ? utf8 : latin).decode(cd.subarray(p + 46, p + 46 + nameLen))
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end; ) {
      const id = v.getUint16(x, true)
      const len = v.getUint16(x + 2, true)
      if (id === 1) {
        let q = x + 4
        const next = () => Number(v.getBigUint64((q += 8) - 8, true))
        if (size === 0xffffffff) size = next()
        if (csize === 0xffffffff) csize = next()
        if (local === 0xffffffff) local = next()
      }
      x += 4 + len
    }
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/') || flags & 1) continue
    if (method !== 0 && method !== 8) continue
    out.push({
      path: name,
      size,
      read: async () => {
        const h = new DataView(await file.slice(local, local + 30).arrayBuffer())
        const start = local + 30 + h.getUint16(26, true) + h.getUint16(28, true)
        const data = await blobBytes(file.slice(start, start + csize))
        return method === 0 ? data : inflateSync(data, { out: new Uint8Array(size) })
      },
    })
  }
  return out
}

/** ISO 9660 image (CD), preferring Joliet names when present. */
export async function isoEntries(file: Blob): Promise<Entry[]> {
  const S = 2048
  const sector = (lba: number, n = 1) => blobBytes(file.slice(lba * S, (lba + n) * S))
  let root: Uint8Array | null = null
  let joliet = false
  for (let lba = 16; lba < 64; lba++) {
    const d = await sector(lba)
    if (d.length < S || String.fromCharCode(...d.subarray(1, 6)) !== 'CD001') break
    if (d[0] === 255) break
    const esc = String.fromCharCode(d[88], d[89], d[90])
    if (d[0] === 1 && !root) root = d.subarray(156, 190)
    if (d[0] === 2 && /^%\/[@CE]$/.test(esc)) {
      root = d.subarray(156, 190)
      joliet = true
    }
  }
  if (!root) throw new Error('Not a valid ISO image.')
  const ucs2 = new TextDecoder('utf-16be')
  const ascii = new TextDecoder('windows-1252')
  const out: Entry[] = []
  const seen = new Set<number>()
  const walk = async (rec: Uint8Array, prefix: string, depth: number): Promise<void> => {
    const rv = new DataView(rec.buffer, rec.byteOffset)
    const lba = rv.getUint32(2, true)
    const len = rv.getUint32(10, true)
    if (seen.has(lba) || depth > 16) return
    seen.add(lba)
    const dir = await sector(lba, Math.ceil(len / S))
    for (let p = 0; p < len; ) {
      const rl = dir[p]
      if (!rl) {
        p = (Math.floor(p / S) + 1) * S
        continue
      }
      const r = dir.subarray(p, p + rl)
      p += rl
      const nl = r[32]
      const raw = r.subarray(33, 33 + nl)
      if (nl === 1 && raw[0] <= 1) continue
      const name = (joliet ? ucs2 : ascii).decode(raw).replace(/;\d+$/, '').replace(/\.$/, '')
      const dv = new DataView(r.buffer, r.byteOffset)
      if (r[25] & 2) await walk(r, prefix + name + '/', depth + 1)
      else {
        const at = dv.getUint32(2, true) * S
        const size = dv.getUint32(10, true)
        out.push({ path: prefix + name, size, read: () => blobBytes(file.slice(at, at + size)) })
      }
    }
  }
  await walk(root, '', 0)
  return out
}

// ---- Game root detection and validation ----

const MARKER = /(^|\/)bh2game\/geometry\.3d$/
/** Files the engine cannot start without (relative to the game root). */
export const REQUIRED = [
  'BH2Game/Geometry.3D',
  'BH2Game/ShapeData',
  'BH2Game/MMap1501x1501.mmap',
  'BH2Game/HMap1501x1501.hmap',
  'BH2Game/TerrainClose01.t24',
  'Fichas/TEXMENU/ini01.tga',
  'Fichas/sfx/Menu.xm',
  'vehicles/apc1.3DB',
]
/** What the engine reads: BH2Game, Fichas, vehicles and BH2002.ini. Skips installers, DirectX, Russian data, executables. */
const NEEDED = /^((bh2game|fichas|vehicles)\/.*|bh2002\.ini)$/
const SKIP = /\.(exe|dll|ex_)$|(^|\/)(\._[^/]*|\.ds_store|thumbs\.db)$/

/** Finds the game root anywhere in a tree, keeps only the files the engine needs, and validates them. */
export function gameEntries(all: Entry[]): Entry[] {
  const markers = all.map((e) => e.path.replace(/\\/g, '/').replace(/^\/+/, '')).filter((p) => MARKER.test(p.toLowerCase()))
  if (!markers.length) throw new Error('Beach Head 2002 files not found (no BH2Game/Geometry.3D).')
  // Shallowest match wins, so a CD copy beats anything nested deeper.
  const marker = markers.sort((a, b) => a.split('/').length - b.split('/').length)[0]
  const prefix = marker.slice(0, marker.length - 'BH2Game/Geometry.3D'.length).toLowerCase()
  const out: Entry[] = []
  for (const e of all) {
    const p = e.path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!p.toLowerCase().startsWith(prefix)) continue
    const rel = p.slice(prefix.length)
    const k = rel.toLowerCase()
    if (NEEDED.test(k) && !SKIP.test(k)) out.push({ ...e, path: rel })
  }
  const have = new Set(out.map((e) => key(unpacked(e.path))))
  const missing = REQUIRED.filter((r) => !have.has(key(r)))
  if (missing.length) throw new Error(`Missing game files:\n${missing.join('\n')}`)
  return out
}

export const openEntriesFS = (entries: Entry[]): GameFS => new EntryFS(entries)

/** Files picked via <input type="file" webkitdirectory>. */
export function openPickedFS(files: FileList | File[]): GameFS {
  return new EntryFS(gameEntries(fileEntries(files)))
}

// ---- Browser storage: OPFS, falling back to IndexedDB ----

export interface StoredInfo {
  backend: 'opfs' | 'idb'
  files: number
  bytes: number
}
interface Manifest extends StoredInfo {
  version: 1
  paths: [string, number][]
}

const OPFS_DIR = 'openbh2002'
const MANIFEST = '__manifest.json'
const IDB_NAME = 'openbh2002'
const enc = (p: string) => encodeURIComponent(p)

interface Backend {
  write(path: string, data: Uint8Array): Promise<void>
  read(path: string): Promise<Uint8Array>
  clear(): Promise<void>
}

/** `create` is for writing; Safari before 26 has OPFS but no createWritable() on the main thread, so it uses IndexedDB. */
async function opfs(create = false): Promise<Backend | null> {
  try {
    if (create && !('createWritable' in FileSystemFileHandle.prototype)) return null
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create })
    return {
      async write(path, data) {
        const w = await (await dir.getFileHandle(enc(path), { create: true })).createWritable()
        await w.write(data as Uint8Array<ArrayBuffer>)
        await w.close()
      },
      async read(path) {
        return blobBytes(await (await dir.getFileHandle(enc(path))).getFile())
      },
      async clear() {
        await root.removeEntry(OPFS_DIR, { recursive: true }).catch(() => {})
      },
    }
  } catch {
    return null
  }
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))))

async function idb(): Promise<Backend | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    const open = indexedDB.open(IDB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('files')
    const db = await req(open)
    db.onversionchange = () => db.close()
    const tx = (mode: IDBTransactionMode) => db.transaction('files', mode).objectStore('files')
    return {
      async write(path, data) {
        // ArrayBuffer rather than Blob: Blobs in IndexedDB have been unreliable on older Safari.
        await req(tx('readwrite').put(data.slice().buffer, path))
      },
      async read(path) {
        const v = await req(tx('readonly').get(path))
        if (!(v instanceof ArrayBuffer)) throw new Error(`Stored file missing: ${path}`)
        return new Uint8Array(v)
      },
      async clear() {
        // Deleting the database frees disk space right away; clearing the store does not.
        db.close()
        await req(indexedDB.deleteDatabase(IDB_NAME))
      },
    }
  } catch {
    return null
  }
}

async function loadManifest(b: Backend): Promise<Manifest | null> {
  try {
    const m = JSON.parse(new TextDecoder().decode(await b.read(MANIFEST))) as Manifest
    return m.version === 1 ? m : null
  } catch {
    return null
  }
}

/** Game files saved by a previous import, or null. */
export async function openStoredFS(): Promise<GameFS | null> {
  for (const b of [await opfs(), await idb()]) {
    const m = b && (await loadManifest(b))
    if (b && m) return new EntryFS(m.paths.map(([path, size]) => ({ path, size, read: () => b.read(path) })))
  }
  return null
}

export async function storedInfo(): Promise<StoredInfo | null> {
  for (const b of [await opfs(), await idb()]) {
    const m = b && (await loadManifest(b))
    if (m) return { backend: m.backend, files: m.files, bytes: m.bytes }
  }
  return null
}

export async function clearStored() {
  for (const b of [await opfs(), await idb()]) await b?.clear()
}

/** Copies entries into OPFS (or IndexedDB), manifest last so a partial copy is never used. */
export async function storeEntries(entries: Entry[], onProgress?: (done: number, total: number) => void): Promise<{ fs: GameFS; info: StoredInfo }> {
  await clearStored()
  const total = entries.reduce((s, e) => s + e.size, 0)
  let lastError: unknown = null
  for (const [name, make] of [['opfs', () => opfs(true)], ['idb', idb]] as const) {
    const b = await make()
    if (!b) continue
    try {
      let done = 0
      onProgress?.(0, total)
      const queue = [...entries]
      const worker = async () => {
        for (let e = queue.shift(); e; e = queue.shift()) {
          await b.write(e.path, await e.read())
          onProgress?.((done += e.size), total)
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()])
      const info: StoredInfo = { backend: name, files: entries.length, bytes: total }
      const m: Manifest = { version: 1, ...info, paths: entries.map((e) => [e.path, e.size]) }
      await b.write(MANIFEST, new TextEncoder().encode(JSON.stringify(m)))
      return { fs: new EntryFS(m.paths.map(([path, size]) => ({ path, size, read: () => b.read(path) }))), info }
    } catch (e) {
      lastError = e
      await b.clear()
    }
  }
  throw lastError ?? new Error('No browser storage available.')
}
