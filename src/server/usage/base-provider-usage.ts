import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { AgentProvider, ProviderUsageEntry } from "../../shared/types"
import { PROVIDERS } from "../../shared/types"

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
    for (const provider of PROVIDERS.map((entry) => entry.id)) {
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

export abstract class BaseProviderUsage {
  protected readonly dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  protected recordRequestTime(provider: AgentProvider, at = Date.now()): void {
    try {
      const next = loadProviderUsageRequestTimes(this.dataDir)
      next[provider] = at
      writeFileSync(providerUsageRequestTimesPath(this.dataDir), JSON.stringify(next))
    } catch {
      // best-effort
    }
  }

  protected readLastRequestedAt(provider: AgentProvider): number {
    return loadProviderUsageRequestTimes(this.dataDir)[provider] ?? 0
  }

  protected shouldSkipRefresh(provider: AgentProvider, minInterval: number, force = false): boolean {
    if (force) return false
    return Date.now() - this.readLastRequestedAt(provider) < minInterval
  }

  abstract readonly provider: AgentProvider
  abstract loadPersistedEntry(): ProviderUsageEntry | null
}
