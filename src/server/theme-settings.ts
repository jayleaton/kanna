import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getThemeSettingsFilePath, LOG_PREFIX } from "../shared/branding"
import {
  DEFAULT_THEME_SETTINGS,
  type ColorTheme,
  type CustomAppearance,
  type ThemePreference,
  type ThemeSettingsSnapshot,
} from "../shared/types"

const VALID_THEME_PREFERENCES: ThemePreference[] = ["light", "dark", "system", "custom"]
const VALID_COLOR_THEMES: ColorTheme[] = ["default", "tokyo-night", "catppuccin", "dracula", "nord", "everforest", "rose-pine"]
const VALID_CUSTOM_APPEARANCES: CustomAppearance[] = ["light", "dark", "system"]

export class ThemeSettingsManager {
  readonly filePath: string
  private watcher: FSWatcher | null = null
  private snapshot: ThemeSettingsSnapshot
  private readonly listeners = new Set<(snapshot: ThemeSettingsSnapshot) => void>()

  constructor(filePath = getThemeSettingsFilePath(homedir())) {
    this.filePath = filePath
    this.snapshot = createDefaultSnapshot(this.filePath)
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const file = Bun.file(this.filePath)
    if (!(await file.exists())) {
      await writeFile(this.filePath, `${JSON.stringify(DEFAULT_THEME_SETTINGS, null, 2)}\n`, "utf8")
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

  onChange(listener: (snapshot: ThemeSettingsSnapshot) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async reload() {
    const nextSnapshot = await readThemeSettingsSnapshot(this.filePath)
    this.setSnapshot(nextSnapshot)
  }

  async write(settings: ThemeSettingsSnapshot["settings"]) {
    const nextSnapshot = normalizeThemeSettings(settings, this.filePath)
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(nextSnapshot.settings, null, 2)}\n`, "utf8")
    this.setSnapshot(nextSnapshot)
    return nextSnapshot
  }

  private setSnapshot(snapshot: ThemeSettingsSnapshot) {
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
          console.warn(`${LOG_PREFIX} Failed to reload theme settings:`, error)
        })
      })
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to watch theme settings file:`, error)
      this.watcher = null
    }
  }
}

export async function readThemeSettingsSnapshot(filePath: string): Promise<ThemeSettingsSnapshot> {
  try {
    const text = await readFile(filePath, "utf8")
    if (!text.trim()) {
      return createDefaultSnapshot(filePath, "Theme settings file was empty. Using defaults.")
    }
    const parsed = JSON.parse(text) as Partial<ThemeSettingsSnapshot["settings"]>
    return normalizeThemeSettings(parsed, filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return createDefaultSnapshot(filePath)
    }
    if (error instanceof SyntaxError) {
      return createDefaultSnapshot(filePath, "Theme settings file is invalid JSON. Using defaults.")
    }
    throw error
  }
}

export function normalizeThemeSettings(
  value: Partial<ThemeSettingsSnapshot["settings"]> | null | undefined,
  filePath = getThemeSettingsFilePath(homedir())
): ThemeSettingsSnapshot {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}

  const themePreference: ThemePreference = VALID_THEME_PREFERENCES.includes(source.themePreference as ThemePreference)
    ? source.themePreference as ThemePreference
    : DEFAULT_THEME_SETTINGS.themePreference

  const colorTheme: ColorTheme = VALID_COLOR_THEMES.includes(source.colorTheme as ColorTheme)
    ? source.colorTheme as ColorTheme
    : DEFAULT_THEME_SETTINGS.colorTheme

  const customAppearance: CustomAppearance = VALID_CUSTOM_APPEARANCES.includes(source.customAppearance as CustomAppearance)
    ? source.customAppearance as CustomAppearance
    : DEFAULT_THEME_SETTINGS.customAppearance

  const backgroundImage: string | null =
    typeof source.backgroundImage === "string" ? source.backgroundImage : DEFAULT_THEME_SETTINGS.backgroundImage

  const backgroundOpacity: number =
    typeof source.backgroundOpacity === "number" && source.backgroundOpacity >= 0 && source.backgroundOpacity <= 1
      ? source.backgroundOpacity
      : DEFAULT_THEME_SETTINGS.backgroundOpacity

  const backgroundBlur: number =
    typeof source.backgroundBlur === "number" && source.backgroundBlur >= 0
      ? source.backgroundBlur
      : DEFAULT_THEME_SETTINGS.backgroundBlur

  return {
    settings: {
      themePreference,
      colorTheme,
      customAppearance,
      backgroundImage,
      backgroundOpacity,
      backgroundBlur,
    },
    warning: null,
    filePathDisplay: formatDisplayPath(filePath),
  }
}

function createDefaultSnapshot(filePath: string, warning: string | null = null): ThemeSettingsSnapshot {
  return {
    settings: { ...DEFAULT_THEME_SETTINGS },
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
