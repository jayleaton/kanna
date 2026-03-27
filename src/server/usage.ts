import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { createDecipheriv, pbkdf2Sync } from "node:crypto"
import puppeteer from "puppeteer-core"
import type {
  AgentProvider,
  ChatUsageSnapshot,
  ChatUsageWarning,
  ProviderUsageAvailability,
  ProviderUsageEntry,
  ProviderUsageMap,
  TranscriptEntry,
} from "../shared/types"
import type { EventStore } from "./event-store"
import { canOpenMacApp, resolveCommandPath } from "./process-utils"

const WARNING_THRESHOLD = 75
const CRITICAL_THRESHOLD = 90
const STALE_AFTER_MS = 5 * 60 * 1000

interface NumericUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
}

interface ClaudeRateLimitInfo {
  percent: number | null
  resetsAt: number | null
}

interface CursorSessionCookie {
  name: string
  value: string
  domain: string
  path: string
  expiresAt: number | null
  secure: boolean
  httpOnly: boolean
}

interface CursorSessionCache {
  cookies: CursorSessionCookie[]
  updatedAt: number
  lastSuccessAt: number | null
}

interface CursorUsagePayload {
  sessionLimitUsedPercent: number | null
  apiPercentUsed: number | null
  rateLimitResetAt: number | null
  rateLimitResetLabel: string | null
}

interface CursorCurlImportResult {
  cookies: CursorSessionCookie[]
}

const CLAUDE_CONTEXT_WINDOW_FALLBACKS: Record<string, number> = {
  sonnet: 200_000,
  opus: 200_000,
  haiku: 200_000,
}

const CHROME_EPOCH_OFFSET_MS = Date.UTC(1601, 0, 1)
const CURSOR_SESSION_COOKIE_NAME = "WorkosCursorSessionToken"
const CURSOR_DASHBOARD_URL = "https://cursor.com/dashboard/spending"
const CURSOR_USAGE_URL = "https://cursor.com/api/dashboard/get-current-period-usage"
const CURSOR_BROWSER_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return null
  }
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function toPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

function usageWarnings(args: {
  contextUsedPercent: number | null
  sessionLimitUsedPercent: number | null
  updatedAt: number | null
}): ChatUsageWarning[] {
  const warnings: ChatUsageWarning[] = []

  if (args.contextUsedPercent !== null) {
    if (args.contextUsedPercent >= CRITICAL_THRESHOLD) {
      warnings.push("context_critical")
    } else if (args.contextUsedPercent >= WARNING_THRESHOLD) {
      warnings.push("context_warning")
    }
  }

  if (args.sessionLimitUsedPercent !== null) {
    if (args.sessionLimitUsedPercent >= CRITICAL_THRESHOLD) {
      warnings.push("rate_critical")
    } else if (args.sessionLimitUsedPercent >= WARNING_THRESHOLD) {
      warnings.push("rate_warning")
    }
  }

  if (args.updatedAt !== null && Date.now() - args.updatedAt > STALE_AFTER_MS) {
    warnings.push("stale")
  }

  return warnings
}

function relevantMessagesForCurrentContext(messages: TranscriptEntry[]) {
  let lastContextClearedIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "context_cleared") {
      lastContextClearedIndex = index
      break
    }
  }

  return lastContextClearedIndex >= 0 ? messages.slice(lastContextClearedIndex + 1) : messages
}

function estimateTokenCountFromText(text: string | undefined | null) {
  if (!text) return 0
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.ceil(trimmed.length / 4)
}

function estimateTokenCountFromUnknown(value: unknown) {
  if (typeof value === "string") {
    return estimateTokenCountFromText(value)
  }

  try {
    return estimateTokenCountFromText(JSON.stringify(value))
  } catch {
    return 0
  }
}

export function estimateCurrentThreadTokens(messages: TranscriptEntry[]) {
  let total = 0

  for (const entry of relevantMessagesForCurrentContext(messages)) {
    switch (entry.kind) {
      case "user_prompt":
        total += estimateTokenCountFromText(entry.content)
        if (entry.attachments?.length) {
          total += entry.attachments.length * 256
        }
        break
      case "assistant_text":
        total += estimateTokenCountFromText(entry.text)
        break
      case "compact_summary":
        total += estimateTokenCountFromText(entry.summary)
        break
      case "result":
        total += estimateTokenCountFromText(entry.result)
        break
      case "tool_call":
        total += estimateTokenCountFromText(entry.tool.toolName)
        total += estimateTokenCountFromUnknown(entry.tool.input)
        break
      case "tool_result":
        total += estimateTokenCountFromUnknown(entry.content)
        break
      case "status":
        total += estimateTokenCountFromText(entry.status)
        break
      default:
        break
    }
  }

  return total
}

function buildSnapshot(args: {
  provider: AgentProvider
  threadTokens: number | null
  contextWindowTokens: number | null
  lastTurnTokens: number | null
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  reasoningOutputTokens?: number | null
  sessionLimitUsedPercent: number | null
  rateLimitResetAt: number | null
  source: ChatUsageSnapshot["source"]
  updatedAt: number | null
}): ChatUsageSnapshot | null {
  const contextUsedPercent = args.threadTokens !== null && args.contextWindowTokens && args.contextWindowTokens > 0
    ? toPercent((args.threadTokens / args.contextWindowTokens) * 100)
    : null

  const snapshot: ChatUsageSnapshot = {
    provider: args.provider,
    threadTokens: args.threadTokens,
    contextWindowTokens: args.contextWindowTokens,
    contextUsedPercent,
    lastTurnTokens: args.lastTurnTokens,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    cachedInputTokens: args.cachedInputTokens,
    reasoningOutputTokens: args.reasoningOutputTokens ?? null,
    sessionLimitUsedPercent: toPercent(args.sessionLimitUsedPercent),
    rateLimitResetAt: args.rateLimitResetAt,
    source: args.source,
    updatedAt: args.updatedAt,
    warnings: usageWarnings({
      contextUsedPercent,
      sessionLimitUsedPercent: toPercent(args.sessionLimitUsedPercent),
      updatedAt: args.updatedAt,
    }),
  }

  const hasAnyData = [
    snapshot.threadTokens,
    snapshot.contextWindowTokens,
    snapshot.lastTurnTokens,
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.cachedInputTokens,
    snapshot.reasoningOutputTokens ?? null,
    snapshot.sessionLimitUsedPercent,
  ].some((value) => value !== null)

  return hasAnyData ? snapshot : null
}

function usageTotals(usage: Record<string, unknown>): NumericUsage & { totalTokens: number } {
  const inputTokens = toNumber(usage.input_tokens) ?? 0
  const outputTokens = toNumber(usage.output_tokens) ?? 0
  const cachedInputTokens = (toNumber(usage.cache_read_input_tokens) ?? 0) + (toNumber(usage.cache_creation_input_tokens) ?? 0)
  const reasoningOutputTokens = toNumber(usage.reasoning_output_tokens) ?? 0

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens,
  }
}

function extractClaudeUsageRecord(entry: TranscriptEntry) {
  if (!entry.debugRaw) return null
  const raw = parseJsonLine(entry.debugRaw)
  if (!raw) return null

  const type = raw.type
  if (type !== "assistant" && type !== "result") return null

  if (type === "assistant") {
    const message = asRecord(raw.message)
    const usage = asRecord(message?.usage)
    if (!usage) return null

    const usageTotalsRecord = usageTotals(usage)
    return {
      key: typeof raw.uuid === "string" ? raw.uuid : entry.messageId ?? entry._id,
      updatedAt: entry.createdAt,
      totals: usageTotalsRecord,
      contextWindowTokens: null,
    }
  }

  const usage = asRecord(raw.usage)
  const modelUsage = asRecord(raw.modelUsage)
  const firstModel = modelUsage ? Object.values(modelUsage).map((value) => asRecord(value)).find(Boolean) ?? null : null
  if (!usage && !firstModel) return null

  const usageTotalsRecord = usage ? usageTotals(usage) : {
    inputTokens: toNumber(firstModel?.inputTokens) ?? 0,
    outputTokens: toNumber(firstModel?.outputTokens) ?? 0,
    cachedInputTokens:
      (toNumber(firstModel?.cacheReadInputTokens) ?? 0)
      + (toNumber(firstModel?.cacheCreationInputTokens) ?? 0),
    reasoningOutputTokens: 0,
    totalTokens:
      (toNumber(firstModel?.inputTokens) ?? 0)
      + (toNumber(firstModel?.outputTokens) ?? 0)
      + (toNumber(firstModel?.cacheReadInputTokens) ?? 0)
      + (toNumber(firstModel?.cacheCreationInputTokens) ?? 0),
  }

  return {
    key: typeof raw.uuid === "string" ? raw.uuid : entry.messageId ?? entry._id,
    updatedAt: entry.createdAt,
    totals: usageTotalsRecord,
    contextWindowTokens: toNumber(firstModel?.contextWindow),
  }
}

