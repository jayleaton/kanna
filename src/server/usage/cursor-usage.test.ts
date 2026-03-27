import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseCursorUsagePayload, refreshCursorUsage } from "./cursor-usage"

describe("cursor usage", () => {
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
})
