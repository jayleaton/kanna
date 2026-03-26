import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarChatRow } from "../../../../shared/types"
import { ChatRow } from "./ChatRow"

function createChat(provider: SidebarChatRow["provider"]): SidebarChatRow {
  return {
    _id: "row-1",
    _creationTime: 1,
    chatId: "chat-1",
    title: "Example Chat",
    status: "idle",
    localPath: "/tmp/project",
    provider,
    lastMessageAt: 1,
    hasAutomation: false,
    featureId: null,
  }
}

describe("ChatRow", () => {
  test("renders the provider icon when enabled and the chat has a provider", () => {
    const html = renderToStaticMarkup(
      <ChatRow
        chat={createChat("claude")}
        activeChatId={null}
        nowMs={1000}
        showProviderIcon
        onSelectChat={() => {}}
        onDeleteChat={() => {}}
      />
    )

    expect(html).toContain('aria-label="claude provider"')
  })

  test("does not render a provider icon when disabled", () => {
    const html = renderToStaticMarkup(
      <ChatRow
        chat={createChat("claude")}
        activeChatId={null}
        nowMs={1000}
        onSelectChat={() => {}}
        onDeleteChat={() => {}}
      />
    )

    expect(html).not.toContain('aria-label="claude provider"')
  })

  test("does not render a provider icon when the provider is missing", () => {
    const html = renderToStaticMarkup(
      <ChatRow
        chat={createChat(null)}
        activeChatId={null}
        nowMs={1000}
        showProviderIcon
        onSelectChat={() => {}}
        onDeleteChat={() => {}}
      />
    )

    expect(html).not.toContain('provider"')
  })
})
