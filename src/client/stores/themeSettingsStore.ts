import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { ColorTheme, CustomAppearance, ThemePreference } from "../../shared/types"

export type { ColorTheme, CustomAppearance, ThemePreference }

interface ThemeSettingsState {
  themePreference: ThemePreference
  colorTheme: ColorTheme
  customAppearance: CustomAppearance
  backgroundImage: string | null
  backgroundOpacity: number
  backgroundBlur: number
  setThemePreference: (pref: ThemePreference) => void
  setColorTheme: (theme: ColorTheme) => void
  setCustomAppearance: (appearance: CustomAppearance) => void
  setBackgroundImage: (image: string | null) => void
  setBackgroundOpacity: (opacity: number) => void
  setBackgroundBlur: (blur: number) => void
}

export const useThemeSettingsStore = create<ThemeSettingsState>()(
  persist(
    (set) => ({
      themePreference: "system",
      colorTheme: "default",
      customAppearance: "system",
      backgroundImage: null,
      backgroundOpacity: 1,
      backgroundBlur: 0,
      setThemePreference: (themePreference) => set({ themePreference }),
      setColorTheme: (colorTheme) => set({ colorTheme }),
      setCustomAppearance: (customAppearance) => set({ customAppearance }),
      setBackgroundImage: (backgroundImage) => set({ backgroundImage }),
      setBackgroundOpacity: (backgroundOpacity) => set({ backgroundOpacity }),
      setBackgroundBlur: (backgroundBlur) => set({ backgroundBlur }),
    }),
    {
      name: "theme-settings",
    }
  )
)
