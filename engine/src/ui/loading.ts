// Loading screen: the title logo over a progress bar while the game files download.
import type { GameFS } from '../vfs'

export function showLoading(logo: string) {
  const el = document.createElement('div')
  el.className = 'loading'
  el.innerHTML = `<img alt="Beach Head 2002" src="${logo}"><div class="bar"><i></i></div>`
  document.body.appendChild(el)
  const fill = el.querySelector('i')!
  return {
    set: (p: number) => fill.style.setProperty('--p', String(Math.min(1, p))),
    /** Advances the bar on every file read, out of `expected` reads. */
    track(fs: GameFS, expected: number) {
      let n = 0
      const read = fs.read.bind(fs)
      fs.read = async (path) => {
        const data = await read(path)
        this.set(++n / expected)
        return data
      }
    },
    remove: () => el.remove(),
  }
}
