// Screen helpers shared by main.ts, the HUD and the touch controls.

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

let probe: HTMLDivElement | null = null

/** CSS env(safe-area-inset-*) in CSS pixels (notches, rounded corners, home indicator). */
export function safeInsets(): Insets {
  if (!probe) {
    probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
    document.body.append(probe)
  }
  const s = getComputedStyle(probe)
  return { top: parseFloat(s.paddingTop) || 0, right: parseFloat(s.paddingRight) || 0, bottom: parseFloat(s.paddingBottom) || 0, left: parseFloat(s.paddingLeft) || 0 }
}

/** Run `fn` once per animation frame after any viewport change (resize, rotation, fullscreen, on-screen UI). */
export function onViewportChange(target: Element, fn: () => void) {
  let queued = 0
  const schedule = () => {
    if (!queued) queued = requestAnimationFrame(() => {
      queued = 0
      fn()
    })
  }
  new ResizeObserver(schedule).observe(target)
  addEventListener('resize', schedule)
  addEventListener('orientationchange', schedule)
  document.addEventListener('fullscreenchange', schedule)
  visualViewport?.addEventListener('resize', schedule)
  // DPR changes (moving between monitors, browser zoom) do not always resize the element.
  const watchDpr = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => {
    schedule()
    watchDpr()
  }, { once: true })
  watchDpr()
}

/** Fullscreen and landscape lock for touch play. Each step is optional (iPhone Safari has neither). */
export function enterImmersive() {
  const lock = () => {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
    o?.lock?.('landscape').catch(() => {})
  }
  const el = document.documentElement
  if (document.fullscreenElement || !el.requestFullscreen) return lock()
  el.requestFullscreen({ navigationUI: 'hide' }).then(lock, () => {})
}

/** Viewport taller than wide (orientation lock unavailable or refused). */
export function isPortrait() {
  return innerHeight > innerWidth
}
