import type { ProviderUsageEntry } from "../../shared/types"
import { BaseProviderUsage } from "./base-provider-usage"
import { unavailableEntry } from "./utils"

export class GeminiUsage extends BaseProviderUsage {
  readonly provider = "gemini" as const

  loadPersistedEntry(): ProviderUsageEntry | null {
    return unavailableEntry(this.provider)
  }

  deriveEntry(): ProviderUsageEntry {
    return unavailableEntry(this.provider)
  }
}

const _instances = new Map<string, GeminiUsage>()

export function getGeminiUsage(dataDir: string): GeminiUsage {
  if (!_instances.has(dataDir)) {
    _instances.set(dataDir, new GeminiUsage(dataDir))
  }
  return _instances.get(dataDir)!
}
