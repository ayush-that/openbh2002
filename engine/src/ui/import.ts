// Import screen: load the player's game files from a folder, loose files, a .zip or an .iso, then keep a copy
// in browser storage (OPFS, else IndexedDB) so later visits open straight away.
import {
  clearStored,
  fileEntries,
  gameEntries,
  isoEntries,
  openEntriesFS,
  openStoredFS,
  storedInfo,
  storeEntries,
  zipEntries,
  type Entry,
  type GameFS,
  type StoredInfo,
} from '../vfs'

/** Removes the stored copy; the next chooseGameFS() call shows the import screen again. */
export const forgetGameFiles = clearStored
/** Backend, file count and bytes of the stored copy, or null. */
export const gameFilesInfo = (): Promise<StoredInfo | null> => storedInfo()

const MAX_FILES = 50000
const mb = (n: number) => (n / 1048576).toFixed(1)

interface DirHandle {
  kind: 'directory'
  name: string
  entries(): AsyncIterable<[string, DirHandle | FileHandle]>
}
interface FileHandle {
  kind: 'file'
  getFile(): Promise<File>
}
type PickerWindow = Window & { showDirectoryPicker?: (o?: { mode?: string }) => Promise<DirHandle> }

async function handleEntries(dir: DirHandle): Promise<Entry[]> {
  const out: Entry[] = []
  const walk = async (d: DirHandle, prefix: string): Promise<void> => {
    for await (const [name, h] of d.entries()) {
      if (out.length > MAX_FILES) throw new Error('Folder too large. Pick the game folder.')
      if (h.kind === 'directory') await walk(h, `${prefix}${name}/`)
      else {
        const f = await h.getFile()
        out.push({ path: prefix + name, size: f.size, read: async () => new Uint8Array(await (await h.getFile()).arrayBuffer()) })
      }
    }
  }
  await walk(dir, '')
  return out
}

async function dropEntries(items: FileSystemEntry[]): Promise<Entry[]> {
  const files: File[] = []
  const paths = new Map<File, string>()
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (files.length > MAX_FILES) throw new Error('Folder too large. Drop the game folder.')
    if (e.isFile) {
      const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej))
      paths.set(f, e.fullPath.replace(/^\/+/, ''))
      files.push(f)
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const c of batch) await walk(c)
      }
    }
  }
  for (const e of items) await walk(e)
  return filesToEntries(files, (f) => paths.get(f)!)
}

/** Loose files plus any .zip/.iso among them, expanded. */
async function filesToEntries(files: File[], pathOf?: (f: File) => string): Promise<Entry[]> {
  const out: Entry[] = []
  const loose: File[] = []
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) out.push(...(await zipEntries(f)))
    else if (/\.iso$/i.test(f.name)) out.push(...(await isoEntries(f)))
    else loose.push(f)
  }
  out.push(...fileEntries(loose, pathOf))
  return out
}

const STYLE = `
.import { gap: 12px; padding: 16px; }
.import h1 { margin: 0 0 4px; }
.import .row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.import .button { justify-self: auto; border: 0; font: inherit; font-weight: 600; }
.import .hint { opacity: .7; font-size: 13px; margin: 0; }
.import progress { width: min(320px, 80vw); justify-self: center; }
.import.drag { outline: 3px dashed #c8a24a; outline-offset: -12px; }
.import.busy .row { pointer-events: none; opacity: .4; }
.import .legal { opacity: .5; font-size: 12px; margin: 16px 0 0; }
.import .legal a { color: inherit; }
`

/** Opens the stored copy if there is one, else shows the import screen until a valid game is loaded. */
export async function chooseGameFS(container: HTMLElement): Promise<GameFS> {
  const stored = await openStoredFS()
  if (stored) return stored

  const w = window as PickerWindow
  const canPickDir = typeof w.showDirectoryPicker === 'function' || 'webkitdirectory' in HTMLInputElement.prototype
  container.innerHTML = `
    <style>${STYLE}</style>
    <div class="picker import">
      <h1>OpenBH2002</h1>
      <p>Load your Beach Head 2002 CD, install folder, .zip or .iso.</p>
      <div class="row">
        ${canPickDir ? '<button class="button" data-act="dir">Folder</button>' : ''}
        <label class="button">Zip / ISO<input type="file" accept=".zip,.iso,application/zip,application/x-iso9660-image" hidden data-in="archive"></label>
        <label class="button">Files<input type="file" multiple hidden data-in="files"></label>
      </div>
      <p class="hint">Or drop it here. Files stay on this device.</p>
      <progress hidden></progress>
      <p class="status" hidden></p>
      <p class="error" hidden></p>
      <input type="file" webkitdirectory hidden data-in="dir">
      <p class="legal">Open source, <a href="https://github.com/ayush-that/openbh2002">GitHub</a>. Not affiliated with the Beach Head 2002 rights holders.</p>
    </div>`
  const root = container.querySelector<HTMLDivElement>('.import')!
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!
  const progress = $<HTMLProgressElement>('progress')
  const status = $<HTMLParagraphElement>('.status')
  const error = $<HTMLParagraphElement>('.error')

  return new Promise<GameFS>((resolve) => {
    let busy = false
    const run = async (load: () => Promise<Entry[]>) => {
      if (busy) return
      busy = true
      root.classList.add('busy')
      error.hidden = true
      status.hidden = false
      status.textContent = 'Reading…'
      try {
        const game = gameEntries(await load())
        let fs: GameFS
        try {
          progress.hidden = false
          const res = await storeEntries(game, (done, total) => {
            progress.max = total
            progress.value = done
            status.textContent = `Copying ${mb(done)} / ${mb(total)} MB`
          })
          fs = res.fs
          await navigator.storage?.persist?.().catch(() => false)
          console.info(`Game files stored: ${res.info.files} files, ${mb(res.info.bytes)} MB (${res.info.backend})`)
        } catch (e) {
          // Storage full or unavailable (e.g. private browsing): play from the source this time.
          console.warn('Could not store game files', e)
          fs = openEntriesFS(game)
        }
        resolve(fs)
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') status.hidden = true
        else {
          status.hidden = true
          error.hidden = false
          error.textContent = (e as Error).message
        }
      } finally {
        busy = false
        progress.hidden = true
        root.classList.remove('busy')
      }
    }

    const dirInput = $<HTMLInputElement>('[data-in="dir"]')
    root.querySelector('[data-act="dir"]')?.addEventListener('click', () => {
      if (w.showDirectoryPicker) void run(async () => handleEntries(await w.showDirectoryPicker!({ mode: 'read' })))
      else dirInput.click()
    })
    for (const input of root.querySelectorAll<HTMLInputElement>('input[type=file]')) {
      input.addEventListener('change', () => {
        const files = [...(input.files ?? [])]
        input.value = ''
        if (files.length) void run(() => filesToEntries(files))
      })
    }

    root.addEventListener('dragover', (e) => {
      e.preventDefault()
      root.classList.add('drag')
    })
    root.addEventListener('dragleave', () => root.classList.remove('drag'))
    root.addEventListener('drop', (e) => {
      e.preventDefault()
      root.classList.remove('drag')
      const dt = e.dataTransfer
      if (!dt) return
      // Entries must be taken synchronously, before the event ends.
      const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x)
      const files = [...dt.files]
      void run(() => (entries.length ? dropEntries(entries) : filesToEntries(files)))
    })
  })
}
