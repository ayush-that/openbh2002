// The Beach Head 2002 front end (bh2.ews), recreated from the decompiled menu loop FUN_00402050.
// Everything is drawn at 640x480 like the original and scaled to the container (letterboxed, pixelated).
// State numbers, flags and timings follow the original; comments name the original globals/offsets.
import type { GameFS } from '../vfs'
import type { MenuAssets, Tex, Card } from './assets'
import type { Store } from './store'
import { atoi } from './store'
import type { MenuAudio } from './audio'
import { VehicleViewer } from './vehicles'
import * as L from './layout'
import type { Rect, UV } from './layout'

const W = 640
const H = 480

export interface PlayOptions {
  /** Level to start (BeachheadIn field 1). */
  level: number
  /** MOUSE TIGHT (ini MouseInvert = 1; BeachheadIn field 3). */
  mouseTight: boolean
  /** MOUSE REVERSE (ini MouseMode = 1; BeachheadIn field 4). */
  mouseReverse: boolean
  /** SOUND ON (ini Fx; BeachheadIn field 5). */
  sound: boolean
}

export interface GameResult {
  /** BeachheadOut status: 0 = died (high-score check), 1 = quit with Esc. */
  status: 0 | 1
  level: number
}

const S = {
  INTRO: 0,
  OPENING: 1,
  MAIN: 2,
  SAVE: 10,
  LOAD: 11,
  VIDEO: 0x14,
  AUDIO: 0x15,
  CONTROLS: 0x16,
  HELP_CONTROLS: 0x1e,
  HELP_OVERVIEW: 0x1f,
  HELP_INTERFACE: 0x20,
  CREDITS: 0x28,
  EXIT: 0x32,
  WEAPONS: 0x3c,
  VEHICLE: 0x3d,
  SCORES: 0x50,
  FINAL: 0x5a,
  PLAY: 100,
  TITLE_PLAY: 0x6e,
} as const

interface BarButton {
  visible: boolean
  selected: boolean
  /** Dropdown fade-in alpha 0..255 (reset on select). */
  fade: number
  hoverRow: number
}

function makeCanvas(parent: HTMLElement, z: number) {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  Object.assign(c.style, { position: 'absolute', inset: '0', margin: 'auto', imageRendering: 'pixelated', zIndex: String(z), pointerEvents: 'none' })
  parent.appendChild(c)
  return c
}

export class Frontend {
  private root: HTMLDivElement
  private lower: CanvasRenderingContext2D
  private upper: CanvasRenderingContext2D
  private g: CanvasRenderingContext2D
  private a: MenuAssets
  private store: Store
  private audio: MenuAudio
  private fs: GameFS
  private viewer: VehicleViewer | null = null

  // ---- input ----
  private mx = 0
  private my = 0
  private down = false
  /** A press seen since the last frame; keeps `down` set for at least one frame so quick clicks register. */
  private pressed = false
  private releasePending = false
  private pressAt: [number, number] = [0, 0]
  private escPressed = false
  private backspace = false
  private typed: string[] = []

  // ---- menu object (obj+0x82c ...) ----
  private state: number = S.INTRO
  private sub = 500 // obj+0x830
  private closing = 0 // obj+0x9c8: 0 idle, 1 doors closing, 2 doors opening
  private quitReq = -1 // obj+0x9cc
  private controlsPage = 0 // obj+0x9d0
  private creditsClosed = false // obj+0x9d4
  private weaponsClosed = false // obj+0x9d8
  private scoresClosed = false // obj+0x9dc
  private weaponsPick = false // obj+0x9e4
  private interfacePage = 0 // obj+0x9e8
  private vehicle = 0 // obj+0x9f4 (and page obj+0x9fc)
  private page = 0 // obj+0x834 (overview / credits)
  private arrowL = 0 // obj+0xa0c / 0xa04
  private arrowR = 0 // obj+0xa10 / 0xa08
  private interfaceFade = 0 // obj+0xa1c
  private doorSub = 0.5 // _DAT_00427a4c: sub-screen doors (0 open, 0.5 closed)
  private bar: BarButton[] = Array.from({ length: 8 }, () => ({ visible: false, selected: false, fade: 0, hoverRow: -1 }))
  private openItem = 0 // DAT_0042a6f0

  // ---- FUN_00402050 locals ----
  private phase = 0 // iVar3 / local_208
  private t = 0 // local_210
  private alpha = 0 // local_214
  private slide = 0 // local_20c: frame/bar slide 0..0.2
  private door = 0 // local_204: main doors 0..0.5
  private doorStep = 0 // local_1d8
  private exitTimer = 0 // local_200[4]

  // ---- globals ----
  private level = 1 // DAT_0042aa88
  private nameRank = -1 // DAT_00427138
  private slot = -1 // DAT_00427968
  private slotNames: string[] = []
  private editBuf = '' // DAT_0042aaac
  private shownName = '' // DAT_0042aa8c
  private titleDebounce = false // DAT_0042a6f8
  private navDebounce = false // DAT_0042adb1
  private arrowDebounce = false // DAT_0042ada8 / DAT_0042ada9
  private hoverCell = -1 // DAT_00427a50
  private dt = 16 // FUN_0040cbb0: ms since the previous frame

  private raf = 0
  private last = 0
  private resolve: ((o: PlayOptions) => void) | null = null
  private pending: Promise<PlayOptions> | null = null
  private intro = true

