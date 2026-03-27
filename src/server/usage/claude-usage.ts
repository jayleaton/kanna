import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"
import type { ChatUsageSnapshot, ProviderUsageEntry, TranscriptEntry } from "../../shared/types"
import { CLAUDE_CONTEXT_WINDOW_FALLBACKS } from "../../shared/types"
import { BaseProviderUsage } from "./base-provider-usage"
import type { ClaudeRateLimitCacheSnapshot, ClaudeRateLimitInfo } from "./types"
import {
  asRecord,
  buildSnapshot,
  estimateCurrentThreadTokens,
  parseJsonLine,
  relevantMessagesForCurrentContext,
  snapshotToEntry,
  toNumber,
  toPercent,
  usageTotals,
  usageWarnings,
} from "./utils"

const PROVIDER_CACHE_TTL_MS = 30_000
const PROVIDER_USAGE_REQUEST_MIN_INTERVAL_MS = 30 * 60 * 1000

function extractClaudeUsageRecord(entry: TranscriptEntry) {
  if (!entry.debugRaw) return null
  const raw = parseJsonLine(entry.debugRaw)
  if (!raw) return null

  const type = raw.type
  if (type !== "assistant" && type !== "result") return null

  if (type === "assistant") {
    const message = asRecord(raw.message)
    const usage = asRecord(message?.usage)
    if (!usage) return null

    const usageTotalsRecord = usageTotals(usage)
    return {
      key: typeof raw.uuid === "string" ? raw.uuid : entry.messageId ?? entry._id,
      updatedAt: entry.createdAt,
      totals: usageTotalsRecord,
      contextWindowTokens: null,
    }
  }

  const usage = asRecord(raw.usage)
  const modelUsage = asRecord(raw.modelUsage)
  const firstModel = modelUsage ? Object.values(modelUsage).map((value) => asRecord(value)).find(Boolean) ?? null : null
  if (!usage && !firstModel) return null

  const usageTotalsRecord = usage ? usageTotals(usage) : {
    inputTokens: toNumber(firstModel?.inputTokens) ?? 0,
    outputTokens: toNumber(firstModel?.outputTokens) ?? 0,
    cachedInputTokens:
      (toNumber(firstModel?.cacheReadInputTokens) ?? 0)
      + (toNumber(firstModel?.cacheCreationInputTokens) ?? 0),
    reasoningOutputTokens: 0,
    totalTokens:
      (toNumber(firstModel?.inputTokens) ?? 0)
      + (toNumber(firstModel?.outputTokens) ?? 0)
      + (toNumber(firstModel?.cacheReadInputTokens) ?? 0)
      + (toNumber(firstModel?.cacheCreationInputTokens) ?? 0),
  }

  return {
    key: typeof raw.uuid === "string" ? raw.uuid : entry.messageId ?? entry._id,
    updatedAt: entry.createdAt,
    totals: usageTotalsRecord,
    contextWindowTokens: toNumber(firstModel?.contextWindow),
  }
}

export function reconstructClaudeUsage(
  messages: TranscriptEntry[],
  liveRateLimit?: ClaudeRateLimitInfo | null
): ChatUsageSnapshot | null {
  const relevantMessages = relevantMessagesForCurrentContext(messages)
  const deduped = new Map<string, ReturnType<typeof extractClaudeUsageRecord>>()

  for (const entry of relevantMessages) {
    const usageRecord = extractClaudeUsageRecord(entry)
    if (!usageRecord) continue
    deduped.set(usageRecord.key, usageRecord)
  }

  const latest = [...deduped.values()]
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]

  if (!latest && liveRateLimit?.percent == null) {
    return null
  }

  const latestModel = [...relevantMessages]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { kind: "system_init" }> =>
      entry.kind === "system_init" && entry.provider === "claude"
    )
  const fallbackContextWindow = latestModel
    ? CLAUDE_CONTEXT_WINDOW_FALLBACKS[latestModel.model.toLowerCase()] ?? null
    : null

  return buildSnapshot({
    provider: "claude",
    threadTokens: estimateCurrentThreadTokens(messages),
    contextWindowTokens: latest?.contextWindowTokens ?? fallbackContextWindow,
    lastTurnTokens: latest?.totals.totalTokens ?? null,
    inputTokens: latest?.totals.inputTokens ?? null,
    outputTokens: latest?.totals.outputTokens ?? null,
    cachedInputTokens: latest?.totals.cachedInputTokens ?? null,
    reasoningOutputTokens: latest?.totals.reasoningOutputTokens ?? null,
    sessionLimitUsedPercent: liveRateLimit?.percent ?? null,
    rateLimitResetAt: liveRateLimit?.resetsAt ?? null,
    source: latest ? "reconstructed" : "live",
    updatedAt: latest?.updatedAt ?? null,
  })
}

