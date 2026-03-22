import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentProvider, TranscriptEntry } from "../shared/types"
import { recoverProviderState } from "./recovery"

const tempDirs: string[] = []

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), "kanna-recovery-"))
  tempDirs.push(directory)
  return directory
}

function encodeClaudeProjectPath(localPath: string) {
  return `-${localPath.replace(/\//g, "-")}`
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

class MemoryRecoveryStore {
  readonly projects = new Map<string, { id: string; localPath: string; title: string }>()
  readonly chats = new Map<string, {
    id: string
    projectId: string
    title: string
    provider: AgentProvider | null
    sessionToken: string | null
  }>()
  readonly messages = new Map<string, TranscriptEntry[]>()
  readonly hiddenProjectPaths = new Set<string>()
  private projectCount = 0
  private chatCount = 0

  listProjects() {
    return [...this.projects.values()]
  }

  listChatsByProject(projectId: string) {
    return [...this.chats.values()].filter((chat) => chat.projectId === projectId)
  }

  isProjectHidden(localPath: string) {
    return this.hiddenProjectPaths.has(localPath)
  }

  async openProject(localPath: string, title?: string) {
    const existing = [...this.projects.values()].find((project) => project.localPath === localPath)
    if (existing) return existing
    const project = {
      id: `project-${++this.projectCount}`,
      localPath,
      title: title ?? path.basename(localPath),
    }
    this.projects.set(project.id, project)
    return project
  }

  async createChat(projectId: string) {
    const chat = {
      id: `chat-${++this.chatCount}`,
      projectId,
      title: "New Chat",
      provider: null,
      sessionToken: null,
    }
    this.chats.set(chat.id, chat)
    return chat
  }

  async renameChat(chatId: string, title: string) {
    const chat = this.chats.get(chatId)
    if (chat) {
      chat.title = title
    }
  }

  async setChatProvider(chatId: string, provider: AgentProvider) {
    const chat = this.chats.get(chatId)
    if (chat) {
      chat.provider = provider
    }
  }

  async setSessionToken(chatId: string, sessionToken: string | null) {
    const chat = this.chats.get(chatId)
    if (chat) {
      chat.sessionToken = sessionToken
    }
  }

  async appendMessage(chatId: string, entry: TranscriptEntry) {
    const existing = this.messages.get(chatId) ?? []
    existing.push(entry)
    this.messages.set(chatId, existing)
  }
}

describe("recoverProviderState", () => {
  test("imports Claude and Codex sessions into an empty store", async () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "kanna")
    const claudeProjectDir = path.join(homeDir, ".claude", "projects", encodeClaudeProjectPath(projectDir))
    const codexSessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "03", "21")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(claudeProjectDir, { recursive: true })
    mkdirSync(codexSessionsDir, { recursive: true })

    writeFileSync(path.join(claudeProjectDir, "claude-session.jsonl"), [
      JSON.stringify({
        type: "user",
        uuid: "claude-user-1",
        timestamp: "2026-03-21T06:07:40.619Z",
        cwd: projectDir,
        sessionId: "claude-session-1",
        message: { role: "user", content: "Recover this Claude chat" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "claude-assistant-1",
        timestamp: "2026-03-21T06:07:44.090Z",
        sessionId: "claude-session-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Claude reply" }],
        },
      }),
    ].join("\n"))

    writeFileSync(path.join(codexSessionsDir, "rollout-2026-03-21T10-00-03-codex-session-1.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-21T10:00:03.410Z",
        type: "session_meta",
        payload: {
          id: "codex-session-1",
          cwd: projectDir,
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-21T10:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Recover this Codex chat",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-21T10:00:06.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Codex reply",
        },
      }),
    ].join("\n"))

    const store = new MemoryRecoveryStore()
    const result = await recoverProviderState({ store, homeDir })

    expect(result).toEqual({
      skipped: false,
      reason: "recovered",
      projectsImported: 1,
      chatsImported: 2,
      messagesImported: 4,
    })

    expect(store.listProjects()).toHaveLength(1)
    expect([...store.chats.values()].map((chat) => ({
      provider: chat.provider,
      title: chat.title,
      sessionToken: chat.sessionToken,
    }))).toEqual([
      {
        provider: "claude",
        title: "Recover this Claude chat",
        sessionToken: "claude-session-1",
      },
      {
        provider: "codex",
        title: "Recover this Codex chat",
        sessionToken: "codex-session-1",
      },
    ])

    expect(store.messages.get("chat-1")?.map((entry) => entry.kind)).toEqual(["user_prompt", "assistant_text"])
    expect(store.messages.get("chat-2")?.map((entry) => entry.kind)).toEqual(["user_prompt", "assistant_text"])
  })

  test("skips recovery when the store already has chats", async () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "kanna")
    const claudeProjectDir = path.join(homeDir, ".claude", "projects", encodeClaudeProjectPath(projectDir))
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(claudeProjectDir, { recursive: true })

    writeFileSync(path.join(claudeProjectDir, "claude-session.jsonl"), JSON.stringify({
      type: "user",
      uuid: "claude-user-1",
      timestamp: "2026-03-21T06:07:40.619Z",
      cwd: projectDir,
      sessionId: "claude-session-1",
      message: { role: "user", content: "Recover this Claude chat" },
    }))

    const store = new MemoryRecoveryStore()
    const project = await store.openProject(projectDir, "kanna")
    await store.createChat(project.id)

    const result = await recoverProviderState({ store, homeDir })

    expect(result.reason).toBe("existing-state")
    expect(store.chats.size).toBe(1)
  })

  test("ignores malformed provider files and reports no-sessions when nothing valid exists", async () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "kanna")
    const codexSessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "03", "21")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(codexSessionsDir, { recursive: true })

    writeFileSync(path.join(codexSessionsDir, "bad.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-21T10:00:03.410Z",
        type: "session_meta",
        payload: {
          id: "codex-session-1",
          cwd: "./relative",
        },
      }),
      `not-json`,
    ].join("\n"))

    const store = new MemoryRecoveryStore()
    const result = await recoverProviderState({ store, homeDir })

    expect(result).toEqual({
      skipped: true,
      reason: "no-sessions",
      projectsImported: 0,
      chatsImported: 0,
      messagesImported: 0,
    })
  })

  test("skips recovery for hidden project paths", async () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "kanna")
    const claudeProjectDir = path.join(homeDir, ".claude", "projects", encodeClaudeProjectPath(projectDir))
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(claudeProjectDir, { recursive: true })

    writeFileSync(path.join(claudeProjectDir, "claude-session.jsonl"), [
      JSON.stringify({
        type: "user",
        uuid: "claude-user-1",
        timestamp: "2026-03-21T06:07:40.619Z",
        cwd: projectDir,
        sessionId: "claude-session-1",
        message: { role: "user", content: "Recover this Claude chat" },
      }),
    ].join("\n"))

    const store = new MemoryRecoveryStore()
    store.hiddenProjectPaths.add(projectDir)

    const result = await recoverProviderState({ store, homeDir })

    expect(result).toEqual({
      skipped: true,
      reason: "no-sessions",
      projectsImported: 0,
      chatsImported: 0,
      messagesImported: 0,
    })
    expect(store.projects.size).toBe(0)
  })
})
