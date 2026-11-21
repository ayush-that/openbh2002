import type { GameFS } from '../vfs'
import { decodeRaw24, toRGBA } from '../formats/raw24'
import { CAPS, HANDGUN_ROUNDS } from './constants'
import type { Game } from './game'
import type { World } from './world'

// In-game HUD: FUN_004021c4 (rects, bars, icons), FUN_00402ca5 (flat rect), FUN_00402d84 (icon quad) and
// FUN_00402a1c (GDI text). Layout is in original screen pixels: left/top items fixed, right/bottom items
// shifted by (W-640, H-480). The window is mapped to a virtual screen whose height is clamped to
// 480..REF_HEIGHT pixels, so the HUD keeps the proportions of the original 640x480..800x600 modes.

const REF_HEIGHT = 600

/** Source rect in Icons128x128 pixels (the original uses uv = px / 127) and drawn size. */
interface Icon {
  u0: number
  v0: number
  u1: number
  v1: number
  w: number
  h: number
}

const ICONS = {
  launcher: { u0: 0, v0: 0, u1: 39, v1: 31, w: 39, h: 31 },
  pip: { u0: 56, v0: 0, u1: 63, v1: 31, w: 7, h: 31 },
  bombers: { u0: 63, v0: 32, u1: 127, v1: 63, w: 63, h: 31 },
  cleared: { u0: 0, v0: 64, u1: 127, v1: 95, w: 127, h: 31 },
  destroyed: { u0: 0, v0: 96, u1: 127, v1: 127, w: 255, h: 48 },
} satisfies Record<string, Icon>

const BLACK = '#000000'
const NAVY = '#000040'
const ENEMY = '#ff4000'
const TEXT = '#e0e0e0'
const LEVEL_TEXT = '#e02010' // COLORREF 0x1020e0
const GREEN = '#008000'
const YELLOW = '#a09000'
const RED = '#ff0000'
/** GDI default DC font (bold "System", 16 px cell, ascent 13). Tahoma Bold is the closest common match. */
const FONT_PX = 13
const FONT_ASCENT = 13
const FONT_FAMILY = 'Tahoma, "Microsoft Sans Serif", "MS Sans Serif", Arial, sans-serif'

function barColor(v: number, hi: number, lo: number) {
  return v > hi ? GREEN : v < lo ? RED : YELLOW
}

interface HudState {
  level: number
  shield: number
  enemyPct: number
  ammoPct: number
  ammoCount: number
  /** Night with flares > 0, else null. */
  flares: number | null
  launcher: boolean
  rails: readonly [boolean, boolean]
  spare: number
  bombers: boolean
  cleared: boolean
  destroyed: boolean
}

export class Hud {
  private view: HTMLElement
  private game: Game
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private icons: ImageBitmap | null = null
  private state: HudState | null = null
  private resizeObserver: ResizeObserver
  private onResize = () => this.draw()
  /** Device pixels per virtual HUD pixel, and the virtual screen size. */
  private k = 1
  private vw = 640
  private vh = 480

  /** view: the element the HUD covers (the renderer canvas). */
  constructor(view: HTMLElement, game: Game, fs: GameFS) {
    this.view = view
    this.game = game
    this.canvas.className = 'hud'
    this.canvas.style.cssText = 'position:fixed;pointer-events:none;'
    ;(view.parentElement ?? document.body).append(this.canvas)
    this.ctx = this.canvas.getContext('2d')!
    this.resizeObserver = new ResizeObserver(this.onResize)
    this.resizeObserver.observe(view)
    addEventListener('resize', this.onResize)
    void this.loadIcons(fs)
  }

  private async loadIcons(fs: GameFS) {
    const name = 'BH2Game/Icons128x128.t24'
    const img = decodeRaw24(name, await fs.read(name))
    // Icons is a plain TextureMap (no colour key) drawn with blending off: black stays opaque.
    const rgba = new Uint8ClampedArray(toRGBA(img))
    this.icons = await createImageBitmap(new ImageData(rgba, img.width, img.height))
    this.draw()
  }

  /** Once per game frame (game.late). Not called while paused, so the HUD freezes like the original. */
  update(w: World) {
    const p = w.player, a = p.ammo, rails = this.game.player.rails
    const ammo = p.weapon === 0 ? [a.bullets, CAPS.bullets] : p.weapon === 1 ? [a.cannon, CAPS.cannon] : [a.handgun, HANDGUN_ROUNDS]
    const enemy = Math.max(0, w.enemyMeter)
    this.state = {
      level: w.levelNumber,
      shield: p.shield,
      enemyPct: w.enemyMeterInitial > 0 ? (enemy / w.enemyMeterInitial) * 100 : 0,
      ammoPct: (ammo[0] / ammo[1]) * 100,
      ammoCount: ammo[0],
      flares: !w.daytime && a.flares > 0 ? a.flares : null,
      // The original's missile count includes loaded rails; ours moves them out of ammo.missiles.
      launcher: a.missiles + Number(rails[0]) + Number(rails[1]) > 0,
      rails: [rails[0], rails[1]],
      spare: a.missiles,
      bombers: p.bombersAvailable,
      cleared: enemy < 0.0001,
      destroyed: p.shield < 1,
    }
    this.draw()
  }

