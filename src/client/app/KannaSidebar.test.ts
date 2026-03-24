import { describe, expect, test } from "bun:test"
import { shouldCloseSidebarOnChatSelect } from "./KannaSidebar"

describe("shouldCloseSidebarOnChatSelect", () => {
  test("closes the sidebar when it is open as the mobile overlay", () => {
    expect(shouldCloseSidebarOnChatSelect(true)).toBe(true)
  })

  test("keeps the desktop sidebar open when it is not in mobile overlay mode", () => {
    expect(shouldCloseSidebarOnChatSelect(false)).toBe(false)
  })
})
