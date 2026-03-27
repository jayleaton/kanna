import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { createDecipheriv, pbkdf2Sync } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import type { CursorCurlImportResult, CursorSessionCache, CursorSessionCookie } from "./types"

const CHROME_EPOCH_OFFSET_MS = Date.UTC(1601, 0, 1)
export const CURSOR_SESSION_COOKIE_NAME = "WorkosCursorSessionToken"

function normalizeCookieDomain(domain: string) {
  return domain.startsWith(".") ? domain.slice(1) : domain
}

function isExpiredCookie(cookie: CursorSessionCookie, now = Date.now()) {
  return cookie.expiresAt !== null && cookie.expiresAt <= now
}

export function mergeCursorCookies(
  existing: CursorSessionCookie[],
  incoming: CursorSessionCookie[],
  now = Date.now()
) {
  const merged = new Map<string, CursorSessionCookie>()
  for (const cookie of existing) {
    if (isExpiredCookie(cookie, now)) continue
    merged.set(`${normalizeCookieDomain(cookie.domain)}|${cookie.path}|${cookie.name}`, cookie)
  }

  for (const cookie of incoming) {
    const key = `${normalizeCookieDomain(cookie.domain)}|${cookie.path}|${cookie.name}`
    if (!cookie.value || isExpiredCookie(cookie, now)) {
      merged.delete(key)
      continue
    }
    merged.set(key, {
      ...cookie,
      domain: normalizeCookieDomain(cookie.domain),
    })
  }

  return [...merged.values()]
    .filter((cookie) => cookie.value)
    .filter((cookie) => !isExpiredCookie(cookie, now))
}

export function buildCursorCookieHeader(cookies: CursorSessionCookie[]) {
  return cookies
    .filter((cookie) => !isExpiredCookie(cookie))
    .filter((cookie) => cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ")
}

function parseSetCookie(header: string): CursorSessionCookie | null {
  const segments = header.split(";").map((part) => part.trim()).filter(Boolean)
  const [cookiePair, ...attributes] = segments
  if (!cookiePair) return null
  const equalsIndex = cookiePair.indexOf("=")
  if (equalsIndex <= 0) return null
  const name = cookiePair.slice(0, equalsIndex).trim()
  const value = cookiePair.slice(equalsIndex + 1).trim()
  if (!name) return null

  let domain = "cursor.com"
  let cookiePath = "/"
  let expiresAt: number | null = null
  let secure = false
  let httpOnly = false

  for (const attribute of attributes) {
    const [rawKey, ...rawRest] = attribute.split("=")
    const key = rawKey.trim().toLowerCase()
    const rawValue = rawRest.join("=").trim()
    if (key === "domain" && rawValue) {
      domain = normalizeCookieDomain(rawValue)
    } else if (key === "path" && rawValue) {
      cookiePath = rawValue
    } else if (key === "expires" && rawValue) {
      const parsed = Date.parse(rawValue)
      expiresAt = Number.isFinite(parsed) ? parsed : null
    } else if (key === "max-age" && rawValue) {
      const seconds = Number(rawValue)
      if (Number.isFinite(seconds)) {
        expiresAt = Date.now() + seconds * 1000
      }
    } else if (key === "secure") {
      secure = true
    } else if (key === "httponly") {
      httpOnly = true
    }
  }

  return {
    name,
    value,
    domain,
    path: cookiePath,
    expiresAt,
    secure,
    httpOnly,
  }
}

function parseCookieHeaderValue(cookieHeader: string): CursorSessionCookie[] {
  return cookieHeader
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment): CursorSessionCookie | null => {
      const equalsIndex = segment.indexOf("=")
      if (equalsIndex <= 0) return null
      return {
        name: segment.slice(0, equalsIndex).trim(),
        value: segment.slice(equalsIndex + 1).trim(),
        domain: "cursor.com",
        path: "/",
        expiresAt: null,
        secure: true,
        httpOnly: true,
      }
    })
    .filter((cookie): cookie is CursorSessionCookie => cookie !== null)
}

