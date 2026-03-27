import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { reconstructCodexUsageFromFile } from "./codex-usage"

describe("codex usage", () => {
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
})