export function createClaudeRateLimitSnapshot(percent: number | null, resetsAt: number | null): ChatUsageSnapshot | null {
  return buildSnapshot({
    provider: "claude",
    threadTokens: null,
    contextWindowTokens: null,
    lastTurnTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    sessionLimitUsedPercent: percent,
    rateLimitResetAt: resetsAt,
    source: "live",
    updatedAt: Date.now(),
  })
}

function stripAnsi(text: string) {
  return text
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
}

function normalizeClaudeScreenText(text: string) {
  return stripAnsi(text)
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n+/g, "\n")
}

function normalizeResetLabel(label: string | null) {
  if (!label) return null
  return label
    .replace(/\b([A-Za-z]{3})(\d)/g, "$1 $2")
    .replace(/,(\S)/g, ", $1")
    .trim()
}

function looksLikeClaudeWeeklyResetLabel(label: string | null) {
  if (!label) return false
  return /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(label)
}

export function parseClaudeUsageScreen(text: string): {
  sessionLimitUsedPercent: number | null
  rateLimitResetLabel: string | null
  weeklyLimitUsedPercent: number | null
  weeklyRateLimitResetLabel: string | null
} | null {
  const normalized = normalizeClaudeScreenText(text)
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  const compactLines = lines.map((line) => line.replace(/\s+/g, "").toLowerCase())
  const parseSection = (pattern: RegExp) => {
    const sectionIndex = compactLines.findIndex((line) => pattern.test(line))
    if (sectionIndex === -1) return null

    let percent: number | null = null
    let resetLabel: string | null = null

    for (let index = sectionIndex; index < Math.min(lines.length, sectionIndex + 6); index += 1) {
      const compact = compactLines[index] ?? ""
      if (percent === null) {
        const match = compact.match(/(\d{1,3})%used/)
        if (match) {
          percent = Number.parseInt(match[1] ?? "", 10)
          continue
        }
      }

      if (resetLabel === null && /^res\w*/.test(compact)) {
        resetLabel = lines[index]?.replace(/^Res(?:ets?|es)?\s*/i, "").trim() ?? null
      }
    }

    if (!Number.isFinite(percent)) return null
    return { percent: toPercent(percent), resetLabel }
  }

  const currentSession = parseSection(/cur\w*session/)
  const currentWeek = parseSection(/current\w*week/)
  if (!currentSession && !currentWeek) return null

  return {
    sessionLimitUsedPercent: currentSession?.percent ?? null,
    rateLimitResetLabel: normalizeResetLabel(currentSession?.resetLabel ?? null),
    weeklyLimitUsedPercent: currentWeek?.percent ?? null,
    weeklyRateLimitResetLabel: normalizeResetLabel(currentWeek?.resetLabel ?? null),
  }
}

function claudeUsageCollectorScript() {
  return [
    "import os, pty, select, subprocess, time, sys",
    "cwd = os.environ.get('CLAUDE_USAGE_CWD') or None",
    "command = ['claude']",
    "if os.environ.get('CLAUDE_USAGE_CONTINUE') == '1':",
    "    command.append('-c')",
    "master, slave = pty.openpty()",
    "proc = subprocess.Popen(command, cwd=cwd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)",
    "os.close(slave)",
    "buf = bytearray()",
    "try:",
    "    ready_deadline = time.time() + 15",
    "    ready_seen_at = None",
    "    while time.time() < ready_deadline:",
    "        r, _, _ = select.select([master], [], [], 0.5)",
    "        if master not in r:",
    "            if ready_seen_at is not None and time.time() - ready_seen_at > 0.7:",
    "                break",
    "            continue",
    "        try:",
    "            data = os.read(master, 65536)",
    "        except OSError:",
    "            break",
    "        if not data:",
    "            break",
    "        buf.extend(data)",
    "        if b'/effort' in buf:",
    "            ready_seen_at = time.time()",
    "    os.write(master, b'/usage\\r')",
    "    deadline = time.time() + 8",
    "    while time.time() < deadline:",
    "        r, _, _ = select.select([master], [], [], 0.5)",
    "        if master not in r:",
    "            continue",
    "        try:",
    "            data = os.read(master, 65536)",
    "        except OSError:",
    "            break",
    "        if not data:",
    "            break",
    "        buf.extend(data)",
    "        week_pos = buf.find(b'Current week')",
    "        if week_pos >= 0 and b'used' in buf[week_pos:]:",
    "            break",
    "    try: os.write(master, b'\\x1b')",
    "    except OSError: pass",
    "    time.sleep(0.2)",
    "    try: os.write(master, b'\\x03')",
    "    except OSError: pass",
    "    time.sleep(0.2)",
    "finally:",
    "    try: proc.terminate()",
    "    except ProcessLookupError: pass",
    "    try: proc.wait(timeout=2)",
    "    except Exception:",
    "        try: proc.kill()",
    "        except ProcessLookupError: pass",
    "sys.stdout.write(buf.decode('utf-8', 'ignore'))",
  ].join("\n")
}

