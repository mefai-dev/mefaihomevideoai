/**
 * SUPER BCS — wallet-scoped history grid.
 * Wallet connection is owned by the top-bar LoginModal; this page only
 * asks for a panel signature if no SuperBCS session exists yet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { useAuthStore } from '@/store/authStore'
import {
  signSuperBCS, clearSession, getSessionFor, shortAddress,
  SuperBCSAuthError, type SuperBCSSession,
} from './superbcs/auth'
import { deleteJob, getHistory, getMe, type HistoryItem, type MeOut, type Tier } from './superbcs/api'
import { shareToX, shareToTelegram, shareToDiscord, shareToSquare } from '@/lib/share'

interface Props {
  onLoginClick: () => void
}

const TIER_COLOR: Record<Tier, string> = {
  free: '#848E9C',
  pro: '#F3BA2F',
  prime: '#A855F7',
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

function fmtDuration(ms: number | null): string {
  if (!ms || ms <= 0) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function SuperBCSHistoryPage({ onLoginClick }: Props) {
  const user = useAuthStore(s => s.user)
  const walletAddress = user?.walletAddress?.toLowerCase() || null
  const { signMessageAsync } = useSignMessage()

  const [session, setSession] = useState<SuperBCSSession | null>(() => getSessionFor(walletAddress))
  const [me, setMe] = useState<MeOut | null>(null)
  const [items, setItems] = useState<HistoryItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [busyJobId, setBusyJobId] = useState<string | null>(null)
  const autoSignedRef = useRef(false)

  // Drop stale session if wallet changed
  useEffect(() => {
    setSession(prev => {
      if (!prev) return getSessionFor(walletAddress)
      if (!walletAddress || prev.wallet.toLowerCase() !== walletAddress) {
        clearSession()
        autoSignedRef.current = false
        return null
      }
      return prev
    })
  }, [walletAddress])

  // Silent auto-SIWE: if wallet is connected and we have no session yet,
  // request the panel signature exactly once per mount. No explicit button.
  useEffect(() => {
    if (!walletAddress || session || authBusy || autoSignedRef.current) return
    autoSignedRef.current = true
    let cancelled = false
    ;(async () => {
      setAuthBusy(true); setError(null)
      try {
        const s = await signSuperBCS(walletAddress, signMessageAsync)
        if (!cancelled) setSession(s)
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof SuperBCSAuthError ? e.message : (e instanceof Error ? e.message : 'Signature failed')
          setError(msg)
        }
      } finally {
        if (!cancelled) setAuthBusy(false)
      }
    })()
    return () => { cancelled = true }
  }, [walletAddress, session, authBusy])

  const loadFirst = useCallback(async () => {
    if (!session) return
    setLoading(true); setError(null)
    try {
      const [h, m] = await Promise.all([getHistory(24), getMe()])
      setItems(h.items)
      setCursor(h.next_cursor)
      setMe(m)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load history'
      setError(msg)
      if (/401|403/.test(msg)) {
        clearSession(); setSession(null)
      }
    } finally { setLoading(false) }
  }, [session])

  useEffect(() => { void loadFirst() }, [loadFirst])

  const retrySignature = async () => {
    if (!walletAddress) { onLoginClick(); return }
    setAuthBusy(true); setError(null)
    try {
      const s = await signSuperBCS(walletAddress, signMessageAsync)
      setSession(s)
    } catch (e) {
      const msg = e instanceof SuperBCSAuthError ? e.message : (e instanceof Error ? e.message : 'Signature failed')
      setError(msg)
    } finally { setAuthBusy(false) }
  }

  const resetSession = () => {
    clearSession(); setSession(null); setItems([]); setMe(null); setCursor(null)
    autoSignedRef.current = false
  }

  const onLoadMore = async () => {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const h = await getHistory(24, cursor)
      setItems(prev => [...prev, ...h.items])
      setCursor(h.next_cursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load more')
    } finally { setLoadingMore(false) }
  }

  const onDelete = async (jobId: string) => {
    if (!confirm('Delete this generation? This cannot be undone.')) return
    setBusyJobId(jobId)
    try {
      await deleteJob(jobId)
      setItems(prev => prev.filter(it => it.job_id !== jobId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally { setBusyJobId(null) }
  }

  const onRegenerate = (it: HistoryItem) => {
    const params = new URLSearchParams({
      prompt: it.prompt_text || '',
      motion: it.motion_preset || '',
      token: it.token_symbol || '',
    })
    window.location.href = `/superbcs-generate?${params.toString()}`
  }

  const buildShareText = (it: HistoryItem): string => {
    const sym = (it.token_symbol || '').toUpperCase().trim()
    const cash = sym ? `$${sym} #${sym} ` : ''
    return `Just generated a SUPER BCS clip · ${cash}#MEFAI`
  }
  const shareUrl = (it: HistoryItem): string => it.media_urls?.[0] || it.media_url || ''

  const onShareX = (it: HistoryItem) => shareToX(buildShareText(it), shareUrl(it))
  const onShareTg = (it: HistoryItem) => shareToTelegram(buildShareText(it), shareUrl(it))
  const onShareDiscord = (it: HistoryItem) => { void shareToDiscord(`${buildShareText(it)}\n${shareUrl(it)}`) }
  const onShareSquare = (it: HistoryItem) => shareToSquare(`${buildShareText(it)}\n${shareUrl(it)}`)

  const tierColor = useMemo(() => (me ? TIER_COLOR[me.tier] : '#848E9C'), [me])

  return (
    <div className="sbh-root">
      <style>{CSS}</style>

      <div className="sbh-top">
        <div className="sbh-brand">
          <a href="/superbcs-generate" className="sbh-back">Back to studio</a>
          <span className="sbh-title">SUPER BCS · History</span>
        </div>
        <div className="sbh-acct">
          {walletAddress && session ? (
            <>
              {me && (
                <span className="sbh-tier" style={{ color: tierColor, borderColor: tierColor }}>
                  {me.tier.toUpperCase()}
                </span>
              )}
              {me && (
                <span className="sbh-quota">
                  {me.quota_used} / {me.quota_limit} today
                </span>
              )}
              <span className="sbh-wallet" title={session.wallet}>{shortAddress(session.wallet)}</span>
              <button className="sbh-btn ghost" onClick={resetSession}>Reset session</button>
            </>
          ) : null}
        </div>
      </div>

      {error && (
        <div className="sbh-err">
          <span>{error}</span>
          <button onClick={() => setError(null)}>close</button>
        </div>
      )}

      {!walletAddress && (
        <div className="sbh-empty">
          <div className="sbh-empty-bar" />
          <div className="sbh-empty-title">Wallet required</div>
          <div className="sbh-empty-sub">
            History is scoped to your wallet. Connect from the top bar to view your generations.
          </div>
          <button className="sbh-btn primary big" onClick={onLoginClick}>Open wallet panel</button>
        </div>
      )}

      {walletAddress && !session && (
        <div className="sbh-empty">
          <div className="sbh-empty-bar" />
          <div className="sbh-empty-title">
            {authBusy ? 'Waiting for signature' : 'Session required'}
          </div>
          <div className="sbh-empty-sub">
            {authBusy
              ? `Approve the panel signature in your wallet to unlock history for ${shortAddress(walletAddress)}.`
              : `A one-time panel signature is needed to load history for ${shortAddress(walletAddress)}.`}
          </div>
          {!authBusy && (
            <button className="sbh-btn primary big" onClick={retrySignature}>
              Retry signature
            </button>
          )}
          {authBusy && <div className="sbh-spin" style={{ marginTop: 18 }} />}
        </div>
      )}

      {walletAddress && session && loading && items.length === 0 && (
        <div className="sbh-loading">
          <div className="sbh-spin" />
          <span>Loading your generations…</span>
        </div>
      )}

      {walletAddress && session && !loading && items.length === 0 && !error && (
        <div className="sbh-empty">
          <div className="sbh-empty-bar" />
          <div className="sbh-empty-title">No generations yet</div>
          <div className="sbh-empty-sub">Head back to the studio and create your first clip.</div>
          <a href="/superbcs-generate" className="sbh-btn primary big">Open studio</a>
        </div>
      )}

      {walletAddress && session && items.length > 0 && (
        <>
          <div className="sbh-grid">
            {items.map(it => {
              const url = it.media_urls?.[0] || it.media_url || null
              const isDone = it.status === 'done' && !!url
              const statusColor =
                it.status === 'done' ? '#03C087' :
                it.status === 'error' ? '#F6465D' :
                it.status === 'cancelled' ? '#848E9C' :
                '#F3BA2F'
              return (
                <div key={it.job_id} className="sbh-card">
                  <div className="sbh-thumb">
                    {isDone ? (
                      <video src={url!} muted loop playsInline preload="metadata"
                        onMouseEnter={e => { void (e.currentTarget as HTMLVideoElement).play().catch(() => {}) }}
                        onMouseLeave={e => { (e.currentTarget as HTMLVideoElement).pause() }}
                      />
                    ) : (
                      <div className="sbh-thumb-empty">
                        <span className="sbh-status-dot" style={{ background: statusColor }} />
                        <span style={{ color: statusColor }}>{it.status.toUpperCase()}</span>
                      </div>
                    )}
                    {it.media_urls && it.media_urls.length > 1 && (
                      <span className="sbh-variants">{it.media_urls.length} variants</span>
                    )}
                  </div>
                  <div className="sbh-meta">
                    <div className="sbh-row1">
                      <span className="sbh-token">${it.token_symbol || '—'}</span>
                      <span className="sbh-motion">{it.motion_preset || '—'}</span>
                    </div>
                    <div className="sbh-prompt" title={it.prompt_text}>
                      {it.prompt_text || <em style={{ opacity: .5 }}>no prompt</em>}
                    </div>
                    <div className="sbh-row2">
                      <span>{fmtDate(it.created_at)}</span>
                      <span>{fmtDuration(it.duration_ms)}</span>
                    </div>
                    <div className="sbh-actions">
                      {isDone && it.media_urls?.map((mu, i) => (
                        <a key={mu} href={mu} download className="sbh-act">Download V{i + 1}</a>
                      ))}
                      <button className="sbh-act" onClick={() => onRegenerate(it)}>Regenerate</button>
                      <button
                        className="sbh-act danger"
                        onClick={() => onDelete(it.job_id)}
                        disabled={busyJobId === it.job_id}
                      >
                        {busyJobId === it.job_id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                    {isDone && (
                      <div className="sbh-share-row">
                        <button className="sbh-share x" title="Share on X" onClick={() => onShareX(it)}>
                          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                        </button>
                        <button className="sbh-share tg" title="Share on Telegram" onClick={() => onShareTg(it)}>
                          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                        </button>
                        <button className="sbh-share dc" title="Share on Discord" onClick={() => onShareDiscord(it)}>
                          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg>
                        </button>
                        <button className="sbh-share sq" title="Share on Binance Square" onClick={() => onShareSquare(it)}>
                          <img src="https://raw.githubusercontent.com/mefai-dev/mefai/refs/heads/main/bsc.png" alt="" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {cursor && (
            <div className="sbh-more">
              <button className="sbh-btn ghost" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

const CSS = `
.sbh-root {
  --gold: #F3BA2F;
  --surf: #0B0E11;
  --surf2: #14171C;
  --line: #232831;
  --line2: #2E343F;
  --text: #EAECEF;
  --muted: #848E9C;
  --red: #F6465D;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  background: var(--surf);
  color: var(--text);
  font-family: var(--sans);
  min-height: 100%;
  padding: 16px 24px 48px;
  overflow-y: auto;
}

.sbh-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 18px;
  gap: 16px;
  flex-wrap: wrap;
}
.sbh-brand { display: flex; align-items: center; gap: 14px; }
.sbh-back {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
  text-decoration: none;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  transition: 120ms;
}
.sbh-back:hover { color: var(--text); border-color: var(--line2); }
.sbh-title {
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: 1.5px;
  color: var(--gold);
  text-transform: uppercase;
}

.sbh-acct { display: flex; align-items: center; gap: 10px; font-family: var(--mono); font-size: 12px; }
.sbh-tier {
  border: 1px solid;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 10px;
  letter-spacing: 1.5px;
  font-weight: 600;
}
.sbh-quota { color: var(--muted); font-size: 11px; }
.sbh-wallet { color: var(--text); }

.sbh-btn {
  font-family: var(--mono);
  font-size: 12px;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--line2);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  transition: 140ms;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}
.sbh-btn:hover { background: var(--surf2); }
.sbh-btn:disabled { opacity: .5; cursor: not-allowed; }
.sbh-btn.primary {
  background: linear-gradient(180deg, #F3BA2F 0%, #D9A934 100%);
  color: #0B0E11;
  border-color: transparent;
  font-weight: 600;
}
.sbh-btn.primary:hover { filter: brightness(1.06); background: linear-gradient(180deg, #F3BA2F 0%, #D9A934 100%); }
.sbh-btn.ghost { color: var(--muted); }
.sbh-btn.big { padding: 10px 22px; font-size: 13px; margin-top: 16px; }

.sbh-err {
  display: flex; justify-content: space-between; align-items: center;
  background: rgba(246,70,93,0.08);
  border: 1px solid rgba(246,70,93,0.3);
  color: var(--red);
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-family: var(--mono);
  font-size: 12px;
}
.sbh-err button {
  background: none; border: 1px solid var(--line2); color: var(--muted);
  padding: 2px 8px; border-radius: 4px; cursor: pointer; font-family: var(--mono); font-size: 10px;
}

.sbh-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 80px 20px;
  text-align: center;
}
.sbh-empty-bar {
  width: 64px; height: 4px; border-radius: 2px;
  background: var(--gold); box-shadow: 0 0 18px var(--gold);
  margin-bottom: 20px;
}
.sbh-empty-title { font-family: var(--mono); font-size: 16px; color: var(--text); margin-bottom: 6px; letter-spacing: 0.5px; }
.sbh-empty-sub { color: var(--muted); font-size: 13px; max-width: 420px; line-height: 1.5; }

.sbh-loading {
  display: flex; align-items: center; justify-content: center;
  gap: 12px; padding: 60px 20px; color: var(--muted);
  font-family: var(--mono); font-size: 12px;
}
.sbh-spin {
  width: 18px; height: 18px;
  border: 2px solid var(--line2);
  border-top-color: var(--gold);
  border-radius: 50%;
  animation: sbh-spin 800ms linear infinite;
}
@keyframes sbh-spin { to { transform: rotate(360deg); } }

.sbh-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.sbh-card {
  background: var(--surf2);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  transition: 160ms;
  display: flex; flex-direction: column;
}
.sbh-card:hover { border-color: var(--line2); transform: translateY(-2px); }

.sbh-thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #000;
  overflow: hidden;
}
.sbh-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.sbh-thumb-empty {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  gap: 8px;
  font-family: var(--mono); font-size: 11px; letter-spacing: 1.5px;
}
.sbh-status-dot { width: 8px; height: 8px; border-radius: 50%; }
.sbh-variants {
  position: absolute; top: 8px; right: 8px;
  background: rgba(0,0,0,.7);
  color: var(--gold);
  font-family: var(--mono);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 0.5px;
}

.sbh-meta { padding: 12px 12px 10px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
.sbh-row1 {
  display: flex; justify-content: space-between; align-items: center;
  font-family: var(--mono); font-size: 11px;
}
.sbh-token { color: var(--gold); font-weight: 600; letter-spacing: 0.5px; }
.sbh-motion { color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
.sbh-prompt {
  font-size: 12px; color: var(--text);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 34px;
}
.sbh-row2 {
  display: flex; justify-content: space-between;
  font-family: var(--mono); font-size: 10px; color: var(--muted);
  padding-top: 4px; border-top: 1px solid var(--line);
}
.sbh-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.sbh-act {
  font-family: var(--mono); font-size: 10px;
  padding: 4px 8px;
  border: 1px solid var(--line2);
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  text-decoration: none;
  transition: 120ms;
}
.sbh-act:hover { color: var(--text); border-color: var(--gold); }
.sbh-act.danger:hover { color: var(--red); border-color: rgba(246,70,93,.5); }
.sbh-act:disabled { opacity: .5; cursor: not-allowed; }

.sbh-share-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.sbh-share {
  width: 26px; height: 26px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--line2);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: 140ms;
  padding: 0;
}
.sbh-share svg { width: 12px; height: 12px; }
.sbh-share img { width: 12px; height: 12px; display: block; }
.sbh-share:hover { color: var(--text); }
.sbh-share.x:hover { color: #ffffff; border-color: #ffffff; }
.sbh-share.tg:hover { color: #229ED9; border-color: #229ED9; }
.sbh-share.dc:hover { color: #5865F2; border-color: #5865F2; }
.sbh-share.sq:hover { color: var(--gold); border-color: var(--gold); }

.sbh-more { display: flex; justify-content: center; margin-top: 24px; }

@media (max-width: 600px) {
  .sbh-root { padding: 12px 14px 32px; }
  .sbh-grid { grid-template-columns: 1fr; }
  .sbh-acct { font-size: 11px; gap: 6px; flex-wrap: wrap; }
  .sbh-quota { display: none; }
}
`
