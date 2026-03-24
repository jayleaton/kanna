import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"

const originalRuntimeProfile = process.env.KANNA_RUNTIME_PROFILE

afterEach(() => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.KANNA_RUNTIME_PROFILE
  } else {
    process.env.KANNA_RUNTIME_PROFILE = originalRuntimeProfile
  }
})

describe("EventStore", () => {
  test("uses the runtime profile for the default data dir", () => {
    process.env.KANNA_RUNTIME_PROFILE = "dev"

    const store = new EventStore()

    expect(store.dataDir).toEndWith("/.kanna-dev/data")
  })

  test("creates a feature directory and overview, then moves chats to general when deleted", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-store-"))
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-"))
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir, "Project")
    const feature = await store.createFeature(project.id, "Stage Nav Button", "Improve the stage navigation interactions.")
    const chat = await store.createChat(project.id, feature.id)

    expect(feature.directoryRelativePath).toBe(".kanna/Stage_Nav_Button")
    expect(await readFile(path.join(projectDir, feature.overviewRelativePath), "utf8")).toContain("Improve the stage navigation interactions.")
    expect(store.getChat(chat.id)?.featureId).toBe(feature.id)

    await store.deleteFeature(feature.id)

    expect(store.getFeature(feature.id)).toBeNull()
    expect(store.getChat(chat.id)?.featureId).toBeNull()
  })

  test("persists in-flight feature writes before compaction", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-store-"))
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-"))
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir, "Project")
    const featurePromise = store.createFeature(project.id, "Feature One", "Persist across restart")

    await store.compact()
    const feature = await featurePromise

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getFeature(feature.id)?.title).toBe("Feature One")
    expect(reloaded.listFeaturesByProject(project.id)).toHaveLength(1)
  })
})
