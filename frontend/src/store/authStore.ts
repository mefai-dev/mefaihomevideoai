import { create } from 'zustand'
import type { WalletUser } from '@/types'

const STORAGE_KEY = 'mefai_wallet'

function loadSession(): WalletUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (data?.walletAddress) return data
  } catch { /* ignore */ }
  return null
}

function saveSession(user: WalletUser | null) {
  if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify(user))
  else localStorage.removeItem(STORAGE_KEY)
}

interface AuthStore {
  user: WalletUser | null
  token: string | null
  connecting: boolean
  error: string | null
  setUser: (user: WalletUser | null) => void
  setToken: (token: string | null) => void
  disconnect: () => void
  clearError: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: loadSession(),
  token: loadSession() ? 'authenticated' : null,
  connecting: false,
  error: null,

  setUser: (user) => {
    saveSession(user)
    set({ user })
  },

  setToken: (token) => set({ token }),

  disconnect: () => {
    saveSession(null)
    set({ user: null, token: null, error: null })
    // Clear backend session
    fetch('/mefai-auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
    // Disconnect Solana wallets
    try { (window as any).solana?.disconnect() } catch { /* ignore */ }
    try { (window as any).solflare?.disconnect() } catch { /* ignore */ }
  },

  clearError: () => set({ error: null }),
}))