function extractCurlArguments(source: string, patterns: string[]) {
  const values: string[] = []
  for (const pattern of patterns) {
    const regex = new RegExp(`${pattern}\\s+(?:'([^']*)'|"([^"]*)"|(\\S+))`, "ig")
    for (const match of source.matchAll(regex)) {
      values.push(match[1] ?? match[2] ?? match[3] ?? "")
    }
  }
  return values.filter(Boolean)
}

export function importCursorSessionFromCurl(curlCommand: string): CursorCurlImportResult | null {
  const cookieHeader = extractCurlArguments(curlCommand, [
    "-b",
    "--cookie",
  ])[0] ?? extractCurlArguments(curlCommand, [
    "-H",
    "--header",
  ])
    .map((header) => header.match(/^cookie:\s*(.+)$/i)?.[1] ?? null)
    .find((header): header is string => Boolean(header))
    ?? null

  if (!cookieHeader) return null
  const cookies = parseCookieHeaderValue(cookieHeader)
  if (!cookies.some((cookie) => cookie.name === CURSOR_SESSION_COOKIE_NAME)) {
    return null
  }

  return { cookies }
}

export function responseSetCookies(response: Response): CursorSessionCookie[] {
  const rawGetSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const cookieHeaders = typeof rawGetSetCookie === "function"
    ? rawGetSetCookie.call(response.headers)
    : (() => {
        const combined = response.headers.get("set-cookie")
        return combined ? [combined] : []
      })()

  return cookieHeaders
    .map((value) => parseSetCookie(value))
    .filter((cookie): cookie is CursorSessionCookie => Boolean(cookie))
    .filter((cookie) => normalizeCookieDomain(cookie.domain).endsWith("cursor.com"))
}

