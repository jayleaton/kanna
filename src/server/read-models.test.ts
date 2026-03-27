import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"
import { createEmptyState } from "./events"

describe("read models", () => {
  test("include provider data in sidebar rows", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      provider: "codex",
      planMode: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map())
    expect(sidebar.projectGroups[0]?.generalChats[0]?.provider).toBe("codex")
    expect(sidebar.projectGroups[0]?.title).toBe("Project")
    expect(sidebar.projectGroups[0]?.browserState).toBe("OPEN")
    expect(sidebar.projectGroups[0]?.generalChatsBrowserState).toBe("OPEN")
    expect(sidebar.projectGroups[0]?.iconDataUrl).toBeNull()
  })

  test("includes available providers in chat snapshots", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      provider: "claude",
      planMode: true,
      sessionToken: "session-1",
      lastTurnOutcome: null,
    })
    state.messagesByChatId.set("chat-1", [
      {
        _id: "msg-1",
        createdAt: 1,
        kind: "system_init",
        provider: "claude",
        model: "sonnet",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
      },
    ])

    const chat = deriveChatSnapshot(state, new Map(), "chat-1", null, {
      provider: "claude",
      threadTokens: 2000,
      contextWindowTokens: 10000,
      contextUsedPercent: 20,
      lastTurnTokens: 2000,
      inputTokens: 1500,
      outputTokens: 500,
      cachedInputTokens: 0,
      reasoningOutputTokens: null,
      sessionLimitUsedPercent: 10,
      rateLimitResetAt: null,
      source: "live",
      updatedAt: 1,
      warnings: [],
    })
    expect(chat?.runtime.provider).toBe("claude")
    expect(chat?.runtime.model).toBe("sonnet")
    expect(chat?.usage?.threadTokens).toBe(2000)
    expect(chat?.availableProviders.length).toBeGreaterThan(1)
    expect(chat?.availableProviders.find((provider) => provider.id === "gemini")?.supportsPlanMode).toBe(true)
    expect(chat?.availableProviders.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
    ])
  })

  test("derives the latest system model for each chat independently", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-a", {
      id: "chat-a",
      projectId: "project-1",
      title: "Chat A",
      createdAt: 1,
      updatedAt: 1,
      provider: "cursor",
      planMode: false,
      sessionToken: "session-a",
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-b", {
      id: "chat-b",
      projectId: "project-1",
      title: "Chat B",
      createdAt: 1,
      updatedAt: 1,
      provider: "cursor",
      planMode: false,
      sessionToken: "session-b",
      lastTurnOutcome: null,
    })
    state.messagesByChatId.set("chat-a", [{
      _id: "msg-a",
      createdAt: 1,
      kind: "system_init",
      provider: "cursor",
      model: "gemini-3.1-pro[]",
      tools: [],
      agents: [],
      slashCommands: [],
      mcpServers: [],
    }])
    state.messagesByChatId.set("chat-b", [{
      _id: "msg-b",
      createdAt: 1,
      kind: "system_init",
      provider: "cursor",
      model: "claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]",
      tools: [],
      agents: [],
      slashCommands: [],
      mcpServers: [],
    }])

    expect(deriveChatSnapshot(state, new Map(), "chat-a")?.runtime.model).toBe("gemini-3.1-pro[]")
    expect(deriveChatSnapshot(state, new Map(), "chat-b")?.runtime.model)
      .toBe("claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]")
  })

  test("prefers saved project metadata over discovered entries for the same path", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Saved Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 50,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 75,
      provider: "codex",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 100,
      lastTurnOutcome: null,
    })

    const snapshot = deriveLocalProjectsSnapshot(state, [
      {
        repoKey: "path:/tmp/project",
        localPath: "/tmp/project",
        worktreePaths: ["/tmp/project"],
        title: "Discovered Project",
        modifiedAt: 10,
      },
    ], "Local Machine")

    expect(snapshot.projects).toEqual([
      {
        localPath: "/tmp/project",
        title: "Saved Project",
        iconDataUrl: null,
        source: "saved",
        lastOpenedAt: 100,
        chatCount: 1,
      },
    ])
    expect(snapshot.suggestedFolders.length).toBeGreaterThan(0)
    expect(snapshot.suggestedFolders.every((folder) => typeof folder.label === "string" && folder.label.length > 0)).toBe(true)
  })

  test("excludes hidden projects from sidebar and local project snapshots", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Hidden Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.hiddenProjectKeys.add("path:/tmp/project")

    expect(deriveSidebarData(state, new Map()).projectGroups).toHaveLength(0)
    expect(deriveLocalProjectsSnapshot(state, [], "Local Machine").projects).toHaveLength(0)
  })

  test("resolves a project icon from the .kanna folder for sidebar and local project snapshots", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-icon-"))
    const kannaDir = path.join(projectRoot, ".kanna")
    mkdirSync(kannaDir)
    writeFileSync(path.join(kannaDir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>')

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())
    const localProjects = deriveLocalProjectsSnapshot(state, [], "Local Machine")

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/svg+xml;utf8,")
    expect(localProjects.projects[0]?.iconDataUrl).toStartWith("data:image/svg+xml;utf8,")
  })

  test("resolves icons from nested app public folders", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-icon-apps-"))
    const publicDir = path.join(projectRoot, "apps", "web", "public")
    mkdirSync(publicDir, { recursive: true })
    writeFileSync(path.join(publicDir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>')

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/svg+xml;utf8,")
  })

  test("resolves monorepo app public favicons from apps/*", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-apps-public-favicon-"))
    const publicDir = path.join(projectRoot, "apps", "web", "public")
    mkdirSync(publicDir, { recursive: true })
    writeFileSync(path.join(publicDir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>')

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/svg+xml;utf8,")
  })

  test("resolves monorepo app icon paths from apps/* framework layouts", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-apps-app-icon-"))
    const appDir = path.join(projectRoot, "apps", "web", "app")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(path.join(appDir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>')

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/svg+xml;utf8,")
  })

  test("resolves a root favicon when no icon file exists", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-favicon-root-"))
    writeFileSync(path.join(projectRoot, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>')

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/svg+xml;utf8,")
  })

  test("resolves app icon paths from common framework layouts", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-app-icon-"))
    const appDir = path.join(projectRoot, "app")
    mkdirSync(appDir)
    writeFileSync(path.join(appDir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>')

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/svg+xml;utf8,")
  })

  test("resolves an ico project icon from the project root", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-icon-root-ico-"))
    writeFileSync(
      path.join(projectRoot, "icon.ico"),
      Buffer.from("AAABAAEAEBAAAAAAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAGAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64")
    )

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/vnd.microsoft.icon;base64,")
  })

  test("resolves root icons case-insensitively across supported file types", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-icon-root-case-"))
    writeFileSync(path.join(projectRoot, "ICON.SVG"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>')

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/svg+xml;utf8,")
  })

  test("resolves non-svg icons from .kanna", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-icon-kanna-png-"))
    const kannaDir = path.join(projectRoot, ".kanna")
    mkdirSync(kannaDir)
    writeFileSync(
      path.join(kannaDir, "icon.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgZkAAAAASUVORK5CYII=", "base64")
    )

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/png;base64,")
  })

  test("resolves an icon declared in index.html when no direct icon file exists", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-icon-declared-"))
    const publicDir = path.join(projectRoot, "public")
    mkdirSync(publicDir)
    writeFileSync(path.join(projectRoot, "index.html"), '<html><head><link rel="icon" href="/brand.svg"></head></html>')
    writeFileSync(path.join(publicDir, "brand.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>')

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/svg+xml;utf8,")
  })

  test("prefers root and .kanna icon files over declared icons", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-icon-direct-over-declared-"))
    const kannaDir = path.join(projectRoot, ".kanna")
    const publicDir = path.join(projectRoot, "public")
    mkdirSync(kannaDir)
    mkdirSync(publicDir)
    writeFileSync(path.join(projectRoot, "index.html"), '<html><head><link rel="icon" href="/brand.svg"></head></html>')
    writeFileSync(path.join(publicDir, "brand.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>')
    writeFileSync(path.join(kannaDir, "icon.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgZkAAAAASUVORK5CYII=", "base64"))

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/png;base64,")
  })

  test("prefers svg over ico when multiple root icon formats exist", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-icon-root-priority-"))
    writeFileSync(path.join(projectRoot, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>')
    writeFileSync(
      path.join(projectRoot, "icon.ico"),
      Buffer.from("AAABAAEAEBAAAAAAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAGAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64")
    )

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/svg+xml;utf8,")
  })

  test("prefers root icon over .kanna icon", () => {
    const state = createEmptyState()
    const projectRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-icon-root-over-kanna-"))
    const kannaDir = path.join(projectRoot, ".kanna")
    mkdirSync(kannaDir)
    writeFileSync(path.join(projectRoot, "icon.ico"), Buffer.from("AAABAAEAEBAAAAAAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAGAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64"))
    writeFileSync(path.join(kannaDir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>')

    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: `path:${projectRoot}`,
      localPath: projectRoot,
      worktreePaths: [projectRoot],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set(`path:${projectRoot}`, "project-1")
    state.projectIdsByPath.set(projectRoot, "project-1")

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.iconDataUrl).toStartWith("data:image/vnd.microsoft.icon;base64,")
  })

  test("groups chats into features and general, with done features sorted last", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "CLOSED",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.featuresById.set("feature-1", {
      id: "feature-1",
      projectId: "project-1",
      title: "First Feature",
      description: "First",
      browserState: "OPEN",
      stage: "progress",
      sortOrder: 0,
      directoryRelativePath: ".kanna/First_Feature",
      overviewRelativePath: ".kanna/First_Feature/overview.md",
      createdAt: 1,
      updatedAt: 5,
    })
    state.featuresById.set("feature-2", {
      id: "feature-2",
      projectId: "project-1",
      title: "Done Feature",
      description: "Done",
      browserState: "CLOSED",
      stage: "done",
      sortOrder: 0,
      directoryRelativePath: ".kanna/Done_Feature",
      overviewRelativePath: ".kanna/Done_Feature/overview.md",
      createdAt: 1,
      updatedAt: 6,
    })
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Feature chat",
      featureId: "feature-1",
      createdAt: 1,
      updatedAt: 5,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-2", {
      id: "chat-2",
      projectId: "project-1",
      title: "General chat",
      featureId: null,
      createdAt: 1,
      updatedAt: 7,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.features.map((feature) => feature.featureId)).toEqual(["feature-1", "feature-2"])
    expect(sidebar.projectGroups[0]?.features.map((feature) => feature.browserState)).toEqual(["OPEN", "CLOSED"])
    expect(sidebar.projectGroups[0]?.features[0]?.chats[0]?.chatId).toBe("chat-1")
    expect(sidebar.projectGroups[0]?.generalChats[0]?.chatId).toBe("chat-2")
  })
})
