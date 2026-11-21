// Read-only, case-insensitive view of the user's game folder.
// Paths are relative to the game root, using '/' separators (e.g. "BH2Game/Sky1.t24").

export interface GameFS {
  list(): string[]
  has(path: string): boolean
  read(path: string): Promise<Uint8Array>
  text(path: string): Promise<string>
}

const key = (p: string) => p.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase()

abstract class BaseFS implements GameFS {
  protected index = new Map<string, string>()
  constructor(paths: string[]) {
    for (const p of paths) this.index.set(key(p), p)
  }
  list() {
    return [...this.index.values()]
  }
  has(path: string) {
    return this.index.has(key(path))
  }
  protected resolve(path: string) {
    const real = this.index.get(key(path))
    if (!real) throw new Error(`Game file not found: ${path}`)
    return real
  }
  abstract read(path: string): Promise<Uint8Array>
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
  async read(path: string) {
    const res = await fetch(this.base + this.resolve(path).split('/').map(encodeURIComponent).join('/'))
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

class FileListFS extends BaseFS {
  private files = new Map<string, File>()
  constructor(files: File[]) {
    // webkitRelativePath is "<picked folder>/<rest>"; strip the picked folder name.
    const entries = files.map((f) => [f.webkitRelativePath.split('/').slice(1).join('/') || f.name, f] as const)
    super(entries.map(([p]) => p))
    for (const [p, f] of entries) this.files.set(p, f)
  }
  async read(path: string) {
    return new Uint8Array(await this.files.get(this.resolve(path))!.arrayBuffer())
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

/** Files picked via <input type="file" webkitdirectory>. */
export function openPickedFS(files: FileList | File[]): GameFS {
  const fs = new FileListFS([...files])
  if (!fs.has('BH2Game/Geometry.3D')) throw new Error('This folder does not look like a Beach Head 2002 install (BH2Game/Geometry.3D missing).')
  return fs
}
