import { describe, expect, test } from "bun:test"
import { getCompactComposerLabels } from "./ChatInput"

describe("getCompactComposerLabels", () => {
  test("hides the Codex provider text in compact mode", () => {
    expect(getCompactComposerLabels({
      selectedProvider: "codex",
      codexFastMode: false,
      planMode: false,
    }).providerText).toBeNull()
  })

  test("keeps the Claude provider text in compact mode", () => {
    expect(getCompactComposerLabels({
      selectedProvider: "claude",
      codexFastMode: false,
      planMode: false,
    }).providerText).toBe("claude")
  })

  test("returns aggressive compact labels for codex mode and plan mode", () => {
    expect(getCompactComposerLabels({
      selectedProvider: "codex",
      codexFastMode: true,
      planMode: true,
    })).toEqual({
      providerText: null,
      codexModeText: "Fast",
      planModeText: "Plan",
    })

    expect(getCompactComposerLabels({
      selectedProvider: "codex",
      codexFastMode: false,
      planMode: false,
    })).toEqual({
      providerText: null,
      codexModeText: "Std",
      planModeText: "Access",
    })
  })
})
