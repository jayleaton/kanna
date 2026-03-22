import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { AgentProvider, TranscriptEntry } from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import { normalizeClaudeStreamMessage } from "./agent"
import type { DiscoveredProject } from "./discovery"

interface RecoveryStore {
  listProjects(): Array<{ id: string; localPath: string; title: string }>
  listChatsByProject(projectId: string): Array<{ id: string }>
  isProjectHidden(localPath: string): boolean
  openProject(localPath: string, title?: string): Promise<{ id: string }>
  createChat(projectId: string): Promise<{ id: string }>
  renameChat(chatId: string, title: string): Promise<void>
  setChatProvider(chatId: string, provider: AgentProvider): Promise<void>
  setSessionToken(chatId: string, sessionToken: string | null): Promise<void>
  appendMessage(chatId: string, entry: TranscriptEntry): Promise<void>
}

interface RecoveryChat {
  provider: AgentProvider
  sessionToken: string
  localPath: string
  title: string
  modifiedAt: number
  entries: TranscriptEntry[]
}

export interface RecoveryResult {
  skipped: boolean
  reason: "existing-state" | "no-sessions" | "recovered"
  projectsImported: number
  chatsImported: number
  messagesImported: number
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function collectFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) {
    return []
  }

  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, extension))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(fullPath)
    }
  }

  return files
}

function makeEntryId(prefix: string, sessionToken: string, index: number) {
  return `${prefix}:${sessionToken}:${index}`
}

function claudeEntriesFromRecord(record: Record<string, unknown>): TranscriptEntry[] {
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
  if (Number.isNaN(timestamp)) {
    return []
  }

  const messageId = typeof record.uuid === "string" ? record.uuid : makeEntryId("claude-message", String(record.sessionId ?? "session"), 0)

  if (record.type === "user") {
    const message = record.message
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const messageRecord = message as Record<string, unknown>
      if (typeof messageRecord.content === "string" && messageRecord.content.trim()) {
        const content = messageRecord.content
        if (content.startsWith("This session is being continued")) {
          return [{
            _id: messageId,
            messageId,
            createdAt: timestamp,
            kind: "compact_summary",
            summary: content,
          }]
        }
        return [{
          _id: messageId,
          messageId,
          createdAt: timestamp,
          kind: "user_prompt",
          content,
        }]
      }
    }
  }

  const entries = normalizeClaudeStreamMessage(record).filter((entry) => {
    if (entry.kind === "assistant_text" && !entry.text.trim()) return false
    if (entry.kind === "compact_summary" && !entry.summary.trim()) return false
    return entry.kind !== "tool_call" && entry.kind !== "tool_result" && entry.kind !== "system_init"
  })

  return entries.map((entry, index) => ({
    ...entry,
    _id: entry._id || makeEntryId("claude", String(record.sessionId ?? "session"), index),
    createdAt: timestamp + index,
  }))
}

function readClaudeRecoveryChats(homeDir: string): RecoveryChat[] {
  const projectsDir = path.join(homeDir, ".claude", "projects")
  const chats: RecoveryChat[] = []

  for (const sessionFile of collectFiles(projectsDir, ".jsonl")) {
    const lines = readFileSync(sessionFile, "utf8").split("\n")
    const entries: TranscriptEntry[] = []
    let sessionToken: string | null = null
    let localPath: string | null = null
    let firstUserPrompt: string | null = null
    let modifiedAt = statSync(sessionFile).mtimeMs

    for (const line of lines) {
      if (!line.trim()) continue
      const record = parseJsonRecord(line)
      if (!record) continue

      if (!sessionToken && typeof record.sessionId === "string") {
        sessionToken = record.sessionId
      }
      if (!localPath && typeof record.cwd === "string" && path.isAbsolute(record.cwd)) {
        localPath = record.cwd
      }

      const normalizedEntries = claudeEntriesFromRecord(record)
      for (const entry of normalizedEntries) {
        entries.push(entry)
        if (!firstUserPrompt && entry.kind === "user_prompt" && entry.content.trim()) {
          firstUserPrompt = entry.content.trim()
        }
      }

      const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
      if (!Number.isNaN(timestamp)) {
        modifiedAt = Math.max(modifiedAt, timestamp)
      }
    }

    if (!sessionToken || !localPath || entries.length === 0) {
      continue
    }

    chats.push({
      provider: "claude",
      sessionToken,
      localPath,
      title: firstUserPrompt || path.basename(localPath) || "Recovered Chat",
      modifiedAt,
      entries,
    })
  }

  return chats
}

