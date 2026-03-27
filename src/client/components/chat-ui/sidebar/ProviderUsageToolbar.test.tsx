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
              apiLimitUsedPercent: null,
              rateLimitResetAt: null,
              rateLimitResetLabel: null,
              weeklyLimitUsedPercent: null,
              weeklyRateLimitResetAt: null,
              weeklyRateLimitResetLabel: null,
              statusDetail: "session_refresh_failed",
              availability: "login_required",
              lastRequestedAt: null,
              updatedAt: null,
              warnings: [],
            },
          }}
        />
      </TooltipProvider>
    )

    expect(html).toContain("Cursor")
    expect(html).toContain("API")
    expect(html).toContain("Composer")
    expect(html).toContain("Sign In")
  })

  test("does not render a Cursor refresh action when usage is available", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProviderUsageToolbar
          providerUsage={{
            cursor: {
              provider: "cursor",
              sessionLimitUsedPercent: 0.6466666666666666,
              apiLimitUsedPercent: 33.4,
              rateLimitResetAt: null,
              rateLimitResetLabel: null,
              weeklyLimitUsedPercent: null,
              weeklyRateLimitResetAt: null,
              weeklyRateLimitResetLabel: null,
              statusDetail: null,
              availability: "available",
              lastRequestedAt: null,
              updatedAt: Date.now(),
              warnings: [],
            },
          }}
        />
      </TooltipProvider>
    )

    expect(html).toContain("Cursor")
    expect(html).toContain("API")
    expect(html).toContain("Composer")
    expect(html).toContain("33.4%")
    expect(html).toContain("0.6%")
    expect(html).not.toContain(">Refresh</button>")
  })

  test("renders a Cursor refresh action when usage is unavailable", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProviderUsageToolbar
          providerUsage={{
            cursor: {
              provider: "cursor",
              sessionLimitUsedPercent: null,
              apiLimitUsedPercent: null,
              rateLimitResetAt: null,
              rateLimitResetLabel: null,
              weeklyLimitUsedPercent: null,
              weeklyRateLimitResetAt: null,
              weeklyRateLimitResetLabel: null,
              statusDetail: "fetch_failed",
              availability: "unavailable",
              lastRequestedAt: null,
              updatedAt: null,
              warnings: [],
            },
          }}
        />
      </TooltipProvider>
    )

    expect(html).toContain("Refresh")
  })

  test("shows N/A instead of 0% when a split value is missing", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProviderUsageToolbar
          providerUsage={{
            cursor: {
              provider: "cursor",
              sessionLimitUsedPercent: 0.6466666666666666,
              apiLimitUsedPercent: null,
              rateLimitResetAt: null,
              rateLimitResetLabel: null,
              weeklyLimitUsedPercent: null,
              weeklyRateLimitResetAt: null,
              weeklyRateLimitResetLabel: null,
              statusDetail: null,
              availability: "available",
              lastRequestedAt: null,
              updatedAt: Date.now(),
              warnings: [],
            },
          }}
        />
      </TooltipProvider>
    )

    expect(html).toContain("Cursor")
    expect(html).toContain("API")
    expect(html).toContain("Composer")
    expect(html).toContain("N/A")
    expect(html).toContain("0.6%")
  })
})