export function reconstructClaudeUsage(
  messages: TranscriptEntry[],
  liveRateLimit?: ClaudeRateLimitInfo | null
): ChatUsageSnapshot | null {
  const relevantMessages = relevantMessagesForCurrentContext(messages)
  const deduped = new Map<string, ReturnType<typeof extractClaudeUsageRecord>>()

  for (const entry of relevantMessages) {
    const usageRecord = extractClaudeUsageRecord(entry)
    if (!usageRecord) continue
    deduped.set(usageRecord.key, usageRecord)
  }

  const latest = [...deduped.values()]
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]

  if (!latest && liveRateLimit?.percent == null) {
    return null
  }

  const latestModel = [...relevantMessages]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { kind: "system_init" }> =>
      entry.kind === "system_init" && entry.provider === "claude"
    )
  const fallbackContextWindow = latestModel
    ? CLAUDE_CONTEXT_WINDOW_FALLBACKS[latestModel.model.toLowerCase()] ?? null
    : null

  return buildSnapshot({
    provider: "claude",
    threadTokens: estimateCurrentThreadTokens(messages),
    contextWindowTokens: latest?.contextWindowTokens ?? fallbackContextWindow,
    lastTurnTokens: latest?.totals.totalTokens ?? null,
    inputTokens: latest?.totals.inputTokens ?? null,
    outputTokens: latest?.totals.outputTokens ?? null,
    cachedInputTokens: latest?.totals.cachedInputTokens ?? null,
    reasoningOutputTokens: latest?.totals.reasoningOutputTokens ?? null,
    sessionLimitUsedPercent: liveRateLimit?.percent ?? null,
    rateLimitResetAt: liveRateLimit?.resetsAt ?? null,
    source: latest ? "reconstructed" : "live",
    updatedAt: latest?.updatedAt ?? null,
  })
}

function findCodexSessionFile(sessionToken: string, sessionsDir = path.join(homedir(), ".codex", "sessions")): string | null {
  if (!existsSync(sessionsDir)) {
    return null
  }

  const stack = [sessionsDir]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      if (entry.name.includes(sessionToken)) {
        return fullPath
      }

      const firstLine = readFileSync(fullPath, "utf8").split("\n", 1)[0]
      const record = parseJsonLine(firstLine)
      const payload = asRecord(record?.payload)
      if (record?.type === "session_meta" && payload?.id === sessionToken) {
        return fullPath
      }
    }
  }

  return null
}

export function reconstructCodexUsageFromFile(
  sessionToken: string,
  sessionsDir = path.join(homedir(), ".codex", "sessions")
): ChatUsageSnapshot | null {
  const sessionFile = findCodexSessionFile(sessionToken, sessionsDir)
  if (!sessionFile || !existsSync(sessionFile)) {
    return null
  }

  let latestUsage: ProviderRateLimitSnapshot | null = null
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue
    const record = parseJsonLine(line)
    if (!record || record.type !== "event_msg") continue
    const payload = asRecord(record.payload)
    if (!payload || payload.type !== "token_count") continue
    const info = asRecord(payload.info)
    const totalTokenUsage = asRecord(info?.total_token_usage)
    const lastTokenUsage = asRecord(info?.last_token_usage)
    const rateLimits = asRecord(payload.rate_limits)
    const primary = asRecord(rateLimits?.primary)
    const secondary = asRecord(rateLimits?.secondary)
    const updatedAt = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Date.now()
    const primaryWindowMinutes = toNumber(primary?.window_minutes)
    const primaryIsWeekly = primaryWindowMinutes !== null && primaryWindowMinutes >= 10_080
    const weeklyLimit = secondary ?? (primaryIsWeekly ? primary : null)

    latestUsage = buildSnapshot({
      provider: "codex",
      threadTokens: null,
      contextWindowTokens: toNumber(info?.model_context_window),
      lastTurnTokens: toNumber(lastTokenUsage?.total_tokens),
      inputTokens: toNumber(totalTokenUsage?.input_tokens),
      outputTokens: toNumber(totalTokenUsage?.output_tokens),
      cachedInputTokens: toNumber(totalTokenUsage?.cached_input_tokens),
      reasoningOutputTokens: toNumber(totalTokenUsage?.reasoning_output_tokens),
      sessionLimitUsedPercent: primaryIsWeekly ? null : toNumber(primary?.used_percent),
      rateLimitResetAt: primaryIsWeekly ? null : (typeof primary?.resets_at === "number" ? primary.resets_at * 1000 : null),
      source: "reconstructed",
      updatedAt,
    }) as ProviderRateLimitSnapshot | null

    if (latestUsage) {
      latestUsage.weeklyLimitUsedPercent = toNumber(weeklyLimit?.used_percent)
      latestUsage.weeklyRateLimitResetAt = typeof weeklyLimit?.resets_at === "number" ? weeklyLimit.resets_at * 1000 : null
      latestUsage.weeklyRateLimitResetLabel = null
    }
  }

  return latestUsage
}

export function mergeUsageSnapshots(
  reconstructed: ChatUsageSnapshot | null,
  live: ChatUsageSnapshot | null
): ChatUsageSnapshot | null {
  if (!reconstructed) return live
  if (!live) return reconstructed

  const merged: ChatUsageSnapshot = {
    ...reconstructed,
    ...live,
    provider: live.provider,
    threadTokens: live.threadTokens ?? reconstructed.threadTokens,
    contextWindowTokens: live.contextWindowTokens ?? reconstructed.contextWindowTokens,
    contextUsedPercent: live.contextUsedPercent ?? reconstructed.contextUsedPercent,
    lastTurnTokens: live.lastTurnTokens ?? reconstructed.lastTurnTokens,
    inputTokens: live.inputTokens ?? reconstructed.inputTokens,
    outputTokens: live.outputTokens ?? reconstructed.outputTokens,
    cachedInputTokens: live.cachedInputTokens ?? reconstructed.cachedInputTokens,
    reasoningOutputTokens: live.reasoningOutputTokens ?? reconstructed.reasoningOutputTokens,
    sessionLimitUsedPercent: live.sessionLimitUsedPercent ?? reconstructed.sessionLimitUsedPercent,
    rateLimitResetAt: live.rateLimitResetAt ?? reconstructed.rateLimitResetAt,
    source: live.source === "live" ? "live" : reconstructed.source,
    updatedAt: live.updatedAt ?? reconstructed.updatedAt,
    warnings: [],
  }

  merged.warnings = usageWarnings({
    contextUsedPercent: merged.contextUsedPercent,
    sessionLimitUsedPercent: merged.sessionLimitUsedPercent,
    updatedAt: merged.updatedAt,
  })

  return merged
}

export function applyThreadEstimate(
  snapshot: ChatUsageSnapshot | null,
  messages: TranscriptEntry[]
): ChatUsageSnapshot | null {
  const estimatedThreadTokens = estimateCurrentThreadTokens(messages)
  if (!snapshot) return null

  const contextUsedPercent = snapshot.contextWindowTokens && snapshot.contextWindowTokens > 0
    ? toPercent((estimatedThreadTokens / snapshot.contextWindowTokens) * 100)
    : null

  return {
    ...snapshot,
    threadTokens: estimatedThreadTokens,
    contextUsedPercent,
    warnings: usageWarnings({
      contextUsedPercent,
      sessionLimitUsedPercent: snapshot.sessionLimitUsedPercent,
      updatedAt: snapshot.updatedAt,
    }),
  }
}

export function createClaudeRateLimitSnapshot(percent: number | null, resetsAt: number | null): ChatUsageSnapshot | null {
  return buildSnapshot({
    provider: "claude",
    threadTokens: null,
    contextWindowTokens: null,
    lastTurnTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    sessionLimitUsedPercent: percent,
    rateLimitResetAt: resetsAt,
    source: "live",
    updatedAt: Date.now(),
  })
}

let codexUsageCache: { snapshot: ChatUsageSnapshot | null; cachedAt: number } | null = null
let claudeFileCache: { snapshot: ChatUsageSnapshot | null; cachedAt: number } | null = null
let cursorUsageFileCache: { filePath: string; entry: ProviderUsageEntry | null; cachedAt: number } | null = null
const PROVIDER_CACHE_TTL_MS = 30_000
const PROVIDER_USAGE_REQUEST_MIN_INTERVAL_MS = 30 * 60 * 1000
let claudeRateLimitRefreshInFlight: Promise<ChatUsageSnapshot | null> | null = null

