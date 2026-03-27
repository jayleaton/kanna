import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "../../ui/tooltip"
import { ProviderUsageToolbar } from "./ProviderUsageToolbar"

describe("ProviderUsageToolbar", () => {
  test("renders a Cursor login action when usage requires auth", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProviderUsageToolbar
          providerUsage={{
            cursor: {
              provider: "cursor",
              sessionLimitUsedPercent: null,
              rateLimitResetAt: null,
              rateLimitResetLabel: null,
              weeklyLimitUsedPercent: null,
              weeklyRateLimitResetAt: null,
              weeklyRateLimitResetLabel: null,
              statusDetail: "session_refresh_failed",
              availability: "login_required",
              updatedAt: null,
              warnings: [],
            },
          }}
        />
      </TooltipProvider>
    )

    expect(html).toContain("Cursor")
    expect(html).toContain("Open &amp; Paste")
  })

  test("renders a Cursor refresh action when usage is available", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProviderUsageToolbar
          providerUsage={{
            cursor: {
              provider: "cursor",
              sessionLimitUsedPercent: 42,
              rateLimitResetAt: null,
              rateLimitResetLabel: null,
              weeklyLimitUsedPercent: null,
              weeklyRateLimitResetAt: null,
              weeklyRateLimitResetLabel: null,
              statusDetail: null,
              availability: "available",
              updatedAt: Date.now(),
              warnings: [],
            },
          }}
        />
      </TooltipProvider>
    )

    expect(html).toContain("Refresh")
    expect(html).toContain("42%")
  })
})
