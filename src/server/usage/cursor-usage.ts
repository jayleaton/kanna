import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import puppeteer from "puppeteer-core"
import type { ProviderUsageAvailability, ProviderUsageEntry } from "../../shared/types"
import { BaseProviderUsage } from "./base-provider-usage"
import {
  attemptCursorUsageFetch,
  CURSOR_BROWSER_LOGIN_TIMEOUT_MS,
  CURSOR_DASHBOARD_URL,
  refreshCursorSessionFromDashboard,
  resolveBrowserExecutable,
  sessionFromBrowserCookies,
} from "./cursor-browser"
import {
  bootstrapCursorSessionFromBrowser,
  CURSOR_SESSION_COOKIE_NAME,
  importCursorSessionFromCurl,
  mergeCursorCookies,
} from "./cursor-cookies"
import type { CursorSessionCache, CursorSessionCookie, CursorUsagePayload } from "./types"
import { asRecord, deriveAvailability, toNumber, usageWarnings } from "./utils"

const PROVIDER_CACHE_TTL_MS = 30_000
const PROVIDER_USAGE_REQUEST_MIN_INTERVAL_MS = 30 * 60 * 1000

function cursorSessionPath(dataDir: string) {
  return path.join(dataDir, "cursor-session.json")
}

function cursorUsagePath(dataDir: string) {
  return path.join(dataDir, "cursor-usage.json")
}

function cursorEntryFromSuccess(payload: CursorUsagePayload, updatedAt = Date.now(), lastRequestedAt = updatedAt): ProviderUsageEntry {
  return {
    provider: "cursor",
    sessionLimitUsedPercent: payload.sessionLimitUsedPercent,
    apiLimitUsedPercent: payload.apiPercentUsed,
    rateLimitResetAt: payload.rateLimitResetAt,
    rateLimitResetLabel: payload.rateLimitResetLabel,
    weeklyLimitUsedPercent: null,
    weeklyRateLimitResetAt: null,
    weeklyRateLimitResetLabel: null,
    statusDetail: null,
    availability: "available",
    lastRequestedAt,
    updatedAt,
    warnings: usageWarnings({
      contextUsedPercent: null,
      sessionLimitUsedPercent: payload.sessionLimitUsedPercent,
      updatedAt,
    }),
  }
}

function cursorStatusEntry(args: {
  availability: ProviderUsageAvailability
  statusDetail: string | null
  lastRequestedAt?: number | null
  updatedAt?: number | null
}): ProviderUsageEntry {
  return {
    provider: "cursor",
    sessionLimitUsedPercent: null,
    apiLimitUsedPercent: null,
    rateLimitResetAt: null,
    rateLimitResetLabel: null,
    weeklyLimitUsedPercent: null,
    weeklyRateLimitResetAt: null,
    weeklyRateLimitResetLabel: null,
    statusDetail: args.statusDetail,
    availability: args.availability,
    lastRequestedAt: args.lastRequestedAt ?? null,
    updatedAt: args.updatedAt ?? null,
    warnings: args.availability === "stale" && args.updatedAt
      ? ["stale"]
      : [],
  }
}

function normalizeCursorResetLabel(label: unknown): string | null {
  if (typeof label !== "string") return null
  const trimmed = label.trim()
  return trimmed || null
}

function parseCursorTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000
  }
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000
    }
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function findFirstValue(value: unknown, matchers: RegExp[], seen = new Set<unknown>()): unknown {
  if (!value || typeof value !== "object") return null
  if (seen.has(value)) return null
  seen.add(value)

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFirstValue(entry, matchers, seen)
      if (found !== null && found !== undefined) return found
    }
    return null
  }

  for (const [key, entry] of Object.entries(value)) {
    if (matchers.some((matcher) => matcher.test(key)) && entry !== null && entry !== undefined) {
      return entry
    }
  }

  for (const entry of Object.values(value)) {
    const found = findFirstValue(entry, matchers, seen)
    if (found !== null && found !== undefined) return found
  }

  return null
}