interface ClaudeRateLimitCacheSnapshot extends ChatUsageSnapshot {
  rateLimitResetLabel?: string | null
  weeklyLimitUsedPercent?: number | null
  weeklyRateLimitResetAt?: number | null
  weeklyRateLimitResetLabel?: string | null
}

interface ProviderRateLimitSnapshot extends ChatUsageSnapshot {
  rateLimitResetLabel?: string | null
  weeklyLimitUsedPercent?: number | null
  weeklyRateLimitResetAt?: number | null
  weeklyRateLimitResetLabel?: string | null
}

function hasClaudeSidebarRateLimitData(snapshot: ChatUsageSnapshot | null): snapshot is ClaudeRateLimitCacheSnapshot {
  if (!snapshot || snapshot.provider !== "claude") return false
  const claudeSnapshot = snapshot as ClaudeRateLimitCacheSnapshot
  return Boolean(
    claudeSnapshot.rateLimitResetLabel
      || claudeSnapshot.weeklyLimitUsedPercent !== undefined
      || claudeSnapshot.weeklyRateLimitResetAt !== undefined
      || claudeSnapshot.weeklyRateLimitResetLabel !== undefined
  )
}

function mergeClaudeProviderSnapshot(
  liveSnapshot: ChatUsageSnapshot | null,
  persistedSnapshot: ChatUsageSnapshot | null
): ChatUsageSnapshot | null {
  if (hasClaudeSidebarRateLimitData(persistedSnapshot)) {
    if (!liveSnapshot) return persistedSnapshot

    const merged = {
      ...liveSnapshot,
      ...persistedSnapshot,
      source: persistedSnapshot.source,
      updatedAt: Math.max(liveSnapshot.updatedAt ?? 0, persistedSnapshot.updatedAt ?? 0) || null,
    } as ClaudeRateLimitCacheSnapshot
    merged.sessionLimitUsedPercent = persistedSnapshot.sessionLimitUsedPercent
    merged.rateLimitResetAt = persistedSnapshot.rateLimitResetAt
    merged.rateLimitResetLabel = persistedSnapshot.rateLimitResetLabel ?? null
    merged.weeklyLimitUsedPercent = persistedSnapshot.weeklyLimitUsedPercent ?? null
    merged.weeklyRateLimitResetAt = persistedSnapshot.weeklyRateLimitResetAt ?? null
    merged.weeklyRateLimitResetLabel = persistedSnapshot.weeklyRateLimitResetLabel ?? null
    merged.warnings = usageWarnings({
      contextUsedPercent: null,
      sessionLimitUsedPercent: merged.sessionLimitUsedPercent,
      updatedAt: merged.updatedAt,
    })
    return merged
  }

  return liveSnapshot ?? persistedSnapshot
}

function createClaudeRateLimitCacheSnapshot(args: {
  sessionLimitUsedPercent: number | null
  rateLimitResetAt: number | null
  rateLimitResetLabel?: string | null
  weeklyLimitUsedPercent?: number | null
  weeklyRateLimitResetAt?: number | null
  weeklyRateLimitResetLabel?: string | null
  updatedAt?: number | null
}): ClaudeRateLimitCacheSnapshot | null {
  const basePercent = args.sessionLimitUsedPercent ?? args.weeklyLimitUsedPercent ?? null
  const snapshot = createClaudeRateLimitSnapshot(basePercent, args.rateLimitResetAt) as ClaudeRateLimitCacheSnapshot | null
  if (!snapshot) return null

  snapshot.sessionLimitUsedPercent = args.sessionLimitUsedPercent
  snapshot.rateLimitResetAt = args.rateLimitResetAt
  snapshot.rateLimitResetLabel = args.rateLimitResetLabel ?? null
  snapshot.weeklyLimitUsedPercent = args.weeklyLimitUsedPercent ?? null
  snapshot.weeklyRateLimitResetAt = args.weeklyRateLimitResetAt ?? null
  snapshot.weeklyRateLimitResetLabel = args.weeklyRateLimitResetLabel ?? null
  snapshot.updatedAt = args.updatedAt ?? snapshot.updatedAt
  snapshot.warnings = usageWarnings({
    contextUsedPercent: null,
    sessionLimitUsedPercent: snapshot.sessionLimitUsedPercent,
    updatedAt: snapshot.updatedAt,
  })
  return snapshot
}

function claudeRateLimitPath(dataDir: string) {
  return path.join(dataDir, "claude-rate-limit.json")
}

function providerUsageRequestTimesPath(dataDir: string) {
  return path.join(dataDir, "provider-usage-request-times.json")
}