  constructor(container: HTMLElement, fs: GameFS, assets: MenuAssets, store: Store, audio: MenuAudio) {
    this.fs = fs
    this.a = assets
    this.store = store
    this.audio = audio
    this.root = document.createElement('div')
    Object.assign(this.root.style, { position: 'absolute', inset: '0', background: '#000', cursor: 'none', overflow: 'hidden', display: 'none', zIndex: '10' })
    this.root.tabIndex = 0
    container.appendChild(this.root)
    this.lower = makeCanvas(this.root, 0).getContext('2d')!
    this.upper = makeCanvas(this.root, 2).getContext('2d')!
    this.g = this.lower
    this.bindInput()
    new ResizeObserver(() => this.layout()).observe(this.root)
  }

  // ======================= public API =======================

  /** Show the menu. Resolves when the player starts a game (PLAY, CONTINUE, NEW GAME, LOAD, title Play). */
  show(): Promise<PlayOptions> {
    if (this.pending) return this.pending
    this.pending = new Promise((r) => (this.resolve = r))
    if (this.intro) this.startMenu(true)
    this.root.style.display = 'block'
    this.root.focus()
    this.layout()
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
    return this.pending
  }

  /** Report the end of a game (death or Esc), like BH2.exe writing BeachheadOut. Call show() afterwards. */
  gameEnded(result: GameResult) {
    this.level = result.level
    this.startMenu(false, result.status)
  }

  // ======================= setup =======================

  /** FUN_00401d70: fresh menu object on every menu start. */
  private startMenu(intro: boolean, status = 1) {
    this.intro = false
    this.closing = 0
    this.quitReq = -1
    this.controlsPage = 0
    this.creditsClosed = this.weaponsClosed = this.scoresClosed = this.weaponsPick = false
    this.interfacePage = 0
    this.page = 0
    this.vehicle = 0
    this.arrowL = this.arrowR = this.interfaceFade = 0
    this.bar = this.bar.map(() => ({ visible: false, selected: false, fade: 0, hoverRow: -1 }))
    this.phase = 0
    this.t = this.alpha = this.slide = this.door = 0
    this.doorStep = this.exitTimer = 0
    this.slotNames = this.store.slotNames() // FUN_00408f80
    this.editBuf = ''
    this.store.loadScores() // FUN_00409720
    const s = this.store.settings
    this.audio.setMusicVolume(s.music ? 64 : 0)
    this.audio.setSfxVolume(s.fx ? 64 : 0)
    if (intro) {
      this.state = S.INTRO
      this.sub = 500
      this.level = 1
      this.audio.stopModule()
      void this.audio.playModule('Fichas/sfx/preludio.xm')
    } else {
      this.state = S.OPENING
      this.openItem = 0
      if (this.store.qualifies(this.level) && status === 0) {
        this.nameRank = this.store.insertScore(this.level)
        this.openItem = 7
      }
    }
    // The original starts MENU.XM at the end of FUN_00401d70 in both modes and seeks to order 12 row 31 on
    // return from the game (FUN_0040e500(0xc, 0x1f)). In intro mode that replaces preludio.xm almost at once
    // because the intro assets load in between; here preludio.xm keeps playing through the intro.
    if (!intro) {
      this.audio.stopModule()
      void this.audio.playModule('Fichas/sfx/Menu.xm', 0xc, 0x1f)
    }
  }

  private layout() {
    const r = this.root.getBoundingClientRect()
    const scale = Math.min(r.width / W, r.height / H) || 1
    for (const c of this.root.querySelectorAll('canvas')) {
      c.style.width = `${W * scale}px`
      c.style.height = `${H * scale}px`
    }
  }

