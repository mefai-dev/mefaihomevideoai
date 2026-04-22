/**
 * Cloudflare Turnstile React wrapper.
 *
 * Renders the widget in "managed" mode (invisible for normal users, visible
 * interactive challenge only when CF decides one is needed). Exposes an
 * imperative `getToken()` via ref so the parent can `await` a fresh token
 * just before submitting a job.
 *
 * A single widget is mounted on page load; `reset()` is called after every
 * successful or failed submit to force a new token on the next generate.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: {
        sitekey: string
        callback?: (token: string) => void
        'error-callback'?: () => void
        'expired-callback'?: () => void
        theme?: 'light' | 'dark' | 'auto'
        size?: 'normal' | 'compact' | 'invisible' | 'flexible'
        appearance?: 'always' | 'execute' | 'interaction-only'
      }) => string
      reset: (widgetId?: string) => void
      getResponse: (widgetId?: string) => string | undefined
      remove: (widgetId?: string) => void
    }
  }
}

export interface TurnstileHandle {
  /** Wait for a fresh token (up to `timeoutMs`). Returns null on timeout. */
  getToken: (timeoutMs?: number) => Promise<string | null>
  /** Force a new challenge — call after each submit. */
  reset: () => void
}

const SITE_KEY = (import.meta.env.VITE_SUPERBCS_TURNSTILE_SITE_KEY as string | undefined) || ''

export const Turnstile = forwardRef<TurnstileHandle>((_, ref) => {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const tokenRef = useRef<string | null>(null)
  tokenRef.current = token

  useEffect(() => {
    if (!SITE_KEY) return
    let cancelled = false

    const tryRender = () => {
      if (cancelled) return
      const ts = window.turnstile
      if (!ts || !mountRef.current) {
        // Script not ready yet. Retry on next tick.
        window.setTimeout(tryRender, 100)
        return
      }
      if (widgetIdRef.current) return
      widgetIdRef.current = ts.render(mountRef.current, {
        sitekey: SITE_KEY,
        // Managed mode + default appearance: the widget is a small visible
        // checkbox that CF auto-solves for most users; it only asks for
        // interaction when CF needs proof. Earlier `interaction-only` hid
        // the widget entirely, which blocked users whenever CF *did* want
        // a click — the token never arrived and the page timed out with
        // "Bot check failed to load".
        theme: 'dark',
        size: 'flexible',
        callback: (t) => setToken(t),
        'error-callback': () => setToken(null),
        'expired-callback': () => setToken(null),
      })
    }
    tryRender()

    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current) } catch { /* ignore */ }
        widgetIdRef.current = null
      }
    }
  }, [])

  useImperativeHandle(ref, () => ({
    getToken: async (timeoutMs = 10_000) => {
      if (tokenRef.current) return tokenRef.current
      // Wait for the callback to populate a token. Poll every 100ms.
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        if (tokenRef.current) return tokenRef.current
        await new Promise(r => setTimeout(r, 100))
      }
      return null
    },
    reset: () => {
      setToken(null)
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.reset(widgetIdRef.current) } catch { /* ignore */ }
      }
    },
  }), [])

  return <div ref={mountRef} className="sbcs-turnstile" style={{ marginTop: 10 }} />
})

Turnstile.displayName = 'Turnstile'
