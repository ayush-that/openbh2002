// Browser input mapped onto what BH2.exe sees: an absolute cursor clamped to a 640x480 box around the
// screen centre (WinMain GetCursorPos, offset -320/-240), the left button, and WM_CHAR keys.
// Under pointer lock there is no cursor, so we integrate mouse movement into a virtual cursor.

export class Input {
  /** Virtual cursor offset from centre in 640x480 pixels, clamped like the original. */
  cx = 0
  cy = 0
  button = false
  private keys: string[] = []
  private el: HTMLElement

  constructor(el: HTMLElement) {
    this.el = el
    el.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== el) {
        el.requestPointerLock()
        return
      }
      if (e.button === 0) this.button = true
    })
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.button = false
    })
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== el) return
      // One original pixel per 640th of the canvas width, so sensitivity matches at any window size.
      const k = 640 / Math.max(1, el.clientWidth)
      this.cx = Math.max(-320, Math.min(319, this.cx + e.movementX * k))
      this.cy = Math.max(-240, Math.min(239, this.cy + e.movementY * k))
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
      if (document.pointerLockElement !== el) this.button = false
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
}
