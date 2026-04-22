import { useTabStore } from '@/store/tabStore'

function toast(msg: string) {
  useTabStore.setState({ toast: msg })
  setTimeout(() => useTabStore.setState({ toast: null }), 3000)
}

// Modal state for Discord/Square setup prompts
type ShareModal = { type: 'discord' | 'square'; content: string } | null
let _modalState: ShareModal = null
let _modalListener: ((m: ShareModal) => void) | null = null

export function getShareModal() { return _modalState }
export function onShareModalChange(fn: (m: ShareModal) => void) { _modalListener = fn }
export function closeShareModal() { _modalState = null; _modalListener?.(null) }
export function getModalState() { return _modalState }

function showModal(type: 'discord' | 'square', content: string) {
  _modalState = { type, content }
  _modalListener?.(_modalState)
}

export async function shareToDiscord(content: string): Promise<boolean> {
  const webhookUrl = localStorage.getItem('mefai_discord_webhook')
  if (!webhookUrl) {
    showModal('discord', content)
    return false
  }
  try {
    const res = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) })
    if (res.ok) { toast('Shared to Discord'); return true }
    localStorage.removeItem('mefai_discord_webhook')
    showModal('discord', content)
    return false
  } catch {
    localStorage.removeItem('mefai_discord_webhook')
    showModal('discord', content)
    return false
  }
}

export function shareToSquare(text: string) {
  const key = localStorage.getItem('mefai_square_key')
  if (!key) {
    showModal('square', text)
    return
  }
  navigator.clipboard.writeText(text)
  toast('Copied to clipboard, opening Binance Square')
  window.open('https://www.binance.com/en/square/create-post', '_blank', 'noopener,noreferrer')
}

export function shareToX(text: string, url?: string) {
  const params = new URLSearchParams({ text })
  if (url) params.set('url', url)
  window.open(`https://x.com/intent/tweet?${params.toString()}`, '_blank', 'noopener,noreferrer')
}

export function shareToTelegram(text: string, url?: string) {
  const params = new URLSearchParams({ text })
  if (url) params.set('url', url)
  window.open(`https://t.me/share/url?${params.toString()}`, '_blank', 'noopener,noreferrer')
}