function loadProviderUsageRequestTimes(dataDir: string): Partial<Record<AgentProvider, number>> {
  try {
    const filePath = providerUsageRequestTimesPath(dataDir)
    if (!existsSync(filePath)) return {}
    const parsed = JSON.parse(readFileSync(filePath, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const result: Partial<Record<AgentProvider, number>> = {}
    for (const provider of ["claude", "codex", "gemini", "cursor"] as const satisfies AgentProvider[]) {
      const value = (parsed as Record<string, unknown>)[provider]
      if (typeof value === "number" && Number.isFinite(value)) {
        result[provider] = value
      }
    }
    return result
  } catch {
    return {}
  }
}

function readProviderUsageLastRequestedAt(dataDir: string, provider: AgentProvider) {
  return loadProviderUsageRequestTimes(dataDir)[provider] ?? 0
}

function recordProviderUsageRequestTime(dataDir: string, provider: AgentProvider, requestedAt = Date.now()) {
  try {
    const next = loadProviderUsageRequestTimes(dataDir)
    next[provider] = requestedAt
    writeFileSync(providerUsageRequestTimesPath(dataDir), JSON.stringify(next))
  } catch {
    // best-effort
  }
}

function persistClaudeRateLimit(dataDir: string, snapshot: ChatUsageSnapshot) {
  try {
    writeFileSync(claudeRateLimitPath(dataDir), JSON.stringify({
      sessionLimitUsedPercent: snapshot.sessionLimitUsedPercent,
      rateLimitResetAt: snapshot.rateLimitResetAt,
      rateLimitResetLabel: (snapshot as ClaudeRateLimitCacheSnapshot).rateLimitResetLabel ?? null,
      weeklyLimitUsedPercent: (snapshot as ClaudeRateLimitCacheSnapshot).weeklyLimitUsedPercent ?? null,
      weeklyRateLimitResetAt: (snapshot as ClaudeRateLimitCacheSnapshot).weeklyRateLimitResetAt ?? null,
      weeklyRateLimitResetLabel: (snapshot as ClaudeRateLimitCacheSnapshot).weeklyRateLimitResetLabel ?? null,
      updatedAt: snapshot.updatedAt,
    }))
  } catch { /* best-effort */ }
}

function loadPersistedClaudeRateLimit(dataDir: string): ChatUsageSnapshot | null {
  const now = Date.now()
  if (claudeFileCache && now - claudeFileCache.cachedAt < PROVIDER_CACHE_TTL_MS) {
    return claudeFileCache.snapshot
  }

  try {
    const filePath = claudeRateLimitPath(dataDir)
    if (!existsSync(filePath)) return null
    const data = JSON.parse(readFileSync(filePath, "utf8"))
    let percent = typeof data.sessionLimitUsedPercent === "number" ? data.sessionLimitUsedPercent : null
    const resetsAt = typeof data.rateLimitResetAt === "number" ? data.rateLimitResetAt : null
    let resetLabel = typeof data.rateLimitResetLabel === "string" ? data.rateLimitResetLabel : null
    let weeklyPercent = typeof data.weeklyLimitUsedPercent === "number" ? data.weeklyLimitUsedPercent : null
    const weeklyResetsAt = typeof data.weeklyRateLimitResetAt === "number" ? data.weeklyRateLimitResetAt : null
    let weeklyResetLabel = typeof data.weeklyRateLimitResetLabel === "string" ? data.weeklyRateLimitResetLabel : null
    const persistedAt = typeof data.updatedAt === "number" ? data.updatedAt : null

    if (weeklyPercent === null && weeklyResetsAt === null && weeklyResetLabel === null && looksLikeClaudeWeeklyResetLabel(resetLabel)) {
      weeklyPercent = percent
      weeklyResetLabel = resetLabel
      percent = null
      resetLabel = null
    }

    if (percent === null && resetsAt === null && weeklyPercent === null && weeklyResetsAt === null) return null

    const snapshot = createClaudeRateLimitCacheSnapshot({
      sessionLimitUsedPercent: percent,
      rateLimitResetAt: resetsAt,
      rateLimitResetLabel: resetLabel,
      weeklyLimitUsedPercent: weeklyPercent,
      weeklyRateLimitResetAt: weeklyResetsAt,
      weeklyRateLimitResetLabel: weeklyResetLabel,
      updatedAt: persistedAt,
    })
    claudeFileCache = { snapshot, cachedAt: now }
    return snapshot
  } catch {
    claudeFileCache = { snapshot: null, cachedAt: now }
    return null
  }
}

function stripAnsi(text: string) {
  return text
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
}

function normalizeClaudeScreenText(text: string) {
  return stripAnsi(text)
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n+/g, "\n")
}

function normalizeResetLabel(label: string | null) {
  if (!label) return null
  return label
    .replace(/\b([A-Za-z]{3})(\d)/g, "$1 $2")
    .replace(/,(\S)/g, ", $1")
    .trim()
}

function looksLikeClaudeWeeklyResetLabel(label: string | null) {
  if (!label) return false
  return /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(label)
}

export function parseClaudeUsageScreen(text: string): {
  sessionLimitUsedPercent: number | null
  rateLimitResetLabel: string | null
  weeklyLimitUsedPercent: number | null
  weeklyRateLimitResetLabel: string | null
} | null {
  const normalized = normalizeClaudeScreenText(text)
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  const compactLines = lines.map((line) => line.replace(/\s+/g, "").toLowerCase())
  const parseSection = (pattern: RegExp) => {
    const sectionIndex = compactLines.findIndex((line) => pattern.test(line))
    if (sectionIndex === -1) return null

    let percent: number | null = null
    let resetLabel: string | null = null

    for (let index = sectionIndex; index < Math.min(lines.length, sectionIndex + 6); index += 1) {
      const compact = compactLines[index] ?? ""
      if (percent === null) {
        const match = compact.match(/(\d{1,3})%used/)
        if (match) {
          percent = Number.parseInt(match[1] ?? "", 10)
          continue
        }
      }

      if (resetLabel === null && /^res\w*/.test(compact)) {
        resetLabel = lines[index]?.replace(/^Res(?:ets?|es)?\s*/i, "").trim() ?? null
      }
    }

    if (!Number.isFinite(percent)) return null
    return { percent: toPercent(percent), resetLabel }
  }

  const currentSession = parseSection(/cur\w*session/)
  const currentWeek = parseSection(/current\w*week/)
  if (!currentSession && !currentWeek) return null

  return {
    sessionLimitUsedPercent: currentSession?.percent ?? null,
    rateLimitResetLabel: normalizeResetLabel(currentSession?.resetLabel ?? null),
    weeklyLimitUsedPercent: currentWeek?.percent ?? null,
    weeklyRateLimitResetLabel: normalizeResetLabel(currentWeek?.resetLabel ?? null),
  }
}

function claudeUsageCollectorScript() {
  return [
    "import os, pty, select, subprocess, time, sys",
    "cwd = os.environ.get('CLAUDE_USAGE_CWD') or None",
    "command = ['claude']",
    "if os.environ.get('CLAUDE_USAGE_CONTINUE') == '1':",
    "    command.append('-c')",
    "master, slave = pty.openpty()",
    "proc = subprocess.Popen(command, cwd=cwd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)",
    "os.close(slave)",
    "buf = bytearray()",
    "try:",
    "    ready_deadline = time.time() + 15",
    "    ready_seen_at = None",
    "    while time.time() < ready_deadline:",
    "        r, _, _ = select.select([master], [], [], 0.5)",
    "        if master not in r:",
    "            if ready_seen_at is not None and time.time() - ready_seen_at > 0.7:",
    "                break",
    "            continue",
    "        try:",
    "            data = os.read(master, 65536)",
    "        except OSError:",
    "            break",
    "        if not data:",
    "            break",
    "        buf.extend(data)",
    "        if b'/effort' in buf:",
    "            ready_seen_at = time.time()",
    "    os.write(master, b'/usage\\r')",
    "    deadline = time.time() + 8",
    "    while time.time() < deadline:",
    "        r, _, _ = select.select([master], [], [], 0.5)",
    "        if master not in r:",
    "            continue",
    "        try:",
    "            data = os.read(master, 65536)",
    "        except OSError:",
    "            break",
    "        if not data:",
    "            break",
    "        buf.extend(data)",
    "        if b'Current week' in buf and b'used' in buf:",
    "            break",
    "    try: os.write(master, b'\\x1b')",
    "    except OSError: pass",
    "    time.sleep(0.2)",
    "    try: os.write(master, b'\\x03')",
    "    except OSError: pass",
    "    time.sleep(0.2)",
    "finally:",
    "    try: proc.terminate()",
    "    except ProcessLookupError: pass",
    "    try: proc.wait(timeout=2)",
    "    except Exception:",
    "        try: proc.kill()",
    "        except ProcessLookupError: pass",
    "sys.stdout.write(buf.decode('utf-8', 'ignore'))",
  ].join("\n")
}

function collectClaudeUsageScreen(args?: { cwd?: string; continueSession?: boolean }) {
  const result = Bun.spawnSync(["python3", "-c", claudeUsageCollectorScript()], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: args?.cwd,
    env: {
      ...process.env,
      ...(args?.cwd ? { CLAUDE_USAGE_CWD: args.cwd } : {}),
      CLAUDE_USAGE_CONTINUE: args?.continueSession ? "1" : "0",
    },
  })
  return new TextDecoder().decode(result.stdout)
}

export async function refreshClaudeRateLimitFromCli(
  dataDir: string,
  runCommand?: () => Promise<string>,
  force?: boolean
): Promise<ChatUsageSnapshot | null> {
  if (!runCommand) {
    const now = Date.now()
    if (claudeRateLimitRefreshInFlight) {
      return claudeRateLimitRefreshInFlight
    }

    if (!force && now - readProviderUsageLastRequestedAt(dataDir, "claude") < PROVIDER_USAGE_REQUEST_MIN_INTERVAL_MS) {
      return loadPersistedClaudeRateLimit(dataDir)
    }

    recordProviderUsageRequestTime(dataDir, "claude", now)
  }

  const performRefresh = async () => {
    let parsed: ReturnType<typeof parseClaudeUsageScreen> = null

    if (runCommand) {
      parsed = parseClaudeUsageScreen(await runCommand())
    } else {
      const liveSessions = findRunningClaudeSessions()
      let best: ReturnType<typeof parseClaudeUsageScreen> = null

      for (const session of liveSessions) {
        const candidate = parseClaudeUsageScreen(collectClaudeUsageScreen({
          cwd: session.cwd,
          continueSession: true,
        }))
        if (!candidate?.sessionLimitUsedPercent && candidate?.sessionLimitUsedPercent !== 0) continue
        if (!best || (candidate.sessionLimitUsedPercent ?? -1) > (best.sessionLimitUsedPercent ?? -1)) {
          best = candidate
        }
      }

      parsed = best ?? parseClaudeUsageScreen(collectClaudeUsageScreen())
    }

    if (!parsed) return null

    const snapshot = createClaudeRateLimitCacheSnapshot({
      sessionLimitUsedPercent: parsed.sessionLimitUsedPercent,
      rateLimitResetAt: null,
      rateLimitResetLabel: parsed.rateLimitResetLabel,
      weeklyLimitUsedPercent: parsed.weeklyLimitUsedPercent,
      weeklyRateLimitResetAt: null,
      weeklyRateLimitResetLabel: parsed.weeklyRateLimitResetLabel,
      updatedAt: Date.now(),
    })
    if (!snapshot) return null
    persistClaudeRateLimit(dataDir, snapshot)
    claudeFileCache = { snapshot, cachedAt: Date.now() }
    return snapshot
  }

  if (runCommand) {
    return performRefresh()
  }

  claudeRateLimitRefreshInFlight = performRefresh().finally(() => {
    claudeRateLimitRefreshInFlight = null
  })
  return claudeRateLimitRefreshInFlight
}

function isRunningPid(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function findRunningClaudeSessions(): Array<{ cwd: string; sessionId: string; startedAt: number }> {
  const sessionsDir = path.join(homedir(), ".claude", "sessions")
  if (!existsSync(sessionsDir)) return []

  const sessions: Array<{ cwd: string; sessionId: string; startedAt: number }> = []
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    try {
      const data = JSON.parse(readFileSync(path.join(sessionsDir, entry.name), "utf8"))
      const pid = typeof data.pid === "number" ? data.pid : null
      const cwd = typeof data.cwd === "string" ? data.cwd : null
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : null
      const startedAt = typeof data.startedAt === "number" ? data.startedAt : 0
      if (!pid || !cwd || !sessionId) continue
      if (!isRunningPid(pid)) continue
      sessions.push({ cwd, sessionId, startedAt })
    } catch {
      continue
    }
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt)
}