function codexAssistantTextFromResponseItem(record: Record<string, unknown>, index: number): TranscriptEntry | null {
  const payload = record.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null
  }

  const payloadRecord = payload as Record<string, unknown>
  if (payloadRecord.type !== "message") {
    return null
  }

  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Date.now()
  const content = Array.isArray(payloadRecord.content) ? payloadRecord.content : []
  const text = content
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return ""
      const contentItem = item as Record<string, unknown>
      return contentItem.type === "output_text" && typeof contentItem.text === "string"
        ? contentItem.text
        : ""
    })
    .filter(Boolean)
    .join("\n")

  if (!text.trim()) {
    return null
  }

  return {
    _id: makeEntryId("codex", String(payloadRecord.id ?? "assistant"), index),
    createdAt: timestamp + index,
    kind: "assistant_text",
    text,
  }
}

function codexToolCallFromResponseItem(record: Record<string, unknown>, index: number): TranscriptEntry | null {
  const payload = record.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null
  }

  const payloadRecord = payload as Record<string, unknown>
  if (payloadRecord.type !== "function_call" || typeof payloadRecord.name !== "string") {
    return null
  }

  const toolId = typeof payloadRecord.call_id === "string"
    ? payloadRecord.call_id
    : makeEntryId("codex-tool", payloadRecord.name, index)
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Date.now()
  let input: Record<string, unknown> = {}

  if (typeof payloadRecord.arguments === "string") {
    input = parseJsonRecord(payloadRecord.arguments) ?? {}
  }

  return {
    _id: makeEntryId("codex", toolId, index),
    createdAt: timestamp + index,
    kind: "tool_call",
    tool: normalizeToolCall({
      toolName: payloadRecord.name,
      toolId,
      input,
    }),
  }
}

function codexEntriesFromRecord(record: Record<string, unknown>, index: number): TranscriptEntry[] {
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Date.now()

  if (record.type === "event_msg") {
    const payload = record.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return []
    }
    const payloadRecord = payload as Record<string, unknown>

    if (payloadRecord.type === "user_message" && typeof payloadRecord.message === "string" && payloadRecord.message.trim()) {
      return [{
        _id: makeEntryId("codex-user", String(index), index),
        createdAt: timestamp + index,
        kind: "user_prompt",
        content: payloadRecord.message,
      }]
    }

    if (payloadRecord.type === "agent_message" && typeof payloadRecord.message === "string" && payloadRecord.message.trim()) {
      return [{
        _id: makeEntryId("codex-assistant", String(index), index),
        createdAt: timestamp + index,
        kind: "assistant_text",
        text: payloadRecord.message,
      }]
    }

    return []
  }

  if (record.type === "response_item") {
    const toolCall = codexToolCallFromResponseItem(record, index)
    if (toolCall) {
      return [toolCall]
    }
    const assistantText = codexAssistantTextFromResponseItem(record, index)
    return assistantText ? [assistantText] : []
  }

  return []
}

