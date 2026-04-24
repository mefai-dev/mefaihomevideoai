/**
 * SUPER BCS Studio · Kling-quality cinematic video generator.
 *
 * Wallet auth is owned by the top-bar LoginModal (useAuthStore). When a
 * wallet is connected, we silently mint a SuperBCS session (one panel
 * signature on first visit, then cached).
 *
 * Tokens are tiered: FREE=8 majors, PRO=+meme universe, PRIME=full
 * CoinGecko search. Prices come from CoinGecko (no API key required).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { useAuthStore } from '@/store/authStore'
import {
  signSuperBCS, clearSession, getSessionFor, shortAddress,
  SuperBCSAuthError, type SuperBCSSession,
} from './superbcs/auth'
import {
  getJob, getMe, submitJob, type JobStatus, type MeOut, type Tier,
} from './superbcs/api'
import { Turnstile, type TurnstileHandle } from './superbcs/Turnstile'

interface Props {
  onLoginClick: () => void
}

const MIDDOT = '\u00B7'

function Corners({ color = '#F0B90B', size = 10, border = 1 }: { color?: string; size?: number; border?: number }) {
  const base = { position: 'absolute' as const, width: size, height: size, pointerEvents: 'none' as const }
  const b = `${border}px solid ${color}`
  return (<>
    <span style={{ ...base, top: 0, left: 0, borderTop: b, borderLeft: b }} />
    <span style={{ ...base, top: 0, right: 0, borderTop: b, borderRight: b }} />
    <span style={{ ...base, bottom: 0, left: 0, borderBottom: b, borderLeft: b }} />
    <span style={{ ...base, bottom: 0, right: 0, borderBottom: b, borderRight: b }} />
  </>)
}

/* ─────────── Motion presets · cinematic, detailed, model-ready ─────────── */
type PresetAnim = 'rise' | 'fall' | 'gallop' | 'freeze' | 'vortex' | 'crystal' |
                  'float' | 'wave' | 'pulse' | 'shatter' | 'steady' | 'launch' |
                  'confetti' | 'flame' | 'network' | 'cross'

interface Preset {
  label: string
  enum: string
  color: string
  color2: string
  blurb: string
  /** Core action · ≤15 words · lands first in the prompt to secure high model-token weight. */
  mood: string
  /** Cinematography · lens, lighting, colour grade · appended after the core action. */
  detail: string
  anim: PresetAnim
}

// Presets are authored so the first ~15 words fully describe the action.
// Video models over-weight the prompt head, so cinematography details are
// pushed into `detail` and composed *after* the core mood. In Hybrid mode
// the user's own tweak slots in between mood and detail — so user intent
// still lands inside the high-weight zone, not at the tail.
const PRESETS: Preset[] = [
  { label: 'PUMP IT', enum: 'PUMP_IT', color: '#03C087', color2: '#F0B90B', blurb: 'Triumphant rise', anim: 'rise',
    mood: 'the subject rockets straight upward with explosive vertical momentum as a shockwave of golden sparks bursts outward around it',
    detail: 'bright green candlestick fragments streaming past from below, warm rim light, volumetric god rays, slow dolly-in, 35mm anamorphic lens, shallow depth of field, subtle film grain, confident bullish energy, emerald-green-and-gold colour grade' },
  { label: 'DUMP IT', enum: 'DUMP_IT', color: '#FF4D63', color2: '#2A0C12', blurb: 'Dramatic crash', anim: 'fall',
    mood: 'the subject plunges straight down in freefall as red candlestick bars shatter into glass shards around it',
    detail: 'low-angle 24mm wide lens, hand-held camera shake accelerating with the fall, deep cyan shadows crushed against blood-red key light, pronounced motion blur streaks, atmospheric dust, crimson-and-black colour grade, cinematic disaster aesthetic' },
  { label: 'BULL RUN', enum: 'BULL_RUN', color: '#03C087', color2: '#FFB020', blurb: 'Charging momentum', anim: 'gallop',
    mood: 'the subject charges forward at full gallop trailing a golden dust cloud through streaking green chart lines',
    detail: 'epic low-angle tracking shot, 50mm cinematic lens, warm amber sunset sky, anamorphic lens flares sweeping across the frame, heroic wide composition, volumetric atmosphere, emerald-and-amber colour grade' },
  { label: 'BEAR MARKET', enum: 'BEAR_MARKET', color: '#3B82F6', color2: '#0F1623', blurb: 'Cold sinking', anim: 'freeze',
    mood: 'the subject sinks slowly into a cavernous deep-blue cryogenic void as ice crystals propagate across its surface',
    detail: 'faint red descending trend line etched into the fog behind, sparse volumetric haze catching rare shafts of light, gentle downward camera drift, muted cold cyan-and-grey palette, IMAX-scale composition, quiet dread' },
  { label: 'RUGPULL', enum: 'RUGPULL', color: '#DC2626', color2: '#0A0000', blurb: 'Floor disappears', anim: 'vortex',
    mood: 'the ground under the subject dissolves and implodes into a spiralling black vortex beneath it',
    detail: '18mm vertigo-inducing wide lens, pulsing red emergency strobes, paper shreds spiralling inward, heavy camera roll combined with crash-zoom, suspended dust and glowing embers, deep crimson against inky black, cinematic collapse aesthetic' },
  { label: 'DIAMOND HANDS', enum: 'DIAMOND_HANDS', color: '#22D3EE', color2: '#EC4899', blurb: 'Crystalline glow', anim: 'crystal',
    mood: 'the subject crystallises into brilliant faceted diamond surfaces with caustic rainbow refractions dancing across every facet',
    detail: 'macro beauty shot, 85mm portrait lens, slow orbital camera, studio key light with prism bokeh, crystalline shimmer particles rising in slow motion, premium luxury finish, cool cyan and rose gold colour grade' },
  { label: 'MOON SHOT', enum: 'MOON_SHOT', color: '#A78BFA', color2: '#060814', blurb: 'Float upward', anim: 'float',
    mood: 'the subject floats weightlessly upward through layered stratus clouds toward a huge glowing full moon',
    detail: 'wide cinematic shot, rocket contrail particles trailing softly below, soft violet-to-deep-blue gradient sky, gentle camera rise with parallax scrolling stars, dreamlike ascent, atmospheric perspective, violet and silver colour grade' },
  { label: 'WHALE ALERT', enum: 'WHALE_ALERT', color: '#0EA5E9', color2: '#F0B90B', blurb: 'Tidal force', anim: 'wave',
    mood: 'a massive radial tsunami ring bursts outward around the subject in hyper slow motion with suspended glowing droplets',
    detail: 'low-angle hero shot, 28mm lens, deep ocean blue tones bathed in golden caustic light from below, horizontal anamorphic lens flare streaks, oceanic power, deep teal and molten gold colour grade' },
  { label: 'FOMO', enum: 'FOMO', color: '#FACC15', color2: '#F97316', blurb: 'Urgent pulse', anim: 'pulse',
    mood: 'concentric energy rings pulse rapidly outward from the subject in a heartbeat rhythm with strobe flashes',
    detail: 'close-up handheld shot, camera crash-zooming in and out in sync with the pulse, neon yellow and orange strobe sweeps, subtle edge chromatic aberration, anxious kinetic feel, bright-yellow-and-deep-orange colour grade' },
  { label: 'LIQUIDATION', enum: 'LIQUIDATION', color: '#DC2626', color2: '#FACC15', blurb: 'Total destruction', anim: 'shatter',
    mood: 'fracture cracks burst across the frame from the subject as sparks and explosions arc through volumetric smoke',
    detail: 'red warning lights pulsing rhythmically in the background, heavy camera shake combined with whip-pans, debris arcing through smoke, high-contrast scarlet and sulphur yellow colour grade, disaster cinematic aesthetic' },
  { label: 'HODL', enum: 'HODL', color: '#F59E0B', color2: '#1A0F00', blurb: 'Eternal calm', anim: 'steady',
    mood: 'the subject stands unshaken at the calm eye of a violent storm with a warm golden protective aura',
    detail: 'monumental wide shot, 35mm cinematic lens, debris and wind streaking harmlessly around the subject, slow cinematic push-in camera, volumetric atmosphere, heroic stillness, amber gold against storm grey colour grade' },
  { label: 'TO THE MOON', enum: 'TO_THE_MOON', color: '#EC4899', color2: '#F0B90B', blurb: 'Rocket launch', anim: 'launch',
    mood: 'the subject blasts upward on a brilliant magenta-and-gold rocket plume with stars whipping past toward the moon',
    detail: 'cratered lunar surface looming at the top of the frame, thick volumetric smoke billowing at the base, camera rising with the subject, anamorphic lens flares, massive scale, hot magenta and molten gold colour grade' },
  { label: 'HYPE TRAIN', enum: 'HYPE_TRAIN', color: '#A855F7', color2: '#EC4899', blurb: 'Confetti party', anim: 'confetti',
    mood: 'holographic confetti and neon streamers burst outward from the subject under pulsing pink and purple stage lights',
    detail: 'ultra-wide festive composition, deep bokeh highlights, camera bouncing gently with the beat, smoke-machine haze catching coloured beams of light, electric pink and deep violet colour grade' },
  { label: 'FIRE SALE', enum: 'FIRE_SALE', color: '#F97316', color2: '#DC2626', blurb: 'Engulfing flames', anim: 'flame',
    mood: 'the subject is engulfed in towering volumetric flames with glowing ember particles drifting through heat-distorted air',
    detail: 'slow orbital camera, deep orange key light against inky black negative space, photoreal fire simulation with natural turbulence, cinematic heat distortion, molten orange and charcoal black colour grade' },
  { label: 'GOLDEN CROSS', enum: 'GOLDEN_CROSS', color: '#F0B90B', color2: '#FFF7D6', blurb: 'Light beams cross', anim: 'cross',
    mood: 'two massive golden light beams sweep in and cross behind the subject with a blinding burst of amber particles',
    detail: 'anamorphic lens flares streaking across the frame, slow zoom-in to a heroic moment, warm radiant divine-light aesthetic, warm gold and ivory colour grade' },
]

