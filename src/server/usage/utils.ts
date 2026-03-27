import type {
  AgentProvider,
  ChatUsageSnapshot,
  ChatUsageWarning,
  ProviderUsageAvailability,
  ProviderUsageEntry,
  TranscriptEntry,
} from "../../shared/types"
import type { NumericUsage, ProviderRateLimitSnapshot } from "./types"

export const WARNING_THRESHOLD = 75
export const CRITICAL_THRESHOLD = 90
export const STALE_AFTER_MS = 5 * 60 * 1000

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return null
  }
}

export function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function toPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

export function usageWarnings(args: {
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

export function relevantMessagesForCurrentContext(messages: TranscriptEntry[]) {
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

export function buildSnapshot(args: {
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

export function usageTotals(usage: Record<string, unknown>): NumericUsage & { totalTokens: number } {
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

export function deriveAvailability(updatedAt: number | null): ProviderUsageAvailability {
  if (updatedAt === null) return "available"
  if (updatedAt < Date.now() - STALE_AFTER_MS) return "stale"
  if (Date.now() < updatedAt) return "stale"
  return "available"
}

export function snapshotToEntry(provider: AgentProvider, snapshot: ChatUsageSnapshot | null): ProviderUsageEntry {
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

export function unavailableEntry(provider: AgentProvider): ProviderUsageEntry {
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