function readCodexRecoveryChats(homeDir: string): RecoveryChat[] {
  const sessionsDir = path.join(homeDir, ".codex", "sessions")
  const chats: RecoveryChat[] = []

  for (const sessionFile of collectFiles(sessionsDir, ".jsonl")) {
    const lines = readFileSync(sessionFile, "utf8").split("\n")
    const entries: TranscriptEntry[] = []
    let sessionToken: string | null = null
    let localPath: string | null = null
    let modifiedAt = statSync(sessionFile).mtimeMs
    let firstUserPrompt: string | null = null

    lines.forEach((line, index) => {
      if (!line.trim()) return
      const record = parseJsonRecord(line)
      if (!record) return

      if (record.type === "session_meta") {
        const payload = record.payload
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const payloadRecord = payload as Record<string, unknown>
          if (!sessionToken && typeof payloadRecord.id === "string") {
            sessionToken = payloadRecord.id
          }
          if (!localPath && typeof payloadRecord.cwd === "string" && path.isAbsolute(payloadRecord.cwd)) {
            localPath = payloadRecord.cwd
          }
        }
      }

      const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
      if (!Number.isNaN(timestamp)) {
        modifiedAt = Math.max(modifiedAt, timestamp)
      }

      for (const entry of codexEntriesFromRecord(record, index)) {
        entries.push(entry)
        if (!firstUserPrompt && entry.kind === "user_prompt" && entry.content.trim()) {
          firstUserPrompt = entry.content.trim()
        }
      }
    })

    if (!sessionToken || !localPath || entries.length === 0) {
      continue
    }

    chats.push({
      provider: "codex",
      sessionToken,
      localPath,
      title: firstUserPrompt || path.basename(localPath) || "Recovered Chat",
      modifiedAt,
      entries,
    })
  }

  return chats
}

function firstLine(value: string, fallback: string) {
  const line = value.split("\n").map((part) => part.trim()).find(Boolean)
  if (!line) return fallback
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

async function importRecoveryChats(store: RecoveryStore, chats: RecoveryChat[]): Promise<RecoveryResult> {
  if (store.listProjects().some((project) => store.listChatsByProject(project.id).length > 0)) {
    return {
      skipped: true,
      reason: "existing-state",
      projectsImported: 0,
      chatsImported: 0,
      messagesImported: 0,
    }
  }

  if (chats.length === 0) {
    return {
      skipped: true,
      reason: "no-sessions",
      projectsImported: 0,
      chatsImported: 0,
      messagesImported: 0,
    }
  }

  const visibleChats = chats.filter((chat) => !store.isProjectHidden(chat.localPath))
  if (visibleChats.length === 0) {
    return {
      skipped: true,
      reason: "no-sessions",
      projectsImported: 0,
      chatsImported: 0,
      messagesImported: 0,
    }
  }

  const projectIdsByPath = new Map<string, string>()
  let projectsImported = 0
  let chatsImported = 0
  let messagesImported = 0

  for (const chat of visibleChats.sort((a, b) => a.modifiedAt - b.modifiedAt)) {
    let projectId = projectIdsByPath.get(chat.localPath)
    if (!projectId) {
      const project = await store.openProject(chat.localPath, path.basename(chat.localPath) || chat.localPath)
      projectId = project.id
      projectIdsByPath.set(chat.localPath, projectId)
      projectsImported += 1
    }

    const createdChat = await store.createChat(projectId)
    await store.renameChat(createdChat.id, firstLine(chat.title, "Recovered Chat"))
    await store.setChatProvider(createdChat.id, chat.provider)
    await store.setSessionToken(createdChat.id, chat.sessionToken)
    for (const entry of chat.entries) {
      await store.appendMessage(createdChat.id, entry)
      messagesImported += 1
    }
    chatsImported += 1
  }

  return {
    skipped: false,
    reason: "recovered",
    projectsImported,
    chatsImported,
    messagesImported,
  }
}

export async function recoverProviderState(args: {
  store: RecoveryStore
  homeDir?: string
  log?: (message: string) => void
}): Promise<RecoveryResult> {
  const homeDir = args.homeDir ?? homedir()
  const claudeChats = readClaudeRecoveryChats(homeDir)
  const codexChats = readCodexRecoveryChats(homeDir)
  const result = await importRecoveryChats(args.store, [...claudeChats, ...codexChats])

  args.log?.(
    `[kanna] recovery ${result.reason} (claude=${claudeChats.length}, codex=${codexChats.length}, importedChats=${result.chatsImported}, importedMessages=${result.messagesImported})`
  )

  return result
}

export function deriveRecoveredProjects(homeDir: string = homedir()): DiscoveredProject[] {
  return [...readClaudeRecoveryChats(homeDir), ...readCodexRecoveryChats(homeDir)].map((chat) => ({
    localPath: chat.localPath,
    title: path.basename(chat.localPath) || chat.localPath,
    modifiedAt: chat.modifiedAt,
  }))
}