  private bindInput() {
    const toLocal = (e: PointerEvent) => {
      const c = this.lower.canvas.getBoundingClientRect()
      this.mx = Math.max(0, Math.min(W - 1, ((e.clientX - c.left) / c.width) * W))
      this.my = Math.max(0, Math.min(H - 1, ((e.clientY - c.top) / c.height) * H))
    }
    this.root.addEventListener('pointermove', toLocal)
    this.root.addEventListener('pointerdown', (e) => {
      toLocal(e)
      if (e.button === 0) {
        this.down = true
        this.pressed = true
        this.pressAt = [this.mx, this.my]
      }
      this.audio.unlock()
      this.root.focus()
    })
    addEventListener('pointerup', (e) => {
      if (e.button !== 0) return
      if (this.pressed) this.releasePending = true
      else this.down = false
    })
    this.root.addEventListener('keydown', (e) => {
      this.audio.unlock()
      if (e.key === 'Escape') this.escPressed = true
      else if (e.key === 'Backspace') this.backspace = true
      else if (e.key.length === 1) this.typed.push(e.key)
      e.preventDefault()
    })
    this.root.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  // ======================= drawing helpers =======================

  private img(tex: Tex, r: Rect, uv: UV = [0, 0, 1, 1], alpha = 1, additive = false) {
    const g = this.g
    const [u0, v0, u1, v1] = uv
    const sx = Math.min(u0, u1) * tex.width, sy = Math.min(v0, v1) * tex.height
    const sw = Math.abs(u1 - u0) * tex.width, sh = Math.abs(v1 - v0) * tex.height
    if (sw <= 0 || sh <= 0 || alpha <= 0) return
    const dx = r[0] * W, dy = r[1] * H, dw = r[2] * W, dh = r[3] * H
    g.save()
    g.globalAlpha = Math.min(1, alpha)
    if (additive) g.globalCompositeOperation = 'lighter'
    if (u1 < u0 || v1 < v0) {
      g.translate(dx + (u1 < u0 ? dw : 0), dy + (v1 < v0 ? dh : 0))
      g.scale(u1 < u0 ? -1 : 1, v1 < v0 ? -1 : 1)
      g.drawImage(tex, sx, sy, sw, sh, 0, 0, dw, dh)
    } else g.drawImage(tex, sx, sy, sw, sh, dx, dy, dw, dh)
    g.restore()
  }

  private card(c: Card, rects: Rect[] = L.CARD) {
    for (let i = 0; i < 4; i++) this.img(c[i], rects[i])
  }

  /** FUN_00405ea0 */
  private ini() {
    this.card(this.a.ini, [
      [0, 0, 0.5, 0.5],
      [0.5, 0, 0.5, 0.5],
      [0, 0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5, 0.5],
    ])
  }

  /** FUN_00405440: the two camouflage doors; d = 0 open, 0.5 closed. */
  private doors(d: number) {
    this.img(this.a.frame[6], [d - 0.4, 0.0875, 0.4, 0.825])
    this.img(this.a.frame[7], [1 - d, 0.0875, 0.4, 0.825])
  }

  /** FUN_00405600: the bunker frame; s = 0 off screen, 0.2 in place. */
  private frameBorders(s: number) {
    const f = this.a.frame, y = s - 0.2
    this.img(f[1], [0, y, 0.5, 0.2666])
    this.img(f[2], [0.5, y, 0.5, 0.2666])
    this.img(f[0], [y, 0, 0.2, 1])
    this.img(f[3], [1 - s, 0, 0.2, 1])
    this.img(f[4], [0, 0.9333 - s, 0.5, 0.2666])
    this.img(f[5], [0.5, 0.9333 - s, 0.5, 0.2666])
  }

  private inside(r: Rect, strict = true) {
    const x = this.mx / W, y = this.my / H
    return strict ? r[0] < x && x < r[0] + r[2] && r[1] < y && y < r[1] + r[3] : r[0] <= x && x < r[0] + r[2] && r[1] <= y && y < r[1] + r[3]
  }

  private text(s: string, x: number, y: number, color: string, weight: number) {
    const g = this.g
    g.font = `${weight} 16px "Comic Sans MS", "Comic Sans", "Chalkboard SE", cursive`
    // GDI TextOut puts the top of the character cell at y; Comic Sans MS ascent is 2257/2048 em.
    g.textBaseline = 'alphabetic'
    g.fillStyle = color
    g.fillText(s, x, y + Math.round(16 * (2257 / 2048)))
  }

  private textWidth(s: string, weight: number) {
    this.g.font = `${weight} 16px "Comic Sans MS", "Comic Sans", "Chalkboard SE", cursive`
    return this.g.measureText(s).width
  }

  /** FUN_0040d520 with alpha 0x20: 50% blend of a solid colour. */
  private shade(x: number, y: number, w: number, h: number, color: string) {
    const g = this.g
    g.save()
    g.globalAlpha = 0.5
    g.fillStyle = color
    g.fillRect(x, y, w, h)
    g.restore()
  }

  // ======================= main loop =======================

  private frame = (now: number) => {
    const dt = Math.min(100, now - this.last)
    this.last = now
    this.dt = dt
    this.g = this.lower
    this.lower.clearRect(0, 0, W, H)
    this.upper.clearRect(0, 0, W, H)
    // A click that went down and up between two frames is seen where it was pressed.
    const latest: [number, number] = [this.mx, this.my]
    if (this.releasePending) [this.mx, this.my] = this.pressAt
    const result = this.step(dt)
    if (this.releasePending) [this.mx, this.my] = latest
    this.escPressed = false
    this.backspace = false
    this.pressed = false
    if (this.releasePending) {
      this.releasePending = false
      this.down = false
    }
    if (this.typed.length) this.typed.shift()
    if (result === null) {
      this.raf = requestAnimationFrame(this.frame)
      return
    }
    this.store.saveSettings() // FUN_004095c0 on every menu exit
    if (result === 1) this.finish()
    else this.quit()
  }

  /** Menu returned 1: hand over to the game (BeachheadIn). */
  private finish() {
    cancelAnimationFrame(this.raf)
    this.audio.stopModule()
    this.viewer?.render(null, 0)
    this.root.style.display = 'none'
    const s = this.store.settings
    const opts: PlayOptions = { level: this.level, mouseTight: s.mouseInvert === 1, mouseReverse: s.mouseMode === 1, sound: s.fx === 1 }
    const r = this.resolve
    this.resolve = null
    this.pending = null
    this.down = false
    r?.(opts)
  }

  /** Menu returned 0 (QUIT/EXIT GAME): the launcher would exit. A browser tab cannot, so restart at the title. */
  private quit() {
    this.audio.stopModule()
    this.startMenu(true)
    this.sub = 3
    this.titleDebounce = true
    this.raf = requestAnimationFrame(this.frame)
  }

  /** One pass of FUN_00402050. Returns 1 (play), 0 (quit) or null (keep running). */
  private step(dt: number): 0 | 1 | null {
    let barSlide = this.slide
    let barNoDropdown = true
    let drawBar = true
    switch (this.state) {
      case S.INTRO:
        this.ini()
        this.introStep(dt)
        drawBar = false
        break
      case S.OPENING:
        this.ini()
        if (this.phase === 0) {
          this.slide += dt * 0.01 * 0.08
          if (this.slide > 0.2) {
            this.slide = 0.2
            this.phase = 1
          }
        } else this.door = L.DOOR_STEPS[Math.min(this.doorStep++, L.DOOR_STEPS.length - 1)]
        if (this.door > 0.5) {
          this.state = S.MAIN
          for (const b of this.bar) b.visible = !b.visible
          this.door = 0.5
          this.doorStep = 0
          this.select(this.openItem)
        }
        this.doors(this.door)
        this.frameBorders(this.slide)
        barSlide = this.slide
        break
      case S.MAIN:
        this.phase = 0
        this.slide = 0.2
        this.door = 0.5
        this.doors(0.5)
        this.frameBorders(0.2)
        barSlide = 0.2
        barNoDropdown = false
        break
      case S.SAVE:
      case S.LOAD: {
        const save = this.state === S.SAVE
        this.card(save ? this.a.saveload.save : this.a.saveload.load)
        this.nav(save ? [-1, -1, 0, 2] : [-1, -1, 1, 2])
        this.slotList(save)
        this.subDoors(dt)
        break
      }
      case S.VIDEO:
        this.card(this.a.options.video)
        this.videoOptions()
        this.nav([-1, -1, -1, 5])
        this.subDoors(dt)
        break
      case S.AUDIO:
        this.card(this.a.options.audio)
        this.audioOptions()
        this.nav([-1, -1, -1, 5])
        this.subDoors(dt)
        break
      case S.CONTROLS:
        this.card(this.a.options.controls)
        this.controlOptions()
        this.nav([-1, -1, -1, 5])
        this.subDoors(dt)
        break
      case S.HELP_CONTROLS: {
        const c = this.a.controls
        this.card([c.rat, c.key, c.joy][this.controlsPage])
        this.nav([8, 7, 6, 5])
        this.subDoors(dt)
        break
      }
      case S.HELP_OVERVIEW:
        this.card(this.a.overview[this.page])
        this.nav([-1, -1, -1, 5])
        this.subDoors(dt)
        if (this.arrowsVisible() && this.state === S.HELP_OVERVIEW) this.pageArrows(dt)
        break
      case S.HELP_INTERFACE:
        if (this.interfacePage === 0) this.card(this.a.fondo, L.FONDO)
        else this.card(this.a.controls.gamescreen)
        this.nav([12, 13, -1, 5])
        this.subDoors(dt)
        if (this.closing === 0 && this.state === S.HELP_INTERFACE && this.interfacePage === 0) {
          // FUN_00405820: the interface diagram fades in over the open doors at 300/s.
          this.interfaceFade = Math.min(255, this.interfaceFade + dt * 0.3)
          const c = this.a.controls.interface
          for (let i = 0; i < 4; i++) this.img(c[i], L.FONDO[i], undefined, this.interfaceFade / 255)
        }
        break
      case S.CREDITS:
        this.card(this.a.credits[this.page])
        this.nav([-1, -1, -1, 5])
        this.subDoors(dt)
        if (this.arrowsVisible()) this.pageArrows(dt)
        break
      case S.EXIT:
        this.ini()
        this.img(this.a.title.final, [0.2765, 0.4562, 0.4593, 0.5437])
        if (this.closeAnim(dt)) {
          this.slide = 0
          this.state = S.FINAL
          drawBar = false
        }
        break
      case S.WEAPONS:
        this.card(this.a.fondo, L.FONDO)
        this.vehicleList()
        this.nav([-1, -1, -1, 5])
        this.subDoors(dt)
        break
      case S.VEHICLE:
        this.card(this.a.fondo, L.FONDO)
        this.card(this.a.vehicleCards[this.vehicle])
        this.nav([-1, -1, -1, 5])
        this.ensureViewer()
        this.viewer!.render(this.vehicle, dt)
        this.g = this.upper
        this.subDoors(dt)
        if (this.arrowsVisible()) this.vehicleArrows(dt)
        break
      case S.SCORES:
        this.card(this.a.score)
        this.nav([-1, -1, 0, 5])
        this.scoreTable()
        if (this.nameRank !== -1) this.nameEntry(this.nameRank)
        this.subDoors(dt)
        break
      case S.FINAL:
        this.ini()
        this.img(this.a.title.final, [0.2765, 0.4562, 0.4593, 0.5437])
        this.exitTimer += dt
        if (this.store.settings.music) this.audio.setMusicVolume(64 - this.exitTimer / 50)
        if (this.exitTimer > 3000) return 0
        drawBar = false
        break
      case S.PLAY:
        this.ini()
        if (this.closeAnim(dt)) return 1
        break
      case S.TITLE_PLAY:
        this.ini()
        this.exitTimer += dt
        if (this.store.settings.music) this.audio.setMusicVolume(64 - this.exitTimer / 10)
        if (this.exitTimer > 500) return 1
        drawBar = false
        break
    }
    if (this.state !== S.VEHICLE && this.viewer) this.viewer.render(null, 0)
    if (drawBar) this.menuBar(barSlide, barNoDropdown)
    this.g = this.state === S.VEHICLE ? this.upper : this.lower
    this.img(this.a.cuadrados, [this.mx / W, this.my / H, 0.1, 0.13333], L.CURSOR_UV)
    return null
  }

  /** States 0x32 and 100: doors open, then the frame and bar slide out. True when finished. */
  private closeAnim(dt: number) {
    if (this.phase === 1) this.slide -= dt * 0.01 * 0.08
    else if (this.phase === 0) this.door -= dt * 0.01 * 0.1
    if (this.door < 0) {
      this.phase = 1
      this.door = 0
    }
    if (this.slide < 0) return true
    this.doors(this.door)
    this.frameBorders(this.slide)
    return false
  }

  /** FUN_004054c0: sub-screen doors and frame. */
  private subDoors(dt: number) {
    if (this.closing === 2) {
      this.doorSub -= dt * 0.01 * 0.1
      if (this.doorSub < 0) {
        this.doorSub = 0
        this.closing = 0
      }
    } else if (this.closing === 1) {
      this.doorSub += dt * 0.01 * 0.1
      if (this.doorSub > 0.5) {
        this.doorSub = 0.5
        this.closing = 0
        this.state = S.MAIN
      }
    }
    this.doors(this.doorSub)
    this.frameBorders(0.2)
  }

  private arrowsVisible() {
    const [l, r] = [this.arrowL, this.arrowR]
    const here = this.state === S.HELP_OVERVIEW || this.state === S.CREDITS || this.state === S.VEHICLE
    return (this.closing === 0 && here) || (this.closing === 1 && (l !== 0 || r !== 0)) || (l !== 0 && r !== 0)
  }

  // ======================= intro and title =======================

  private introStep(dt: number) {
    const click = this.down
    if (this.sub === 500) {
      this.t += dt * 0.001
      if (this.t > 2.5) {
        this.t = 0
        this.sub = 0
      }
      if (this.escPressed) this.toTitle()
      if (click) {
        this.titleDebounce = true
        this.toTitle()
      }
      return
    }
    if (this.sub === 3) return this.title()
    const holds: Record<number, { hold: number; next: number; tex: Tex; rect: Rect }> = {
      0: { hold: 1.5, next: 1, tex: this.a.infogrames, rect: [0.234, 0.2, 0.5, 0.5] },
      1: { hold: 2.5, next: 2, tex: this.a.digital, rect: [0.203, 0.21, 0.6, 0.5333] },
      2: { hold: 2.0, next: 5, tex: this.a.titulo, rect: [0.14625, 0.2125, 0.6953, 0.5333] },
      5: { hold: 3.0, next: 3, tex: this.a.disclaimer, rect: [0.1703125, 0.2125, 0.67344, 0.5291] },
    }
    const h = holds[this.sub]
    if (this.phase === 0) this.alpha += dt * 0.1
    else if (this.phase === 1) this.t += dt * 0.001
    else this.alpha -= dt * 0.1
    if (this.t > h.hold) this.phase = 2
    if (this.alpha > 255) {
      this.phase = 1
      this.alpha = 255
    } else if (this.alpha < 0) {
      this.sub = h.next
      this.resetFade()
      return
    }
    if (this.escPressed) {
      // ESC skips to the title, except on the logo, where it jumps to the disclaimer.
      if (this.sub === 2) {
        this.sub = 5
        this.resetFade()
      } else this.toTitle()
    }
    if (click) {
      this.titleDebounce = true
      this.toTitle()
    }
    this.img(h.tex, h.rect, undefined, this.alpha / 255)
  }

  private resetFade() {
    this.phase = 0
    this.alpha = 0
    this.t = 0
  }

  private toTitle() {
    this.sub = 3
    this.resetFade()
  }

  private title() {
    const a = this.a
    this.img(a.gunOff, L.GUN_RECT)
    const tex = [a.title.credits, a.title.exit, a.title.help, a.title.play, a.title.loadGame]
    for (let i = 0; i < 5; i++) {
      if (this.inside(L.TITLE_HIT_A[i]) || this.inside(L.TITLE_HIT_B[i])) {
        if (i === 3) this.img(a.gunOn, L.GUN_RECT)
        else if (i === 0) this.img(a.espejito, [0.8406, 0.5125, 0.1, 0.2666])
        else if (i === 1) this.img(a.metralletita, [0, 0.4479, 0.17, 0.552])
        else if (i === 2) this.img(a.radio, [0, 0.4666, 0.4, 0.5333])
        this.img(tex[i], L.TITLE_DRAW[i])
        if (this.down && !this.titleDebounce) {
          if (i === 0) this.openFromTitle(2)
          else if (i === 1) this.state = S.FINAL
          else if (i === 2) this.openFromTitle(3)
          else if (i === 3) {
            this.state = S.TITLE_PLAY
            this.exitTimer = 0
          } else this.openFromTitle(0)
        } else if (!this.down) this.titleDebounce = false
      } else this.img(tex[i], L.TITLE_DRAW[i], undefined, L.TITLE_IDLE_ALPHA)
    }
    if (this.state === S.FINAL) this.exitTimer = 0
  }

  private openFromTitle(item: number) {
    this.state = S.OPENING
    this.openItem = item
    this.phase = 0
    this.slide = 0
    this.door = 0
    this.doorStep = 0
    // MENU.XM starts after the intro asset load in the original (end of FUN_00401d70).
    this.audio.stopModule()
    void this.audio.playModule('Fichas/sfx/Menu.xm')
  }

  // ======================= menu bar =======================

  /** FUN_004013a0: select bar item i (deselecting the rest, resetting dropdown fades). */
  private select(i: number) {
    if (i >= 8) return
    this.bar.forEach((b, k) => {
      if (k !== i || !b.selected) {
        b.selected = false
        b.fade = 0
      }
    })
    this.bar[i].selected = true
  }

  /** FUN_00401130 */
  private menuBar(slide: number, noDropdown: boolean) {
    this.barClicks()
    const tex = this.a.botones
    this.bar.forEach((b, i) => {
      if (!b.visible) return
      const d = L.BAR[i]
      const y = i < 5 ? d.rect[1] - 0.2 + slide : d.rect[1] + 0.2 - slide
      const r: Rect = [d.rect[0], y, d.rect[2], d.rect[3]]
      if (!b.selected) return this.img(tex, r, d.uv)
      this.img(tex, r, d.uvSel)
      const dd = L.DROPDOWN_ROWS[i]
      if (!dd || noDropdown) return
      this.dropdown(i)
      if (b.hoverRow !== -1) this.img(tex, [L.ROW_X, b.hoverRow * L.ROW_STEP + dd.y0, L.ROW_W, L.ROW_H], L.ROW_HILITE_UV)
      b.fade = Math.min(255, b.fade + this.dt * 0.15)
      const t = i === 0 ? this.a.dropdowns.file : i === 1 ? this.a.dropdowns.options : this.a.dropdowns.help
      this.img(t, L.DROPDOWN_RECT, undefined, b.fade / 255)
    })
  }

  /** FUN_004013e0: dropdown hover and selection. */
  private dropdown(item: number) {
    const dd = L.DROPDOWN_ROWS[item], b = this.bar[item]
    b.hoverRow = -1
    for (let row = 0; row < dd.rows; row++) {
      if (!this.inside([L.ROW_X, row * L.ROW_STEP + dd.y0, L.ROW_W, L.ROW_H], false)) continue
      b.hoverRow = row
      if (!this.down) return
      const go = (state: number) => {
        this.state = state
        if (this.closing === 0) this.closing = 2
      }
      if (item === 0) {
        if (row === 0) go(S.SAVE)
        else if (row === 1) go(S.LOAD)
        else if (row === 2) go(S.PLAY)
        else if (row === 3) {
          this.level = 1
          go(S.PLAY)
        } else this.state = S.EXIT
      } else if (item === 1) go([S.VIDEO, S.AUDIO, S.CONTROLS][row])
      else if (row === 0) {
        this.controlsPage = 0
        go(S.HELP_CONTROLS)
      } else if (row === 1) go(S.HELP_OVERVIEW)
      else {
        this.interfaceFade = 0
        this.interfacePage = 0
        go(S.HELP_INTERFACE)
      }
      if (this.state === S.PLAY || this.state === S.EXIT) this.phase = 0
      return
    }
  }

  /** FUN_00401660: bar clicks and deferred openings once the doors have closed. */
  private barClicks() {
    if (this.quitReq === 4 && this.closing === 0) {
      this.state = S.EXIT
      this.phase = 0
      return
    }
    const sel = (i: number) => this.bar[i].selected
    if (this.state === S.MAIN) {
      if (this.creditsClosed) {
        this.select(0)
        this.creditsClosed = false
        this.page = 0
        return
      }
      if (sel(2) && this.closing === 0) return this.openCredits()
      if (this.weaponsClosed) {
        this.select(0)
        this.weaponsClosed = false
        return
      }
      if (sel(5) && this.closing === 0) {
        if (this.weaponsPick) {
          this.closing = 2
          this.arrowL = this.arrowR = 0
          this.weaponsPick = false
          this.state = S.VEHICLE
          return
        }
        return this.openWeapons()
      }
      if (this.scoresClosed) {
        this.select(0)
        this.scoresClosed = false
        return
      }
      if (sel(7) && this.closing === 0) {
        this.closing = 2
        this.state = S.SCORES
        return
      }
      if (sel(6) && this.closing === 0) return this.openPlay()
    }
    if (!this.down) return
    for (let i = 0; i < 8; i++) {
      const b = this.bar[i]
      if (!b.visible || !this.inside(L.BAR[i].rect)) continue
      this.page = 0
      if (b.selected || this.closing !== 0) continue
      this.audio.sfx(2)
      this.select(i)
      const main = this.state === S.MAIN
      if (!main) this.closing = 1
      if (i === 2 && main) this.openCredits()
      else if (i === 4) this.quitReq = 4
      else if (i === 5 && main) this.openWeapons()
      else if (i === 6 && main) this.openPlay()
      else if (i === 7 && main) {
        this.closing = 2
        this.state = S.SCORES
      }
      return
    }
  }

  private openCredits() {
    this.closing = 2
    this.arrowL = this.arrowR = 0
    this.page = 0
    this.state = S.CREDITS
  }

  private openWeapons() {
    this.closing = 2
    this.state = S.WEAPONS
  }

  private openPlay() {
    this.state = S.PLAY
    this.closing = 2
    this.phase = 0
  }

  // ======================= shared sub-screen widgets =======================

  /** FUN_00406d40: the four plates with action labels (-1 = empty plate). */
  private nav(actions: number[]) {
    if (this.escPressed && this.closing === 0) this.closing = 1
    const tex = this.a.navButtons
    for (const p of L.NAV_PLATES) this.img(tex, p.rect, p.uv)
    actions.forEach((act, k) => {
      if (act === -1) return
      const r = L.NAV_LABELS[k]
      if (!this.inside(r, false)) return this.img(tex, r, L.NAV_UV[act])
      this.img(tex, r, L.NAV_UV_HOVER[act])
      if (!this.down) {
        this.navDebounce = false
        return
      }
      if (this.navDebounce) return
      this.navDebounce = true
      this.audio.sfx(0)
      this.navAction(act)
    })
  }

  private navAction(act: number) {
    const close = () => {
      if (this.closing === 0) this.closing = 1
    }
    switch (act) {
      case 0: // SAVE / OK
        close()
        if (this.state === S.SAVE && this.slot >= 0) {
          this.slotNames[this.slot] = this.editBuf
          const s = this.store.settings
          // FUN_004090e0 stores the ad28/ad24 copies of MouseMode/MouseInvert.
          this.store.writeSlot(this.slot, { name: this.editBuf, level: this.level, width: [640, 800, 1024][s.resolution], mouseMode: s.mouseMode, mouseInvert: s.mouseInvert })
          this.slotNames = this.store.slotNames()
          this.editBuf = ''
        } else if (this.state === S.SCORES) {
          this.store.saveScores()
          this.scoresClosed = true
          this.nameRank = -1
          this.level = 1
        }
        break
      case 1: // LOAD: FUN_00409200, then start at once
        if (this.slot >= 0) {
          const rec = this.store.readSlot(this.slot)
          if (rec) {
            this.level = rec.level
            const res = [640, 800, 1024].indexOf(rec.width)
            if (res >= 0) this.store.settings.resolution = res
            // The saved mouse fields only reach copies that FUN_00409390 overwrites before launch: no effect.
          }
        }
        close()
        this.state = S.PLAY
        this.phase = 0
        break
      case 2:
        close()
        break
      case 5:
        close()
        if (this.state === S.CREDITS) {
          this.creditsClosed = true
          this.page = 0
        } else if (this.state === S.HELP_OVERVIEW) this.page = 0
        else if (this.state === S.WEAPONS) this.weaponsClosed = true
        else if (this.state === S.SCORES) {
          this.store.loadScores()
          this.scoresClosed = true
          this.nameRank = -1
        }
        break
      case 6:
        this.controlsPage = 2
        break
      case 7:
        this.controlsPage = 1
        break
      case 8:
        this.controlsPage = 0
        break
      case 12:
        this.interfacePage = 0
        break
      case 13:
        this.interfacePage = 1
        this.interfaceFade = 0
        break
    }
  }

  /** FUN_00406450 (pages 0..4) and FUN_004068c0 (vehicles 0..8): fading page arrows. */
  private arrows(dt: number, index: number, count: number, step: (d: number) => void) {
    const leftOn = index !== 0 && this.closing === 0
    const rightOn = index !== count - 1 && this.closing === 0
    this.arrowL = leftOn ? Math.min(150, this.arrowL + dt * 0.4) : Math.max(0, this.arrowL - dt * 0.4)
    this.arrowR = rightOn ? Math.min(150, this.arrowR + dt * 0.4) : Math.max(0, this.arrowR - dt * 0.4)
    this.img(this.a.flecha, L.ARROW_L, [1, 0, 0, 1], this.arrowL / 255)
    this.img(this.a.flecha, L.ARROW_R, [0, 0, 1, 1], this.arrowR / 255)
    const sides: [Rect, boolean, UV, number][] = [
      [L.ARROW_L, index !== 0, [1, 0, 0, 1], -1],
      [L.ARROW_R, index !== count - 1, [0, 0, 1, 1], 1],
    ]
    for (const [r, enabled, uv, d] of sides) {
      if (!this.inside(r)) continue
      if (enabled) this.img(this.a.flecha, r, uv)
      if (!this.down) {
        this.arrowDebounce = false
        continue
      }
      if (this.arrowDebounce) continue
      this.arrowDebounce = true
      if (enabled) {
        this.audio.sfx(0)
        step(d)
      }
    }
  }

  private pageArrows(dt: number) {
    this.arrows(dt, this.page, 5, (d) => (this.page += d))
  }

  private vehicleArrows(dt: number) {
    this.arrows(dt, this.vehicle, 9, (d) => (this.vehicle += d))
  }

  // ======================= options =======================

  private optionRows(rows: number, y0: number, menu: Tex, marks: number[], pick: (row: number) => void) {
    let hover = -1
    for (let row = 0; row < rows; row++) {
      const y = row * L.ROW_STEP + y0
      if (!this.inside([L.ROW_X, y, 0.7233 - L.ROW_X, L.ROW_H])) continue
      hover = row
      if (this.down && this.closing === 0) pick(row)
    }
    if (hover !== -1) this.img(this.a.botones, [L.ROW_X, hover * L.ROW_STEP + y0, L.ROW_W, L.ROW_H], L.ROW_HILITE_UV)
    this.img(menu, L.DROPDOWN_RECT)
    for (const m of marks) this.img(this.a.flechita, [0.2453, m, 0.045, 0.0594])
  }

  /** FUN_00408070: LOW/MID/HIGH. Kept for fidelity; the browser ignores the game resolution. */
  private videoOptions() {
    const s = this.store.settings
    this.optionRows(3, 0.41246, this.a.menuVideo, [s.resolution * L.ROW_STEP + 0.41686], (row) => (s.resolution = row))
  }

  /** FUN_004082b0: MUSIC ON/OFF, SOUND ON/OFF, applied live. */
  private audioOptions() {
    const s = this.store.settings
    this.optionRows(4, 0.3583, this.a.menuAudio, [s.music ? 0.3583 : 0.41246, s.fx ? 0.46662 : 0.52078], (row) => {
      if (row < 2) {
        s.music = row === 0 ? 1 : 0
        this.audio.setMusicVolume(s.music ? 64 : 0)
      } else {
        s.fx = row === 2 ? 1 : 0
        this.audio.setSfxVolume(s.fx ? 64 : 0)
      }
    })
  }

  /** FUN_004085a0: MOUSE NORMAL/REVERSE (MouseMode), MOUSE LOOSE/TIGHT (MouseInvert). */
  private controlOptions() {
    const s = this.store.settings
    this.optionRows(4, 0.3583, this.a.menuControls, [s.mouseMode ? 0.41246 : 0.3583, s.mouseInvert ? 0.52078 : 0.46662], (row) => {
      if (row < 2) s.mouseMode = row
      else s.mouseInvert = row - 2
    })
  }

  // ======================= save / load =======================

  /** FUN_00408850 + FUN_00408b20 (+ FUN_00408ce0 when saving). */
  private slotList(save: boolean) {
    L.SLOTS.forEach(([x, y], i) => {
      if (!(x < this.mx && this.mx < x + 194 && y < this.my && this.my < y + 20)) return
      this.shade(x, y, 194, 20, 'rgb(240,50,50)')
      if (this.down) {
        this.slot = i
        this.editBuf = this.slotNames[i]
        this.shownName = this.editBuf
      }
    })
    if (this.slot !== -1) {
      const [x, y] = L.SLOTS[this.slot]
      this.shade(x, y, 194, 20, 'rgb(50,50,240)')
      if (save) {
        this.editLine(200, 600, 185, 353, this.editBuf, (s) => (this.editBuf = s))
        this.shownName = this.editBuf
      }
    }
    L.SLOTS.forEach(([x, y], i) => {
      if (i === this.slot) this.text(this.shownName, x, y, '#ffff00', 200)
      else this.text(this.slotNames[i], x, y, '#ffffff', 200)
    })
  }

  /** Typed-text field shared by FUN_00408ce0 and FUN_00409b70: 0-9 A-Z a-z '.' space, upper-cased, Backspace. */
  private editLine(maxWidth: number, weight: number, x: number, y: number, value: string, set: (s: string) => void) {
    if (this.backspace && value.length) value = value.slice(0, -1)
    const ch = this.typed[0]
    if (ch && /^[0-9A-Za-z. ]$/.test(ch)) {
      const next = (value + ch).toUpperCase()
      if (this.textWidth(next, weight) <= maxWidth) value = next
    }
    set(value)
    this.text(value, x, y, '#ffffff', weight)
    if (Math.floor(performance.now() / 120) % 2) this.text('|', x + this.textWidth(value, weight), y, '#ffffff', weight)
  }

  // ======================= scores =======================

  /** FUN_00409850 */
  private scoreTable() {
    this.store.scores.forEach((r, i) => {
      this.text(r.name, 0x9a, L.SCORE_Y[i], '#ffffff', 200)
      this.text(r.score, 0x171 - this.textWidth(r.score, 200), L.SCORE_Y[i], '#ffffff', 200)
    })
  }

  /** FUN_00409b70 */
  private nameEntry(rank: number) {
    const y = L.SCORE_Y[rank]
    this.shade(0x9a, y, 0x8b, 0x16, 'rgb(50,50,240)')
    const row = this.store.scores[rank]
    this.editLine(0x87, 200, 0x9a, y, row.name, (s) => (row.name = s))
  }

  // ======================= weapons chart =======================

  /** FUN_00407880 */
  private vehicleList() {
    for (let i = 0; i < 9; i++) {
      this.img(this.a.cuadrados, L.GRID_FRAME[i], L.GRID_FRAME_UV)
      this.img(this.a.vehicleList, L.GRID_THUMB[i], L.GRID_UV[i])
    }
    for (let i = 0; i < 9; i++) {
      const r = L.GRID_THUMB[i]
      if (!this.inside(r)) continue
      if (this.hoverCell !== i) {
        this.audio.sfx(3)
        this.hoverCell = i
      }
      if (this.down) {
        this.closing = 1
        this.weaponsPick = true
        this.vehicle = i
        this.ensureViewer()
        void this.viewer!.load(i)
      }
      this.img(this.a.highlight, r, undefined, 1, true)
    }
  }

  private ensureViewer() {
    if (this.viewer) return
    this.viewer = new VehicleViewer(this.fs, W, H)
    const c = this.viewer.canvas
    Object.assign(c.style, { position: 'absolute', inset: '0', margin: 'auto', imageRendering: 'pixelated', zIndex: '1', pointerEvents: 'none' })
    this.root.insertBefore(c, this.upper.canvas)
    this.layout()
  }

  /** Current score table, for tests and tools. */
  get scores() {
    return this.store.scores.map((r) => ({ name: r.name, level: atoi(r.score) }))
  }
}