export function parseCursorUsagePayload(payload: unknown): CursorUsagePayload | null {
  const record = asRecord(payload)
  if (!record) return null

  const planUsage = asRecord(record.planUsage)
  const autoPercentUsed = toNumber(planUsage?.autoPercentUsed)
  const apiPercentRaw = toNumber(planUsage?.apiPercentUsed)
  if (autoPercentUsed !== null) {
    return {
      sessionLimitUsedPercent: Math.max(0, Math.min(100, autoPercentUsed)),
      apiPercentUsed: apiPercentRaw === null ? null : Math.max(0, Math.min(100, apiPercentRaw)),
      rateLimitResetAt: null,
      rateLimitResetLabel: null,
    }
  }

  const percentValue = findFirstValue(record, [
    /^used_?percent$/i,
    /^session_?limit_?used_?percent$/i,
    /^percent_?used$/i,
    /^usage_?percent(age)?$/i,
  ])
  const resetValue = findFirstValue(record, [
    /^reset(s|_at|At)?$/i,
    /^current_?period_?(end|reset)(s|_at|At)?$/i,
    /^period_?(end|reset)(s|_at|At)?$/i,
    /^next_?reset(_at|At)?$/i,
  ])
  const resetLabelValue = findFirstValue(record, [
    /^reset_?label$/i,
    /^reset_?text$/i,
    /^next_?reset_?label$/i,
  ])

  const percent = typeof percentValue === "number"
    ? percentValue
    : typeof percentValue === "string"
      ? Number(percentValue)
      : null

  if (!Number.isFinite(percent)) return null
  const normalizedPercent = percent as number

  return {
    sessionLimitUsedPercent: Math.max(0, Math.min(100, normalizedPercent)),
    apiPercentUsed: null,
    rateLimitResetAt: parseCursorTimestamp(resetValue),
    rateLimitResetLabel: normalizeCursorResetLabel(resetLabelValue),
  }
}

export class CursorUsage extends BaseProviderUsage {
  readonly provider = "cursor" as const
  private fileCache: { filePath: string; entry: ProviderUsageEntry | null; cachedAt: number } | null = null

  private persistSession(session: CursorSessionCache) {
    const prunedCookies = session.cookies
      .filter((cookie) => cookie.domain === "cursor.com" || cookie.domain.endsWith(".cursor.com"))
      .map((cookie) => ({
        ...cookie,
        value: String(cookie.value),
      }))

    writeFileSync(cursorSessionPath(this.dataDir), JSON.stringify({
      cookies: prunedCookies,
      updatedAt: session.updatedAt,
      lastSuccessAt: session.lastSuccessAt,
    }))
  }

  private loadPersistedSession(): CursorSessionCache | null {
    try {
      const filePath = cursorSessionPath(this.dataDir)
      if (!existsSync(filePath)) return null
      const parsed = JSON.parse(readFileSync(filePath, "utf8"))
      const cookies = Array.isArray(parsed.cookies)
        ? parsed.cookies
          .map((cookie: unknown) => asRecord(cookie))
          .filter((cookie: Record<string, unknown> | null): cookie is Record<string, unknown> => Boolean(cookie))
          .map((cookie: Record<string, unknown>) => ({
            name: typeof cookie.name === "string" ? cookie.name : "",
            value: typeof cookie.value === "string" ? cookie.value : "",
            domain: typeof cookie.domain === "string" ? cookie.domain : "cursor.com",
            path: typeof cookie.path === "string" ? cookie.path : "/",
            expiresAt: typeof cookie.expiresAt === "number" ? cookie.expiresAt : null,
            secure: cookie.secure !== false,
            httpOnly: cookie.httpOnly !== false,
          }))
          .filter((cookie: CursorSessionCookie) => cookie.name && cookie.value)
        : []

      if (cookies.length === 0) return null

      return {
        cookies,
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
        lastSuccessAt: typeof parsed.lastSuccessAt === "number" ? parsed.lastSuccessAt : null,
      }
    } catch {
      return null
    }
  }

  private persistUsageEntry(entry: ProviderUsageEntry) {
    const filePath = cursorUsagePath(this.dataDir)
    writeFileSync(filePath, JSON.stringify(entry))
    this.fileCache = { filePath, entry, cachedAt: Date.now() }
  }