  dispose() {
    this.resizeObserver.disconnect()
    removeEventListener('resize', this.onResize)
    this.canvas.remove()
  }

  private layout() {
    const r = this.view.getBoundingClientRect(), dpr = devicePixelRatio || 1
    const width = Math.round(r.width * dpr), height = Math.round(r.height * dpr)
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    Object.assign(this.canvas.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    const s = Math.min(r.height / Math.min(Math.max(r.height, 480), REF_HEIGHT), r.width / 640) || 1
    this.k = s * dpr
    this.vw = Math.round(r.width / s)
    this.vh = Math.round(r.height / s)
  }

  draw() {
    this.layout()
    const c = this.ctx, st = this.state
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (!st) return
    const ox = this.vw - 640, oy = this.vh - 480, cx = this.vw >> 1, cy = this.vh / 2

    this.rect(4, 4, 108, 22, BLACK)
    this.rect(ox + 528, 4, 108, 22, BLACK)
    this.rect(4, oy + 454, 108, 22, BLACK)
    this.rect(cx - 44, 4, 88, 22, NAVY)
    if (st.shield > 0) this.rect(8, 8, st.shield, 14, barColor(st.shield, 50, 26))
    if (st.enemyPct > 0) this.rect(ox + 532, 8, st.enemyPct, 14, ENEMY)
    if (st.ammoPct > 0) this.rect(8, oy + 458, st.ammoPct, 14, barColor(st.ammoPct, 50, 26))
    if (st.flares !== null) {
      this.rect(116, oy + 454, 88, 22, BLACK)
      const f = (st.flares / 20) * 80
      this.rect(120, oy + 458, f, 14, barColor(f, 40, 21))
    }

    const iy = oy + 446
    if (st.launcher) {
      this.icon(ICONS.launcher, cx - 20, iy)
      if (st.rails[0]) this.icon(ICONS.pip, cx - 18, iy)
      if (st.rails[1]) this.icon(ICONS.pip, cx + 10, iy)
      for (let i = 0; i < st.spare; i++) this.icon(ICONS.pip, cx + 32 + 12 * i, iy)
    }
    if (st.bombers) this.icon(ICONS.bombers, cx - 96, iy)
    if (st.cleared) this.icon(ICONS.cleared, cx - 64, cy - 16)
    if (st.destroyed) this.icon(ICONS.destroyed, cx - 128, cy - 24)

    // GDI text is drawn after EndScene, on top of everything.
    c.font = `bold ${FONT_PX * this.k}px ${FONT_FAMILY}`
    c.textBaseline = 'alphabetic'
    this.text('SHIELD', 34, 7, TEXT)
    this.text('ENEMY', ox + 556, 7, TEXT)
    this.text('AMMO', 24, oy + 457, TEXT)
    this.text(`Level  ${st.level}`, (ox >> 1) + 286, 7, LEVEL_TEXT)
    this.text(String(st.ammoCount), 72, oy + 457, TEXT)
    if (st.flares !== null) this.text(`FLARES ${st.flares}`, 124, oy + 457, TEXT)
  }

  /** FUN_00402ca5, edges snapped to device pixels. */
  private rect(x: number, y: number, w: number, h: number, color: string) {
    const k = this.k
    const x0 = Math.round(x * k), y0 = Math.round(y * k)
    this.ctx.fillStyle = color
    this.ctx.fillRect(x0, y0, Math.round((x + w) * k) - x0, Math.round((y + h) * k) - y0)
  }

  /** FUN_00402d84: textured quad, MODULATE with white diffuse, no blending. */
  private icon(ic: Icon, x: number, y: number) {
    if (!this.icons) return
    const k = this.k, t = 128 / 127
    const x0 = Math.round(x * k), y0 = Math.round(y * k)
    this.ctx.drawImage(
      this.icons,
      ic.u0 * t, ic.v0 * t, (ic.u1 - ic.u0) * t, (ic.v1 - ic.v0) * t,
      x0, y0, Math.round((x + ic.w) * k) - x0, Math.round((y + ic.h) * k) - y0,
    )
  }

  /** TextOutA: (x, y) is the top of the character cell. */
  private text(s: string, x: number, y: number, color: string) {
    this.ctx.fillStyle = color
    this.ctx.fillText(s, Math.round(x * this.k), Math.round((y + FONT_ASCENT) * this.k))
  }
}
