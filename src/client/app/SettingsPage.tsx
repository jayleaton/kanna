import { Info, Loader2, Settings } from "lucide-react"
import { useOutletContext } from "react-router-dom"
import { SDK_CLIENT_APP } from "../../shared/branding"
import {
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  useTerminalPreferencesStore,
} from "../stores/terminalPreferencesStore"
import { PageHeader } from "./PageHeader"
import type { KannaState } from "./useKannaState"

function SettingsCard({
  title,
  description,
  value,
}: {
  title: string
  description: string
  value: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-1 text-sm font-medium text-foreground">{title}</div>
      <div className="mb-3 text-sm text-muted-foreground">{description}</div>
      <div className="rounded-xl border border-border bg-background px-3 py-2 font-mono text-sm text-foreground">
        {value}
      </div>
    </div>
  )
}

export function SettingsPage() {
  const state = useOutletContext<KannaState>()
  const isConnecting = state.connectionStatus === "connecting" || !state.localProjectsReady
  const machineName = state.localProjects?.machine.displayName ?? "Settings"
  const scrollbackLines = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const setScrollbackLines = useTerminalPreferencesStore((store) => store.setScrollbackLines)

  return (
    <div className="flex-1 min-w-0 overflow-y-auto bg-background">
      <PageHeader
        icon={Settings}
        title={machineName}
        subtitle={isConnecting
          ? "Kanna is starting up and loading your local environment settings."
          : "Kanna is connected. Configure app details and review your local environment."}
      />

      <div className="w-full px-6 pb-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground">Settings</h2>
        </div>

        {isConnecting ? (
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading machine settings…</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <SettingsCard
              title="Machine"
              description="The local machine currently connected to Kanna."
              value={state.localProjects?.machine.displayName ?? "Unavailable"}
            />
            <SettingsCard
              title="Connection"
              description="Current connection state for the local Kanna runtime."
              value={state.connectionStatus}
            />
            <SettingsCard
              title="Projects Indexed"
              description="Number of local projects currently available in the app."
              value={String(state.localProjects?.projects.length ?? 0)}
            />
            <SettingsCard
              title="App Version"
              description="Current Kanna desktop client build."
              value={SDK_CLIENT_APP.split("/")[1] ?? "unknown"}
            />
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="mb-1 text-sm font-medium text-foreground">Terminal Scrollback</div>
              <div className="mb-3 text-sm text-muted-foreground">
                Number of lines retained for embedded terminal history.
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={MIN_TERMINAL_SCROLLBACK}
                  max={MAX_TERMINAL_SCROLLBACK}
                  step={100}
                  value={scrollbackLines}
                  onChange={(event) => setScrollbackLines(Number(event.target.value))}
                  className="w-32 rounded-xl border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none ring-0"
                />
                <div className="text-xs text-muted-foreground">
                  {MIN_TERMINAL_SCROLLBACK}-{MAX_TERMINAL_SCROLLBACK} lines
                </div>
              </div>
            </div>
          </div>
        )}

        {state.commandError ? (
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{state.commandError}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