function cursorSessionPath(dataDir: string) {
  return path.join(dataDir, "cursor-session.json")
}

function cursorUsagePath(dataDir: string) {
  return path.join(dataDir, "cursor-usage.json")
}

function persistCursorSession(dataDir: string, session: CursorSessionCache) {
  const prunedCookies = session.cookies
    .filter((cookie) => cookie.domain === "cursor.com" || cookie.domain.endsWith(".cursor.com"))
    .map((cookie) => ({
      ...cookie,
      value: String(cookie.value),
    }))

  writeFileSync(cursorSessionPath(dataDir), JSON.stringify({
    cookies: prunedCookies,
    updatedAt: session.updatedAt,
    lastSuccessAt: session.lastSuccessAt,
  }))
}

function loadPersistedCursorSession(dataDir: string): CursorSessionCache | null {
  try {
    const filePath = cursorSessionPath(dataDir)
    if (!existsSync(filePath)) return null
    const parsed = JSON.parse(readFileSync(filePath, "utf8"))
    const cookies = Array.isArray(parsed.cookies)
      ? parsed.cookies
        .map((cookie: unknown) => asRecord(cookie))
        .filter((cookie: Record<string, unknown> | null): cookie is Record<string, unknown> => Boolean(cookie))
        .map((cookie: Record<string, unknown>) => ({
          name: typeof cookie.name === "string" ? cookie.name : "",
          value: typeof cookie.value === "string" ? cookie.value : "",
          domain: typeof cookie.domain === "string" ? cookie.domain : "cursor.com",
          path: typeof cookie.path === "string" ? cookie.path : "/",
          expiresAt: typeof cookie.expiresAt === "number" ? cookie.expiresAt : null,
          secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly !== false,
        }))
        .filter((cookie: CursorSessionCookie) => cookie.name && cookie.value)
      : []

    if (cookies.length === 0) return null

    return {
      cookies,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      lastSuccessAt: typeof parsed.lastSuccessAt === "number" ? parsed.lastSuccessAt : null,
    }
  } catch {
    return null
  }
}

function persistCursorUsageEntry(dataDir: string, entry: ProviderUsageEntry) {
  const filePath = cursorUsagePath(dataDir)
  writeFileSync(filePath, JSON.stringify(entry))
  cursorUsageFileCache = { filePath, entry, cachedAt: Date.now() }
}

function loadPersistedCursorUsageEntry(dataDir: string): ProviderUsageEntry | null {
  const now = Date.now()
  const filePath = cursorUsagePath(dataDir)
  if (cursorUsageFileCache && cursorUsageFileCache.filePath === filePath && now - cursorUsageFileCache.cachedAt < PROVIDER_CACHE_TTL_MS) {
    return cursorUsageFileCache.entry
  }

  try {
    if (!existsSync(filePath)) return null
    const parsed = JSON.parse(readFileSync(filePath, "utf8"))
    const entry = asRecord(parsed)
    if (!entry) return null
    const availability = typeof entry.availability === "string" ? entry.availability as ProviderUsageAvailability : "unavailable"
    const hasApiLimitUsedPercent = Object.prototype.hasOwnProperty.call(entry, "apiLimitUsedPercent")
    const normalized: ProviderUsageEntry = {
      provider: "cursor",
      sessionLimitUsedPercent: typeof entry.sessionLimitUsedPercent === "number" ? entry.sessionLimitUsedPercent : null,
      apiLimitUsedPercent: hasApiLimitUsedPercent
        ? (typeof entry.apiLimitUsedPercent === "number" ? entry.apiLimitUsedPercent : null)
        : undefined,
      rateLimitResetAt: typeof entry.rateLimitResetAt === "number" ? entry.rateLimitResetAt : null,
      rateLimitResetLabel: typeof entry.rateLimitResetLabel === "string" ? entry.rateLimitResetLabel : null,
      weeklyLimitUsedPercent: typeof entry.weeklyLimitUsedPercent === "number" ? entry.weeklyLimitUsedPercent : null,
      weeklyRateLimitResetAt: typeof entry.weeklyRateLimitResetAt === "number" ? entry.weeklyRateLimitResetAt : null,
      weeklyRateLimitResetLabel: typeof entry.weeklyRateLimitResetLabel === "string" ? entry.weeklyRateLimitResetLabel : null,
      statusDetail: typeof entry.statusDetail === "string" ? entry.statusDetail : null,
      lastRequestedAt: typeof entry.lastRequestedAt === "number" ? entry.lastRequestedAt : null,
      availability: availability === "available" || availability === "unavailable" || availability === "stale" || availability === "login_required"
        ? availability
        : "unavailable",
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : null,
      warnings: Array.isArray(entry.warnings) ? entry.warnings.filter((warning) => typeof warning === "string") as ChatUsageWarning[] : [],
    }

    if (normalized.availability === "available" || normalized.availability === "stale") {
      normalized.availability = deriveAvailability(normalized.updatedAt)
      normalized.warnings = usageWarnings({
        contextUsedPercent: null,
        sessionLimitUsedPercent: normalized.sessionLimitUsedPercent,
        updatedAt: normalized.updatedAt,
      })
    }

    cursorUsageFileCache = { filePath, entry: normalized, cachedAt: now }
    return normalized
  } catch {
    cursorUsageFileCache = { filePath, entry: null, cachedAt: now }
    return null
  }
}

function cursorEntryFromSuccess(payload: CursorUsagePayload, updatedAt = Date.now(), lastRequestedAt = updatedAt): ProviderUsageEntry {
  return {
    provider: "cursor",
    sessionLimitUsedPercent: payload.sessionLimitUsedPercent,
    apiLimitUsedPercent: payload.apiPercentUsed,
    rateLimitResetAt: payload.rateLimitResetAt,
    rateLimitResetLabel: payload.rateLimitResetLabel,
    weeklyLimitUsedPercent: null,
    weeklyRateLimitResetAt: null,
    weeklyRateLimitResetLabel: null,
    statusDetail: null,
    availability: "available",
    lastRequestedAt,
    updatedAt,
    warnings: usageWarnings({
      contextUsedPercent: null,
      sessionLimitUsedPercent: payload.sessionLimitUsedPercent,
      updatedAt,
    }),
  }
}

function cursorStatusEntry(args: {
  availability: ProviderUsageAvailability
  statusDetail: string | null
  lastRequestedAt?: number | null
  updatedAt?: number | null
}): ProviderUsageEntry {
  return {
    provider: "cursor",
    sessionLimitUsedPercent: null,
    apiLimitUsedPercent: null,
    rateLimitResetAt: null,
    rateLimitResetLabel: null,
    weeklyLimitUsedPercent: null,
    weeklyRateLimitResetAt: null,
    weeklyRateLimitResetLabel: null,
    statusDetail: args.statusDetail,
    availability: args.availability,
    lastRequestedAt: args.lastRequestedAt ?? null,
    updatedAt: args.updatedAt ?? null,
    warnings: args.availability === "stale" && args.updatedAt
      ? ["stale"]
      : [],
  }
}

function normalizeCookieDomain(domain: string) {
  return domain.startsWith(".") ? domain.slice(1) : domain
}

function isExpiredCookie(cookie: CursorSessionCookie, now = Date.now()) {
  return cookie.expiresAt !== null && cookie.expiresAt <= now
}

function mergeCursorCookies(
  existing: CursorSessionCookie[],
  incoming: CursorSessionCookie[],
  now = Date.now()
) {
  const merged = new Map<string, CursorSessionCookie>()
  for (const cookie of existing) {
    if (isExpiredCookie(cookie, now)) continue
    merged.set(`${normalizeCookieDomain(cookie.domain)}|${cookie.path}|${cookie.name}`, cookie)
  }

  for (const cookie of incoming) {
    const key = `${normalizeCookieDomain(cookie.domain)}|${cookie.path}|${cookie.name}`
    if (!cookie.value || isExpiredCookie(cookie, now)) {
      merged.delete(key)
      continue
    }
    merged.set(key, {
      ...cookie,
      domain: normalizeCookieDomain(cookie.domain),
    })
  }

  return [...merged.values()]
    .filter((cookie) => cookie.value)
    .filter((cookie) => !isExpiredCookie(cookie, now))
}