  loadPersistedEntry(): ProviderUsageEntry | null {
    const now = Date.now()
    const filePath = cursorUsagePath(this.dataDir)
    if (this.fileCache && this.fileCache.filePath === filePath && now - this.fileCache.cachedAt < PROVIDER_CACHE_TTL_MS) {
      return this.fileCache.entry
    }

    try {
      if (!existsSync(filePath)) return null
      const parsed = JSON.parse(readFileSync(filePath, "utf8"))
      const entry = asRecord(parsed)
      if (!entry) return null
      const availability = typeof entry.availability === "string" ? entry.availability as ProviderUsageAvailability : "unavailable"
      const hasApiLimitUsedPercent = Object.prototype.hasOwnProperty.call(entry, "apiLimitUsedPercent")
      const normalized: ProviderUsageEntry = {
        provider: "cursor",
        sessionLimitUsedPercent: typeof entry.sessionLimitUsedPercent === "number" ? entry.sessionLimitUsedPercent : null,
        apiLimitUsedPercent: hasApiLimitUsedPercent
          ? (typeof entry.apiLimitUsedPercent === "number" ? entry.apiLimitUsedPercent : null)
          : undefined,
        rateLimitResetAt: typeof entry.rateLimitResetAt === "number" ? entry.rateLimitResetAt : null,
        rateLimitResetLabel: typeof entry.rateLimitResetLabel === "string" ? entry.rateLimitResetLabel : null,
        weeklyLimitUsedPercent: typeof entry.weeklyLimitUsedPercent === "number" ? entry.weeklyLimitUsedPercent : null,
        weeklyRateLimitResetAt: typeof entry.weeklyRateLimitResetAt === "number" ? entry.weeklyRateLimitResetAt : null,
        weeklyRateLimitResetLabel: typeof entry.weeklyRateLimitResetLabel === "string" ? entry.weeklyRateLimitResetLabel : null,
        statusDetail: typeof entry.statusDetail === "string" ? entry.statusDetail : null,
        lastRequestedAt: typeof entry.lastRequestedAt === "number" ? entry.lastRequestedAt : null,
        availability: availability === "available" || availability === "unavailable" || availability === "stale" || availability === "login_required"
          ? availability
          : "unavailable",
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : null,
        warnings: Array.isArray(entry.warnings)
          ? entry.warnings.filter((warning): warning is ProviderUsageEntry["warnings"][number] => typeof warning === "string")
          : [],
      }

      if (normalized.availability === "available" || normalized.availability === "stale") {
        normalized.availability = deriveAvailability(normalized.updatedAt)
        normalized.warnings = usageWarnings({
          contextUsedPercent: null,
          sessionLimitUsedPercent: normalized.sessionLimitUsedPercent,
          updatedAt: normalized.updatedAt,
        })
      }

      this.fileCache = { filePath, entry: normalized, cachedAt: now }
      return normalized
    } catch {
      this.fileCache = { filePath, entry: null, cachedAt: now }
      return null
    }
  }

  async refresh(platform = process.platform, force = false): Promise<ProviderUsageEntry> {
    const now = Date.now()
    const persistedEntry = this.loadPersistedEntry()
    const lastRequestedAt = persistedEntry?.lastRequestedAt ?? this.readLastRequestedAt(this.provider)
    const needsCursorUsageSplitRefresh = persistedEntry?.availability === "available"
      && persistedEntry.sessionLimitUsedPercent !== null
      && persistedEntry.apiLimitUsedPercent === undefined

    if (!force && now - lastRequestedAt < PROVIDER_USAGE_REQUEST_MIN_INTERVAL_MS && persistedEntry && !needsCursorUsageSplitRefresh) {
      return persistedEntry
    }

    this.recordRequestTime(this.provider, now)

    let session = this.loadPersistedSession()

    if (!session) {
      session = bootstrapCursorSessionFromBrowser(platform)
      if (session) {
        this.persistSession(session)
      }
    }

    if (!session) {
      const entry = cursorStatusEntry({
        availability: platform === "linux" || platform === "darwin" ? "login_required" : "unavailable",
        statusDetail: platform === "linux" || platform === "darwin" ? "browser_cookie_import_failed" : "unsupported_platform",
        lastRequestedAt: now,
      })
      this.persistUsageEntry(entry)
      return entry
    }

    let result = await attemptCursorUsageFetch(session)
    session = result.session

    if (result.authFailed) {
      const refreshed = await refreshCursorSessionFromDashboard(session)
      session = refreshed.session
      result = await attemptCursorUsageFetch(session)
      session = result.session
    }

    if (!result.ok && result.authFailed) {
      const bootstrapped = bootstrapCursorSessionFromBrowser(platform)
      if (bootstrapped) {
        session = {
          cookies: mergeCursorCookies(session.cookies, bootstrapped.cookies),
          updatedAt: Date.now(),
          lastSuccessAt: session.lastSuccessAt,
        }
        result = await attemptCursorUsageFetch(session)
        session = result.session
      }
    }

    if (session.cookies.length > 0) {
      this.persistSession(session)
    }

    if (!result.ok || !result.payload) {
      const entry = cursorStatusEntry({
        availability: result.authFailed ? "login_required" : "unavailable",
        statusDetail: result.authFailed ? "session_refresh_failed" : "fetch_failed",
        lastRequestedAt: now,
        updatedAt: session.lastSuccessAt,
      })
      this.persistUsageEntry(entry)
      return entry
    }

    session.lastSuccessAt = Date.now()
    session.updatedAt = session.lastSuccessAt
    this.persistSession(session)

    const entry = cursorEntryFromSuccess(result.payload, session.lastSuccessAt, now)
    this.persistUsageEntry(entry)
    return entry
  }

