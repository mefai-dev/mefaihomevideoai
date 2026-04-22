/**
 * SUPER BCS API client (typed thin wrapper around fetch).
 */
import { authHeaders } from './auth'

const API_BASE = (import.meta.env.VITE_SUPERBCS_API_BASE as string | undefined) || 'https://api.example.com'
export const SUPERBCS_API = `${API_BASE}/api/superbcs`

export type JobStatus = 'queued' | 'claimed' | 'running' | 'done' | 'error' | 'cancelled'
export type Tier = 'free' | 'pro' | 'prime'

export interface JobCreated {
  job_id: string
  status: 'queued'
  queue_position: number
  poll_after_seconds: number
  tier: Tier | null
  quota_used: number | null
  quota_limit: number | null
}

export interface JobStatusOut {
  job_id: string
  status: JobStatus
  media_url: string | null
  media_id: string | null
  media_urls: string[]
  error_text: string | null
  duration_ms: number | null
  created_at: string
  completed_at: string | null
}

export interface HistoryItem {
  job_id: string
  status: JobStatus
  prompt_text: string
  motion_preset: string
  token_symbol: string
  media_url: string | null
  media_urls: string[]
  duration_ms: number | null
  created_at: string
  completed_at: string | null
}

export interface HistoryOut {
  items: HistoryItem[]
  next_cursor: string | null
  quota_used: number
  quota_limit: number
  tier: Tier
}

export interface MeOut {
  wallet: string
  tier: Tier
  source: string
  quota_used: number
  quota_limit: number
}

export interface SubmitJobInput {
  prompt: string
  motion_preset: string
  token_symbol: string
  input_image?: File | null
  duration_sec?: number
  num_variants?: number
  seed?: number | null
}

async function asJsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json() as { error?: string; detail?: string }
      msg = body.error || body.detail || msg
    } catch { /* ignore parse */ }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export async function submitJob(input: SubmitJobInput, turnstileToken: string): Promise<JobCreated> {
  const fd = new FormData()
  fd.append('prompt', input.prompt)
  fd.append('motion_preset', input.motion_preset)
  fd.append('token_symbol', input.token_symbol)
  fd.append('turnstile_token', turnstileToken)
  if (input.duration_sec) fd.append('duration_sec', String(input.duration_sec))
  if (input.num_variants) fd.append('num_variants', String(input.num_variants))
  if (input.seed != null) fd.append('seed', String(input.seed))
  if (input.input_image) fd.append('input_image', input.input_image, input.input_image.name)

  const res = await fetch(`${SUPERBCS_API}/jobs`, {
    method: 'POST',
    headers: authHeaders(),
    body: fd,
  })
  return asJsonOrThrow<JobCreated>(res)
}

export async function getJob(jobId: string): Promise<JobStatusOut> {
  // Send Authorization when available: IDOR guard on the API returns 404
  // for wallet-owned jobs unless the caller's Bearer matches job owner.
  const res = await fetch(`${SUPERBCS_API}/jobs/${jobId}`, { headers: authHeaders() })
  return asJsonOrThrow<JobStatusOut>(res)
}

export async function deleteJob(jobId: string): Promise<void> {
  const res = await fetch(`${SUPERBCS_API}/jobs/${jobId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok && res.status !== 204) {
    throw new Error(`HTTP ${res.status}`)
  }
}

export async function getHistory(limit = 24, before?: string): Promise<HistoryOut> {
  const url = new URL(`${SUPERBCS_API}/history`)
  url.searchParams.set('limit', String(limit))
  if (before) url.searchParams.set('before', before)
  const res = await fetch(url.toString(), { headers: authHeaders() })
  return asJsonOrThrow<HistoryOut>(res)
}

export async function getMe(): Promise<MeOut> {
  const res = await fetch(`${SUPERBCS_API}/me`, { headers: authHeaders() })
  return asJsonOrThrow<MeOut>(res)
}
