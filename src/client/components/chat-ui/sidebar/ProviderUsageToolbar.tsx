import { useState } from "react"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { PROVIDERS, type AgentProvider, type ProviderUsageEntry, type ProviderUsageMap } from "../../../../shared/types"
import { PROVIDER_ICONS } from "../ChatPreferenceControls"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import { cn } from "../../../lib/utils"

const STORAGE_KEY = "kanna:provider-usage-collapsed"
const MODE_STORAGE_KEY = "kanna:provider-usage-mode"
const ALL_PROVIDERS = PROVIDERS.map((provider) => provider.id) as AgentProvider[]
const WEEKLY_PROVIDERS: AgentProvider[] = ["claude", "codex"]
type ProviderUsageMode = "session" | "weekly"

const PROVIDER_LABELS = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.id, provider.label])
) as Record<AgentProvider, string>

function barColor(percent: number | null): string {
  if (percent === null) return "bg-muted"
  if (percent >= 90) return "bg-red-500"
  if (percent >= 75) return "bg-amber-500"
  return "bg-emerald-500"
}

function formatPercent(percent: number | null): string {
  if (percent === null) return "N/A"
  return `${percent.toFixed(1)}%`
}

function formatResetTime(resetAt: number | null, resetLabel?: string | null): string | null {
  if (resetLabel?.trim()) return `Resets ${resetLabel.trim()}`
  if (resetAt === null) return null

  const now = Date.now()
  if (resetAt <= now) return "Limit may have reset"

  const diffMs = resetAt - now
  const minutes = Math.ceil(diffMs / 60_000)

  if (minutes < 60) return `Resets in ${minutes} min`

  const date = new Date(resetAt)
  return `Resets at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function readMode(): ProviderUsageMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === "weekly" ? "weekly" : "session"
  } catch {
    return "session"
  }
}

function writeCollapsed(value: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch { /* noop */ }
}

function writeMode(value: ProviderUsageMode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, value)
  } catch { /* noop */ }
}

function ProviderUsageRow(args: {
  entry: ProviderUsageEntry
  mode: ProviderUsageMode
  isPending: boolean
  labelOverride?: string
  percentOverride?: number | null
  bars?: { label: string; percent: number | null }[]
  hideActions?: boolean
  onRefreshProviderUsage?: (provider: "cursor") => Promise<void>
  onOpenProviderLogin?: (provider: "cursor") => void
}) {
  const { entry, mode, isPending, onRefreshProviderUsage, onOpenProviderLogin } = args
  const Icon = PROVIDER_ICONS[entry.provider]
  const label = args.labelOverride ?? PROVIDER_LABELS[entry.provider]
  const isUnavailable = entry.availability === "unavailable"
  const isLoginRequired = entry.availability === "login_required"
  const isStale = entry.availability === "stale"
  const isCursor = entry.provider === "cursor"
  const percent = args.percentOverride !== undefined
    ? args.percentOverride
    : mode === "weekly"
      ? (entry.weeklyLimitUsedPercent ?? null)
      : entry.sessionLimitUsedPercent
  const displayPercent = percent
  const resetLabel = isCursor
    ? null
    : mode === "weekly"
      ? formatResetTime(entry.weeklyRateLimitResetAt ?? null, entry.weeklyRateLimitResetLabel ?? null)
      : formatResetTime(entry.rateLimitResetAt, entry.rateLimitResetLabel)

  const tooltipLines: string[] = []
  if (isLoginRequired) {
    tooltipLines.push("Login required to fetch Cursor usage")
  } else if (isUnavailable) {
    tooltipLines.push("Usage data unavailable")
  } else {
    if (args.bars) {
      tooltipLines.push("Cursor limit usage")
    } else if (percent !== null) {
      tooltipLines.push(`${formatPercent(percent)} of ${mode} limit used`)
    }
    if (resetLabel) tooltipLines.push(resetLabel)
    if (isStale) tooltipLines.push("Data may be outdated")
    if (tooltipLines.length === 0) tooltipLines.push("No usage data yet")
  }
  if (entry.statusDetail) {
    tooltipLines.push(entry.statusDetail.replaceAll("_", " "))
  }

  const showCursorLogin = !args.hideActions && isCursor && isLoginRequired
  const showCursorRefresh = isCursor
    && !args.hideActions
    && isUnavailable
    && !isLoginRequired
    && entry.statusDetail !== "unsupported_platform"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("flex flex-col", isStale && "opacity-50")}>
          <div className="flex items-center gap-2 px-2 py-1 rounded-md">
            <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground w-11 shrink-0">{label}</span>

            {isUnavailable && !args.bars ? (
              <span className="text-[10px] text-muted-foreground/60 ml-auto">N/A</span>
            ) : args.bars ? (
              <div className="flex-1" />
            ) : (
              <>
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden min-w-0">
                  {displayPercent !== null ? (
                    <div
                      className={cn("h-full rounded-full transition-all", barColor(displayPercent))}
                      style={{ width: `${Math.min(100, Math.max(0, displayPercent))}%` }}
                    />
                  ) : null}
                </div>
                <span className="text-[10px] tabular-nums text-muted-foreground w-7 text-right shrink-0">
                  {formatPercent(displayPercent)}
                </span>
              </>
            )}

            {showCursorLogin ? (
              <button
                type="button"
                disabled={isPending}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenProviderLogin?.("cursor")
                }}
                className="ml-auto rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
              >
                Sign In
              </button>
            ) : null}

            {showCursorRefresh ? (
              <button
                type="button"
                disabled={isPending}
                onClick={(event) => {
                  event.stopPropagation()
                  onRefreshProviderUsage?.("cursor")
                }}
                className="flex items-center gap-1 rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
              >
                {isPending && <RefreshCw className="h-2 w-2 animate-spin" />}
                {isPending ? "Checking" : "Refresh"}
              </button>
            ) : null}
          </div>

          {args.bars && (
            <div className="flex flex-col gap-1 pb-1">
              {args.bars.map((bar, i) => (
                <div key={i} className="flex items-center gap-2 pl-7 pr-2">
                  <span className="text-[10px] text-muted-foreground w-12 shrink-0">{bar.label}</span>
                  {isUnavailable ? (
                    <span className="text-[10px] text-muted-foreground/60 ml-auto">N/A</span>
                  ) : (
                    <>
                      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden min-w-0">
                        {bar.percent !== null ? (
                          <div
                            className={cn("h-full rounded-full transition-all", barColor(bar.percent))}
                            style={{ width: `${Math.min(100, Math.max(0, bar.percent))}%` }}
                          />
                        ) : null}
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground w-7 text-right shrink-0">
                        {formatPercent(bar.percent)}
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-48">
        {tooltipLines.map((line, i) => (
          <div key={i} className="text-xs">{line}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

interface ProviderUsageToolbarProps {
  providerUsage?: ProviderUsageMap
  visibleProviders?: AgentProvider[]
  onRefreshProviderUsage?: (provider?: AgentProvider) => Promise<void>
  onOpenProviderLogin?: (provider: "cursor") => void
}

export function ProviderUsageToolbar({
  providerUsage,
  visibleProviders = ALL_PROVIDERS,
  onRefreshProviderUsage,
  onOpenProviderLogin,
}: ProviderUsageToolbarProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mode, setMode] = useState<ProviderUsageMode>(readMode)
  const [pendingProvider, setPendingProvider] = useState<"cursor" | "all" | null>(null)

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev
      writeCollapsed(next)
      return next
    })
  }

  const handleRefreshAll = async () => {
    setPendingProvider("all")
    try {
      await onRefreshProviderUsage?.()
      toast("Usage checked successfully.")
    } catch {
      toast("Failed to check usage.")
    } finally {
      setPendingProvider((current) => current === "all" ? null : current)
    }
  }

  return (
    <div className="px-1 pb-1.5">
      <div className="flex items-center gap-2 px-2 pb-0.5">
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left group"
        >
          {collapsed
            ? <ChevronRight className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
            : <ChevronDown className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />}
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium group-hover:text-muted-foreground transition-colors">
            Provider Usage
          </span>
        </button>

        {!collapsed && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleRefreshAll}
              disabled={pendingProvider === "all"}
              className="shrink-0 rounded-md border border-border/70 bg-muted/40 p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
              title="Refresh usages"
            >
              <RefreshCw className={cn("h-3 w-3", pendingProvider === "all" && "animate-spin")} />
            </button>
            <button
              type="button"
              onClick={() => {
                setMode((current) => {
                  const next: ProviderUsageMode = current === "session" ? "weekly" : "session"
                  writeMode(next)
                  return next
                })
              }}
              className="shrink-0 rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              {mode === "session" ? "Session" : "Weekly"}
            </button>
          </div>
        )}
      </div>

      {!collapsed && (mode === "weekly" ? WEEKLY_PROVIDERS : visibleProviders).flatMap((provider) => {
        const entry: ProviderUsageEntry = providerUsage?.[provider] ?? {
          provider,
          sessionLimitUsedPercent: null,
          apiLimitUsedPercent: null,
          rateLimitResetAt: null,
          rateLimitResetLabel: null,
          weeklyLimitUsedPercent: null,
          weeklyRateLimitResetAt: null,
          weeklyRateLimitResetLabel: null,
          statusDetail: null,
          availability: "unavailable",
          lastRequestedAt: null,
          updatedAt: null,
          warnings: [],
        }
        const handleRefreshProviderUsage = async (nextProvider: "cursor") => {
          setPendingProvider(nextProvider)
          try {
            await onRefreshProviderUsage?.(nextProvider)
            toast(`${PROVIDER_LABELS[nextProvider] ?? "Provider"} usage checked successfully.`)
          } catch {
            toast(`Failed to check ${PROVIDER_LABELS[nextProvider] ?? "provider"} usage.`)
          } finally {
            setPendingProvider((current) => current === nextProvider ? null : current)
          }
        }
        const handleOpenProviderLogin = (nextProvider: "cursor") => {
          setPendingProvider(nextProvider)
          Promise.resolve(onOpenProviderLogin?.(nextProvider)).finally(() => {
            setPendingProvider((current) => current === nextProvider ? null : current)
          })
        }

        if (provider === "cursor" && mode === "session") {
          return [
            <ProviderUsageRow
              key="cursor"
              entry={entry}
              mode={mode}
              isPending={pendingProvider === "cursor"}
              bars={[
                { label: "API", percent: entry.apiLimitUsedPercent ?? null },
                { label: "Composer", percent: entry.sessionLimitUsedPercent },
              ]}
              onRefreshProviderUsage={handleRefreshProviderUsage}
              onOpenProviderLogin={handleOpenProviderLogin}
            />,
          ]
        }

        return [
          <ProviderUsageRow
            key={provider}
            entry={entry}
            mode={mode}
            isPending={pendingProvider === provider || pendingProvider === "all"}
            onRefreshProviderUsage={handleRefreshProviderUsage}
            onOpenProviderLogin={handleOpenProviderLogin}
          />,
        ]
      })}
    </div>
  )
}
