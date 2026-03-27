import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "../event-store"
import { resetClaudeUsageCaches } from "./claude-usage"
import { resetCodexUsageCaches } from "./codex-usage"
import { resetCursorUsageCaches } from "./cursor-usage"
import { deriveProviderUsage } from "./provider-usage"

describe("provider usage", () => {
  test("upgrades legacy Claude weekly cache entries that were stored in the session field", async () => {
    resetClaudeUsageCaches()
    resetCodexUsageCaches()
    resetCursorUsageCaches()
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
        sessionLimitUsedPercent: null,
        weeklyLimitUsedPercent: 92,
        weeklyRateLimitResetLabel: "Mar 30, 8am (Asia/Bangkok)",
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
