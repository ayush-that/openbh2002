import posthog from 'posthog-js'

// Product analytics and error tracking (PostHog). Off unless the build has VITE_POSTHOG_KEY, and off on
// localhost so development and test runs never report. No autocapture of clicks and no cookies.

const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com'
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
let enabled = false

export function initAnalytics() {
  if (!key || local) return
  posthog.init(key, {
    api_host: host,
    ui_host: 'https://us.posthog.com',
    defaults: '2025-11-30',
    persistence: 'localStorage',
    autocapture: false,
    capture_pageview: true,
    capture_exceptions: true,
    person_profiles: 'identified_only',
    disable_session_recording: true,
  })
  enabled = true
}

export function track(event: string, props?: Record<string, string | number | boolean | null>) {
  if (enabled) posthog.capture(event, props)
}