function collectClaudeUsageScreen(args?: { cwd?: string; continueSession?: boolean }) {
  const result = Bun.spawnSync(["python3", "-c", claudeUsageCollectorScript()], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: args?.cwd,
    env: {
      ...process.env,
      ...(args?.cwd ? { CLAUDE_USAGE_CWD: args.cwd } : {}),
      CLAUDE_USAGE_CONTINUE: args?.continueSession ? "1" : "0",
    },
  })
  return new TextDecoder().decode(result.stdout)
}

function isRunningPid(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function findRunningClaudeSessions(): Array<{ cwd: string; sessionId: string; startedAt: number }> {
  const sessionsDir = path.join(homedir(), ".claude", "sessions")
  if (!existsSync(sessionsDir)) return []

  const sessions: Array<{ cwd: string; sessionId: string; startedAt: number }> = []
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    try {
      const data = JSON.parse(readFileSync(path.join(sessionsDir, entry.name), "utf8"))
      const pid = typeof data.pid === "number" ? data.pid : null
      const cwd = typeof data.cwd === "string" ? data.cwd : null
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : null
      const startedAt = typeof data.startedAt === "number" ? data.startedAt : 0
      if (!pid || !cwd || !sessionId) continue
      if (!isRunningPid(pid)) continue
      sessions.push({ cwd, sessionId, startedAt })
    } catch {
      continue
    }
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt)
}

function claudeRateLimitPath(dataDir: string) {
  return path.join(dataDir, "claude-rate-limit.json")
}

function hasClaudeSidebarRateLimitData(snapshot: ChatUsageSnapshot | null): snapshot is ClaudeRateLimitCacheSnapshot {
  if (!snapshot || snapshot.provider !== "claude") return false
  const claudeSnapshot = snapshot as ClaudeRateLimitCacheSnapshot
  return Boolean(
    claudeSnapshot.rateLimitResetLabel
      || claudeSnapshot.weeklyLimitUsedPercent !== undefined
      || claudeSnapshot.weeklyRateLimitResetAt !== undefined
      || claudeSnapshot.weeklyRateLimitResetLabel !== undefined
  )
}

function mergeClaudeProviderSnapshot(
  liveSnapshot: ChatUsageSnapshot | null,
  persistedSnapshot: ChatUsageSnapshot | null
): ChatUsageSnapshot | null {
  if (hasClaudeSidebarRateLimitData(persistedSnapshot)) {
    if (!liveSnapshot) return persistedSnapshot

    const merged = {
      ...liveSnapshot,
      ...persistedSnapshot,
      source: persistedSnapshot.source,
      updatedAt: Math.max(liveSnapshot.updatedAt ?? 0, persistedSnapshot.updatedAt ?? 0) || null,
    } as ClaudeRateLimitCacheSnapshot
    merged.sessionLimitUsedPercent = persistedSnapshot.sessionLimitUsedPercent
    merged.rateLimitResetAt = persistedSnapshot.rateLimitResetAt
    merged.rateLimitResetLabel = persistedSnapshot.rateLimitResetLabel ?? null
    merged.weeklyLimitUsedPercent = persistedSnapshot.weeklyLimitUsedPercent ?? null
    merged.weeklyRateLimitResetAt = persistedSnapshot.weeklyRateLimitResetAt ?? null
    merged.weeklyRateLimitResetLabel = persistedSnapshot.weeklyRateLimitResetLabel ?? null
    merged.warnings = usageWarnings({
      contextUsedPercent: null,
      sessionLimitUsedPercent: merged.sessionLimitUsedPercent,
      updatedAt: merged.updatedAt,
    })
    return merged
  }

  return liveSnapshot ?? persistedSnapshot
}

