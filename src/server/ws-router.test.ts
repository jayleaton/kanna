import { describe, expect, test } from "bun:test"
import { PROTOCOL_VERSION } from "../shared/types"
import { createEmptyState } from "./events"
import { GitManager } from "./git-manager"
import { createWsRouter } from "./ws-router"

class FakeWebSocket {
  readonly sent: unknown[] = []
  readonly data = {
    subscriptions: new Map(),
  }

  send(message: string) {
    this.sent.push(JSON.parse(message))
  }
}

describe("ws-router", () => {
  test("acks system.ping without broadcasting snapshots", () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      fileTree: {
        getSnapshot: () => ({ projectId: "project-1", rootPath: "/tmp/project-1", pageSize: 200, supportsRealtime: true }),
        onInvalidate: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    ws.data.subscriptions.set("sub-1", { type: "sidebar" })
    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "ping-1",
        command: { type: "system.ping" },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "ping-1",
      },
    ])
  })

  test("acks terminal.input without rebroadcasting terminal snapshots", () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
        write: () => {},
      } as never,
      fileTree: {
        getSnapshot: () => ({ projectId: "project-1", rootPath: "/tmp/project-1", pageSize: 200, supportsRealtime: true }),
        onInvalidate: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    ws.data.subscriptions.set("sub-terminal", { type: "terminal", terminalId: "terminal-1" })
    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "terminal-input-1",
        command: {
          type: "terminal.input",
          terminalId: "terminal-1",
          data: "ls\r",
        },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "terminal-input-1",
      },
    ])
  })

  test("subscribes and unsubscribes file-tree topics and acks directory reads", async () => {
    const fileTree = {
      subscribeCalls: [] as string[],
      unsubscribeCalls: [] as string[],
      subscribe(projectId: string) {
        this.subscribeCalls.push(projectId)
      },
      unsubscribe(projectId: string) {
        this.unsubscribeCalls.push(projectId)
      },
      getSnapshot: (projectId: string) => ({
        projectId,
        rootPath: "/tmp/project-1",
        pageSize: 200,
        supportsRealtime: true as const,
      }),
      readDirectory: async () => ({
        directoryPath: "",
        entries: [],
        nextCursor: null,
        hasMore: false,
      }),
      onInvalidate: () => () => {},
    }

    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      fileTree: fileTree as never,
      git: new GitManager(),
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "tree-sub-1",
        topic: { type: "file-tree", projectId: "project-1" },
      })
    )

    expect(fileTree.subscribeCalls).toEqual(["project-1"])
    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "tree-sub-1",
      snapshot: {
        type: "file-tree",
        data: {
          projectId: "project-1",
          rootPath: "/tmp/project-1",
          pageSize: 200,
          supportsRealtime: true,
        },
      },
    })

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "tree-read-1",
        command: {
          type: "file-tree.readDirectory",
          projectId: "project-1",
          directoryPath: "",
        },
      })
    )

    await Promise.resolve()
    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "tree-read-1",
      result: {
        directoryPath: "",
        entries: [],
        nextCursor: null,
        hasMore: false,
      },
    })

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "unsubscribe",
        id: "tree-sub-1",
      })
    )

    expect(fileTree.unsubscribeCalls).toEqual(["project-1"])
    expect(ws.sent[2]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "tree-sub-1",
    })
  })

  test("hides a discovered project without requiring a saved project record", async () => {
    const hiddenPaths: string[] = []
    const refreshed: string[] = []
    const router = createWsRouter({
      store: {
        state: createEmptyState(),
        listProjects: () => [],
        hideProject: async (localPath: string) => {
          hiddenPaths.push(localPath)
        },
      } as never,
      agent: { cancel: async () => {}, getActiveStatuses: () => new Map() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
        closeByCwd: () => {},
      } as never,
      fileTree: {
        getSnapshot: () => ({ projectId: "project-1", rootPath: "/tmp/project-1", pageSize: 200, supportsRealtime: true }),
        onInvalidate: () => () => {},
      } as never,
      git: new GitManager(),
      refreshDiscovery: async () => {
        refreshed.push("done")
        return []
      },
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "project-hide-1",
        command: { type: "project.hide", localPath: "/tmp/project-1" },
      })
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(hiddenPaths).toEqual(["/tmp/project-1"])
    expect(refreshed).toEqual(["done"])
    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "project-hide-1",
      },
    ])
  })
})
