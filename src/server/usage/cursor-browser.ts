import { canOpenMacApp, resolveCommandPath } from "../process-utils"
import { buildCursorCookieHeader, mergeCursorCookies, responseSetCookies } from "./cursor-cookies"
import { parseCursorUsagePayload } from "./cursor-usage"
import type { CursorSessionCache } from "./types"

export const CURSOR_DASHBOARD_URL = "https://cursor.com/dashboard/spending"
export const CURSOR_USAGE_URL = "https://cursor.com/api/dashboard/get-current-period-usage"
export const CURSOR_BROWSER_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export async function fetchCursorEndpoint(args: {
  url: string
  method?: "GET" | "POST"
  session: CursorSessionCache
  body?: unknown
}) {
  const response = await fetch(args.url, {
    method: args.method ?? "GET",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      origin: "https://cursor.com",
      referer: CURSOR_DASHBOARD_URL,
      cookie: buildCursorCookieHeader(args.session.cookies),
      "user-agent": "Kanna/1.0",
    },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  })

  const mergedSession: CursorSessionCache = {
    cookies: mergeCursorCookies(args.session.cookies, responseSetCookies(response)),
    updatedAt: Date.now(),
    lastSuccessAt: args.session.lastSuccessAt,
  }

  return { response, session: mergedSession }
}

export function isCursorAuthFailure(response: Response) {
  return response.status === 401 || response.status === 403
}

export async function attemptCursorUsageFetch(session: CursorSessionCache) {
  const { response, session: nextSession } = await fetchCursorEndpoint({
    url: CURSOR_USAGE_URL,
    method: "POST",
    session,
    body: {},
  })

  if (isCursorAuthFailure(response)) {
    return { ok: false as const, authFailed: true, session: nextSession, payload: null }
  }

  if (!response.ok) {
    return { ok: false as const, authFailed: false, session: nextSession, payload: null }
  }

  const payload = parseCursorUsagePayload(await response.json().catch(() => null))
  if (!payload) {
    return { ok: false as const, authFailed: false, session: nextSession, payload: null }
  }

  return { ok: true as const, authFailed: false, session: nextSession, payload }
}

export async function refreshCursorSessionFromDashboard(session: CursorSessionCache) {
  const { response, session: nextSession } = await fetchCursorEndpoint({
    url: CURSOR_DASHBOARD_URL,
    method: "GET",
    session,
  })

  if (!response.ok && !isCursorAuthFailure(response)) {
    return { ok: false as const, session: nextSession }
  }

  return { ok: true as const, session: nextSession }
}

export function resolveBrowserExecutable(platform = process.platform) {
  const resolvedCommand = resolveCommandPath("google-chrome")
    ?? resolveCommandPath("chromium")
    ?? resolveCommandPath("chromium-browser")
    ?? resolveCommandPath("brave-browser")
  if (resolvedCommand) return resolvedCommand

  if (platform === "darwin") {
    if (canOpenMacApp("Google Chrome")) return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if (canOpenMacApp("Chromium")) return "/Applications/Chromium.app/Contents/MacOS/Chromium"
    if (canOpenMacApp("Brave Browser")) return "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }

  return null
}

export function sessionFromBrowserCookies(cookies: Array<{
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  secure?: boolean
  httpOnly?: boolean
}>): CursorSessionCache {
  return {
    cookies: cookies
      .filter((cookie) => (cookie.domain ?? "cursor.com").replace(/^\./, "").endsWith("cursor.com"))
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: (cookie.domain ?? "cursor.com").replace(/^\./, ""),
        path: cookie.path ?? "/",
        expiresAt: typeof cookie.expires === "number" && Number.isFinite(cookie.expires) ? cookie.expires * 1000 : null,
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly === true,
      })),
    updatedAt: Date.now(),
    lastSuccessAt: null,
  }
}
