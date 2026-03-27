import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarChatRow, SidebarProjectGroup } from "../../../../shared/types"
import {
  FEATURE_CHAT_PREVIEW_LIMIT,
  LocalProjectsSection,
  getFeatureSectionKeysToCollapse,
  getVisibleFeatureChats,
  splitProjectFeatures,
} from "./LocalProjectsSection"
import { TooltipProvider } from "../../ui/tooltip"

function createChat(index: number, featureId: string | null = null): SidebarChatRow {
  return {
    _id: `row-${index}`,
    _creationTime: index,
    chatId: `chat-${index}`,
    title: `Chat ${index}`,
    status: "idle",
    localPath: "/tmp/project",
    provider: null,
    lastMessageAt: index,
    hasAutomation: false,
    featureId,
  }
}

function createProjectGroup(features: SidebarProjectGroup["features"]): SidebarProjectGroup {
  return {
    groupKey: "project-1",
    title: "Project 1",
    localPath: "/tmp/project",
    iconDataUrl: null,
    browserState: "OPEN",
    generalChatsBrowserState: "OPEN",
    features,
    generalChats: [],
  }
}

describe("splitProjectFeatures", () => {
  test("separates completed features from active ones while preserving order", () => {
    const features = [
      { featureId: "feature-1", stage: "todo" },
      { featureId: "feature-2", stage: "done" },
      { featureId: "feature-3", stage: "progress" },
      { featureId: "feature-4", stage: "done" },
    ] as SidebarProjectGroup["features"]

    expect(splitProjectFeatures(features)).toEqual({
      activeFeatures: [features[0], features[2]],
      completedFeatures: [features[1], features[3]],
    })
  })
})

describe("getVisibleFeatureChats", () => {
  test("limits collapsed features to the configured preview count", () => {
    const chats = Array.from({ length: FEATURE_CHAT_PREVIEW_LIMIT + 3 }, (_, index) => createChat(index + 1, "feature-1"))

    expect(getVisibleFeatureChats(chats, false)).toHaveLength(FEATURE_CHAT_PREVIEW_LIMIT)
  })

  test("returns all chats when expanded", () => {
    const chats = Array.from({ length: FEATURE_CHAT_PREVIEW_LIMIT + 3 }, (_, index) => createChat(index + 1, "feature-1"))

    expect(getVisibleFeatureChats(chats, true)).toEqual(chats)
  })
})

describe("getFeatureSectionKeysToCollapse", () => {
  test("returns only open feature section keys for a project", () => {
    const features = [
      { featureId: "feature-1" },
      { featureId: "feature-2" },
      { featureId: "feature-3" },
    ] as SidebarProjectGroup["features"]

    expect(getFeatureSectionKeysToCollapse(features, new Set(["feature:feature-2"]))).toEqual([
      "feature:feature-1",
      "feature:feature-3",
    ])
  })
})

describe("LocalProjectsSection", () => {
  test("renders only the first eight chats in a long feature and shows the expander", () => {
    const longFeatureChats = Array.from({ length: 10 }, (_, index) => createChat(index + 1, "feature-1"))
    const projectGroup = createProjectGroup([
      {
        featureId: "feature-1",
        title: "Active Feature",
        description: "",
        browserState: "OPEN",
        stage: "progress",
        sortOrder: 0,
        directoryRelativePath: "features/active",
        overviewRelativePath: "features/active/README.md",
        updatedAt: 1,
        chats: longFeatureChats,
      },
    ])

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <LocalProjectsSection
          projectGroups={[projectGroup]}
          collapsedSections={new Set()}
          onToggleSection={() => {}}
          renderChatRow={(chat) => <div key={chat.chatId} data-chat-id={chat.chatId}>{chat.title}</div>}
          folderGroupsEnabled
        />
      </TooltipProvider>
    )

    expect(html).toContain("Chat 1")
    expect(html).toContain("Chat 8")
    expect(html).not.toContain("Chat 9")
    expect(html).not.toContain("Chat 10")
    expect(html).toContain("Show 2 more")
  })

  test("hides completed features behind the completed disclosure by default", () => {
    const projectGroup = createProjectGroup([
      {
        featureId: "feature-done",
        title: "Completed Feature",
        description: "",
        browserState: "OPEN",
        stage: "done",
        sortOrder: 0,
        directoryRelativePath: "features/done",
        overviewRelativePath: "features/done/README.md",
        updatedAt: 1,
        chats: [createChat(1, "feature-done")],
      },
    ])

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <LocalProjectsSection
          projectGroups={[projectGroup]}
          collapsedSections={new Set()}
          onToggleSection={() => {}}
          renderChatRow={(chat) => <div key={chat.chatId} data-chat-id={chat.chatId}>{chat.title}</div>}
          folderGroupsEnabled
        />
      </TooltipProvider>
    )

    expect(html).toContain("Show completed")
    expect(html).not.toContain("Completed Feature")
  })

  test("renders a close-all-feature-folders control in the project header when features exist", () => {
    const projectGroup = createProjectGroup([
      {
        featureId: "feature-1",
        title: "Feature 1",
        description: "",
        browserState: "OPEN",
        stage: "todo",
        sortOrder: 0,
        directoryRelativePath: "features/one",
        overviewRelativePath: "features/one/README.md",
        updatedAt: 1,
        chats: [],
      },
    ])

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <LocalProjectsSection
          projectGroups={[projectGroup]}
          collapsedSections={new Set()}
          onToggleSection={() => {}}
          renderChatRow={(chat) => <div key={chat.chatId} data-chat-id={chat.chatId}>{chat.title}</div>}
          folderGroupsEnabled
          onCreateFeature={() => {}}
        />
      </TooltipProvider>
    )

    expect(html).toContain("lucide-chevrons-up")
  })

  test("renders the project icon between the chevron and name when present", () => {
    const projectGroup = {
      ...createProjectGroup([]),
      iconDataUrl: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%228%22%20r%3D%228%22%2F%3E%3C%2Fsvg%3E",
    }

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <LocalProjectsSection
          projectGroups={[projectGroup]}
          collapsedSections={new Set()}
          onToggleSection={() => {}}
          renderChatRow={(chat) => <div key={chat.chatId} data-chat-id={chat.chatId}>{chat.title}</div>}
          folderGroupsEnabled
        />
      </TooltipProvider>
    )

    expect(html).toContain('alt="Project 1 icon"')
  })
})