function buildCursorCookieHeader(cookies: CursorSessionCookie[]) {
  return cookies
    .filter((cookie) => !isExpiredCookie(cookie))
    .filter((cookie) => cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ")
}

function parseSetCookie(header: string): CursorSessionCookie | null {
  const segments = header.split(";").map((part) => part.trim()).filter(Boolean)
  const [cookiePair, ...attributes] = segments
  if (!cookiePair) return null
  const equalsIndex = cookiePair.indexOf("=")
  if (equalsIndex <= 0) return null
  const name = cookiePair.slice(0, equalsIndex).trim()
  const value = cookiePair.slice(equalsIndex + 1).trim()
  if (!name) return null

  let domain = "cursor.com"
  let cookiePath = "/"
  let expiresAt: number | null = null
  let secure = false
  let httpOnly = false

  for (const attribute of attributes) {
    const [rawKey, ...rawRest] = attribute.split("=")
    const key = rawKey.trim().toLowerCase()
    const rawValue = rawRest.join("=").trim()
    if (key === "domain" && rawValue) {
      domain = normalizeCookieDomain(rawValue)
    } else if (key === "path" && rawValue) {
      cookiePath = rawValue
    } else if (key === "expires" && rawValue) {
      const parsed = Date.parse(rawValue)
      expiresAt = Number.isFinite(parsed) ? parsed : null
    } else if (key === "max-age" && rawValue) {
      const seconds = Number(rawValue)
      if (Number.isFinite(seconds)) {
        expiresAt = Date.now() + seconds * 1000
      }
    } else if (key === "secure") {
      secure = true
    } else if (key === "httponly") {
      httpOnly = true
    }
  }

  return {
    name,
    value,
    domain,
    path: cookiePath,
    expiresAt,
    secure,
    httpOnly,
  }
}

function parseCookieHeaderValue(cookieHeader: string): CursorSessionCookie[] {
  const cookies = cookieHeader
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment): CursorSessionCookie | null => {
      const equalsIndex = segment.indexOf("=")
      if (equalsIndex <= 0) return null
      return {
        name: segment.slice(0, equalsIndex).trim(),
        value: segment.slice(equalsIndex + 1).trim(),
        domain: "cursor.com",
        path: "/",
        expiresAt: null,
        secure: true,
        httpOnly: true,
      } satisfies CursorSessionCookie
    })
    .filter((cookie): cookie is CursorSessionCookie => cookie !== null)

  return cookies
}

function extractCurlArguments(source: string, patterns: string[]) {
  const values: string[] = []
  for (const pattern of patterns) {
    const regex = new RegExp(`${pattern}\\s+(?:'([^']*)'|"([^"]*)"|(\\S+))`, "ig")
    for (const match of source.matchAll(regex)) {
      values.push(match[1] ?? match[2] ?? match[3] ?? "")
    }
  }
  return values.filter(Boolean)
}

export function importCursorSessionFromCurl(curlCommand: string): CursorCurlImportResult | null {
  const cookieHeader = extractCurlArguments(curlCommand, [
    "-b",
    "--cookie",
  ])[0] ?? extractCurlArguments(curlCommand, [
    "-H",
    "--header",
  ])
    .map((header) => header.match(/^cookie:\s*(.+)$/i)?.[1] ?? null)
    .find((header): header is string => Boolean(header))
    ?? null

  if (!cookieHeader) return null
  const cookies = parseCookieHeaderValue(cookieHeader)
  if (!cookies.some((cookie) => cookie.name === CURSOR_SESSION_COOKIE_NAME)) {
    return null
  }

  return { cookies }
}

function responseSetCookies(response: Response): CursorSessionCookie[] {
  const rawGetSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const cookieHeaders = typeof rawGetSetCookie === "function"
    ? rawGetSetCookie.call(response.headers)
    : (() => {
        const combined = response.headers.get("set-cookie")
        return combined ? [combined] : []
      })()

  return cookieHeaders
    .map((value) => parseSetCookie(value))
    .filter((cookie): cookie is CursorSessionCookie => Boolean(cookie))
    .filter((cookie) => normalizeCookieDomain(cookie.domain).endsWith("cursor.com"))
}

function normalizeCursorResetLabel(label: unknown): string | null {
  if (typeof label !== "string") return null
  const trimmed = label.trim()
  return trimmed || null
}

function parseCursorTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000
  }
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000
    }
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function findFirstValue(value: unknown, matchers: RegExp[], seen = new Set<unknown>()): unknown {
  if (!value || typeof value !== "object") return null
  if (seen.has(value)) return null
  seen.add(value)

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFirstValue(entry, matchers, seen)
      if (found !== null && found !== undefined) return found
    }
    return null
  }

  for (const [key, entry] of Object.entries(value)) {
    if (matchers.some((matcher) => matcher.test(key)) && entry !== null && entry !== undefined) {
      return entry
    }
  }

  for (const entry of Object.values(value)) {
    const found = findFirstValue(entry, matchers, seen)
    if (found !== null && found !== undefined) return found
  }

  return null
}

export function parseCursorUsagePayload(payload: unknown): CursorUsagePayload | null {
  const record = asRecord(payload)
  if (!record) return null

  const planUsage = asRecord(record.planUsage)
  const autoPercentUsed = toNumber(planUsage?.autoPercentUsed)
  const apiPercentRaw = toNumber(planUsage?.apiPercentUsed)
  if (autoPercentUsed !== null) {
    return {
      sessionLimitUsedPercent: toPercent(autoPercentUsed),
      apiPercentUsed: toPercent(apiPercentRaw),
      rateLimitResetAt: null,
      rateLimitResetLabel: null,
    }
  }

  const percentValue = findFirstValue(record, [
    /^used_?percent$/i,
    /^session_?limit_?used_?percent$/i,
    /^percent_?used$/i,
    /^usage_?percent(age)?$/i,
  ])
  const resetValue = findFirstValue(record, [
    /^reset(s|_at|At)?$/i,
    /^current_?period_?(end|reset)(s|_at|At)?$/i,
    /^period_?(end|reset)(s|_at|At)?$/i,
    /^next_?reset(_at|At)?$/i,
  ])
  const resetLabelValue = findFirstValue(record, [
    /^reset_?label$/i,
    /^reset_?text$/i,
    /^next_?reset_?label$/i,
  ])

  const percent = typeof percentValue === "number"
    ? percentValue
    : typeof percentValue === "string"
      ? Number(percentValue)
      : null

  if (!Number.isFinite(percent)) return null

  return {
    sessionLimitUsedPercent: toPercent(percent),
    apiPercentUsed: null,
    rateLimitResetAt: parseCursorTimestamp(resetValue),
    rateLimitResetLabel: normalizeCursorResetLabel(resetLabelValue),
  }
}

