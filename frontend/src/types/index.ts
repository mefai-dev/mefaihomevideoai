export interface Tab {
  id: string
  title: string
  path: string
  icon: string
  closeable: boolean
  pinned?: boolean
}

export interface User {
  id: string
  email: string
  name: string
  avatar?: string
}

export interface TickerItem {
  symbol: string
  price: number
  change: number
  prevPrice: number
}

export interface ProjectCard {
  id: string
  title: string
  description: string
  status: 'live' | 'beta'
  path: string
}

export interface NavItem {
  id: string
  label: string
  path: string
  active?: boolean
}

export interface NavSection {
  id: string
  label: string
  count: number
  items: NavItem[]
  expanded: boolean
}

export interface WalletUser {
  id: string
  walletAddress: string
  chainType: 'bsc' | 'sol'
  connectedAt: string
  username?: string | null
  avatar?: string | null
  slogan?: string | null
  socialLink?: string | null
  gameBalance?: string
  referralCode?: string
  clanId?: string | null
  isAdmin?: boolean
}

export interface AuditRequest {
  id: string
  walletAddress: string
  chainType: 'bsc' | 'sol'
  burnTxId: string
  burnVerified: boolean
  burnAmount: number
  projectWebsite: string
  projectGithub?: string
  findings?: string
  status: 'pending' | 'reviewing' | 'published' | 'rejected'
  adminFindings?: string
  submittedAt: string
  publishedAt?: string
}

export interface AuditReport {
  id: string
  auditRequestId?: string
  projectName: string
  projectWebsite: string
  summary: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  findings: string
  publishedAt: string
}

export interface CAAnalysis {
  contractAddress: string
  chain: 'bsc' | 'sol'
  isHoneypot: boolean
  isMintable: boolean
  ownershipRenounced: boolean
  buyTax: number
  sellTax: number
  lpLocked: boolean
  holderCount: number
  topHolderPercent: number
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  analyzedAt: string
}