  async importFromCurl(curlCommand: string, platform = process.platform) {
    const imported = importCursorSessionFromCurl(curlCommand)
    if (!imported) {
      return cursorStatusEntry({
        availability: "login_required",
        statusDetail: "invalid_curl_import",
        lastRequestedAt: Date.now(),
      })
    }

    const existing = this.loadPersistedSession()
    const session: CursorSessionCache = {
      cookies: mergeCursorCookies(existing?.cookies ?? [], imported.cookies),
      updatedAt: Date.now(),
      lastSuccessAt: existing?.lastSuccessAt ?? null,
    }
    this.persistSession(session)
    return this.refresh(platform)
  }

  async signInWithBrowser(platform = process.platform) {
    const executablePath = resolveBrowserExecutable(platform)
    if (!executablePath) {
      return cursorStatusEntry({
        availability: "login_required",
        statusDetail: "browser_launch_failed",
        lastRequestedAt: Date.now(),
      })
    }

    const userDataDir = mkdtempSync(path.join(tmpdir(), "kanna-cursor-login-"))
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null

    try {
      browser = await puppeteer.launch({
        executablePath,
        headless: false,
        userDataDir,
        defaultViewport: null,
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-blink-features=AutomationControlled",
        ],
      })

      const page = await browser.newPage()
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
        })
      })
      await page.goto(CURSOR_DASHBOARD_URL, { waitUntil: "domcontentloaded" })

      const start = Date.now()
      let session: CursorSessionCache | null = null
      while (Date.now() - start < CURSOR_BROWSER_LOGIN_TIMEOUT_MS) {
        const cookies = await page.cookies(CURSOR_DASHBOARD_URL)
        if (cookies.some((cookie) => cookie.name === CURSOR_SESSION_COOKIE_NAME && cookie.value)) {
          session = sessionFromBrowserCookies(cookies)
          break
        }
        await Bun.sleep(1000)
      }

      if (!session) {
        return cursorStatusEntry({
          availability: "login_required",
          statusDetail: "browser_login_failed",
          lastRequestedAt: Date.now(),
        })
      }

      this.persistSession(session)
      return this.refresh(platform)
    } catch {
      return cursorStatusEntry({
        availability: "login_required",
        statusDetail: "browser_login_failed",
        lastRequestedAt: Date.now(),
      })
    } finally {
      try {
        await browser?.close()
      } catch {
        // noop
      }
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }
}

const _instances = new Map<string, CursorUsage>()

export function getCursorUsage(dataDir: string): CursorUsage {
  if (!_instances.has(dataDir)) {
    _instances.set(dataDir, new CursorUsage(dataDir))
  }
  return _instances.get(dataDir)!
}

export async function refreshCursorUsage(dataDir: string, platform = process.platform, force = false): Promise<ProviderUsageEntry> {
  return getCursorUsage(dataDir).refresh(platform, force)
}

export async function importCursorUsageFromCurl(dataDir: string, curlCommand: string, platform = process.platform) {
  return getCursorUsage(dataDir).importFromCurl(curlCommand, platform)
}

export async function signInToCursorWithBrowser(dataDir: string, platform = process.platform) {
  return getCursorUsage(dataDir).signInWithBrowser(platform)
}

export function resetCursorUsageCaches() {
  _instances.clear()
}