/* ─────────── Prompt enhancer ─────────── */
const SUBJECT_LOCK_SUFFIX = 'preserve the exact subject from the reference image unchanged, identical face, pose, and identity, the scene animates around this subject'
// Quality suffix appended to every render: tuned for Wan 2.2 TI2V-5B at 24fps · 832x480.
const QUALITY_SUFFIX = 'ultra-detailed 4K cinematography, physically accurate lighting, natural motion, coherent anatomy, sharp focus on the subject, clean composition, cinematic colour grade, no text, no watermark, no logo overlays'

/* ─────────── Token universe · tier-gated ─────────── */
interface TokenEntry {
  symbol: string
  cgId: string | null
  color: string
  tier: Tier
}

const TOKENS: TokenEntry[] = [
  { symbol: 'BNB',   cgId: 'binancecoin', color: '#F0B90B', tier: 'free' },
  { symbol: 'BTC',   cgId: 'bitcoin',     color: '#F7931A', tier: 'free' },
  { symbol: 'ETH',   cgId: 'ethereum',    color: '#627EEA', tier: 'free' },
  { symbol: 'SOL',   cgId: 'solana',      color: '#14F195', tier: 'free' },
  { symbol: 'MEFAI', cgId: 'meta-financial-ai', color: '#F0B90B', tier: 'free' },
]

function tokensForTier(tier: Tier): TokenEntry[] {
  if (tier === 'prime') return TOKENS
  if (tier === 'pro') return TOKENS
  return TOKENS.filter(t => t.tier === 'free')
}

/* ─────────── Search results from CoinGecko ─────────── */
interface SearchRow { symbol: string; cgId: string; color: string; thumb?: string; name?: string }

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']
const MAX_FILE_SIZE = 10 * 1024 * 1024
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3'

const TIER_LABEL: Record<Tier, string> = { free: 'FREE', pro: 'PRO', prime: 'PRIME' }
const TIER_COLOR: Record<Tier, string> = { free: '#848E9C', pro: '#F0B90B', prime: '#A855F7' }

const T = {
  title: 'SUPER BCS',
  subtitle: `Fully local AI studio for social media content ${MIDDOT} 3 second clips ${MIDDOT} download as MP4 or GIF`,
  connectPrompt: 'Connect a wallet from the top bar to unlock tiers and job history.',
  quota: (n: number, m: number) => `${n} / ${m}`,
  modeLabel: 'Prompt mode',
  modeQuick: 'Quick', modeQuickDesc: 'Preset only',
  modeHybrid: 'Hybrid', modeHybridDesc: 'Preset + tweak',
  modeCustom: 'Custom', modeCustomDesc: 'Free form',
  promptPlaceholder: 'Add your own direction, mood, lighting, camera move, atmosphere…',
  promptHint: 'Describe the world reacting to your token. The token logo is overlaid automatically by the renderer.',
  customPromptHint: 'Custom mode sends only your text. For recognisable output, describe subject, action, camera move, lighting, mood · at least 12 words.',
  customTooShort: (w: number, need: number) => `${w} / ${need} words · add more detail for a coherent render`,
  motion: 'Motion preset',
  token: 'Token',
  tokenSearchFree: 'Upgrade to PRIME for full token search',
  tokenSearchPrime: 'Search any token · symbol, name, or 0x contract address…',
  tokenSearchNone: 'No matching token. Try another symbol, name, or paste a BSC / ETH contract address.',
  tokenSearchResolvingContract: 'Resolving contract address…',
  image: 'Reference image',
  imageDrop: 'Drop an image or click to upload',
  imageHint: 'PNG, JPG, WebP up to 10 MB. If provided, the subject is preserved.',
  imageRemove: 'Remove',
  subjectLocked: 'Subject locked to reference, motion preset will animate this subject.',
  generate: 'Generate video',
  generating: 'Generating',
  submitting: 'Submitting',
  queued: 'Queued',
  claimed: 'Worker claimed job',
  running: 'Rendering frames',
  done: 'Done',
  errored: 'Error',
  elapsed: 'elapsed',
  queuePos: (p: number) => `position ${p} in queue`,
  variantA: 'Variant A', variantB: 'Variant B',
  download: 'Download',
  regenerate: 'Regenerate',
  regenerateSeed: 'Different seed',
  share: 'Share on X',
  history: 'History',
  fullHistory: 'Open full history',
  quotaHit: 'Daily quota reached. Try again after the 24 hour window.',
  timeout: 'Job timed out after 10 minutes.',
  specs: 'Render specs',
  tier: TIER_LABEL,
}

type PromptMode = 'quick' | 'hybrid' | 'custom'
type Phase = 'idle' | 'submitting' | 'queued' | 'claimed' | 'running' | 'done' | 'error'

function phaseFromStatus(s: JobStatus): Phase {
  if (s === 'queued') return 'queued'
  if (s === 'claimed') return 'claimed'
  if (s === 'running') return 'running'
  if (s === 'done') return 'done'
  return 'error'
}

function statusBlurb(p: Phase): string {
  switch (p) {
    case 'submitting': return T.submitting
    case 'queued': return T.queued
    case 'claimed': return T.claimed
    case 'running': return T.running
    case 'done': return T.done
    case 'error': return T.errored
    default: return ''
  }
}

function formatPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return '—'
  if (p < 0.0001) return p.toExponential(2)
  if (p < 1) return p.toFixed(6)
  if (p < 100) return p.toFixed(4)
  return p.toFixed(2)
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31)
}

/* Map raw wallet / auth errors to short, reassuring user-facing copy. */
function friendlyAuthError(raw: string): string {
  const m = (raw || '').toLowerCase()
  if (/quota.*exceeded|storage.*full|out of .*(storage|memory|data)/.test(m)) {
    return 'Browser storage is full. Clear some cached site data for this site and try again.'
  }
  if (/reject|denied|4001/.test(m)) {
    return 'Signature was cancelled in your wallet. Tap Generate again when you are ready to sign.'
  }
  if (/no accounts|not connected|wallet provider not found/.test(m)) {
    return 'Wallet session expired. Please reconnect from the top bar and try again.'
  }
  if (/network|fetch|timeout|failed to fetch/.test(m)) {
    return 'Network hiccup while contacting the panel. Check your connection and retry.'
  }
  if (/invalid.*address/.test(m)) {
    return 'Your wallet rejected the signing address. Reconnect from the top bar and try once more.'
  }
  return raw || 'Signature failed. Please try again.'
}

/* ═════════════════════════════════════════════════════════════ */