function parseCursorProfileCookiesDb(args: {
  cookiesPath: string
  browserName: string
  platform: NodeJS.Platform
}): CursorSessionCookie[] {
  const tempDir = mkdtempSync(path.join(tmpdir(), "kanna-cursor-cookies-"))
  const tempDbPath = path.join(tempDir, "Cookies")
  try {
    copyFileSync(args.cookiesPath, tempDbPath)
    const database = new Database(tempDbPath, { readonly: true })
    try {
      const rows = database
        .query(`
          SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly
          FROM cookies
          WHERE host_key LIKE '%cursor.com'
        `)
        .all() as Array<{
          host_key: string
          name: string
          value: string
          encrypted_value: Uint8Array | null
          path: string
          expires_utc: number
          is_secure: number
          is_httponly: number
        }>

      const key = getChromiumCookieKey({
        cookiesPath: args.cookiesPath,
        browserName: args.browserName,
        platform: args.platform,
      })

      return rows
        .map((row) => {
          const value = row.value || decryptChromiumCookieValue(row.encrypted_value, key, args.platform)
          if (!value) return null
          return {
            name: row.name,
            value,
            domain: normalizeCookieDomain(row.host_key),
            path: row.path || "/",
            expiresAt: chromeTimestampToUnixMs(row.expires_utc),
            secure: row.is_secure === 1,
            httpOnly: row.is_httponly === 1,
          } satisfies CursorSessionCookie
        })
        .filter((cookie): cookie is CursorSessionCookie => Boolean(cookie))
    } finally {
      database.close()
    }
  } catch {
    return []
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function chromeTimestampToUnixMs(value: number | null | undefined) {
  if (!value || value <= 0) return null
  return CHROME_EPOCH_OFFSET_MS + Math.floor(value / 1000)
}

function browserRootCandidates(platform: NodeJS.Platform) {
  const home = homedir()
  if (platform === "darwin") {
    return [
      {
        name: "chrome",
        rootPath: path.join(home, "Library", "Application Support", "Google", "Chrome"),
        safeStorageName: "Chrome Safe Storage",
      },
      {
        name: "chromium",
        rootPath: path.join(home, "Library", "Application Support", "Chromium"),
        safeStorageName: "Chromium Safe Storage",
      },
      {
        name: "brave",
        rootPath: path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
        safeStorageName: "Brave Safe Storage",
      },
    ]
  }

  if (platform === "linux") {
    return [
      {
        name: "chrome",
        rootPath: path.join(home, ".config", "google-chrome"),
        safeStorageName: "Chrome Safe Storage",
      },
      {
        name: "chromium",
        rootPath: path.join(home, ".config", "chromium"),
        safeStorageName: "Chromium Safe Storage",
      },
      {
        name: "brave",
        rootPath: path.join(home, ".config", "BraveSoftware", "Brave-Browser"),
        safeStorageName: "Brave Safe Storage",
      },
    ]
  }

  return []
}

function discoverChromiumCookieSources(platform: NodeJS.Platform) {
  const profiles: Array<{ browserName: string; cookiesPath: string }> = []
  for (const browser of browserRootCandidates(platform)) {
    if (!existsSync(browser.rootPath)) continue
    for (const entry of readdirSync(browser.rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name !== "Default" && !entry.name.startsWith("Profile ")) continue
      const cookiesPath = path.join(browser.rootPath, entry.name, "Cookies")
      if (!existsSync(cookiesPath)) continue
      profiles.push({ browserName: browser.name, cookiesPath })
    }
  }
  return profiles
}

function safeStoragePasswordForMac(safeStorageName: string) {
  const result = Bun.spawnSync(["security", "find-generic-password", "-w", "-s", safeStorageName], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  if (result.exitCode !== 0) return null
  const output = new TextDecoder().decode(result.stdout).trim()
  return output || null
}

function safeStoragePasswordForLinux(browserName: string, safeStorageName: string) {
  const candidateCommands = [
    ["secret-tool", "lookup", "application", browserName],
    ["secret-tool", "lookup", "service", safeStorageName],
    ["secret-tool", "lookup", "application", `${browserName} Safe Storage`],
  ]

  for (const command of candidateCommands) {
    const result = Bun.spawnSync(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    if (result.exitCode !== 0) continue
    const output = new TextDecoder().decode(result.stdout).trim()
    if (output) return output
  }

  return "peanuts"
}

function getChromiumCookieKey(args: {
  cookiesPath: string
  browserName: string
  platform: NodeJS.Platform
}) {
  const browser = browserRootCandidates(args.platform).find((candidate) => candidate.name === args.browserName)
  if (!browser) return null
  const password = args.platform === "darwin"
    ? safeStoragePasswordForMac(browser.safeStorageName)
    : args.platform === "linux"
      ? safeStoragePasswordForLinux(args.browserName, browser.safeStorageName)
      : null

  if (!password) return null

  const iterations = args.platform === "darwin" ? 1003 : 1
  return pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1")
}

function decryptChromiumCookieValue(
  encryptedValue: Uint8Array | null,
  key: Buffer | null,
  platform: NodeJS.Platform
) {
  if (!encryptedValue || encryptedValue.length === 0 || !key) return null
  const encrypted = Buffer.from(encryptedValue)
  const versionPrefix = encrypted.subarray(0, 3).toString("utf8")
  if (platform !== "darwin" && platform !== "linux") return null
  if (versionPrefix !== "v10" && versionPrefix !== "v11") return null

  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20))
    const decrypted = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ])
    return decrypted.toString("utf8")
  } catch {
    return null
  }
}

function bootstrapCursorSessionFromBrowser(platform = process.platform): CursorSessionCache | null {
  if (platform !== "linux" && platform !== "darwin") return null

  for (const source of discoverChromiumCookieSources(platform)) {
    const cookies = parseCursorProfileCookiesDb({
      cookiesPath: source.cookiesPath,
      browserName: source.browserName,
      platform,
    })
    if (!cookies.some((cookie) => cookie.name === CURSOR_SESSION_COOKIE_NAME)) continue
    return {
      cookies,
      updatedAt: Date.now(),
      lastSuccessAt: null,
    }
  }

  return null
}

async function fetchCursorEndpoint(args: {
  url: string
  method?: "GET" | "POST"
  session: CursorSessionCache
  body?: unknown
}) {
  const response = await fetch(args.url, {
    method: args.method ?? "GET",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      origin: "https://cursor.com",
      referer: CURSOR_DASHBOARD_URL,
      cookie: buildCursorCookieHeader(args.session.cookies),
      "user-agent": "Kanna/1.0",
    },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  })

  const mergedSession: CursorSessionCache = {
    cookies: mergeCursorCookies(args.session.cookies, responseSetCookies(response)),
    updatedAt: Date.now(),
    lastSuccessAt: args.session.lastSuccessAt,
  }

  return { response, session: mergedSession }
}

function isCursorAuthFailure(response: Response) {
  return response.status === 401 || response.status === 403
}

async function attemptCursorUsageFetch(session: CursorSessionCache) {
  const { response, session: nextSession } = await fetchCursorEndpoint({
    url: CURSOR_USAGE_URL,
    method: "POST",
    session,
    body: {},
  })

  if (isCursorAuthFailure(response)) {
    return { ok: false as const, authFailed: true, session: nextSession, payload: null }
  }

  if (!response.ok) {
    return { ok: false as const, authFailed: false, session: nextSession, payload: null }
  }

  const payload = parseCursorUsagePayload(await response.json().catch(() => null))
  if (!payload) {
    return { ok: false as const, authFailed: false, session: nextSession, payload: null }
  }

  return { ok: true as const, authFailed: false, session: nextSession, payload }
}

async function refreshCursorSessionFromDashboard(session: CursorSessionCache) {
  const { response, session: nextSession } = await fetchCursorEndpoint({
    url: CURSOR_DASHBOARD_URL,
    method: "GET",
    session,
  })

  if (!response.ok && !isCursorAuthFailure(response)) {
    return { ok: false as const, session: nextSession }
  }

  return { ok: true as const, session: nextSession }
}

export async function refreshCursorUsage(dataDir: string, platform = process.platform, force = false): Promise<ProviderUsageEntry> {
  const now = Date.now()
  const persistedEntry = loadPersistedCursorUsageEntry(dataDir)
  const lastRequestedAt = persistedEntry?.lastRequestedAt ?? readProviderUsageLastRequestedAt(dataDir, "cursor")
  const needsCursorUsageSplitRefresh = persistedEntry?.availability === "available"
    && persistedEntry.sessionLimitUsedPercent !== null
    && persistedEntry.apiLimitUsedPercent === undefined

  if (!force && now - lastRequestedAt < PROVIDER_USAGE_REQUEST_MIN_INTERVAL_MS && persistedEntry && !needsCursorUsageSplitRefresh) {
    return persistedEntry
  }

  recordProviderUsageRequestTime(dataDir, "cursor", now)

  let session = loadPersistedCursorSession(dataDir)

  if (!session) {
    session = bootstrapCursorSessionFromBrowser(platform)
    if (session) {
      persistCursorSession(dataDir, session)
    }
  }

  if (!session) {
    const entry = cursorStatusEntry({
      availability: platform === "linux" || platform === "darwin" ? "login_required" : "unavailable",
      statusDetail: platform === "linux" || platform === "darwin" ? "browser_cookie_import_failed" : "unsupported_platform",
      lastRequestedAt: now,
    })
    persistCursorUsageEntry(dataDir, entry)
    return entry
  }

  let result = await attemptCursorUsageFetch(session)
  session = result.session

  if (result.authFailed) {
    const refreshed = await refreshCursorSessionFromDashboard(session)
    session = refreshed.session
    result = await attemptCursorUsageFetch(session)
    session = result.session
  }

  if (!result.ok && result.authFailed) {
    const bootstrapped = bootstrapCursorSessionFromBrowser(platform)
    if (bootstrapped) {
      session = {
        cookies: mergeCursorCookies(session.cookies, bootstrapped.cookies),
        updatedAt: Date.now(),
        lastSuccessAt: session.lastSuccessAt,
      }
      result = await attemptCursorUsageFetch(session)
      session = result.session
    }
  }

  if (session.cookies.length > 0) {
    persistCursorSession(dataDir, session)
  }

  if (!result.ok || !result.payload) {
    const entry = cursorStatusEntry({
      availability: result.authFailed ? "login_required" : "unavailable",
      statusDetail: result.authFailed ? "session_refresh_failed" : "fetch_failed",
      lastRequestedAt: now,
      updatedAt: session.lastSuccessAt,
    })
    persistCursorUsageEntry(dataDir, entry)
    return entry
  }

  session.lastSuccessAt = Date.now()
  session.updatedAt = session.lastSuccessAt
  persistCursorSession(dataDir, session)

  const entry = cursorEntryFromSuccess(result.payload, session.lastSuccessAt, now)
  persistCursorUsageEntry(dataDir, entry)
  return entry
}

