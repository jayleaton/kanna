import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TranscriptEntry } from "../shared/types"
import {
  applyThreadEstimate,
  deriveProviderUsage,
  estimateCurrentThreadTokens,
  mergeUsageSnapshots,
  importCursorSessionFromCurl,
  parseCursorUsagePayload,
  parseClaudeUsageScreen,
  refreshClaudeRateLimitFromCli,
  refreshCursorUsage,
  reconstructClaudeUsage,
  reconstructCodexUsageFromFile,
} from "./usage"
import { EventStore } from "./event-store"

function transcriptEntry(overrides: Partial<TranscriptEntry> & Pick<TranscriptEntry, "kind">): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: 1,
    ...overrides,
  } as TranscriptEntry
}

describe("usage reconstruction", () => {
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
    expect(snapshot?.contextWindowTokens).toBe(200000)
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

    expect(snapshot?.contextWindowTokens).toBe(200000)
  })

  test("reconstructs Codex usage from persisted token_count records", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-codex-usage-"))
    const sessionsDir = path.join(root, ".codex", "sessions", "2026", "03", "21")
    const sessionFile = path.join(sessionsDir, "rollout-thread-1.jsonl")
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(sessionFile, [
      JSON.stringify({
        timestamp: "2026-03-21T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "thread-1", cwd: "/tmp/project" },
      }),
      JSON.stringify({
        timestamp: "2026-03-21T10:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 12000,
              cached_input_tokens: 3000,
              output_tokens: 900,
              reasoning_output_tokens: 200,
              total_tokens: 16100,
            },
            last_token_usage: {
              total_tokens: 4200,
            },
            model_context_window: 258400,
          },
          rate_limits: {
            primary: {
              used_percent: 82,
              window_minutes: 300,
              resets_at: 1773838096,
            },
            secondary: {
              used_percent: 91,
              window_minutes: 10080,
              resets_at: 1774000000,
            },
          },
        },
      }),
    ].join("\n"))

    try {
      const snapshot = reconstructCodexUsageFromFile("thread-1", path.join(root, ".codex", "sessions"))
      expect(snapshot?.threadTokens).toBeNull()
      expect(snapshot?.lastTurnTokens).toBe(4200)
      expect(snapshot?.contextWindowTokens).toBe(258400)
      expect(snapshot?.sessionLimitUsedPercent).toBe(82)
      expect((snapshot as { weeklyLimitUsedPercent?: number | null })?.weeklyLimitUsedPercent).toBe(91)
      expect((snapshot as { weeklyRateLimitResetAt?: number | null })?.weeklyRateLimitResetAt).toBe(1774000000 * 1000)
      expect(snapshot?.warnings).toContain("rate_warning")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  test("upgrades legacy Claude weekly cache entries that were stored in the session field", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-claude-cli-usage-"))
    try {
      writeFileSync(path.join(root, "claude-rate-limit.json"), JSON.stringify({
        sessionLimitUsedPercent: 92,
        rateLimitResetAt: null,
        rateLimitResetLabel: "Mar 30, 8am (Asia/Bangkok)",
        updatedAt: Date.now(),
      }))

      const store = new EventStore(root)
      await store.initialize()
      const usage = deriveProviderUsage(new Map(), store)

      expect(usage.claude).toMatchObject({
        sessionLimitUsedPercent: 0,
        rateLimitResetLabel: "5:59pm (Asia/Bangkok)",
        weeklyLimitUsedPercent: 92,
        weeklyRateLimitResetLabel: "Mar 30, 8am (Asia/Bangkok)",
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("parses Cursor usage payloads", () => {
    const parsed = parseCursorUsagePayload({
      current_period: {
        used_percent: 41,
        reset_at: "2026-03-30T08:00:00.000Z",
      },
    })

    expect(parsed).toEqual({
      sessionLimitUsedPercent: 41,
      apiPercentUsed: null,
      rateLimitResetAt: Date.parse("2026-03-30T08:00:00.000Z"),
      rateLimitResetLabel: null,
    })
  })

  test("parses Cursor dashboard usage payloads", () => {
    const parsed = parseCursorUsagePayload({
      billingCycleEnd: "1774600782000",
      planUsage: {
        autoPercentUsed: 0.6466666666666666,
        apiPercentUsed: 33.4,
      },
      displayMessage: "You've used 64% of your usage limit",
    })

    expect(parsed).toEqual({
      sessionLimitUsedPercent: 0.6466666666666666,
      apiPercentUsed: 33.4,
      rateLimitResetAt: null,
      rateLimitResetLabel: null,
    })
  })

  test("imports Cursor cookies from a copied curl command", () => {
    const imported = importCursorSessionFromCurl(`curl 'https://cursor.com/api/dashboard/get-current-period-usage' -H 'accept: */*' -b 'workos_id=user_123; WorkosCursorSessionToken=session_abc; cursor_anonymous_id=anon_1' --data-raw '{}'`)

    expect(imported?.cookies.find((cookie) => cookie.name === "WorkosCursorSessionToken")?.value).toBe("session_abc")
    expect(imported?.cookies.find((cookie) => cookie.name === "workos_id")?.value).toBe("user_123")
  })

  test("refreshes Cursor usage and persists a server-side session jar", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-cursor-usage-"))
    const originalFetch = globalThis.fetch
    let usageCallCount = 0

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/dashboard/get-current-period-usage")) {
        usageCallCount += 1
        return new Response(JSON.stringify({
          usage: {
            used_percent: 64,
            reset_at: "2026-03-30T08:00:00.000Z",
          },
        }), {
          status: 200,
          headers: {
            "set-cookie": "WorkosCursorSessionToken=rotated-session; Domain=.cursor.com; Path=/; HttpOnly; Secure",
          },
        })
      }

      return new Response("<html></html>", { status: 200 })
    }) as typeof fetch

    try {
      writeFileSync(path.join(root, "cursor-session.json"), JSON.stringify({
        cookies: [{
          name: "WorkosCursorSessionToken",
          value: "existing-session",
          domain: "cursor.com",
          path: "/",
          expiresAt: null,
          secure: true,
          httpOnly: true,
        }],
        updatedAt: 1,
        lastSuccessAt: null,
      }))

      const entry = await refreshCursorUsage(root)
      expect(entry.availability).toBe("available")
      expect(entry.sessionLimitUsedPercent).toBe(64)
      expect(typeof entry.lastRequestedAt).toBe("number")
      expect(usageCallCount).toBe(1)

      const persistedSession = JSON.parse(readFileSync(path.join(root, "cursor-session.json"), "utf8"))
      expect(persistedSession.cookies[0]?.value).toBe("rotated-session")
      const persistedUsage = JSON.parse(readFileSync(path.join(root, "cursor-usage.json"), "utf8"))
      expect(typeof persistedUsage.lastRequestedAt).toBe("number")
    } finally {
      globalThis.fetch = originalFetch
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reuses persisted Cursor usage for at least two minutes between requests", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-cursor-throttle-"))
    const originalFetch = globalThis.fetch
    let usageCallCount = 0

    globalThis.fetch = (async () => {
      usageCallCount += 1
      return new Response(JSON.stringify({
        planUsage: {
          autoPercentUsed: 0.5,
        },
        displayMessage: "You've used 50% of your usage limit",
      }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      writeFileSync(path.join(root, "cursor-session.json"), JSON.stringify({
        cookies: [{
          name: "WorkosCursorSessionToken",
          value: "existing-session",
          domain: "cursor.com",
          path: "/",
          expiresAt: null,
          secure: true,
          httpOnly: true,
        }],
        updatedAt: 1,
        lastSuccessAt: null,
      }))

      const first = await refreshCursorUsage(root)
      const second = await refreshCursorUsage(root)

      expect(first.sessionLimitUsedPercent).toBe(0.5)
      expect(second.sessionLimitUsedPercent).toBe(0.5)
      expect(usageCallCount).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("refreshes legacy persisted Cursor usage that is missing API percent", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-cursor-legacy-split-"))
    const originalFetch = globalThis.fetch
    let usageCallCount = 0

    globalThis.fetch = (async () => {
      usageCallCount += 1
      return new Response(JSON.stringify({
        planUsage: {
          autoPercentUsed: 0.6466666666666666,
          apiPercentUsed: 33.4,
        },
      }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      writeFileSync(path.join(root, "cursor-session.json"), JSON.stringify({
        cookies: [{
          name: "WorkosCursorSessionToken",
          value: "existing-session",
          domain: "cursor.com",
          path: "/",
          expiresAt: null,
          secure: true,
          httpOnly: true,
        }],
        updatedAt: 1,
        lastSuccessAt: null,
      }))

      writeFileSync(path.join(root, "cursor-usage.json"), JSON.stringify({
        provider: "cursor",
        sessionLimitUsedPercent: 64,
        rateLimitResetAt: null,
        rateLimitResetLabel: null,
        weeklyLimitUsedPercent: null,
        weeklyRateLimitResetAt: null,
        weeklyRateLimitResetLabel: null,
        statusDetail: null,
        availability: "available",
        lastRequestedAt: Date.now(),
        updatedAt: Date.now(),
        warnings: [],
      }))

      const entry = await refreshCursorUsage(root)

      expect(entry.sessionLimitUsedPercent).toBe(0.6466666666666666)
      expect(entry.apiLimitUsedPercent).toBe(33.4)
      expect(usageCallCount).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("marks Cursor usage login_required after recovery fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-cursor-login-"))
    const originalFetch = globalThis.fetch
    let dashboardCalls = 0

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/dashboard/spending")) {
        dashboardCalls += 1
      }
      return new Response("{}", { status: 401 })
    }) as typeof fetch

    try {
      writeFileSync(path.join(root, "cursor-session.json"), JSON.stringify({
        cookies: [{
          name: "WorkosCursorSessionToken",
          value: "expired-session",
          domain: "cursor.com",
          path: "/",
          expiresAt: null,
          secure: true,
          httpOnly: true,
        }],
        updatedAt: 1,
        lastSuccessAt: null,
      }))

      const entry = await refreshCursorUsage(root, "win32")
      expect(entry.availability).toBe("login_required")
      expect(entry.statusDetail).toBe("session_refresh_failed")
      expect(dashboardCalls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(root, { recursive: true, force: true })
    }
  })

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
