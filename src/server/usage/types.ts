import type { ChatUsageSnapshot } from "../../shared/types"

export interface NumericUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
}

export interface ClaudeRateLimitInfo {
  percent: number | null
  resetsAt: number | null
}

export interface CursorSessionCookie {
  name: string
  value: string
  domain: string
  path: string
  expiresAt: number | null
  secure: boolean
  httpOnly: boolean
}

export interface CursorSessionCache {
  cookies: CursorSessionCookie[]
  updatedAt: number
  lastSuccessAt: number | null
}

export interface CursorUsagePayload {
  sessionLimitUsedPercent: number | null
  apiPercentUsed: number | null
  rateLimitResetAt: number | null
  rateLimitResetLabel: string | null
}

export interface CursorCurlImportResult {
  cookies: CursorSessionCookie[]
}

export interface ClaudeRateLimitCacheSnapshot extends ChatUsageSnapshot {
  rateLimitResetLabel?: string | null
  weeklyLimitUsedPercent?: number | null
  weeklyRateLimitResetAt?: number | null
  weeklyRateLimitResetLabel?: string | null
}

export interface ProviderRateLimitSnapshot extends ChatUsageSnapshot {
  rateLimitResetLabel?: string | null
  weeklyLimitUsedPercent?: number | null
  weeklyRateLimitResetAt?: number | null
  weeklyRateLimitResetLabel?: string | null
}