export async function importCursorUsageFromCurl(dataDir: string, curlCommand: string, platform = process.platform) {
  const imported = importCursorSessionFromCurl(curlCommand)
  if (!imported) {
    return cursorStatusEntry({
      availability: "login_required",
      statusDetail: "invalid_curl_import",
      lastRequestedAt: Date.now(),
    })
  }

  const existing = loadPersistedCursorSession(dataDir)
  const session: CursorSessionCache = {
    cookies: mergeCursorCookies(existing?.cookies ?? [], imported.cookies),
    updatedAt: Date.now(),
    lastSuccessAt: existing?.lastSuccessAt ?? null,
  }
  persistCursorSession(dataDir, session)
  return refreshCursorUsage(dataDir, platform)
}

function resolveBrowserExecutable(platform = process.platform) {
  const resolvedCommand = resolveCommandPath("google-chrome")
    ?? resolveCommandPath("chromium")
    ?? resolveCommandPath("chromium-browser")
    ?? resolveCommandPath("brave-browser")
  if (resolvedCommand) return resolvedCommand

  if (platform === "darwin") {
    if (canOpenMacApp("Google Chrome")) return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if (canOpenMacApp("Chromium")) return "/Applications/Chromium.app/Contents/MacOS/Chromium"
    if (canOpenMacApp("Brave Browser")) return "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }

  return null
}

function sessionFromBrowserCookies(cookies: Array<{
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  secure?: boolean
  httpOnly?: boolean
}>): CursorSessionCache {
  return {
    cookies: cookies
      .filter((cookie) => normalizeCookieDomain(cookie.domain ?? "cursor.com").endsWith("cursor.com"))
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: normalizeCookieDomain(cookie.domain ?? "cursor.com"),
        path: cookie.path ?? "/",
        expiresAt: typeof cookie.expires === "number" && Number.isFinite(cookie.expires) ? cookie.expires * 1000 : null,
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly === true,
      })),
    updatedAt: Date.now(),
    lastSuccessAt: null,
  }
}

export async function signInToCursorWithBrowser(dataDir: string, platform = process.platform) {
  const executablePath = resolveBrowserExecutable(platform)
  if (!executablePath) {
    return cursorStatusEntry({
      availability: "login_required",
      statusDetail: "browser_launch_failed",
      lastRequestedAt: Date.now(),
    })
  }

  const userDataDir = mkdtempSync(path.join(tmpdir(), "kanna-cursor-login-"))
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir,
      defaultViewport: null,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
      ],
    })

    const page = await browser.newPage()
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      })
    })
    await page.goto(CURSOR_DASHBOARD_URL, { waitUntil: "domcontentloaded" })

    const start = Date.now()
    let session: CursorSessionCache | null = null
    while (Date.now() - start < CURSOR_BROWSER_LOGIN_TIMEOUT_MS) {
      const cookies = await page.cookies(CURSOR_DASHBOARD_URL)
      if (cookies.some((cookie) => cookie.name === CURSOR_SESSION_COOKIE_NAME && cookie.value)) {
        session = sessionFromBrowserCookies(cookies)
        break
      }
      await Bun.sleep(1000)
    }

    if (!session) {
      return cursorStatusEntry({
        availability: "login_required",
        statusDetail: "browser_login_failed",
        lastRequestedAt: Date.now(),
      })
    }

    persistCursorSession(dataDir, session)
    return refreshCursorUsage(dataDir, platform)
  } catch {
    return cursorStatusEntry({
      availability: "login_required",
      statusDetail: "browser_login_failed",
      lastRequestedAt: Date.now(),
    })
  } finally {
    try {
      await browser?.close()
    } catch { /* noop */ }
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function deriveAvailability(updatedAt: number | null): ProviderUsageAvailability {
  if (updatedAt === null) return "available"
  if (updatedAt < Date.now() - STALE_AFTER_MS) return "stale"
  if (Date.now() < updatedAt) return "stale"
  return "available"
}

function snapshotToEntry(provider: AgentProvider, snapshot: ChatUsageSnapshot | null): ProviderUsageEntry {
  if (!snapshot) {
    return {
      provider,
      sessionLimitUsedPercent: null,
      apiLimitUsedPercent: null,
      rateLimitResetAt: null,
      rateLimitResetLabel: null,
      weeklyLimitUsedPercent: null,
      weeklyRateLimitResetAt: null,
      weeklyRateLimitResetLabel: null,
      statusDetail: null,
      availability: "available",
      updatedAt: null,
      warnings: [],
    }
  }

  const availability = deriveAvailability(snapshot.updatedAt)
  const warnings = usageWarnings({
    contextUsedPercent: null,
    sessionLimitUsedPercent: snapshot.sessionLimitUsedPercent,
    updatedAt: snapshot.updatedAt,
  })

  return {
    provider,
    sessionLimitUsedPercent: snapshot.sessionLimitUsedPercent,
    apiLimitUsedPercent: null,
    rateLimitResetAt: snapshot.rateLimitResetAt,
    rateLimitResetLabel: (snapshot as ProviderRateLimitSnapshot).rateLimitResetLabel ?? null,
    weeklyLimitUsedPercent: (snapshot as ProviderRateLimitSnapshot).weeklyLimitUsedPercent ?? null,
    weeklyRateLimitResetAt: (snapshot as ProviderRateLimitSnapshot).weeklyRateLimitResetAt ?? null,
    weeklyRateLimitResetLabel: (snapshot as ProviderRateLimitSnapshot).weeklyRateLimitResetLabel ?? null,
    statusDetail: null,
    availability,
    updatedAt: snapshot.updatedAt,
    warnings,
  }
}

function unavailableEntry(provider: AgentProvider): ProviderUsageEntry {
  return {
    provider,
    sessionLimitUsedPercent: null,
    apiLimitUsedPercent: null,
    rateLimitResetAt: null,
    rateLimitResetLabel: null,
    weeklyLimitUsedPercent: null,
    weeklyRateLimitResetAt: null,
    weeklyRateLimitResetLabel: null,
    statusDetail: null,
    availability: "unavailable",
    updatedAt: null,
    warnings: [],
  }
}

export function deriveProviderUsage(
  liveUsage: Map<string, ChatUsageSnapshot>,
  store: EventStore
): ProviderUsageMap {
  const result: ProviderUsageMap = {}

  let latestClaude: ChatUsageSnapshot | null = null
  let latestCodex: ChatUsageSnapshot | null = null

  for (const snapshot of liveUsage.values()) {
    if (snapshot.provider === "claude") {
      if (!latestClaude || (snapshot.updatedAt ?? 0) > (latestClaude.updatedAt ?? 0)) {
        latestClaude = snapshot
      }
    }
    if (snapshot.provider === "codex") {
      if (!latestCodex || (snapshot.updatedAt ?? 0) > (latestCodex.updatedAt ?? 0)) {
        latestCodex = snapshot
      }
    }
  }

  const persistedClaude = loadPersistedClaudeRateLimit(store.dataDir)
  latestClaude = mergeClaudeProviderSnapshot(latestClaude, persistedClaude)

  if (hasClaudeSidebarRateLimitData(latestClaude)) {
    persistClaudeRateLimit(store.dataDir, latestClaude)
  }

  result.claude = snapshotToEntry("claude", latestClaude)

  if (!latestCodex) {
    const now = Date.now()
    if (codexUsageCache && now - codexUsageCache.cachedAt < PROVIDER_CACHE_TTL_MS) {
      latestCodex = codexUsageCache.snapshot
    } else {
      let bestSnapshot: ChatUsageSnapshot | null = null
      let bestMessageAt = 0

      for (const chat of store.state.chatsById.values()) {
        if (chat.deletedAt || chat.provider !== "codex" || !chat.sessionToken) continue
        const messageAt = chat.lastMessageAt ?? chat.updatedAt ?? 0
        if (messageAt > bestMessageAt) {
          bestMessageAt = messageAt
          const reconstructed = reconstructCodexUsageFromFile(chat.sessionToken)
          if (reconstructed) {
            bestSnapshot = reconstructed
          }
        }
      }

      codexUsageCache = { snapshot: bestSnapshot, cachedAt: now }
      latestCodex = bestSnapshot
    }
  }

  result.codex = snapshotToEntry("codex", latestCodex)

  result.gemini = unavailableEntry("gemini")
  result.cursor = loadPersistedCursorUsageEntry(store.dataDir) ?? unavailableEntry("cursor")

  return result
}
