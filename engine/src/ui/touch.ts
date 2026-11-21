// On-screen controls for touch play: drag anywhere (not on a button) to aim, hold FIRE, tap the
// keys the keyboard would send. Shown while a game runs and the last input was touch or pen.
import type { Game } from '../game/game'
import { isPortrait } from './viewport'

type Button = 'fire' | 'weapon' | 'missile' | 'flare' | 'bombers' | 'menu'

const KEY: Record<Exclude<Button, 'fire'>, string> = { weapon: ' ', missile: 'm', flare: 'f', bombers: 'b', menu: 'Escape' }

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

const ICON: Record<Button, string> = {
  fire: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  weapon: svg('<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>'),
  missile: svg('<path d="M12 2c2.5 2.5 3.5 6 3.5 10v4h-7v-4c0-4 1-7.5 3.5-10z"/><path d="M8.5 13 6 16v3l2.5-1.5M15.5 13 18 16v3l-2.5-1.5M10.5 19.5 12 22l1.5-2.5"/>'),
  flare: svg('<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5 19 19M5 19l2.5-2.5M16.5 7.5 19 5"/>'),
  bombers: svg('<path d="M12 2.5c.8 0 1.2.8 1.2 2V10l8 4.5v2l-8-2.5v4.5l2.5 2v1.5L12 21l-3.7 1v-1.5l2.5-2V14l-8 2.5v-2l8-4.5V4.5c0-1.2.4-2 1.2-2z" fill="currentColor" stroke="none"/>'),
  menu: svg('<path d="M9 6v12M15 6v12"/>'),
}
const ROTATE = svg('<rect x="7" y="2" width="10" height="17" rx="2"/><path d="M11 16h2"/><path d="M3 15a9 9 0 0 0 6 7M21 9a9 9 0 0 0-6-7"/><path d="M3 19v-4h4M21 5v4h-4"/>')

export class TouchControls {
  readonly el = document.createElement('div')
  private game: Game
  private buttons = new Map<Button, HTMLElement>()
  private rotate = document.createElement('div')
  private rotateDismissed = false
  private playing = false
  /** Pointer id -> what it is doing; aim pointers remember their last position. */
  private pointers = new Map<number, { button: Button | null; x: number; y: number }>()

  constructor(parent: HTMLElement, game: Game) {
    this.game = game
    this.el.className = 'touch'
    this.el.hidden = true
    for (const b of Object.keys(ICON) as Button[]) {
      const d = document.createElement('div')
      d.className = `tbtn t-${b}`
      d.dataset.button = b
      d.innerHTML = ICON[b]
      this.buttons.set(b, d)
      this.el.append(d)
    }
    this.rotate.className = 't-rotate'
    this.rotate.innerHTML = ROTATE
    this.rotate.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      this.rotateDismissed = true
      this.sync()
    })
    this.el.append(this.rotate)
    parent.append(this.el)

    this.el.addEventListener('pointerdown', this.down)
    this.el.addEventListener('pointermove', this.move)
    this.el.addEventListener('pointerup', this.up)
    this.el.addEventListener('pointercancel', this.up)
    this.el.addEventListener('contextmenu', (e) => e.preventDefault())
    game.input.onModeChange = () => this.sync()
    addEventListener('resize', () => this.sync())
  }

  /** A game is running (false while the menu shows). */
  setPlaying(on: boolean) {
    this.playing = on
    this.sync()
  }

  /** Once per rendered frame: show only the buttons that do something right now. */
  update() {
    if (this.el.hidden) return
    const w = this.game.world, p = w.player, rails = this.game.player.rails
    const playing = w.outcome === 'playing'
    this.show('missile', p.ammo.missiles > 0 || rails[0] || rails[1])
    this.show('flare', !w.daytime && p.ammo.flares > 0)
    this.show('bombers', p.bombersAvailable && playing)
  }

  private show(b: Button, on: boolean) {
    const el = this.buttons.get(b)!
    if (el.hidden === on) el.hidden = !on
  }

  private sync() {
    const on = this.playing && this.game.input.mode === 'touch'
    if (!on && !this.el.hidden) {
      this.pointers.clear()
      for (const el of this.buttons.values()) el.classList.remove('on')
      this.game.input.release()
    }
    this.el.hidden = !on
    this.rotate.hidden = !(on && isPortrait() && !this.rotateDismissed)
  }

  private down = (e: PointerEvent) => {
    e.preventDefault()
    const el = (e.target as Element).closest<HTMLElement>('.tbtn')
    const button = (el?.dataset.button as Button | undefined) ?? null
    // Touch pointers are implicitly captured by the pressed element, so moves and ups still bubble here.
    this.pointers.set(e.pointerId, { button, x: e.clientX, y: e.clientY })
    if (!button) return
    el!.classList.add('on')
    if (button === 'fire') this.game.input.button = true
    else this.game.input.press(KEY[button])
  }

  private move = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    // Aim with any finger that is not on a small button; sliding the FIRE thumb aims too.
    if (!p || (p.button && p.button !== 'fire')) return
    this.game.input.aim(e.clientX - p.x, e.clientY - p.y)
    p.x = e.clientX
    p.y = e.clientY
  }

  private up = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    if (!p) return
    this.pointers.delete(e.pointerId)
    if (!p.button) return
    if (![...this.pointers.values()].some((q) => q.button === p.button)) this.buttons.get(p.button)!.classList.remove('on')
    if (p.button === 'fire' && !this.buttons.get('fire')!.classList.contains('on')) this.game.input.button = false
  }
}