function parseCursorProfileCookiesDb(args: {
  cookiesPath: string
  browserName: string
  platform: NodeJS.Platform
}): CursorSessionCookie[] {
  const tempDir = mkdtempSync(path.join(tmpdir(), "kanna-cursor-cookies-"))
  const tempDbPath = path.join(tempDir, "Cookies")
  try {
    copyFileSync(args.cookiesPath, tempDbPath)
    const database = new Database(tempDbPath, { readonly: true })
    try {
      const rows = database
        .query(`
          SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly
          FROM cookies
          WHERE host_key LIKE '%cursor.com'
        `)
        .all() as Array<{
          host_key: string
          name: string
          value: string
          encrypted_value: Uint8Array | null
          path: string
          expires_utc: number
          is_secure: number
          is_httponly: number
        }>

      const key = getChromiumCookieKey({
        cookiesPath: args.cookiesPath,
        browserName: args.browserName,
        platform: args.platform,
      })

      return rows
        .map((row) => {
          const value = row.value || decryptChromiumCookieValue(row.encrypted_value, key, args.platform)
          if (!value) return null
          return {
            name: row.name,
            value,
            domain: normalizeCookieDomain(row.host_key),
            path: row.path || "/",
            expiresAt: chromeTimestampToUnixMs(row.expires_utc),
            secure: row.is_secure === 1,
            httpOnly: row.is_httponly === 1,
          } satisfies CursorSessionCookie
        })
        .filter((cookie): cookie is CursorSessionCookie => Boolean(cookie))
    } finally {
      database.close()
    }
  } catch {
    return []
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function chromeTimestampToUnixMs(value: number | null | undefined) {
  if (!value || value <= 0) return null
  return CHROME_EPOCH_OFFSET_MS + Math.floor(value / 1000)
}

function browserRootCandidates(platform: NodeJS.Platform) {
  const home = homedir()
  if (platform === "darwin") {
    return [
      {
        name: "chrome",
        rootPath: path.join(home, "Library", "Application Support", "Google", "Chrome"),
        safeStorageName: "Chrome Safe Storage",
      },
      {
        name: "chromium",
        rootPath: path.join(home, "Library", "Application Support", "Chromium"),
        safeStorageName: "Chromium Safe Storage",
      },
      {
        name: "brave",
        rootPath: path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
        safeStorageName: "Brave Safe Storage",
      },
    ]
  }

  if (platform === "linux") {
    return [
      {
        name: "chrome",
        rootPath: path.join(home, ".config", "google-chrome"),
        safeStorageName: "Chrome Safe Storage",
      },
      {
        name: "chromium",
        rootPath: path.join(home, ".config", "chromium"),
        safeStorageName: "Chromium Safe Storage",
      },
      {
        name: "brave",
        rootPath: path.join(home, ".config", "BraveSoftware", "Brave-Browser"),
        safeStorageName: "Brave Safe Storage",
      },
    ]
  }

  return []
}

function discoverChromiumCookieSources(platform: NodeJS.Platform) {
  const profiles: Array<{ browserName: string; cookiesPath: string }> = []
  for (const browser of browserRootCandidates(platform)) {
    if (!existsSync(browser.rootPath)) continue
    for (const entry of readdirSync(browser.rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name !== "Default" && !entry.name.startsWith("Profile ")) continue
      const cookiesPath = path.join(browser.rootPath, entry.name, "Cookies")
      if (!existsSync(cookiesPath)) continue
      profiles.push({ browserName: browser.name, cookiesPath })
    }
  }
  return profiles
}

function safeStoragePasswordForMac(safeStorageName: string) {
  const result = Bun.spawnSync(["security", "find-generic-password", "-w", "-s", safeStorageName], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  if (result.exitCode !== 0) return null
  const output = new TextDecoder().decode(result.stdout).trim()
  return output || null
}

function safeStoragePasswordForLinux(browserName: string, safeStorageName: string) {
  const candidateCommands = [
    ["secret-tool", "lookup", "application", browserName],
    ["secret-tool", "lookup", "service", safeStorageName],
    ["secret-tool", "lookup", "application", `${browserName} Safe Storage`],
  ]

  for (const command of candidateCommands) {
    const result = Bun.spawnSync(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    if (result.exitCode !== 0) continue
    const output = new TextDecoder().decode(result.stdout).trim()
    if (output) return output
  }

  return "peanuts"
}

function getChromiumCookieKey(args: {
  cookiesPath: string
  browserName: string
  platform: NodeJS.Platform
}) {
  const browser = browserRootCandidates(args.platform).find((candidate) => candidate.name === args.browserName)
  if (!browser) return null
  const password = args.platform === "darwin"
    ? safeStoragePasswordForMac(browser.safeStorageName)
    : args.platform === "linux"
      ? safeStoragePasswordForLinux(args.browserName, browser.safeStorageName)
      : null

  if (!password) return null

  const iterations = args.platform === "darwin" ? 1003 : 1
  return pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1")
}

function decryptChromiumCookieValue(
  encryptedValue: Uint8Array | null,
  key: Buffer | null,
  platform: NodeJS.Platform
) {
  if (!encryptedValue || encryptedValue.length === 0 || !key) return null
  const encrypted = Buffer.from(encryptedValue)
  const versionPrefix = encrypted.subarray(0, 3).toString("utf8")
  if (platform !== "darwin" && platform !== "linux") return null
  if (versionPrefix !== "v10" && versionPrefix !== "v11") return null

  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20))
    const decrypted = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ])
    return decrypted.toString("utf8")
  } catch {
    return null
  }
}

export function bootstrapCursorSessionFromBrowser(platform = process.platform): CursorSessionCache | null {
  if (platform !== "linux" && platform !== "darwin") return null

  for (const source of discoverChromiumCookieSources(platform)) {
    const cookies = parseCursorProfileCookiesDb({
      cookiesPath: source.cookiesPath,
      browserName: source.browserName,
      platform,
    })
    if (!cookies.some((cookie) => cookie.name === CURSOR_SESSION_COOKIE_NAME)) continue
    return {
      cookies,
      updatedAt: Date.now(),
      lastSuccessAt: null,
    }
  }

  return null
}