function createClaudeRateLimitCacheSnapshot(args: {
  sessionLimitUsedPercent: number | null
  rateLimitResetAt: number | null
  rateLimitResetLabel?: string | null
  weeklyLimitUsedPercent?: number | null
  weeklyRateLimitResetAt?: number | null
  weeklyRateLimitResetLabel?: string | null
  updatedAt?: number | null
}): ClaudeRateLimitCacheSnapshot | null {
  const basePercent = args.sessionLimitUsedPercent ?? args.weeklyLimitUsedPercent ?? null
  const snapshot = createClaudeRateLimitSnapshot(basePercent, args.rateLimitResetAt) as ClaudeRateLimitCacheSnapshot | null
  if (!snapshot) return null

  snapshot.sessionLimitUsedPercent = args.sessionLimitUsedPercent
  snapshot.rateLimitResetAt = args.rateLimitResetAt
  snapshot.rateLimitResetLabel = args.rateLimitResetLabel ?? null
  snapshot.weeklyLimitUsedPercent = args.weeklyLimitUsedPercent ?? null
  snapshot.weeklyRateLimitResetAt = args.weeklyRateLimitResetAt ?? null
  snapshot.weeklyRateLimitResetLabel = args.weeklyRateLimitResetLabel ?? null
  snapshot.updatedAt = args.updatedAt ?? snapshot.updatedAt
  snapshot.warnings = usageWarnings({
    contextUsedPercent: null,
    sessionLimitUsedPercent: snapshot.sessionLimitUsedPercent,
    updatedAt: snapshot.updatedAt,
  })
  return snapshot
}

export class ClaudeUsage extends BaseProviderUsage {
  readonly provider = "claude" as const
  private fileCache: { snapshot: ChatUsageSnapshot | null; cachedAt: number } | null = null
  private refreshInFlight: Promise<ChatUsageSnapshot | null> | null = null

  private persistRateLimit(snapshot: ChatUsageSnapshot) {
    try {
      writeFileSync(claudeRateLimitPath(this.dataDir), JSON.stringify({
        sessionLimitUsedPercent: snapshot.sessionLimitUsedPercent,
        rateLimitResetAt: snapshot.rateLimitResetAt,
        rateLimitResetLabel: (snapshot as ClaudeRateLimitCacheSnapshot).rateLimitResetLabel ?? null,
        weeklyLimitUsedPercent: (snapshot as ClaudeRateLimitCacheSnapshot).weeklyLimitUsedPercent ?? null,
        weeklyRateLimitResetAt: (snapshot as ClaudeRateLimitCacheSnapshot).weeklyRateLimitResetAt ?? null,
        weeklyRateLimitResetLabel: (snapshot as ClaudeRateLimitCacheSnapshot).weeklyRateLimitResetLabel ?? null,
        updatedAt: snapshot.updatedAt,
      }))
    } catch {
      // best-effort
    }
  }

  loadPersistedSnapshot(): ChatUsageSnapshot | null {
    const now = Date.now()
    if (this.fileCache && now - this.fileCache.cachedAt < PROVIDER_CACHE_TTL_MS) {
      return this.fileCache.snapshot
    }

    try {
      const filePath = claudeRateLimitPath(this.dataDir)
      if (!existsSync(filePath)) return null
      const data = JSON.parse(readFileSync(filePath, "utf8"))
      let percent = typeof data.sessionLimitUsedPercent === "number" ? data.sessionLimitUsedPercent : null
      const resetsAt = typeof data.rateLimitResetAt === "number" ? data.rateLimitResetAt : null
      let resetLabel = typeof data.rateLimitResetLabel === "string" ? data.rateLimitResetLabel : null
      let weeklyPercent = typeof data.weeklyLimitUsedPercent === "number" ? data.weeklyLimitUsedPercent : null
      const weeklyResetsAt = typeof data.weeklyRateLimitResetAt === "number" ? data.weeklyRateLimitResetAt : null
      let weeklyResetLabel = typeof data.weeklyRateLimitResetLabel === "string" ? data.weeklyRateLimitResetLabel : null
      const persistedAt = typeof data.updatedAt === "number" ? data.updatedAt : null

      if (weeklyPercent === null && weeklyResetsAt === null && weeklyResetLabel === null && looksLikeClaudeWeeklyResetLabel(resetLabel)) {
        weeklyPercent = percent
        weeklyResetLabel = resetLabel
        percent = null
        resetLabel = null
      }

      if (percent === null && resetsAt === null && weeklyPercent === null && weeklyResetsAt === null) return null

      const snapshot = createClaudeRateLimitCacheSnapshot({
        sessionLimitUsedPercent: percent,
        rateLimitResetAt: resetsAt,
        rateLimitResetLabel: resetLabel,
        weeklyLimitUsedPercent: weeklyPercent,
        weeklyRateLimitResetAt: weeklyResetsAt,
        weeklyRateLimitResetLabel: weeklyResetLabel,
        updatedAt: persistedAt,
      })
      this.fileCache = { snapshot, cachedAt: now }
      return snapshot
    } catch {
      this.fileCache = { snapshot: null, cachedAt: now }
      return null
    }
  }

