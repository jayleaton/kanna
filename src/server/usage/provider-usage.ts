import { PROVIDERS, type AgentProvider, type ChatUsageSnapshot, type ProviderUsageMap } from "../../shared/types"
import type { EventStore } from "../event-store"
import type { BaseProviderUsage } from "./base-provider-usage"
import { getClaudeUsage } from "./claude-usage"
import { getCodexUsage } from "./codex-usage"
import { getCursorUsage } from "./cursor-usage"
import { getGeminiUsage } from "./gemini-usage"
import { unavailableEntry } from "./utils"

export function getProviderUsage(provider: AgentProvider, dataDir: string): BaseProviderUsage {
  if (provider === "claude") return getClaudeUsage(dataDir)
  if (provider === "codex") return getCodexUsage(dataDir)
  if (provider === "cursor") return getCursorUsage(dataDir)
  return getGeminiUsage(dataDir)
}

function latestLiveSnapshotForProvider(
  provider: AgentProvider,
  liveUsage: Map<string, ChatUsageSnapshot>
): ChatUsageSnapshot | null {
  let latest: ChatUsageSnapshot | null = null

  for (const snapshot of liveUsage.values()) {
    if (snapshot.provider !== provider) continue
    if (!latest || (snapshot.updatedAt ?? 0) > (latest.updatedAt ?? 0)) {
      latest = snapshot
    }
  }

  return latest
}

export function deriveProviderUsage(
  liveUsage: Map<string, ChatUsageSnapshot>,
  store: EventStore
): ProviderUsageMap {
  const result: ProviderUsageMap = {}

  for (const provider of PROVIDERS) {
    const liveSnapshot = latestLiveSnapshotForProvider(provider.id, liveUsage)

    if (provider.id === "claude") {
      result[provider.id] = getClaudeUsage(store.dataDir).deriveEntry(liveSnapshot)
      continue
    }

    if (provider.id === "codex") {
      result[provider.id] = getCodexUsage(store.dataDir).deriveEntry(liveSnapshot, store)
      continue
    }

    if (provider.id === "cursor") {
      result[provider.id] = getCursorUsage(store.dataDir).loadPersistedEntry() ?? unavailableEntry("cursor")
      continue
    }

    result[provider.id] = getGeminiUsage(store.dataDir).deriveEntry()
  }

  return result
}
