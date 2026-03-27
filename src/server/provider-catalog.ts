import type {
  AgentProvider,
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  GeminiModelOptions,
  ModelOptions,
  ProviderCatalogEntry,
  ServiceTier,
} from "../shared/types"
import {
  getProviderCatalog,
  getProviderDefaultModelOptions,
  isClaudeReasoningEffort,
  isCodexReasoningEffort,
  isGeminiThinkingMode,
  normalizeCursorModelId,
} from "../shared/types"

export function getServerProviderCatalog(provider: AgentProvider): ProviderCatalogEntry {
  return getProviderCatalog(provider)
}

export function normalizeServerModel(provider: AgentProvider, model?: string): string {
  if (provider === "cursor") {
    return normalizeCursorModelId(model)
  }
  const catalog = getServerProviderCatalog(provider)
  if (model && catalog.models.some((candidate) => candidate.id === model)) {
    return model
  }
  return catalog.defaultModel
}

export function normalizeClaudeModelOptions(modelOptions?: ModelOptions, legacyEffort?: string): ClaudeModelOptions {
  const defaultOptions = getProviderDefaultModelOptions("claude")
  const reasoningEffort = modelOptions?.claude?.reasoningEffort
  return {
    reasoningEffort: isClaudeReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isClaudeReasoningEffort(legacyEffort)
        ? legacyEffort
        : defaultOptions.reasoningEffort,
  }
}

export function normalizeCodexModelOptions(modelOptions?: ModelOptions, legacyEffort?: string): CodexModelOptions {
  const defaultOptions = getProviderDefaultModelOptions("codex")
  const reasoningEffort = modelOptions?.codex?.reasoningEffort
  return {
    reasoningEffort: isCodexReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isCodexReasoningEffort(legacyEffort)
        ? legacyEffort
        : defaultOptions.reasoningEffort,
    fastMode: typeof modelOptions?.codex?.fastMode === "boolean"
      ? modelOptions.codex.fastMode
      : defaultOptions.fastMode,
  }
}

export function normalizeGeminiModelOptions(modelOptions?: ModelOptions): GeminiModelOptions {
  const defaultOptions = getProviderDefaultModelOptions("gemini")
  return {
    thinkingMode: isGeminiThinkingMode(modelOptions?.gemini?.thinkingMode)
      ? modelOptions.gemini.thinkingMode
      : defaultOptions.thinkingMode,
  }
}

export function normalizeCursorModelOptions(modelOptions?: ModelOptions): CursorModelOptions {
  void modelOptions
  return { ...getProviderDefaultModelOptions("cursor") }
}

export function codexServiceTierFromModelOptions(modelOptions: CodexModelOptions): ServiceTier | undefined {
  return modelOptions.fastMode ? "fast" : undefined
}