  loadPersistedEntry(): ProviderUsageEntry | null {
    return snapshotToEntry(this.provider, this.loadPersistedSnapshot())
  }

  deriveEntry(liveSnapshot: ChatUsageSnapshot | null): ProviderUsageEntry {
    const mergedSnapshot = mergeClaudeProviderSnapshot(liveSnapshot, this.loadPersistedSnapshot())
    if (hasClaudeSidebarRateLimitData(mergedSnapshot)) {
      this.persistRateLimit(mergedSnapshot)
    }
    return snapshotToEntry(this.provider, mergedSnapshot)
  }

  async refreshFromCli(runCommand?: () => Promise<string>, force = false): Promise<ChatUsageSnapshot | null> {
    if (!runCommand) {
      if (this.refreshInFlight) {
        return this.refreshInFlight
      }

      if (this.shouldSkipRefresh(this.provider, PROVIDER_USAGE_REQUEST_MIN_INTERVAL_MS, force)) {
        return this.loadPersistedSnapshot()
      }

      this.recordRequestTime(this.provider)
    }

    const performRefresh = async () => {
      let parsed: ReturnType<typeof parseClaudeUsageScreen> = null

      if (runCommand) {
        parsed = parseClaudeUsageScreen(await runCommand())
      } else {
        const liveSessions = findRunningClaudeSessions()
        let best: ReturnType<typeof parseClaudeUsageScreen> = null

        for (const session of liveSessions) {
          const candidate = parseClaudeUsageScreen(collectClaudeUsageScreen({
            cwd: session.cwd,
            continueSession: true,
          }))
          if (!candidate?.sessionLimitUsedPercent && candidate?.sessionLimitUsedPercent !== 0) continue
          if (!best || (candidate.sessionLimitUsedPercent ?? -1) > (best.sessionLimitUsedPercent ?? -1)) {
            best = candidate
          }
        }

        parsed = best ?? parseClaudeUsageScreen(collectClaudeUsageScreen())
      }

      if (!parsed) return null

      const snapshot = createClaudeRateLimitCacheSnapshot({
        sessionLimitUsedPercent: parsed.sessionLimitUsedPercent,
        rateLimitResetAt: null,
        rateLimitResetLabel: parsed.rateLimitResetLabel,
        weeklyLimitUsedPercent: parsed.weeklyLimitUsedPercent,
        weeklyRateLimitResetAt: null,
        weeklyRateLimitResetLabel: parsed.weeklyRateLimitResetLabel,
        updatedAt: Date.now(),
      })
      if (!snapshot) return null
      this.persistRateLimit(snapshot)
      this.fileCache = { snapshot, cachedAt: Date.now() }
      return snapshot
    }

    if (runCommand) {
      return performRefresh()
    }

    this.refreshInFlight = performRefresh().finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }
}

const _instances = new Map<string, ClaudeUsage>()

export function getClaudeUsage(dataDir: string): ClaudeUsage {
  if (!_instances.has(dataDir)) {
    _instances.set(dataDir, new ClaudeUsage(dataDir))
  }
  return _instances.get(dataDir)!
}

export async function refreshClaudeRateLimitFromCli(
  dataDir: string,
  runCommand?: () => Promise<string>,
  force?: boolean
): Promise<ChatUsageSnapshot | null> {
  return getClaudeUsage(dataDir).refreshFromCli(runCommand, force)
}

export function resetClaudeUsageCaches() {
  _instances.clear()
}
