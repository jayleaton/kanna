import { create } from "zustand"
import { persist } from "zustand/middleware"

export const DEFAULT_TERMINAL_SCROLLBACK = 1_000
export const MIN_TERMINAL_SCROLLBACK = 500
export const MAX_TERMINAL_SCROLLBACK = 5_000

function clampScrollback(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_SCROLLBACK
  return Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(MIN_TERMINAL_SCROLLBACK, Math.round(value)))
}

interface TerminalPreferencesState {
  scrollbackLines: number
  setScrollbackLines: (scrollbackLines: number) => void
}

export const useTerminalPreferencesStore = create<TerminalPreferencesState>()(
  persist(
    (set) => ({
      scrollbackLines: DEFAULT_TERMINAL_SCROLLBACK,
      setScrollbackLines: (scrollbackLines) => set({ scrollbackLines: clampScrollback(scrollbackLines) }),
    }),
    {
      name: "terminal-preferences",
      version: 1,
      migrate: (persistedState) => {
        const state = persistedState as Partial<TerminalPreferencesState> | undefined
        return {
          scrollbackLines: clampScrollback(state?.scrollbackLines ?? DEFAULT_TERMINAL_SCROLLBACK),
        }
      },
    }
  )
)
