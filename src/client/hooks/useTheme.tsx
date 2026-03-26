import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react"
import { useThemeSettingsStore } from "../stores/themeSettingsStore"
import type { ThemePreference } from "../../shared/types"

export type { ThemePreference }

interface ThemeContextValue {
  theme: ThemePreference
  resolvedTheme: "light" | "dark"
  setTheme: (theme: ThemePreference) => void
}

// Keep this key for one-time migration from old localStorage storage
const LEGACY_THEME_STORAGE_KEY = "lever-theme"
const MANIFEST_HREF_BY_THEME = {
  light: "/manifest.webmanifest",
  dark: "/manifest-dark.webmanifest",
  custom: "/manifest-dark.webmanifest",
} as const
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

const isValidTheme = (value: string | null): value is ThemePreference => {
  return value === "light" || value === "dark" || value === "system" || value === "custom"
}

const getSystemTheme = (): "light" | "dark" => {
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const applyThemeClass = (preference: ThemePreference, customAppearance?: "light" | "dark" | "system") => {
  if (typeof document === "undefined") return
  let resolved: "light" | "dark"
  if (preference === "custom") {
    resolved = (customAppearance === "system" || !customAppearance) ? getSystemTheme() : customAppearance
  } else {
    resolved = preference === "system" ? getSystemTheme() : preference
  }
  document.documentElement.classList.toggle("dark", resolved === "dark")
}

const syncThemeMeta = (resolvedTheme: "light" | "dark") => {
  if (typeof document === "undefined") return

  document.documentElement.style.colorScheme = resolvedTheme

  const themeColorMeta = document.querySelector('meta[name="theme-color"]')
  if (themeColorMeta) {
    const backgroundColor = getComputedStyle(document.body).backgroundColor
    if (backgroundColor && backgroundColor !== "rgba(0, 0, 0, 0)" && backgroundColor !== "transparent") {
      themeColorMeta.setAttribute("content", backgroundColor)
    }
  }

  const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]#app-manifest')
  const nextManifestHref = MANIFEST_HREF_BY_THEME[resolvedTheme]
  if (manifestLink && manifestLink.getAttribute("href") !== nextManifestHref) {
    manifestLink.setAttribute("href", nextManifestHref)
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useThemeSettingsStore((state) => state.themePreference)
  const setThemePreference = useThemeSettingsStore((state) => state.setThemePreference)
  const colorTheme = useThemeSettingsStore((state) => state.colorTheme)
  const customAppearance = useThemeSettingsStore((state) => state.customAppearance)
  const backgroundImage = useThemeSettingsStore((state) => state.backgroundImage)
  const backgroundOpacity = useThemeSettingsStore((state) => state.backgroundOpacity)
  const backgroundBlur = useThemeSettingsStore((state) => state.backgroundBlur)

  // One-time migration from old localStorage key to Zustand store
  useEffect(() => {
    if (typeof window === "undefined") return
    const legacy = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
    if (isValidTheme(legacy)) {
      const stored = useThemeSettingsStore.getState().themePreference
      if (stored === "system" && legacy !== "system") {
        setThemePreference(legacy)
      }
      window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    applyThemeClass(theme, customAppearance)
    const resolvedTheme = theme === "custom" ? (customAppearance === "system" ? getSystemTheme() : customAppearance) : (theme === "system" ? getSystemTheme() : theme)
    syncThemeMeta(resolvedTheme)
  }, [theme, customAppearance])

  useEffect(() => {
    if (theme !== "system" && (theme !== "custom" || customAppearance !== "system")) return
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      applyThemeClass(theme, customAppearance)
      syncThemeMeta(getSystemTheme())
    }

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange)
      return () => mediaQuery.removeEventListener("change", handleChange)
    }

    mediaQuery.addListener(handleChange)
    return () => mediaQuery.removeListener(handleChange)
  }, [theme, customAppearance])

  useEffect(() => {
    if (typeof document === "undefined") return
    if (theme === "custom") {
      document.documentElement.setAttribute("data-theme", colorTheme)
    } else {
      document.documentElement.removeAttribute("data-theme")
    }
  }, [theme, colorTheme])

  useEffect(() => {
    if (typeof document === "undefined") return

    let styleEl = document.getElementById("kanna-custom-theme-styles")
    if (!styleEl) {
      styleEl = document.createElement("style")
      styleEl.id = "kanna-custom-theme-styles"
      document.head.appendChild(styleEl)
    }

    const hasBg = theme === "custom" && backgroundImage && backgroundImage.trim() !== ""
    const css = []

    if (hasBg) {
      const spread = backgroundBlur ? backgroundBlur * 2 : 0;
      css.push(`
        body {
          background-image: none !important;
          background-color: transparent !important;
        }
        body::before {
          content: "";
          position: fixed;
          top: -${spread}px;
          left: -${spread}px;
          right: -${spread}px;
          bottom: -${spread}px;
          background-image: url("${backgroundImage}");
          background-size: cover;
          background-position: center;
          filter: blur(${backgroundBlur}px);
          z-index: -2;
          pointer-events: none;
        }
        body::after {
          content: "";
          position: fixed;
          inset: 0;
          background-color: hsl(var(--background) / ${backgroundOpacity});
          z-index: -1;
          pointer-events: none;
        }
        #root {
          background-color: transparent !important;
        }
        :root {
          --color-background: transparent !important;
          --color-card: hsl(var(--card) / 0.15) !important;
          --color-popover: hsl(var(--popover) / 0.8) !important;
          --color-muted: hsl(var(--muted) / 0.25) !important;
        }
        .kanna-terminal, .xterm-viewport, .xterm-screen {
          background-color: transparent !important;
        }
      `)
    } else {
      css.push(`
        body {
          background-image: none !important;
        }
        body::before {
          display: none;
        }
        #root {
          background-color: transparent;
        }
      `)
    }

    styleEl.textContent = css.join("\n")
  }, [theme, backgroundImage, backgroundOpacity, backgroundBlur])

  const setTheme = (next: ThemePreference) => {
    setThemePreference(next)
  }

  const value = useMemo<ThemeContextValue>(() => {
    const resolvedTheme = theme === "custom" ? (customAppearance === "system" ? getSystemTheme() : customAppearance) : (theme === "system" ? getSystemTheme() : theme)
    return { theme, resolvedTheme, setTheme }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, customAppearance, setThemePreference])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}
