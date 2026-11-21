import type { World } from './world'

// Browser input mapped onto what BH2.exe sees: an absolute cursor clamped to a 640x480 box around the
// screen centre (WinMain GetCursorPos, offset -320/-240), the left button, and WM_CHAR keys.
// Under pointer lock there is no cursor, so we integrate mouse movement into a virtual cursor.
// Touch (src/ui/touch.ts) feeds the same cursor through aim(): a drag turns the view by a proportional
// angle, converted to the rate-controlled cx one game frame at a time.

export type InputMode = 'mouse' | 'touch'

/** Touch aim: degrees turned by a drag across the shorter screen side. */
const TOUCH_AIM_DEG = 90

export class Input {
  /** Virtual cursor offset from centre in 640x480 pixels, clamped like the original. */
  cx = 0
  cy = 0
  button = false
  /** 'touch' after a touch or pen press (or with a coarse primary pointer), 'mouse' after real mouse use. */
  mode: InputMode = matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse'
  onModeChange?: (mode: InputMode) => void
  private keys: string[] = []
  private el: HTMLElement
  /** Touch: yaw degrees still to turn (positive = right), and whether cx currently carries it. */
  private yawLeft = 0
  private touchCx = false
  private tight = false

  constructor(el: HTMLElement) {
    this.el = el
    addEventListener('pointerdown', (e) => this.setMode(e.pointerType === 'mouse' ? 'mouse' : 'touch'), true)
    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && (e.movementX || e.movementY)) this.setMode('mouse')
    }, true)
    el.addEventListener('mousedown', (e) => {
      // Touch never takes pointer lock (compatibility mouse events follow taps on some browsers).
      if (this.mode !== 'mouse') return
      if (document.pointerLockElement !== el) {
        el.requestPointerLock()
        return
      }
      if (e.button === 0) this.button = true
    })
    addEventListener('mouseup', (e) => {
      if (e.button === 0 && this.mode === 'mouse') this.button = false
    })
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== el) return
      // One original pixel per 640th of the canvas width, so sensitivity matches at any window size.
      const k = 640 / Math.max(1, el.clientWidth)
      if (this.touchCx) this.release()
      this.cx = Math.max(-320, Math.min(319, this.cx + e.movementX * k))
      this.cy = softClamp(this.cy, e.movementY * k)
    })
    addEventListener('keydown', (e) => {
      if (e.repeat) return
      const k = e.key === 'Escape' ? 'Escape' : e.key === ' ' ? ' ' : e.key.length === 1 ? e.key.toLowerCase() : ''
      if (k) {
        this.keys.push(k)
        if (k === ' ') e.preventDefault()
      }
    })
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== el && this.mode === 'mouse') this.button = false
    })
  }

  get locked() {
    return document.pointerLockElement === this.el
  }

  /** Keys typed since the last call, as lower-case characters (WM_CHAR semantics). */
  takeKeys() {
    const k = this.keys
    this.keys = []
    return k
  }

  /** A key from an on-screen button. */
  press(key: string) {
    this.keys.push(key)
  }

  /** Touch drag of dx, dy CSS pixels. Right/down turns right/down, like moving the mouse. */
  aim(dx: number, dy: number) {
    const k = TOUCH_AIM_DEG / Math.max(1, Math.min(innerWidth, innerHeight))
    this.yawLeft += dx * k
    // Pitch follows cursor deltas (0.2 deg per pixel), so move cy directly. Left unclamped: the player
    // clamps pitch, so dragging back responds at once.
    this.cy += (dy * k) / 0.2
    this.touchCx = true
    this.cx = this.rate(this.yawLeft)
  }

  /** Drop any touch turn in progress and the fire button (touch controls hidden). */
  release() {
    if (this.touchCx) this.cx = 0
    this.yawLeft = 0
    this.touchCx = false
    if (this.mode === 'touch') this.button = false
  }

  /** game.late, after Player.update read cx: subtract the turn it applied and set up the next frame. */
  update(w: World) {
    this.tight = w.player.mouseTight
    if (!this.touchCx) return
    const c = this.cx
    this.yawLeft -= this.tight ? Math.abs(c / 20) * c * 0.002 : c * 0.02
    if (Math.abs(this.yawLeft) < 1e-4) this.release()
    else this.cx = this.rate(this.yawLeft)
  }

  /** cx that turns `deg` in one frame (Player: loose cx * 0.02, tight |cx / 20| * cx * 0.002), clamped. */
  private rate(deg: number) {
    const c = this.tight ? Math.sign(deg) * Math.sqrt(Math.abs(deg) / 0.0001) : deg / 0.02
    return Math.max(-320, Math.min(319, c))
  }

  private setMode(m: InputMode) {
    if (m === this.mode) return
    this.mode = m
    this.onModeChange?.(m)
  }
}

/** The original clamp, except that a value already outside (after touch aim) only moves back in, never jumps. */
function softClamp(v: number, d: number) {
  const n = v + d
  return d > 0 ? Math.min(n, Math.max(v, 239)) : Math.max(n, Math.min(v, -240))
}
