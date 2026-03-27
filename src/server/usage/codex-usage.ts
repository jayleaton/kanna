import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { ChatUsageSnapshot, ProviderUsageEntry } from "../../shared/types"
import type { EventStore } from "../event-store"
import { BaseProviderUsage } from "./base-provider-usage"
import type { ProviderRateLimitSnapshot } from "./types"
import { asRecord, buildSnapshot, parseJsonLine, snapshotToEntry, toNumber } from "./utils"

const PROVIDER_CACHE_TTL_MS = 30_000

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

export class CodexUsage extends BaseProviderUsage {
  readonly provider = "codex" as const
  private cache: { snapshot: ChatUsageSnapshot | null; cachedAt: number } | null = null

  loadPersistedEntry(): ProviderUsageEntry | null {
    return snapshotToEntry(this.provider, this.cache?.snapshot ?? null)
  }

  deriveFromStore(store: EventStore): ChatUsageSnapshot | null {
    const now = Date.now()
    if (this.cache && now - this.cache.cachedAt < PROVIDER_CACHE_TTL_MS) {
      return this.cache.snapshot
    }

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

    this.cache = { snapshot: bestSnapshot, cachedAt: now }
    return bestSnapshot
  }

  deriveEntry(liveSnapshot: ChatUsageSnapshot | null, store: EventStore): ProviderUsageEntry {
    return snapshotToEntry(this.provider, liveSnapshot ?? this.deriveFromStore(store))
  }
}

const _instances = new Map<string, CodexUsage>()

export function getCodexUsage(dataDir: string): CodexUsage {
  if (!_instances.has(dataDir)) {
    _instances.set(dataDir, new CodexUsage(dataDir))
  }
  return _instances.get(dataDir)!
}

export function resetCodexUsageCaches() {
  _instances.clear()
}
