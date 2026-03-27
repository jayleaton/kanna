import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  parseClaudeUsageScreen,
  refreshClaudeRateLimitFromCli,
  reconstructClaudeUsage,
} from "./claude-usage"
import { transcriptEntry } from "./test-helpers"

describe("claude usage", () => {
  test("dedupes repeated Claude usage records that share the same raw message", () => {
    const debugRaw = JSON.stringify({
      type: "assistant",
      uuid: "assistant-1",
      message: {
        usage: {
          input_tokens: 1200,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 100,
          output_tokens: 80,
        },
      },
    })

    const snapshot = reconstructClaudeUsage([
      transcriptEntry({ kind: "assistant_text", text: "hello", debugRaw, messageId: "assistant-1", createdAt: 10 }),
      transcriptEntry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-1",
          input: { command: "pwd" },
        },
        debugRaw,
        messageId: "assistant-1",
        createdAt: 11,
      }),
    ])

    expect(snapshot?.threadTokens).toBe(8)
    expect(snapshot?.lastTurnTokens).toBe(1680)
    expect(snapshot?.inputTokens).toBe(1200)
    expect(snapshot?.cachedInputTokens).toBe(400)
    expect(snapshot?.outputTokens).toBe(80)
  })

  test("extracts Claude context window from result modelUsage", () => {
    const snapshot = reconstructClaudeUsage([
      transcriptEntry({
        kind: "system_init",
        provider: "claude",
        model: "sonnet",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        createdAt: 1,
      }),
      transcriptEntry({
        kind: "user_prompt",
        content: "A".repeat(4000),
        createdAt: 2,
      }),
      transcriptEntry({
        kind: "result",
        subtype: "success",
        isError: false,
        durationMs: 12,
        result: "done",
        createdAt: 20,
        debugRaw: JSON.stringify({
          type: "result",
          uuid: "result-1",
          usage: {
            input_tokens: 2000,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 100,
            output_tokens: 250,
          },
          modelUsage: {
            "claude-sonnet": {
              contextWindow: 200000,
            },
          },
        }),
      }),
    ])

    expect(snapshot?.threadTokens).toBeGreaterThan(900)
    expect(snapshot?.contextWindowTokens).toBe(200_000)
    expect(snapshot?.contextUsedPercent).not.toBeNull()
  })

  test("falls back to Claude model family context window when usage metadata omits it", () => {
    const snapshot = reconstructClaudeUsage([
      transcriptEntry({
        kind: "system_init",
        provider: "claude",
        model: "sonnet",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
        createdAt: 1,
      }),
      transcriptEntry({
        kind: "assistant_text",
        text: "B".repeat(2000),
        createdAt: 2,
        debugRaw: JSON.stringify({
          type: "assistant",
          uuid: "assistant-2",
          message: {
            usage: {
              input_tokens: 1000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 100,
            },
          },
        }),
      }),
    ])

    expect(snapshot?.contextWindowTokens).toBe(1_000_000)
  })

  test("parses Claude /usage screen output", () => {
    const parsed = parseClaudeUsageScreen(`
Current session
████████████████████████████████████████████▌      89% used
Resets 1pm (Asia/Bangkok)

Current week (all models)
██████████████████████████████████████████████     92% used
Resets Mar 30, 8am (Asia/Bangkok)
`)

    expect(parsed).toEqual({
      sessionLimitUsedPercent: 89,
      rateLimitResetLabel: "1pm (Asia/Bangkok)",
      weeklyLimitUsedPercent: 92,
      weeklyRateLimitResetLabel: "Mar 30, 8am (Asia/Bangkok)",
    })
  })

  test("parses Claude current session usage when the rolling window is zero", () => {
    const parsed = parseClaudeUsageScreen(`
Current session
0% used
Resets 5:59pm (Asia/Bangkok)

Current week (all models)
██████████████████████████████████████████████     92% used
Resets Mar 30, 8am (Asia/Bangkok)
`)

    expect(parsed).toEqual({
      sessionLimitUsedPercent: 0,
      rateLimitResetLabel: "5:59pm (Asia/Bangkok)",
      weeklyLimitUsedPercent: 92,
      weeklyRateLimitResetLabel: "Mar 30, 8am (Asia/Bangkok)",
    })
  })

  test("refreshes Claude rate limit from CLI output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-claude-cli-usage-"))
    try {
      const snapshot = await refreshClaudeRateLimitFromCli(root, async () => `
Current session
████████████████████████████████████████████▌      89% used
Resets 1pm (Asia/Bangkok)

Current week (all models)
██████████████████████████████████████████████     92% used
Resets Mar 30, 8am (Asia/Bangkok)
`)

      expect(snapshot?.provider).toBe("claude")
      expect(snapshot?.sessionLimitUsedPercent).toBe(89)
      const persisted = JSON.parse(readFileSync(path.join(root, "claude-rate-limit.json"), "utf8"))
      expect(persisted.rateLimitResetLabel).toBe("1pm (Asia/Bangkok)")
      expect(persisted.weeklyRateLimitResetLabel).toBe("Mar 30, 8am (Asia/Bangkok)")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("refreshes Claude rate limits when the rolling session window is zero", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-claude-cli-usage-"))
    try {
      const snapshot = await refreshClaudeRateLimitFromCli(root, async () => `
Current session
0% used
Resets 5:59pm (Asia/Bangkok)

Current week (all models)
██████████████████████████████████████████████     92% used
Resets Mar 30, 8am (Asia/Bangkok)
`)

      expect(snapshot?.provider).toBe("claude")
      expect(snapshot?.sessionLimitUsedPercent).toBe(0)
      const persisted = JSON.parse(readFileSync(path.join(root, "claude-rate-limit.json"), "utf8"))
      expect(persisted.sessionLimitUsedPercent).toBe(0)
      expect(persisted.rateLimitResetLabel).toBe("5:59pm (Asia/Bangkok)")
      expect(persisted.weeklyLimitUsedPercent).toBe(92)
      expect(persisted.weeklyRateLimitResetLabel).toBe("Mar 30, 8am (Asia/Bangkok)")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
