import type { AgentProvider, ChatSnapshot, LocalProjectsSnapshot, ModelOptions, SidebarData } from "./types"

export type SubscriptionTopic =
  | { type: "sidebar" }
  | { type: "local-projects" }
  | { type: "chat"; chatId: string }

export type ClientCommand =
  | { type: "project.open"; localPath: string }
  | { type: "project.create"; localPath: string; title: string }
  | { type: "project.remove"; projectId: string }
  | { type: "system.openExternal"; localPath: string; action: "open_finder" | "open_terminal" | "open_editor" }
  | { type: "chat.create"; projectId: string }
  | { type: "chat.rename"; chatId: string; title: string }
  | { type: "chat.delete"; chatId: string }
  | {
      type: "chat.send"
      chatId?: string
      projectId?: string
      provider?: AgentProvider
      content: string
      model?: string
      modelOptions?: ModelOptions
      effort?: string
      planMode?: boolean
    }
  | { type: "chat.cancel"; chatId: string }
  | { type: "chat.respondTool"; chatId: string; toolUseId: string; result: unknown }

export type ClientEnvelope =
  | { v: 1; type: "subscribe"; id: string; topic: SubscriptionTopic }
  | { v: 1; type: "unsubscribe"; id: string }
  | { v: 1; type: "command"; id: string; command: ClientCommand }

export type ServerSnapshot =
  | { type: "sidebar"; data: SidebarData }
  | { type: "local-projects"; data: LocalProjectsSnapshot }
  | { type: "chat"; data: ChatSnapshot | null }

export type ServerEnvelope =
  | { v: 1; type: "snapshot"; id: string; snapshot: ServerSnapshot }
  | { v: 1; type: "ack"; id: string; result?: unknown }
  | { v: 1; type: "error"; id?: string; message: string }

export function isClientEnvelope(value: unknown): value is ClientEnvelope {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ClientEnvelope>
  return candidate.v === 1 && typeof candidate.type === "string"
}
