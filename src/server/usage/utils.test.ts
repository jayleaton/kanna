import { describe, expect, test } from "bun:test"
import { applyThreadEstimate, estimateCurrentThreadTokens, mergeUsageSnapshots } from "./utils"
import { transcriptEntry } from "./test-helpers"

describe("usage utils", () => {
  test("merges reconstructed and live usage snapshots", () => {
    const merged = mergeUsageSnapshots(
      {
        provider: "claude",
        threadTokens: 2000,
        contextWindowTokens: 10000,
        contextUsedPercent: 20,
        lastTurnTokens: 2000,
        inputTokens: 1500,
        outputTokens: 500,
        cachedInputTokens: 0,
        reasoningOutputTokens: null,
        sessionLimitUsedPercent: null,
        rateLimitResetAt: null,
        source: "reconstructed",
        updatedAt: 1,
        warnings: [],
      },
      {
        provider: "claude",
        threadTokens: null,
        contextWindowTokens: null,
        contextUsedPercent: null,
        lastTurnTokens: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
        sessionLimitUsedPercent: 91,
        rateLimitResetAt: 999,
        source: "live",
        updatedAt: 2,
        warnings: [],
      }
    )

    expect(merged?.threadTokens).toBe(2000)
    expect(merged?.sessionLimitUsedPercent).toBe(91)
    expect(merged?.warnings).toContain("rate_critical")
  })

  test("estimates current thread size from the transcript and applies it to usage snapshots", () => {
    const messages = [
      transcriptEntry({ kind: "user_prompt", content: "A".repeat(800), createdAt: 1 }),
      transcriptEntry({ kind: "assistant_text", text: "B".repeat(1200), createdAt: 2 }),
    ]

    const estimated = estimateCurrentThreadTokens(messages)
    expect(estimated).toBeGreaterThan(400)

    const snapshot = applyThreadEstimate({
      provider: "codex",
      threadTokens: null,
      contextWindowTokens: 10000,
      contextUsedPercent: null,
      lastTurnTokens: 3000,
      inputTokens: 2800,
      outputTokens: 200,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      sessionLimitUsedPercent: 10,
      rateLimitResetAt: null,
      source: "reconstructed",
      updatedAt: 10,
      warnings: [],
    }, messages)

    expect(snapshot?.threadTokens).toBe(estimated)
    expect(snapshot?.contextUsedPercent).toBeGreaterThan(1)
  })
})