export function SuperBCSPage({ onLoginClick }: Props) {
  const user = useAuthStore(s => s.user)
  const walletAddress = user?.walletAddress?.toLowerCase() || null
  // wagmi-routed signer: uses the exact connector from the top-bar LoginModal
  // (MetaMask / Trust / WalletConnect) instead of whichever injected provider
  // happens to own window.ethereum. Prevents "Trust popup when MetaMask is
  // connected" race conditions.
  const { signMessageAsync } = useSignMessage()

  /* ─── Auth: session is lazy — only minted on Generate click ─── */
  const [session, setSession] = useState<SuperBCSSession | null>(() => getSessionFor(walletAddress))
  const [authError, setAuthError] = useState<string | null>(null)
  const [me, setMe] = useState<MeOut | null>(null)
  const [walletTier, setWalletTier] = useState<Tier | null>(null)  // instant tier from permissions/check

  /* ─── Instant tier from panel permissions/check (no signature needed) ─── */
  /* Mirrors /mefai-panel pattern: read wallet from top-bar auth store, ask */
  /* panel for access level directly. Signature deferred until job submit. */
  useEffect(() => {
    if (!walletAddress) { setWalletTier(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/permissions/check/${walletAddress}`, { cache: 'no-store' })
        if (!res.ok) return
        const body = await res.json() as { access_level?: string }
        if (cancelled) return
        const lvl = (body.access_level || '').toLowerCase()
        const t: Tier = lvl === 'prime' ? 'prime' : lvl === 'pro' ? 'pro' : 'free'
        setWalletTier(t)
      } catch { /* silent */ }
    })()
    return () => { cancelled = true }
  }, [walletAddress])

  useEffect(() => {
    setSession(prev => {
      if (!prev) return getSessionFor(walletAddress)
      if (!walletAddress || prev.wallet.toLowerCase() !== walletAddress) {
        clearSession()
        return null
      }
      return prev
    })
  }, [walletAddress])

  /* On-demand SIWE: mint a session only when needed (Generate click). */
  const ensureSession = useCallback(async (): Promise<SuperBCSSession | null> => {
    if (!walletAddress) { onLoginClick(); return null }
    const existing = getSessionFor(walletAddress)
    if (existing) { setSession(existing); return existing }
    try {
      const s = await signSuperBCS(walletAddress, signMessageAsync)
      setSession(s)
      return s
    } catch (err) {
      const raw = err instanceof SuperBCSAuthError ? err.message : (err as Error).message || ''
      const friendly = friendlyAuthError(raw)
      setAuthError(friendly)
      return null
    }
  }, [walletAddress, onLoginClick, signMessageAsync])

  const refreshMe = useCallback(async () => {
    if (!session) { setMe(null); return }
    try {
      const data = await getMe()
      setMe(data)
    } catch {
      clearSession(); setSession(null); setMe(null)
    }
  }, [session])

  useEffect(() => { refreshMe() }, [refreshMe])

  const tier: Tier = me?.tier ?? walletTier ?? 'free'
  const quotaUsed = me?.quota_used ?? 0
  const quotaLimit = me?.quota_limit ?? (tier === 'prime' ? 50 : tier === 'pro' ? 20 : 3)
  const quotaPct = quotaLimit > 0 ? Math.min(1, quotaUsed / quotaLimit) : 0

  /* ─── Compose state ─── */
  const [promptMode, setPromptMode] = useState<PromptMode>('hybrid')
  const [presetIdx, setPresetIdx] = useState<number>(0)
  const [tokenSym, setTokenSym] = useState('BNB')
  const [tokenSearch, setTokenSearch] = useState('')
  const [searchResults, setSearchResults] = useState<SearchRow[]>([])
  const [customPrompt, setCustomPrompt] = useState('')
  const [imgFile, setImgFile] = useState<File | null>(null)
  const [imgThumb, setImgThumb] = useState<string | null>(null)
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [seed, setSeed] = useState<number | null>(null)

  const dropRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<number | null>(null)

  // Tokens visible for current tier
  const availableTokens = useMemo(() => tokensForTier(tier), [tier])

  // Clamp current token to tier's available list (e.g., if user downgrades)
  useEffect(() => {
    if (!availableTokens.find(t => t.symbol === tokenSym)) {
      // Allow custom/PRIME searched tokens in state (not in availableTokens)
      const inUniverse = TOKENS.find(t => t.symbol === tokenSym)
      if (inUniverse && inUniverse.tier !== 'free' && tier === 'free') {
        setTokenSym('BNB')
      }
    }
  }, [tier, tokenSym, availableTokens])

  /* ─── Prefill from history regenerate ─── */
  useEffect(() => {
    try {
      const qs = new URLSearchParams(window.location.search)
      const p = qs.get('prompt'); const m = qs.get('motion'); const tk = qs.get('token')
      if (m) {
        const i = PRESETS.findIndex(x => x.enum === m)
        if (i >= 0) setPresetIdx(i)
      }
      if (tk) setTokenSym(tk.toUpperCase())
      if (p) { setCustomPrompt(p); setPromptMode('hybrid') }
    } catch { /* ignore */ }
  }, [])

  const composedPrompt = useMemo(() => {
    const preset = PRESETS[presetIdx]
    let base: string
    // Ordering matters: video models over-weight the prompt head, so the
    // preset's core mood always lands first. In Hybrid mode the user's own
    // tweak slots between mood and cinematography detail — landing inside
    // the high-weight zone instead of the low-weight tail.
    if (promptMode === 'quick') {
      base = `${preset.mood} ${MIDDOT} ${preset.detail}`
    } else if (promptMode === 'hybrid') {
      const tweak = customPrompt.trim()
      base = tweak
        ? `${preset.mood} ${MIDDOT} ${tweak} ${MIDDOT} ${preset.detail}`
        : `${preset.mood} ${MIDDOT} ${preset.detail}`
    } else {
      base = customPrompt.trim() || `${preset.mood} ${MIDDOT} ${preset.detail}`
    }
    if (imgFile) base = `${base} ${MIDDOT} ${SUBJECT_LOCK_SUFFIX}`
    // Always append a shared technical/quality suffix tuned for the video model.
    base = `${base} ${MIDDOT} ${QUALITY_SUFFIX}`
    return base
  }, [promptMode, customPrompt, presetIdx, imgFile])

  /* ─── Job state ─── */
  const [phase, setPhase] = useState<Phase>('idle')
  const [job, setJob] = useState<{
    id: string; queuePos: number | null; videoUrls: string[]; error: string | null
  } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const elapsedRef = useRef<number | null>(null)
  const pollRef = useRef<number | null>(null)
  const turnstileRef = useRef<TurnstileHandle>(null)

  /* ─── Token prices via SuperBSC proxy (avoids CoinGecko free-tier IP throttling) ─── */
  const fetchPrices = useCallback(async () => {
    const cgIds = Array.from(new Set(TOKENS.map(t => t.cgId).filter((x): x is string => !!x)))
    if (cgIds.length === 0) return
    try {
      const url = `/superbsc/api/coingecko/simple-price?ids=${cgIds.join(',')}`
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json() as Record<string, { usd?: number }>
      const map: Record<string, number> = {}
      for (const tk of TOKENS) {
        const p = tk.cgId ? data[tk.cgId]?.usd : undefined
        if (typeof p === 'number' && isFinite(p)) map[tk.symbol] = p
      }
      setPrices(prev => ({ ...prev, ...map }))
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    fetchPrices()
    const iv = window.setInterval(fetchPrices, 30000)
    return () => clearInterval(iv)
  }, [fetchPrices])

  /* ─── Token search (PRIME only) ─── */
  const [searchPending, setSearchPending] = useState(false)
  const [searchedOnce, setSearchedOnce] = useState(false)

  const resolveContract = async (addr: string): Promise<SearchRow | null> => {
    const platforms = ['binance-smart-chain', 'ethereum']
    for (const p of platforms) {
      try {
        const res = await fetch(`/superbsc/api/coingecko/contract/${p}/${addr.toLowerCase()}`)
        if (!res.ok) continue
        const body = await res.json() as { id?: string; symbol?: string; name?: string; image?: { thumb?: string }; error?: string }
        if (body.error || !body.id || !body.symbol) continue
        return {
          symbol: body.symbol.toUpperCase().slice(0, 12),
          cgId: body.id,
          color: '#F0B90B',
          thumb: body.image?.thumb || '',
          name: body.name || body.symbol,
        }
      } catch { /* try next platform */ }
    }
    return null
  }

  const searchToken = async (q: string) => {
    const query = q.trim()
    if (!query || query.length < 2) { setSearchResults([]); setSearchedOnce(false); return }
    if (tier !== 'prime') return
    setSearchPending(true)
    try {
      // If it looks like a 0x contract address, resolve via contract endpoint.
      if (/^0x[a-fA-F0-9]{40}$/.test(query)) {
        const row = await resolveContract(query)
        setSearchResults(row ? [row] : [])
        setSearchedOnce(true)
        return
      }
      const res = await fetch(`/superbsc/api/coingecko/search?query=${encodeURIComponent(query)}`)
      if (!res.ok) { setSearchResults([]); setSearchedOnce(true); return }
      const body = await res.json() as { coins?: Array<{ id: string; symbol: string; name: string; thumb: string; market_cap_rank: number | null }> }
      const rows: SearchRow[] = (body.coins || [])
        .filter(c => c.symbol && c.symbol.length <= 12)
        .slice(0, 10)
        .map(c => ({
          symbol: c.symbol.toUpperCase(),
          cgId: c.id,
          color: '#F0B90B',
          thumb: c.thumb,
          name: c.name,
        }))
      setSearchResults(rows)
      setSearchedOnce(true)
    } catch {
      setSearchResults([])
      setSearchedOnce(true)
    } finally {
      setSearchPending(false)
    }
  }

  const pickSearchResult = async (r: SearchRow) => {
    setTokenSym(r.symbol)
    setTokenSearch('')
    setSearchResults([])
    // Fetch its price if not in cache
    if (!prices[r.symbol] && r.cgId) {
      try {
        const res = await fetch(`/superbsc/api/coingecko/simple-price?ids=${r.cgId}`)
        if (res.ok) {
          const body = await res.json() as Record<string, { usd?: number }>
          const p = body[r.cgId]?.usd
          if (typeof p === 'number') setPrices(prev => ({ ...prev, [r.symbol]: p }))
        }
      } catch { /* silent */ }
    }
  }

  /* ─── Image handling ─── */
  const handleFile = (file: File | null | undefined) => {
    if (!file) return
    if (!ALLOWED_TYPES.includes(file.type)) { setAuthError('PNG, JPG, WebP only'); return }
    if (file.size > MAX_FILE_SIZE) { setAuthError('Image larger than 10 MB'); return }
    setImgFile(file)
    setImgThumb(URL.createObjectURL(file))
  }
  const removeImage = () => {
    if (imgThumb) URL.revokeObjectURL(imgThumb)
    setImgFile(null); setImgThumb(null)
  }
  const openFilePicker = () => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'
    inp.onchange = e => handleFile((e.target as HTMLInputElement).files?.[0])
    inp.click()
  }
  useEffect(() => {
    const el = dropRef.current
    if (!el) return
    const prevent = (e: Event) => { e.preventDefault(); e.stopPropagation() }
    const onDrop = (e: DragEvent) => { prevent(e); handleFile(e.dataTransfer?.files?.[0]) }
    el.addEventListener('dragover', prevent)
    el.addEventListener('drop', onDrop as EventListener)
    return () => { el.removeEventListener('dragover', prevent); el.removeEventListener('drop', onDrop as EventListener) }
  }, [])

  /* ─── Generate ─── */
  const isWorking = phase === 'submitting' || phase === 'queued' || phase === 'claimed' || phase === 'running'
  const CUSTOM_MIN_WORDS = 12
  const customWordCount = customPrompt.trim() ? customPrompt.trim().split(/\s+/).length : 0
  const customTooShort = promptMode === 'custom' && customWordCount < CUSTOM_MIN_WORDS
  const canGenerate = !isWorking && composedPrompt.length >= 3 && tokenSym.length >= 2 && !customTooShort
  const generateBlockReason: string | null = isWorking
    ? null
    : composedPrompt.length < 3
      ? 'Pick a preset or write a prompt first.'
      : tokenSym.length < 2
        ? 'Select a token.'
        : customTooShort
          ? `Add more detail · at least ${CUSTOM_MIN_WORDS} words for a coherent render.`
          : !walletAddress
            ? 'Connect your wallet to generate.'
            : null

  const stopPolling = () => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
  }
  const stopElapsed = () => {
    if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null }
  }
  const startElapsed = () => {
    stopElapsed()
    setElapsed(0)
    elapsedRef.current = window.setInterval(() => {
      setElapsed(v => {
        if (v >= 600) { setPhase('error'); setJob(j => j ? { ...j, error: T.timeout } : j); stopElapsed(); return v }
        return v + 1
      })
    }, 1000)
  }

  useEffect(() => () => { stopPolling(); stopElapsed() }, [])

  const pollJob = async (jobId: string, intervalMs: number) => {
    try {
      const data = await getJob(jobId)
      setJob(j => j ? { ...j, videoUrls: data.media_urls, error: data.error_text } : j)
      const next = phaseFromStatus(data.status)
      setPhase(next)
      if (next === 'done') { stopPolling(); stopElapsed(); refreshMe(); return }
      if (next === 'error') { stopPolling(); stopElapsed(); return }
      pollRef.current = window.setTimeout(() => pollJob(jobId, intervalMs), intervalMs)
    } catch {
      pollRef.current = window.setTimeout(() => pollJob(jobId, 5000), 5000)
    }
  }

  const generate = async (opts?: { newSeed?: boolean }) => {
    if (!canGenerate && !opts?.newSeed) return
    // Lazy SIWE: only mint a panel session right before submitting the job.
    // If the user cancels the signature, bail quietly.
    const s = await ensureSession()
    if (!s) return
    stopPolling(); stopElapsed()
    setPhase('submitting')
    setJob(null)
    setAuthError(null)
    const effectiveSeed = opts?.newSeed ? randomSeed() : seed
    if (opts?.newSeed) setSeed(effectiveSeed)
    try {
      // Pull a fresh Turnstile token right before submit. If CF challenges
      // the user interactively, the widget will surface it and resolve once
      // solved. Hard-fail cleanly if we can't get a token within 10s.
      const tsToken = await turnstileRef.current?.getToken()
      if (!tsToken) {
        setPhase('error')
        setJob({ id: '', queuePos: null, videoUrls: [], error: 'Bot check failed to load. Please refresh and try again.' })
        return
      }
      const created = await submitJob({
        prompt: composedPrompt,
        motion_preset: PRESETS[presetIdx].enum,
        token_symbol: tokenSym.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'BNB',
        input_image: imgFile,
        seed: effectiveSeed,
      }, tsToken)
      setJob({
        id: created.job_id,
        queuePos: created.queue_position,
        videoUrls: [],
        error: null,
      })
      setPhase('queued')
      startElapsed()
      pollJob(created.job_id, (created.poll_after_seconds || 3) * 1000)
      refreshMe()
    } catch (err) {
      const msg = (err as Error).message || 'Submission failed'
      const friendly = msg.toLowerCase().includes('quota') ? T.quotaHit : msg
      setPhase('error')
      setJob({ id: '', queuePos: null, videoUrls: [], error: friendly })
    } finally {
      // Turnstile tokens are one-shot — always reset after a submit attempt
      // so the next Generate click gets a freshly-minted token.
      turnstileRef.current?.reset()
    }
  }

  const reset = () => {
    stopPolling(); stopElapsed()
    setPhase('idle'); setJob(null); setElapsed(0)
  }

  /* ─── Render ─── */
  const preset = PRESETS[presetIdx]
  const tokenMeta = TOKENS.find(q => q.symbol === tokenSym)
  const tokenColor = tokenMeta?.color || '#F0B90B'
  const tokenPrice = prices[tokenSym]
  const showSubjectLock = !!imgFile

  return (
    <div className="sbcs-shell">
      {/* ── Header ── */}
      <div className="sbcs-header">
        <Corners size={14} border={2} />
        <div className="sbcs-header-row">
          <div>
            <div className="sbcs-brand">SUPER BCS</div>
            <div className="sbcs-brand-tag">Binance Community Share</div>
            <div className="sbcs-brand-sub">{T.subtitle}</div>
          </div>
          <div className="sbcs-header-status">
            {walletAddress ? (
              <>
                <span className="sbcs-status-dot on" />
                <span>SESSION LIVE</span>
              </>
            ) : (
              <>
                <span className="sbcs-status-dot off" />
                <span>WALLET OFFLINE</span>
                <span className="sbcs-sep">{MIDDOT}</span>
                <button className="sbcs-link-btn" onClick={onLoginClick}>Connect</button>
              </>
            )}
          </div>
        </div>
      </div>

      {authError && <div className="sbcs-err-banner">{authError}</div>}

      {/* ── Studio grid ── */}
      <div className="sbcs-studio">

        {/* LEFT · compose */}
        <aside className="sbcs-compose">

          {/* Credit / tier hero card */}
          <CreditCard
            walletAddress={walletAddress}
            sessionWallet={session?.wallet ?? null}
            tier={tier}
            quotaUsed={quotaUsed}
            quotaLimit={quotaLimit}
            quotaPct={quotaPct}
            onConnect={onLoginClick}
          />

          <section className="sbcs-card sbcs-cornered">
            <Corners />
            <div className="sbcs-label">{T.modeLabel}</div>
            <div className="sbcs-mode-row">
              {(['quick', 'hybrid', 'custom'] as PromptMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setPromptMode(m)}
                  className={`sbcs-mode ${promptMode === m ? 'sbcs-mode-on' : ''}`}
                >
                  <div className="sbcs-mode-name">
                    {m === 'quick' ? T.modeQuick : m === 'hybrid' ? T.modeHybrid : T.modeCustom}
                  </div>
                  <div className="sbcs-mode-desc">
                    {m === 'quick' ? T.modeQuickDesc : m === 'hybrid' ? T.modeHybridDesc : T.modeCustomDesc}
                  </div>
                </button>
              ))}
            </div>
            {promptMode !== 'quick' && (
              <>
                <textarea
                  className="sbcs-textarea"
                  placeholder={T.promptPlaceholder}
                  value={customPrompt}
                  onChange={e => setCustomPrompt(e.target.value)}
                  rows={3}
                  maxLength={500}
                />
                <div className="sbcs-row">
                  <div className="sbcs-hint">
                    {promptMode === 'custom' ? T.customPromptHint : T.promptHint}
                  </div>
                  <div className={`sbcs-counter ${customTooShort ? 'sbcs-counter-warn' : ''}`}>
                    {promptMode === 'custom' && customTooShort
                      ? T.customTooShort(customWordCount, CUSTOM_MIN_WORDS)
                      : `${customPrompt.length} / 500`}
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="sbcs-card sbcs-cornered">
            <Corners />
            <div className="sbcs-label-row">
              <div className="sbcs-label">{T.image}</div>
              {showSubjectLock && <span className="sbcs-lock-pill">SUBJECT LOCKED</span>}
            </div>
            <div
              ref={dropRef}
              className={`sbcs-drop ${imgThumb ? 'sbcs-drop-has' : ''}`}
              onClick={openFilePicker}
            >
              {imgThumb ? (
                <>
                  <img src={imgThumb} alt="" className="sbcs-drop-thumb" />
                  <button
                    className="sbcs-drop-remove"
                    onClick={e => { e.stopPropagation(); removeImage() }}
                  >{T.imageRemove}</button>
                </>
              ) : (
                <>
                  <div className="sbcs-drop-label">{T.imageDrop}</div>
                  <div className="sbcs-drop-hint">{T.imageHint}</div>
                </>
              )}
            </div>
            {showSubjectLock && <div className="sbcs-subject-note">{T.subjectLocked}</div>}
          </section>

          <button
            className="sbcs-generate"
            onClick={() => {
              if (isWorking) return
              if (generateBlockReason) { setAuthError(generateBlockReason); return }
              setAuthError(null)
              generate()
            }}
            disabled={isWorking}
            title={generateBlockReason || ''}
          >
            {phase === 'submitting' ? T.submitting
              : isWorking ? T.generating
              : T.generate}
          </button>
          {!isWorking && generateBlockReason && (
            <div className="sbcs-generate-hint">{generateBlockReason}</div>
          )}
          <Turnstile ref={turnstileRef} />
        </aside>

        {/* CENTER · gallery + stage + prompt */}
        <main className="sbcs-center">

          {/* Token row */}
          <section className="sbcs-card sbcs-cornered">
            <Corners />
            <div className="sbcs-label-row">
              <div className="sbcs-label">{T.token}</div>
              <div className="sbcs-tier-gate">
                {tier === 'free' && <span>FREE {MIDDOT} 8 majors</span>}
                {tier === 'pro' && <span>PRO {MIDDOT} majors + meme universe</span>}
                {tier === 'prime' && <span>PRIME {MIDDOT} any listed token</span>}
              </div>
            </div>

            {tier === 'prime' && (
              <div className="sbcs-token-search-wrap">
                <input
                  className="sbcs-input"
                  placeholder={T.tokenSearchPrime}
                  value={tokenSearch}
                  onChange={e => {
                    setTokenSearch(e.target.value)
                    if (searchTimer.current) clearTimeout(searchTimer.current)
                    searchTimer.current = window.setTimeout(() => searchToken(e.target.value), 280)
                  }}
                />
                {searchResults.length > 0 && tokenSearch && (
                  <div className="sbcs-token-dropdown">
                    {searchResults.map(r => (
                      <button
                        key={r.cgId}
                        className="sbcs-token-dropdown-item"
                        onClick={() => pickSearchResult(r)}
                      >
                        {r.thumb && <img src={r.thumb} alt="" className="sbcs-search-thumb" />}
                        <span className="sbcs-search-sym">{r.symbol}</span>
                        <span className="sbcs-search-name">{r.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {tokenSearch && searchPending && (
                  <div className="sbcs-token-search-hint">
                    {/^0x[a-fA-F0-9]{40}$/.test(tokenSearch.trim()) ? T.tokenSearchResolvingContract : 'Searching…'}
                  </div>
                )}
                {tokenSearch && !searchPending && searchedOnce && searchResults.length === 0 && (
                  <div className="sbcs-token-search-hint sbcs-token-search-empty">
                    {T.tokenSearchNone}
                  </div>
                )}
              </div>
            )}

            {tier !== 'prime' && (
              <div className="sbcs-tier-ghost">{T.tokenSearchFree}</div>
            )}

            <div className="sbcs-token-chips">
              {availableTokens.map(q => {
                const pr = prices[q.symbol]
                return (
                  <button
                    key={q.symbol}
                    className={`sbcs-token-chip ${tokenSym === q.symbol ? 'sbcs-token-chip-on' : ''}`}
                    onClick={() => setTokenSym(q.symbol)}
                    title={pr ? `$${formatPrice(pr)}` : ''}
                  >
                    <span className="sbcs-token-dot" style={{ background: q.color }} />
                    <span>{q.symbol}</span>
                    {pr && <span className="sbcs-token-chip-price">${formatPrice(pr)}</span>}
                  </button>
                )
              })}
              {/* Locked tokens teaser for FREE */}
              {tier === 'free' && TOKENS.filter(t => t.tier === 'pro').slice(0, 4).map(q => (
                <button
                  key={`locked-${q.symbol}`}
                  className="sbcs-token-chip sbcs-token-chip-locked"
                  onClick={() => { /* CTA only */ }}
                  title="Upgrade to PRO"
                  disabled
                >
                  <span className="sbcs-token-dot" style={{ background: '#2E343F' }} />
                  <span>{q.symbol}</span>
                  <span className="sbcs-lock-glyph">PRO</span>
                </button>
              ))}
            </div>
          </section>

          {/* Preset gallery */}
          <section className="sbcs-card sbcs-cornered">
            <Corners />
            <div className="sbcs-label">{T.motion}</div>
            <div className="sbcs-preset-gallery">
              {PRESETS.map((p, i) => (
                <PresetTile
                  key={p.enum}
                  preset={p}
                  active={presetIdx === i}
                  onClick={() => setPresetIdx(i)}
                />
              ))}
            </div>
          </section>

          {/* Stage */}
          <section className="sbcs-stage sbcs-cornered">
            <Corners size={14} border={2} />
            {phase === 'idle' && (
              <div className="sbcs-stage-idle">
                <PresetTile preset={preset} active large onClick={() => { /* noop */ }} />
                <div className="sbcs-stage-meta">
                  <span className="sbcs-stage-tok" style={{ color: tokenColor }}>{tokenSym}</span>
                  {tokenPrice && <span className="mono-mute"> ${formatPrice(tokenPrice)} </span>}
                  <span className="mono-mute">{MIDDOT}</span>
                  <span>3 s</span>
                  <span className="mono-mute">{MIDDOT}</span>
                  <span>832 × 480</span>
                  <span className="mono-mute">{MIDDOT}</span>
                  <span>MP4 / GIF</span>
                </div>
              </div>
            )}

            {(phase === 'submitting' || phase === 'queued' || phase === 'claimed' || phase === 'running') && (
              <div className="sbcs-stage-progress">
                <div className="sbcs-progress-spinner" />
                <div className="sbcs-progress-stage">{statusBlurb(phase)}</div>
                {job?.queuePos != null && phase === 'queued' && (
                  <div className="sbcs-progress-pos">{T.queuePos(job.queuePos)}</div>
                )}
                <div className="sbcs-progress-elapsed">{elapsed}s {T.elapsed}</div>
                <div className="sbcs-progress-stages">
                  <span className={`sbcs-stage-dot ${['queued','claimed','running','done'].includes(phase) ? 'on' : ''}`}>queued</span>
                  <span className={`sbcs-stage-dot ${['claimed','running','done'].includes(phase) ? 'on' : ''}`}>claimed</span>
                  <span className={`sbcs-stage-dot ${['running','done'].includes(phase) ? 'on' : ''}`}>running</span>
                  <span className="sbcs-stage-dot">done</span>
                </div>
              </div>
            )}

            {phase === 'done' && job && (
              <div className="sbcs-result">
                <div className="sbcs-variants">
                  {job.videoUrls.length === 0 && <div className="sbcs-stage-prompt">No media returned</div>}
                  {job.videoUrls.map((url, i) => (
                    <figure key={url} className="sbcs-variant">
                      <video
                        src={url}
                        controls
                        loop
                        muted
                        playsInline
                        autoPlay
                        preload="metadata"
                        onMouseEnter={e => { void (e.currentTarget as HTMLVideoElement).play().catch(() => {}) }}
                        className="sbcs-variant-video"
                      />
                      <figcaption className="sbcs-variant-cap">
                        <span>{tokenSym} clip</span>
                        <a href={url} download className="sbcs-variant-dl">{T.download}</a>
                      </figcaption>
                    </figure>
                  ))}
                </div>
                <div className="sbcs-result-actions">
                  <button className="sbcs-btn-outline" onClick={reset}>{T.regenerate}</button>
                  <button className="sbcs-btn-outline" onClick={() => generate({ newSeed: true })} disabled={isWorking}>
                    {T.regenerateSeed}
                  </button>
                  <a
                    className="sbcs-btn-outline"
                    href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`Just generated a SUPER BCS clip for $${tokenSym} #${tokenSym}`)}&url=${encodeURIComponent(job.videoUrls[0] || '')}`}
                    target="_blank" rel="noopener noreferrer"
                  >{T.share}</a>
                </div>
              </div>
            )}

            {phase === 'error' && (
              <div className="sbcs-stage-error">
                <div className="sbcs-stage-error-bar" />
                <div className="sbcs-stage-error-title">{T.errored}</div>
                <div className="sbcs-stage-error-msg">{job?.error || 'Unknown error'}</div>
                <button className="sbcs-btn-outline" onClick={reset}>{T.regenerate}</button>
              </div>
            )}
          </section>

          {/* Composed prompt preview intentionally hidden · keeps the internal prompt proprietary. */}
        </main>

        {/* RIGHT · side */}
        <aside className="sbcs-side">
          <section className="sbcs-card sbcs-cornered">
            <Corners />
            <div className="sbcs-label">{T.history}</div>
            {walletAddress ? (
              <a className="sbcs-history-link" href="/superbcs-history">{T.fullHistory}</a>
            ) : (
              <>
                <div className="sbcs-hint">{T.connectPrompt}</div>
                <button className="sbcs-history-link" onClick={onLoginClick}>Connect wallet</button>
              </>
            )}
          </section>

          <section className="sbcs-card sbcs-cornered">
            <Corners />
            <div className="sbcs-label">{T.specs}</div>
            <dl className="sbcs-speclist">
              <div><dt>Duration</dt><dd>3 s</dd></div>
              <div><dt>Resolution</dt><dd>832 × 480</dd></div>
              <div><dt>Export</dt><dd>MP4 / GIF</dd></div>
              <div><dt>Model</dt><dd>SDXL + Lightning</dd></div>
              <div><dt>Renderer</dt><dd>RTX 5070 · local</dd></div>
            </dl>
            <div className="sbcs-purpose">
              Fully local AI for creating short social media clips.
              Each render stays on our hardware · no external cloud,
              no extra cost per render. Clips export as MP4 or animated GIF.
              <br /><br />
              <strong>Data policy:</strong> renders are kept for 30 days,
              then permanently deleted. Prompts, wallet address and generated
              media are stored only to deliver the service and are never sold
              or shared with third parties. You can delete any clip at any
              time from History.
            </div>
          </section>

          <section className="sbcs-card sbcs-cornered">
            <Corners />
            <div className="sbcs-label">Tier perks</div>
            <div className="sbcs-perks">
              <div className={`sbcs-perk ${tier === 'free' ? 'active' : ''}`}>
                <div className="sbcs-perk-name" style={{ color: TIER_COLOR.free }}>FREE</div>
                <div className="sbcs-perk-line">1 clip / 24 h</div>
                <div className="sbcs-perk-line">8 major tokens</div>
              </div>
              <div className={`sbcs-perk ${tier === 'pro' ? 'active' : ''}`}>
                <div className="sbcs-perk-name" style={{ color: TIER_COLOR.pro }}>PRO</div>
                <div className="sbcs-perk-line">5 clips / 24 h</div>
                <div className="sbcs-perk-line">+ meme universe</div>
              </div>
              <div className={`sbcs-perk ${tier === 'prime' ? 'active' : ''}`}>
                <div className="sbcs-perk-name" style={{ color: TIER_COLOR.prime }}>PRIME</div>
                <div className="sbcs-perk-line">15 clips / 24 h</div>
                <div className="sbcs-perk-line">any listed token</div>
              </div>
            </div>
          </section>
        </aside>
      </div>

      <style>{CSS}</style>
    </div>
  )
}

/* ═════════════════════ Credit Card ═════════════════════ */

function CreditCard({
  walletAddress, sessionWallet, tier, quotaUsed, quotaLimit, quotaPct, onConnect,
}: {
  walletAddress: string | null
  sessionWallet: string | null
  tier: Tier
  quotaUsed: number
  quotaLimit: number
  quotaPct: number
  onConnect: () => void
}) {
  const R = 38
  const C = 2 * Math.PI * R
  const offset = C - quotaPct * C
  const tierColor = TIER_COLOR[tier]
  const remaining = Math.max(0, quotaLimit - quotaUsed)

  return (
    <section className="sbcs-credit">
      <Corners size={14} border={2} />
      <div className="sbcs-credit-inner">
        <svg width="96" height="96" viewBox="0 0 96 96" className="sbcs-ring">
          <circle cx="48" cy="48" r={R} stroke="rgba(255,255,255,0.06)" strokeWidth="5" fill="none" />
          <circle
            cx="48" cy="48" r={R}
            stroke={tierColor}
            strokeWidth="5"
            fill="none"
            strokeDasharray={C}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 48 48)"
            style={{ transition: 'stroke-dashoffset 600ms ease' }}
          />
          <text x="48" y="44" textAnchor="middle" fontSize="22" fontWeight="700"
            fill="#F5F7FA" fontFamily="'JetBrains Mono', monospace">
            {remaining}
          </text>
          <text x="48" y="62" textAnchor="middle" fontSize="8" fontWeight="600"
            fill="#6B7685" letterSpacing="1.5" fontFamily="'Orbitron', monospace">
            CREDITS
          </text>
        </svg>

        <div className="sbcs-credit-right">
          <div className="sbcs-credit-tier-row">
            <span className="sbcs-credit-tier" style={{ borderColor: tierColor, color: tierColor }}>
              {TIER_LABEL[tier]}
            </span>
            <span className="sbcs-credit-quota">{quotaUsed} / {quotaLimit} today</span>
          </div>

          {walletAddress ? (
            <div className="sbcs-credit-wallet">{shortAddress(sessionWallet || walletAddress)}</div>
          ) : (
            <button className="sbcs-credit-connect" onClick={onConnect}>Connect wallet</button>
          )}

          {tier === 'free' && walletAddress && (
            <a className="sbcs-credit-cta" href="/buy-mefai">
              UNLOCK PRO →
            </a>
          )}
          {tier === 'pro' && walletAddress && (
            <a className="sbcs-credit-cta" href="/buy-mefai">
              UNLOCK PRIME →
            </a>
          )}
        </div>
      </div>
    </section>
  )
}

