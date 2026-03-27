import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getProviderSettingsFilePath, LOG_PREFIX } from "../shared/branding"
import {
  DEFAULT_PROVIDER_SETTINGS,
  type AgentProvider,
  type ProviderSettingsEntry,
  type ProviderSettingsSnapshot,
} from "../shared/types"

const PROVIDER_IDS = Object.keys(DEFAULT_PROVIDER_SETTINGS) as AgentProvider[]

type ProviderSettingsFile = Partial<Record<AgentProvider, Partial<ProviderSettingsEntry>>>

export class ProviderSettingsManager {
  readonly filePath: string
  private watcher: FSWatcher | null = null
  private snapshot: ProviderSettingsSnapshot
  private readonly listeners = new Set<(snapshot: ProviderSettingsSnapshot) => void>()

  constructor(filePath = getProviderSettingsFilePath(homedir())) {
    this.filePath = filePath
    this.snapshot = createDefaultSnapshot(this.filePath)
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const file = Bun.file(this.filePath)
    if (!(await file.exists())) {
      await writeFile(this.filePath, `${JSON.stringify(DEFAULT_PROVIDER_SETTINGS, null, 2)}\n`, "utf8")
    }
    await this.reload()
    this.startWatching()
  }

  dispose() {
    this.watcher?.close()
    this.watcher = null
    this.listeners.clear()
  }

  getSnapshot() {
    return this.snapshot
  }

  onChange(listener: (snapshot: ProviderSettingsSnapshot) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async reload() {
    const nextSnapshot = await readProviderSettingsSnapshot(this.filePath)
    this.setSnapshot(nextSnapshot)
  }

  async write(settings: ProviderSettingsSnapshot["settings"]) {
    const nextSnapshot = normalizeProviderSettings(settings, this.filePath)
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(nextSnapshot.settings, null, 2)}\n`, "utf8")
    this.setSnapshot(nextSnapshot)
    return nextSnapshot
  }

  private setSnapshot(snapshot: ProviderSettingsSnapshot) {
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  private startWatching() {
    this.watcher?.close()
    try {
      this.watcher = watch(path.dirname(this.filePath), { persistent: false }, (_eventType, filename) => {
        if (filename && filename !== path.basename(this.filePath)) {
          return
        }
        void this.reload().catch((error: unknown) => {
          console.warn(`${LOG_PREFIX} Failed to reload provider settings:`, error)
        })
      })
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to watch provider settings file:`, error)
      this.watcher = null
    }
  }
}

export async function readProviderSettingsSnapshot(filePath: string): Promise<ProviderSettingsSnapshot> {
  try {
    const text = await readFile(filePath, "utf8")
    if (!text.trim()) {
      return createDefaultSnapshot(filePath, "Provider settings file was empty. Using defaults.")
    }
    const parsed = JSON.parse(text) as ProviderSettingsFile
    return normalizeProviderSettings(parsed, filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return createDefaultSnapshot(filePath)
    }
    if (error instanceof SyntaxError) {
      return createDefaultSnapshot(filePath, "Provider settings file is invalid JSON. Using defaults.")
    }
    throw error
  }
}

export function normalizeProviderSettings(
  value: ProviderSettingsFile | null | undefined,
  filePath = getProviderSettingsFilePath(homedir())
): ProviderSettingsSnapshot {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}

  const settings = {} as ProviderSettingsSnapshot["settings"]
  for (const provider of PROVIDER_IDS) {
    const rawValue = source[provider]
    const defaultValue = DEFAULT_PROVIDER_SETTINGS[provider]

    settings[provider] = {
      active: typeof rawValue?.active === "boolean" ? rawValue.active : defaultValue.active,
    }
  }

  return {
    settings,
    warning: null,
    filePathDisplay: formatDisplayPath(filePath),
  }
}

function createDefaultSnapshot(filePath: string, warning: string | null = null): ProviderSettingsSnapshot {
  return {
    settings: {
      claude: { ...DEFAULT_PROVIDER_SETTINGS.claude },
      codex: { ...DEFAULT_PROVIDER_SETTINGS.codex },
      gemini: { ...DEFAULT_PROVIDER_SETTINGS.gemini },
      cursor: { ...DEFAULT_PROVIDER_SETTINGS.cursor },
    },
    warning,
    filePathDisplay: formatDisplayPath(filePath),
  }
}

function formatDisplayPath(filePath: string) {
  const homePath = homedir()
  if (filePath === homePath) return "~"
  if (filePath.startsWith(`${homePath}${path.sep}`)) {
    return `~${filePath.slice(homePath.length)}`
  }
  return filePath
}
