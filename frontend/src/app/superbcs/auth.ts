/**
 * SUPER BCS wallet auth. Session is a Bearer token issued by the parent
 * panel's SIWE flow and verified by the SUPER BCS API via passthrough to
 * /api/profile/me. The top-bar LoginModal (in the parent application)
 * handles the primary wallet connect; this module only handles the
 * signature-exchange step to mint a panel session token for an
 * already-connected wallet.
 *
 *   GET  /api/profile/nonce/{wallet}  -> { nonce, message }
 *   POST /api/profile/auth            -> { token, wallet }
 */

const PANEL_BASE =
  (import.meta.env.VITE_PANEL_BASE_URL as string | undefined) || 'https://panel.example.com'
const STORAGE_KEY = 'superbcs.session'
const SESSION_TTL_MS = 23 * 60 * 60 * 1000

export interface SuperBCSSession {
  token: string
  wallet: string
  storedAt: number
}

function readStored(): SuperBCSSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SuperBCSSession>
    if (!parsed.token || !parsed.wallet || !parsed.storedAt) return null
    if (Date.now() - parsed.storedAt > SESSION_TTL_MS) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return parsed as SuperBCSSession
  } catch {
    return null
  }
}

function persist(session: SuperBCSSession) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)) } catch { /* private mode */ }
}

export function getSession(): SuperBCSSession | null {
  return readStored()
}

export function getSessionFor(wallet: string | null | undefined): SuperBCSSession | null {
  const s = readStored()
  if (!s) return null
  if (!wallet) return s
  return s.wallet.toLowerCase() === wallet.toLowerCase() ? s : null
}

export function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

export function authHeaders(): Record<string, string> {
  const s = readStored()
  return s ? { Authorization: `Bearer ${s.token}` } : {}
}

function pickInjectedProvider(): any {
  const w = window as any
  if (!w.ethereum) return null
  if (Array.isArray(w.ethereum.providers)) {
    const mm = w.ethereum.providers.find((p: any) => p.isMetaMask && !p.isTrust)
    if (mm) return mm
    const trust = w.ethereum.providers.find((p: any) => p.isTrust)
    if (trust) return trust
    return w.ethereum.providers[0]
  }
  return w.ethereum
}

export class SuperBCSAuthError extends Error {
  constructor(message: string, public code?: string) {
    super(message)
    this.name = 'SuperBCSAuthError'
  }
}

/**
 * Mint a SUPER BCS session for an already-connected wallet. The primary
 * wallet connection is owned by the top-bar LoginModal; this only adds
 * the panel-side signature exchange needed to authorise SUPER BCS calls.
 */
export type SignMessageFn = (args: { message: string; account?: `0x${string}` }) => Promise<string>

export async function signSuperBCS(wallet: string, signMessage?: SignMessageFn): Promise<SuperBCSSession> {
  const normalized = wallet.toLowerCase()
  const nonceRes = await fetch(`${PANEL_BASE}/api/profile/nonce/${normalized}`)
  if (!nonceRes.ok) {
    throw new SuperBCSAuthError(`Nonce request failed (${nonceRes.status})`, 'NONCE_FAILED')
  }
  const nonceData = await nonceRes.json() as { nonce: string; message: string }
  if (!nonceData.message) throw new SuperBCSAuthError('Bad nonce response', 'NONCE_BAD')

  let signature: string
  // Preferred path: use wagmi's signMessage — it routes through the exact
  // connector (MetaMask / Trust / WalletConnect / etc.) that the top-bar
  // LoginModal established. This avoids the "wrong wallet popup" problem when
  // multiple injected providers exist on window.ethereum.
  if (signMessage) {
    try {
      signature = await signMessage({ message: nonceData.message, account: wallet as `0x${string}` })
    } catch (err: any) {
      if (err?.code === 4001 || /reject|denied/i.test(err?.message || '')) {
        throw new SuperBCSAuthError('Signature rejected.', 'SIG_REJECTED')
      }
      throw new SuperBCSAuthError(err?.message || 'Signature failed', 'SIG_FAILED')
    }
  } else {
    // Fallback: legacy injected path (kept for compatibility; not ideal when
    // multiple providers share window.ethereum).
    const provider = pickInjectedProvider()
    if (!provider) {
      throw new SuperBCSAuthError('Wallet provider not found. Re-connect from the top bar.', 'NO_WALLET')
    }
    try {
      signature = await provider.request({
        method: 'personal_sign',
        params: [nonceData.message, normalized],
      })
    } catch (err: any) {
      if (err?.code === 4001) throw new SuperBCSAuthError('Signature rejected.', 'SIG_REJECTED')
      throw new SuperBCSAuthError(err?.message || 'Signature failed', 'SIG_FAILED')
    }
  }

  const authRes = await fetch(`${PANEL_BASE}/api/profile/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wallet: normalized,
      signature,
      wallet_type: 'evm',
    }),
  })
  if (!authRes.ok) {
    throw new SuperBCSAuthError(`Auth failed (${authRes.status})`, 'AUTH_FAILED')
  }
  const auth = await authRes.json() as { token?: string; wallet?: string }
  if (!auth.token || !auth.wallet) {
    throw new SuperBCSAuthError('Auth response missing token', 'AUTH_BAD')
  }

  const session: SuperBCSSession = {
    token: auth.token,
    wallet: auth.wallet.toLowerCase(),
    storedAt: Date.now(),
  }
  persist(session)
  return session
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr || ''
  return `${addr.slice(0, 6)}${String.fromCharCode(8230)}${addr.slice(-4)}`
}