/* ═════════════════════ Preset Tile ═════════════════════ */

function PresetTile({ preset, active, large, onClick }: {
  preset: Preset
  active: boolean
  large?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`sbcs-ptile ${active ? 'sbcs-ptile-on' : ''} ${large ? 'sbcs-ptile-lg' : ''}`}
      onClick={onClick}
      style={{ '--pc1': preset.color, '--pc2': preset.color2 } as React.CSSProperties}
      title={`${preset.mood} ${MIDDOT} ${preset.detail}`}
    >
      <div className="sbcs-ptile-meta">
        <span className="sbcs-ptile-name">{preset.label}</span>
        <span className="sbcs-ptile-blurb">{preset.blurb}</span>
      </div>
      {active && <span className="sbcs-ptile-check">●</span>}
    </button>
  )
}

/* ═════════════════════ CSS ═════════════════════ */
const CSS = `
.sbcs-shell {
  --bg0: #05080F;
  --bg1: #0A0F1A;
  --bg2: #0F1623;
  --bg3: #141C2E;
  --line: rgba(240,180,11,0.12);
  --line2: rgba(240,180,11,0.22);
  --line3: rgba(255,255,255,0.06);
  --gold: #F0B90B;
  --goldDim: #8B6A08;
  --goldSoft: #F5D061;
  --gold-bg: rgba(240,180,11,0.08);
  --green: #03C087;
  --red: #FF4D63;
  --text: #F5F7FA;
  --text1: #C8D0DC;
  --muted: #6B7685;
  --muted2: #4A5362;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --orb: 'Orbitron', 'JetBrains Mono', ui-monospace, sans-serif;
  --sans: 'Inter', system-ui, -apple-system, Segoe UI, sans-serif;
  display: flex; flex-direction: column;
  width: 100%; min-height: 100%;
  font-family: var(--sans); color: var(--text);
  background: var(--bg0);
}
.mono-mute { color: var(--muted2); }
.sbcs-cornered { position: relative; }

/* ── Header ── */
.sbcs-header {
  position: relative;
  padding: clamp(14px, 2.5vw, 22px) clamp(14px, 3vw, 26px);
  background: radial-gradient(ellipse at top, rgba(240,180,11,0.08), transparent 60%), var(--bg1);
  border-bottom: 1px solid var(--line2);
}
.sbcs-header-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 14px; flex-wrap: wrap;
}
.sbcs-brand {
  font-family: var(--orb);
  font-size: clamp(20px, 3.2vw, 26px);
  letter-spacing: clamp(2.5px, 0.5vw, 3.5px);
  color: var(--gold); font-weight: 800;
}
.sbcs-brand-tag {
  font-family: var(--orb);
  font-size: 10px;
  color: var(--goldSoft);
  margin-top: 6px;
  letter-spacing: 2px;
  text-transform: uppercase;
  font-weight: 600;
}
.sbcs-brand-sub {
  font-size: 11px; color: var(--muted);
  margin-top: 4px; letter-spacing: 0.5px;
}
.sbcs-header-status {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--orb); font-size: 10px;
  letter-spacing: 1.5px; color: var(--text1);
  text-transform: uppercase;
}
.sbcs-status-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--muted2);
}
.sbcs-status-dot.on { background: var(--gold); box-shadow: 0 0 8px var(--gold); animation: sbcs-pulse 2s ease-in-out infinite; }
.sbcs-status-dot.syncing { background: var(--goldSoft); animation: sbcs-pulse 1s ease-in-out infinite; }
.sbcs-status-dot.off { background: var(--red); }
@keyframes sbcs-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.sbcs-sep { color: var(--muted2); }
.sbcs-link-btn {
  background: transparent; color: var(--gold); border: none;
  font-family: inherit; font-size: inherit; letter-spacing: inherit;
  cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}

/* ── Err banner ── */
.sbcs-err-banner {
  margin: 10px 14px 0; padding: 9px 14px;
  background: rgba(255,77,99,0.06); border: 1px solid rgba(255,77,99,0.30);
  color: var(--red); font-size: 11px; font-family: var(--mono);
}

/* ── Studio grid ── */
.sbcs-studio {
  display: grid;
  grid-template-columns: 320px 1fr 260px;
  gap: 12px;
  padding: 12px 14px 16px;
  flex: 1; min-height: 0;
}
.sbcs-compose { display: flex; flex-direction: column; gap: 12px; }
.sbcs-center  { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.sbcs-side    { display: flex; flex-direction: column; gap: 12px; }

.sbcs-card {
  position: relative;
  background: var(--bg1); border: 1px solid var(--line2);
  padding: 14px;
}
.sbcs-label {
  font-family: var(--orb); font-size: 9px; letter-spacing: 1.6px;
  color: var(--muted); text-transform: uppercase; margin-bottom: 10px;
}
.sbcs-label-row { display: flex; justify-content: space-between; align-items: center; }
.sbcs-tier-gate {
  font-family: var(--orb); font-size: 8px; letter-spacing: 1.5px;
  color: var(--muted); text-transform: uppercase; margin-bottom: 10px;
}
.sbcs-lock-pill {
  font-family: var(--orb); font-size: 8px; letter-spacing: 1.5px;
  color: var(--gold); border: 1px solid var(--gold);
  padding: 2px 6px;
  background: var(--gold-bg);
  margin-bottom: 10px;
}
.sbcs-hint { color: var(--muted); font-size: 11px; line-height: 1.5; }
.sbcs-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-top: 6px; }
.sbcs-counter { font-family: var(--mono); font-size: 10px; color: var(--muted2); white-space: nowrap; }
.sbcs-counter-warn { color: var(--gold); white-space: normal; text-align: right; max-width: 55%; line-height: 1.4; }

/* ── Credit card ── */
.sbcs-credit {
  position: relative;
  background: linear-gradient(135deg, var(--bg2), var(--bg1));
  border: 1px solid var(--line2);
  padding: 18px;
}
.sbcs-credit::before {
  content: ''; position: absolute; inset: 0;
  background: radial-gradient(circle at 20% 30%, rgba(240,180,11,0.10), transparent 55%);
  pointer-events: none;
}
.sbcs-credit-inner { display: flex; align-items: center; gap: 16px; position: relative; }
.sbcs-ring { flex-shrink: 0; filter: drop-shadow(0 0 10px rgba(240,180,11,0.25)); }
.sbcs-credit-right { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
.sbcs-credit-tier-row { display: flex; align-items: center; gap: 8px; }
.sbcs-credit-tier {
  font-family: var(--orb); font-size: 10px; font-weight: 700;
  letter-spacing: 2px;
  border: 1px solid; padding: 3px 8px;
}
.sbcs-credit-quota {
  font-family: var(--mono); font-size: 10px; color: var(--muted);
}
.sbcs-credit-wallet {
  font-family: var(--mono); font-size: 11px; color: var(--text1);
  letter-spacing: 0.4px;
}
.sbcs-credit-connect {
  background: var(--gold); color: var(--bg0); border: none;
  padding: 6px 12px; margin-top: 2px;
  font-family: var(--orb); font-size: 10px; font-weight: 700;
  letter-spacing: 1.5px; text-transform: uppercase; cursor: pointer;
  width: fit-content;
}
.sbcs-credit-cta {
  display: inline-block; text-decoration: none;
  font-family: var(--orb); font-size: 10px; font-weight: 700;
  letter-spacing: 2px; color: var(--gold);
  border: 1px solid var(--gold);
  padding: 6px 10px; margin-top: 6px;
  width: fit-content;
  transition: 140ms;
}
.sbcs-credit-cta:hover { background: var(--gold); color: var(--bg0); }

/* ── Mode row ── */
.sbcs-mode-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; }
.sbcs-mode {
  background: var(--bg2); border: 1px solid var(--line3);
  padding: 8px 6px;
  cursor: pointer; transition: 120ms;
  text-align: center;
}
.sbcs-mode:hover { border-color: var(--line2); }
.sbcs-mode-on { border-color: var(--gold); background: var(--gold-bg); }
.sbcs-mode-name { font-family: var(--orb); font-size: 10px; font-weight: 700; color: var(--text); letter-spacing: 0.6px; }
.sbcs-mode-desc { font-size: 9px; color: var(--muted); margin-top: 3px; line-height: 1.3; }

.sbcs-textarea {
  width: 100%; margin-top: 8px;
  background: var(--bg0); border: 1px solid var(--line3);
  padding: 9px 11px;
  font-family: var(--mono); font-size: 11px; color: var(--text);
  resize: vertical; min-height: 66px; outline: none; line-height: 1.55;
}
.sbcs-textarea:focus { border-color: var(--gold); }

/* ── Preset gallery ── */
.sbcs-preset-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 8px;
}
.sbcs-ptile {
  position: relative;
  background: var(--bg0);
  border: 1px solid var(--line3);
  padding: 0; cursor: pointer;
  display: flex; flex-direction: column;
  overflow: hidden; transition: 140ms;
  text-align: left; font-family: inherit; color: inherit;
}
.sbcs-ptile:hover { border-color: var(--line2); transform: translateY(-1px); }
.sbcs-ptile-on { border-color: var(--pc1); box-shadow: 0 0 0 1px var(--pc1), 0 6px 22px rgba(0,0,0,0.5); }
.sbcs-ptile-canvas {
  position: relative; width: 100%;
  aspect-ratio: 16 / 9;
  background: linear-gradient(135deg, var(--pc2), #000);
  overflow: hidden;
}
.sbcs-ptile-fx {
  position: absolute; inset: -20%;
  background: radial-gradient(circle at 30% 70%, var(--pc1), transparent 50%);
  opacity: 0.75;
}
.sbcs-ptile-fx2 {
  background: radial-gradient(circle at 70% 30%, var(--pc1), transparent 55%);
  opacity: 0.55;
  mix-blend-mode: screen;
}
.sbcs-ptile-meta {
  padding: 8px 10px;
  display: flex; flex-direction: column; gap: 2px;
  background: var(--bg1);
  border-top: 1px solid var(--line3);
}
.sbcs-ptile-name {
  font-family: var(--orb); font-size: 10px; font-weight: 700;
  letter-spacing: 1.2px; color: var(--text);
}
.sbcs-ptile-blurb {
  font-size: 9px; color: var(--muted); letter-spacing: 0.3px;
}
.sbcs-ptile-check {
  position: absolute; top: 6px; right: 8px;
  color: var(--pc1); font-size: 14px;
  text-shadow: 0 0 6px var(--pc1);
}

/* preset tile large variant (inside stage idle) */
.sbcs-ptile-lg { pointer-events: none; }
.sbcs-ptile-lg .sbcs-ptile-canvas { aspect-ratio: 21 / 9; }
.sbcs-ptile-lg .sbcs-ptile-name { font-size: 16px; letter-spacing: 2px; }
.sbcs-ptile-lg .sbcs-ptile-blurb { font-size: 11px; }

/* preset animations · signature motion per enum */
.sbcs-anim-rise .sbcs-ptile-fx { animation: pm-rise 3.2s ease-in-out infinite; }
.sbcs-anim-rise .sbcs-ptile-fx2 { animation: pm-rise 3.2s ease-in-out infinite reverse; }
@keyframes pm-rise { 0%,100% { transform: translateY(20%); } 50% { transform: translateY(-15%); } }

.sbcs-anim-fall .sbcs-ptile-fx { animation: pm-fall 2.8s ease-in infinite; }
.sbcs-anim-fall .sbcs-ptile-fx2 { animation: pm-fall 2.8s ease-in infinite reverse; }
@keyframes pm-fall { 0% { transform: translateY(-30%); } 100% { transform: translateY(30%); } }

.sbcs-anim-gallop .sbcs-ptile-fx { animation: pm-slide 2.0s linear infinite; }
.sbcs-anim-gallop .sbcs-ptile-fx2 { animation: pm-slide 1.4s linear infinite reverse; }
@keyframes pm-slide { 0% { transform: translateX(-40%); } 100% { transform: translateX(40%); } }

.sbcs-anim-freeze .sbcs-ptile-fx { animation: pm-freeze 5s ease-in-out infinite; }
.sbcs-anim-freeze .sbcs-ptile-fx2 { animation: pm-freeze 5s ease-in-out infinite reverse; filter: hue-rotate(60deg); }
@keyframes pm-freeze { 0%,100% { opacity: 0.3; transform: scale(1.0); } 50% { opacity: 0.8; transform: scale(1.12); } }

.sbcs-anim-vortex .sbcs-ptile-fx { animation: pm-vortex 3.5s linear infinite; transform-origin: center; }
.sbcs-anim-vortex .sbcs-ptile-fx2 { animation: pm-vortex 2.5s linear infinite reverse; transform-origin: center; }
@keyframes pm-vortex { 0%,100% { transform: scale(1); opacity: 0.6; } 50% { transform: scale(0.55); opacity: 1; } }

.sbcs-anim-crystal .sbcs-ptile-fx { animation: pm-shimmer 2.5s ease-in-out infinite; }
.sbcs-anim-crystal .sbcs-ptile-fx2 { animation: pm-shimmer 2.5s ease-in-out infinite reverse; filter: hue-rotate(180deg); }
@keyframes pm-shimmer { 0%,100% { opacity: 0.4; filter: hue-rotate(0deg); } 50% { opacity: 1; filter: hue-rotate(45deg); } }

.sbcs-anim-float .sbcs-ptile-fx { animation: pm-float 5s ease-in-out infinite; }
.sbcs-anim-float .sbcs-ptile-fx2 { animation: pm-float 5s ease-in-out infinite reverse; }
@keyframes pm-float { 0%,100% { transform: translateY(10%) translateX(-5%); } 50% { transform: translateY(-10%) translateX(5%); } }

.sbcs-anim-wave .sbcs-ptile-fx { animation: pm-wave 3s ease-out infinite; transform-origin: center; }
.sbcs-anim-wave .sbcs-ptile-fx2 { animation: pm-wave 3s ease-out infinite 1.5s; transform-origin: center; }
@keyframes pm-wave { 0% { transform: scale(0.6); opacity: 1; } 100% { transform: scale(1.8); opacity: 0; } }

.sbcs-anim-pulse .sbcs-ptile-fx { animation: pm-pulse 1.1s ease-in-out infinite; }
.sbcs-anim-pulse .sbcs-ptile-fx2 { animation: pm-pulse 1.1s ease-in-out infinite 0.55s; }
@keyframes pm-pulse { 0%,100% { opacity: 0.3; transform: scale(0.95); } 50% { opacity: 1; transform: scale(1.08); } }

.sbcs-anim-shatter .sbcs-ptile-fx { animation: pm-shatter 2s ease-in-out infinite; }
.sbcs-anim-shatter .sbcs-ptile-fx2 { animation: pm-shatter 2s ease-in-out infinite reverse; }
@keyframes pm-shatter { 0%,100% { transform: scale(1); } 45% { transform: scale(1.12) translate(2%, 2%); } 50% { transform: scale(0.9) translate(-2%, -2%); } 55% { transform: scale(1.08); } }

.sbcs-anim-steady .sbcs-ptile-fx { animation: pm-steady 6s ease-in-out infinite; }
.sbcs-anim-steady .sbcs-ptile-fx2 { animation: pm-steady 6s ease-in-out infinite reverse; }
@keyframes pm-steady { 0%,100% { opacity: 0.5; } 50% { opacity: 0.85; } }

.sbcs-anim-launch .sbcs-ptile-fx { animation: pm-launch 2.5s cubic-bezier(.4,0,.2,1) infinite; }
.sbcs-anim-launch .sbcs-ptile-fx2 { animation: pm-launch 2.5s cubic-bezier(.4,0,.2,1) infinite 0.5s; }
@keyframes pm-launch { 0% { transform: translateY(40%); opacity: 0.5; } 60% { transform: translateY(-30%); opacity: 1; } 100% { transform: translateY(-60%); opacity: 0; } }

.sbcs-anim-confetti .sbcs-ptile-fx { animation: pm-confetti 1.8s ease-in-out infinite; }
.sbcs-anim-confetti .sbcs-ptile-fx2 { animation: pm-confetti 1.8s ease-in-out infinite 0.6s; filter: hue-rotate(90deg); }
@keyframes pm-confetti { 0%,100% { transform: scale(0.82) translateY(6%); opacity: 0.6; } 50% { transform: scale(1.15) translateY(-6%); opacity: 1; } }

.sbcs-anim-flame .sbcs-ptile-fx { animation: pm-flame 1.3s ease-in-out infinite; }
.sbcs-anim-flame .sbcs-ptile-fx2 { animation: pm-flame 1.1s ease-in-out infinite reverse; }
@keyframes pm-flame { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-15%) scale(1.15); } }

.sbcs-anim-network .sbcs-ptile-fx { animation: pm-net 4s linear infinite; }
.sbcs-anim-network .sbcs-ptile-fx2 { animation: pm-net 4s linear infinite reverse; }
@keyframes pm-net { 0%,100% { transform: translateX(-4%) scale(1); opacity: 0.55; } 50% { transform: translateX(4%) scale(1.1); opacity: 1; } }

.sbcs-anim-cross .sbcs-ptile-fx { animation: pm-cross 3s ease-in-out infinite; }
.sbcs-anim-cross .sbcs-ptile-fx2 { animation: pm-cross 3s ease-in-out infinite reverse; }
@keyframes pm-cross { 0%,100% { transform: scale(0.94); opacity: 0.55; } 50% { transform: scale(1.12); opacity: 1; } }

/* ── Tier ghost line ── */
.sbcs-tier-ghost {
  font-family: var(--mono); font-size: 11px; color: var(--muted);
  padding: 10px; text-align: center;
  background: var(--bg0); border: 1px dashed var(--line3);
  margin-bottom: 10px;
}

/* ── Token ── */
.sbcs-token-search-wrap { position: relative; margin-bottom: 10px; }
.sbcs-input {
  width: 100%;
  background: var(--bg0); border: 1px solid var(--line3);
  padding: 8px 11px;
  font-family: var(--mono); font-size: 11px; color: var(--text);
  outline: none;
}
.sbcs-input:focus { border-color: var(--gold); }
.sbcs-token-dropdown {
  position: absolute; top: calc(100% + 2px); left: 0; right: 0;
  background: var(--bg1); border: 1px solid var(--line2);
  z-index: 20;
  max-height: 260px; overflow-y: auto;
  box-shadow: 0 8px 24px rgba(0,0,0,0.6);
}
.sbcs-token-dropdown-item {
  display: flex; align-items: center; gap: 10px;
  width: 100%; padding: 8px 12px;
  background: transparent; border: none; color: var(--text);
  font-family: var(--mono); font-size: 11px; cursor: pointer;
  border-bottom: 1px solid var(--line3);
  text-align: left;
}
.sbcs-token-dropdown-item:last-child { border-bottom: none; }
.sbcs-token-dropdown-item:hover { background: var(--bg2); }
.sbcs-search-thumb { width: 16px; height: 16px; border-radius: 50%; }
.sbcs-search-sym { font-weight: 700; color: var(--text); letter-spacing: 0.5px; }
.sbcs-search-name { color: var(--muted); font-size: 10px; }
.sbcs-token-search-hint {
  margin-top: 6px; padding: 8px 11px;
  font-family: var(--mono); font-size: 10.5px;
  color: var(--muted); border: 1px dashed var(--line3); background: var(--bg0);
}
.sbcs-token-search-empty { color: var(--gold); border-color: rgba(240,180,11,0.35); }

.sbcs-token-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.sbcs-token-chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bg2); border: 1px solid var(--line3);
  padding: 5px 10px;
  font-family: var(--mono); font-size: 10px; color: var(--text1);
  cursor: pointer;
  transition: 120ms;
}
.sbcs-token-chip:hover { border-color: var(--line2); color: var(--text); }
.sbcs-token-chip-on { border-color: var(--gold); background: var(--gold-bg); color: var(--text); }
.sbcs-token-chip-price { color: var(--muted); font-size: 9px; margin-left: 2px; }
.sbcs-token-chip-on .sbcs-token-chip-price { color: var(--goldSoft); }
.sbcs-token-chip-locked { opacity: 0.55; cursor: not-allowed; }
.sbcs-token-chip-locked:hover { border-color: var(--line3); }
.sbcs-lock-glyph {
  font-family: var(--orb); font-size: 8px; letter-spacing: 1px;
  color: var(--goldDim); border: 1px solid var(--goldDim);
  padding: 1px 4px;
}
.sbcs-token-dot { width: 7px; height: 7px; border-radius: 50%; }

/* ── Drop zone ── */
.sbcs-drop {
  min-height: 90px;
  background: var(--bg0); border: 1px dashed var(--line3);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; cursor: pointer; transition: 140ms;
  position: relative; overflow: hidden;
  padding: 8px;
}
.sbcs-drop:hover { border-color: var(--gold); background: var(--gold-bg); }
.sbcs-drop-has { padding: 0; border-style: solid; border-color: var(--gold); }
.sbcs-drop-thumb { max-height: 150px; width: 100%; object-fit: cover; display: block; }
.sbcs-drop-remove {
  position: absolute; top: 6px; right: 6px;
  background: rgba(0,0,0,0.8); color: var(--text);
  border: 1px solid var(--line2);
  padding: 3px 8px; font-family: var(--orb); font-size: 9px; letter-spacing: 1px;
  cursor: pointer;
}
.sbcs-drop-label { font-family: var(--mono); font-size: 11px; color: var(--text1); }
.sbcs-drop-hint { font-size: 9px; color: var(--muted); text-align: center; line-height: 1.4; }
.sbcs-subject-note {
  margin-top: 8px; padding: 7px 9px;
  background: var(--gold-bg); border: 1px solid var(--line2);
  font-family: var(--mono); font-size: 10px; color: var(--text1); line-height: 1.45;
}

/* ── Generate ── */
.sbcs-generate {
  width: 100%;
  background: var(--gold);
  color: var(--bg0); border: none;
  padding: 14px; font-family: var(--orb); font-weight: 700; font-size: 11px;
  letter-spacing: 2.5px;
  cursor: pointer; transition: 120ms;
  text-transform: uppercase;
}
.sbcs-generate:hover:not(:disabled) { filter: brightness(1.08); box-shadow: 0 6px 24px rgba(240,180,11,0.35); }
.sbcs-generate:disabled { opacity: 0.35; cursor: not-allowed; filter: grayscale(0.5); }
.sbcs-generate-hint {
  margin-top: 6px; padding: 6px 10px;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.3px;
  color: var(--gold); border: 1px dashed rgba(240,180,11,0.35); background: rgba(240,180,11,0.06);
}

/* ── Stage ── */
.sbcs-stage {
  background: var(--bg1); border: 1px solid var(--line2);
  min-height: 320px;
  display: flex; align-items: center; justify-content: center;
  padding: 28px;
  position: relative; overflow: hidden;
}
.sbcs-stage::before {
  content: ''; position: absolute; inset: 0;
  background: radial-gradient(ellipse at 50% 35%, rgba(240,180,11,0.06), transparent 60%);
  pointer-events: none;
}
.sbcs-stage-idle {
  width: 100%; max-width: 680px;
  display: flex; flex-direction: column; gap: 16px; align-items: center;
  position: relative;
}
.sbcs-stage-idle .sbcs-ptile { width: 100%; border-width: 2px; }
.sbcs-stage-meta {
  display: flex; align-items: center; gap: 10px;
  font-family: var(--mono); font-size: 11px; color: var(--text1);
  letter-spacing: 0.4px; text-transform: uppercase;
  flex-wrap: wrap; justify-content: center;
}
.sbcs-stage-tok { font-weight: 700; letter-spacing: 1px; }

.sbcs-stage-progress { text-align: center; position: relative; }
.sbcs-progress-spinner {
  width: 44px; height: 44px; margin: 0 auto 16px;
  border: 2px solid var(--line3);
  border-top-color: var(--gold);
  border-radius: 50%;
  animation: sbcs-spin 0.9s linear infinite;
}
@keyframes sbcs-spin { to { transform: rotate(360deg); } }
.sbcs-progress-stage { font-family: var(--orb); font-weight: 700; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; }
.sbcs-progress-pos { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 6px; }
.sbcs-progress-elapsed { font-family: var(--mono); font-size: 10px; color: var(--muted2); margin-top: 4px; }
.sbcs-progress-stages {
  display: flex; justify-content: center; gap: 14px;
  margin-top: 20px;
  font-family: var(--orb); font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase;
}
.sbcs-stage-dot { color: var(--muted2); position: relative; padding-left: 10px; }
.sbcs-stage-dot::before {
  content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  width: 5px; height: 5px; border-radius: 50%; background: var(--muted2);
}
.sbcs-stage-dot.on { color: var(--gold); }
.sbcs-stage-dot.on::before { background: var(--gold); box-shadow: 0 0 8px var(--gold); }

.sbcs-result { width: 100%; display: flex; flex-direction: column; gap: 12px; position: relative; }
.sbcs-variants {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
}
.sbcs-variant {
  background: var(--bg0); border: 1px solid var(--line3);
  overflow: hidden; margin: 0;
}
.sbcs-variant-video { width: 100%; display: block; background: #000; aspect-ratio: 16/9; object-fit: cover; }
.sbcs-variant-cap {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 10px;
  font-family: var(--orb); font-size: 10px; color: var(--muted); letter-spacing: 1.5px;
  text-transform: uppercase;
}
.sbcs-variant-dl {
  color: var(--gold); text-decoration: none;
  border: 1px solid var(--line2);
  padding: 3px 7px;
}
.sbcs-variant-dl:hover { border-color: var(--gold); }

.sbcs-result-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.sbcs-btn-outline {
  background: transparent; color: var(--text);
  border: 1px solid var(--line2);
  padding: 8px 14px; font-family: var(--orb); font-size: 10px; letter-spacing: 1.5px;
  cursor: pointer; text-decoration: none; display: inline-block; text-transform: uppercase;
}
.sbcs-btn-outline:hover:not(:disabled) { border-color: var(--gold); color: var(--gold); }
.sbcs-btn-outline:disabled { opacity: 0.4; cursor: not-allowed; }

.sbcs-stage-error { text-align: center; position: relative; }
.sbcs-stage-error-bar {
  width: 64px; height: 3px;
  margin: 0 auto 18px;
  background: var(--red); box-shadow: 0 0 16px var(--red);
}
.sbcs-stage-error-title { font-family: var(--orb); font-weight: 700; font-size: 14px; letter-spacing: 2px; color: var(--red); margin-bottom: 6px; text-transform: uppercase; }
.sbcs-stage-error-msg { color: var(--muted); font-size: 12px; margin-bottom: 16px; max-width: 380px; margin-left: auto; margin-right: auto; }

/* ── Composed prompt ── */
.sbcs-prompt-preview {
  position: relative;
  background: var(--bg1); border: 1px solid var(--line2);
  padding: 12px 14px;
}
.sbcs-pp-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.sbcs-pp-head .sbcs-label { margin-bottom: 0; }
.sbcs-pp-len { font-family: var(--mono); font-size: 9px; color: var(--muted2); letter-spacing: 0.5px; }
.sbcs-pp-body {
  font-family: var(--mono); font-size: 11px; color: var(--text);
  line-height: 1.65; margin: 0;
  white-space: pre-wrap; word-break: break-word;
  background: var(--bg0);
  padding: 10px 12px;
  border: 1px solid var(--line3);
  max-height: 180px; overflow-y: auto;
}

/* ── Side ── */
.sbcs-history-link {
  display: inline-block;
  color: var(--gold); text-decoration: none;
  font-family: var(--orb); font-size: 10px; letter-spacing: 1.5px;
  padding: 8px 10px; margin-top: 8px;
  border: 1px solid var(--line2);
  text-align: center; text-transform: uppercase;
  background: transparent; cursor: pointer; width: 100%;
}
.sbcs-history-link:hover { border-color: var(--gold); background: var(--gold-bg); }

.sbcs-speclist { margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.sbcs-speclist > div { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; }
.sbcs-speclist dt { color: var(--muted); letter-spacing: 0.5px; }
.sbcs-speclist dd { margin: 0; color: var(--text1); }
.sbcs-purpose {
  margin-top: 12px; padding-top: 10px;
  border-top: 1px solid var(--line2);
  font-family: var(--mono); font-size: 10px; line-height: 1.55;
  color: var(--muted); letter-spacing: 0.2px;
}

.sbcs-perks { display: flex; flex-direction: column; gap: 8px; }
.sbcs-perk {
  padding: 8px 10px;
  background: var(--bg2);
  border: 1px solid var(--line3);
  transition: 140ms;
}
.sbcs-perk.active { border-color: var(--line2); background: var(--gold-bg); }
.sbcs-perk-name { font-family: var(--orb); font-size: 10px; font-weight: 700; letter-spacing: 2px; margin-bottom: 4px; }
.sbcs-perk-line { font-family: var(--mono); font-size: 10px; color: var(--text1); line-height: 1.45; }

/* ── Responsive ── */
@media (max-width: 1320px) {
  .sbcs-studio { grid-template-columns: 300px 1fr; }
  .sbcs-side { display: none; }
}
@media (max-width: 900px) {
  .sbcs-studio { grid-template-columns: 1fr; padding: 10px; gap: 10px; }
  .sbcs-variants { grid-template-columns: 1fr; }
}
`
