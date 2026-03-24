import type {
  ChatRuntime,
  ChatSnapshot,
  ChatUsageSnapshot,
  KannaStatus,
  LocalProjectsSnapshot,
  SidebarChatRow,
  SidebarData,
  SidebarProjectGroup,
  SidebarFeatureRow,
} from "../shared/types"
import type { ChatRecord, StoreState } from "./events"
import { cloneTranscriptEntries } from "./events"
import { resolveLocalPath } from "./paths"
import { SERVER_PROVIDERS } from "./provider-catalog"

export function deriveStatus(chat: ChatRecord, activeStatus?: KannaStatus): KannaStatus {
  if (activeStatus) return activeStatus
  if (chat.lastTurnOutcome === "failed") return "failed"
  return "idle"
}

export function deriveSidebarData(
  state: StoreState,
  activeStatuses: Map<string, KannaStatus>
): SidebarData {
  const projects = [...state.projectsById.values()]
    .filter((project) => !project.deletedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const projectGroups: SidebarProjectGroup[] = projects.map((project) => {
    const chats: SidebarChatRow[] = [...state.chatsById.values()]
      .filter((chat) => chat.projectId === project.id && !chat.deletedAt)
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))
      .map((chat) => ({
        _id: chat.id,
        _creationTime: chat.createdAt,
        chatId: chat.id,
        title: chat.title,
        status: deriveStatus(chat, activeStatuses.get(chat.id)),
        localPath: project.localPath,
        provider: chat.provider,
        lastMessageAt: chat.lastMessageAt,
        hasAutomation: false,
        featureId: chat.featureId ?? null,
      }))

    const features: SidebarFeatureRow[] = [...state.featuresById.values()]
      .filter((feature) => feature.projectId === project.id && !feature.deletedAt)
      .sort((a, b) => {
        const aDone = a.stage === "done" ? 1 : 0
        const bDone = b.stage === "done" ? 1 : 0
        if (aDone !== bDone) return aDone - bDone
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
        return b.updatedAt - a.updatedAt
      })
      .map((feature) => ({
        featureId: feature.id,
        title: feature.title,
        description: feature.description,
        stage: feature.stage,
        sortOrder: feature.sortOrder,
        directoryRelativePath: feature.directoryRelativePath,
        overviewRelativePath: feature.overviewRelativePath,
        updatedAt: feature.updatedAt,
        chats: chats.filter((chat) => chat.featureId === feature.id),
      }))

    return {
      groupKey: project.id,
      localPath: project.localPath,
      features,
      generalChats: chats.filter((chat) => !chat.featureId),
    }
  })

  return { projectGroups }
}

export function deriveLocalProjectsSnapshot(
  state: StoreState,
  discoveredProjects: Array<{ localPath: string; title: string; modifiedAt: number }>,
  machineName: string
): LocalProjectsSnapshot {
  const projects = new Map<string, LocalProjectsSnapshot["projects"][number]>()

  for (const project of discoveredProjects) {
    const normalizedPath = resolveLocalPath(project.localPath)
    projects.set(normalizedPath, {
      localPath: normalizedPath,
      title: project.title,
      source: "discovered",
      lastOpenedAt: project.modifiedAt,
      chatCount: 0,
    })
  }

  for (const project of [...state.projectsById.values()].filter((entry) => !entry.deletedAt)) {
    const chats = [...state.chatsById.values()].filter((chat) => chat.projectId === project.id && !chat.deletedAt)
    const lastOpenedAt = chats.reduce(
      (latest, chat) => Math.max(latest, chat.lastMessageAt ?? chat.updatedAt ?? 0),
      project.updatedAt
    )

    projects.set(project.localPath, {
      localPath: project.localPath,
      title: project.title,
      source: "saved",
      lastOpenedAt,
      chatCount: chats.length,
    })
  }

  return {
    machine: {
      id: "local",
      displayName: machineName,
    },
    projects: [...projects.values()].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)),
  }
}

export function deriveChatSnapshot(
  state: StoreState,
  activeStatuses: Map<string, KannaStatus>,
  chatId: string,
  usage: ChatUsageSnapshot | null = null
): ChatSnapshot | null {
  const chat = state.chatsById.get(chatId)
  if (!chat || chat.deletedAt) return null
  const project = state.projectsById.get(chat.projectId)
  if (!project || project.deletedAt) return null

  const runtime: ChatRuntime = {
    chatId: chat.id,
    projectId: project.id,
    localPath: project.localPath,
    title: chat.title,
    status: deriveStatus(chat, activeStatuses.get(chat.id)),
    provider: chat.provider,
    planMode: chat.planMode,
    sessionToken: chat.sessionToken,
  }

  return {
    runtime,
    messages: cloneTranscriptEntries(state.messagesByChatId.get(chat.id) ?? []),
    usage,
    availableProviders: [...SERVER_PROVIDERS],
  }
}
