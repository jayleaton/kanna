import process from "node:process"
import { hostname as getHostname } from "node:os"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { LOG_PREFIX } from "../src/shared/branding"
import { resolveDevPorts, stripPortArg } from "../src/shared/dev-ports"

const cwd = process.cwd()
const forwardedArgs = process.argv.slice(2)
const serverArgs = stripPortArg(forwardedArgs)
const { clientPort, serverPort } = resolveDevPorts(forwardedArgs)
const bunBin = process.execPath
const localHostname = getHostname()
const serverPidFile = join(cwd, ".kanna", `dev-server-${serverPort}.pid`)

function getDevHostConfig(args: string[]) {
  let backendTargetHost = "127.0.0.1"
  let allowAllHosts = false
  const hosts = new Set<string>(["localhost", "127.0.0.1", "0.0.0.0", localHostname])

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--remote") {
      backendTargetHost = "127.0.0.1"
      allowAllHosts = true
      continue
    }
    if (arg !== "--host") continue

    const next = args[index + 1]
    if (!next || next.startsWith("-")) continue
    hosts.add(next)
    backendTargetHost = next === "0.0.0.0" ? "127.0.0.1" : next
    index += 1
  }

  return {
    allowedHosts: allowAllHosts ? true : [...hosts],
    backendTargetHost,
  }
}

const devHostConfig = getDevHostConfig(forwardedArgs)

const clientEnv = {
  ...process.env,
  KANNA_DEV_ALLOWED_HOSTS: typeof devHostConfig.allowedHosts === "boolean"
    ? String(devHostConfig.allowedHosts)
    : JSON.stringify(devHostConfig.allowedHosts),
  KANNA_DEV_BACKEND_TARGET_HOST: devHostConfig.backendTargetHost,
  KANNA_DEV_BACKEND_PORT: String(serverPort),
}

function spawnLabeledProcess(label: string, args: string[]) {
  const child = spawn(bunBin, args, {
    cwd,
    stdio: "inherit",
    env: label === "client" ? clientEnv : process.env,
  })

  child.on("spawn", () => {
    console.log(`${LOG_PREFIX.replace("]", `:${label}]`)} started`)
  })

  return child
}

function stopChild(child: ChildProcess) {
  if (child.killed || child.exitCode !== null) return
  child.kill("SIGTERM")
}

function removeServerPidFile() {
  if (!existsSync(serverPidFile)) return
  rmSync(serverPidFile, { force: true })
}

function getCommandForPid(pid: number) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    cwd,
    encoding: "utf8",
  })

  if (result.status !== 0) {
    return null
  }

  const command = result.stdout.trim()
  return command.length > 0 ? command : null
}

function isManagedDevServerCommand(command: string | null) {
  return command?.includes("./scripts/dev-server.ts") ?? false
}

async function waitForPidExit(pid: number, timeoutMs = 5_000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0)
      await Bun.sleep(100)
    } catch {
      return true
    }
  }

  return false
}

async function tryCleanupStaleDevServerPid() {
  if (!existsSync(serverPidFile)) return

  const rawPid = readFileSync(serverPidFile, "utf8").trim()
  const pid = Number(rawPid)

  if (!Number.isInteger(pid) || pid <= 0) {
    removeServerPidFile()
    return
  }

  const command = getCommandForPid(pid)
  if (!command) {
    removeServerPidFile()
    return
  }

  if (!isManagedDevServerCommand(command)) {
    removeServerPidFile()
    return
  }

  console.log(`${LOG_PREFIX.replace("]", ":dev]")} stopping stale dev server pid ${String(pid)}`)
  try {
    process.kill(pid, "SIGTERM")
    if (!(await waitForPidExit(pid))) {
      process.kill(pid, "SIGKILL")
      await waitForPidExit(pid, 1_000)
    }
  } catch {
    // The process may have exited between detection and cleanup.
  }

  removeServerPidFile()
}

function findListeningPidOnPort(port: number) {
  const result = spawnSync("lsof", ["-tiTCP:" + String(port), "-sTCP:LISTEN"], {
    cwd,
    encoding: "utf8",
  })

  if (result.status !== 0) {
    return null
  }

  const rawPid = result.stdout.trim().split("\n")[0]
  const pid = Number(rawPid)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

async function ensureServerPortAvailable(port: number) {
  await tryCleanupStaleDevServerPid()

  const pid = findListeningPidOnPort(port)
  if (!pid) return

  const command = getCommandForPid(pid)
  if (isManagedDevServerCommand(command)) {
    console.log(`${LOG_PREFIX.replace("]", ":dev]")} reclaiming port ${String(port)} from stale dev server pid ${String(pid)}`)
    try {
      process.kill(pid, "SIGTERM")
      if (!(await waitForPidExit(pid))) {
        process.kill(pid, "SIGKILL")
        await waitForPidExit(pid, 1_000)
      }
    } catch {
      // If the process is already gone, the upcoming spawn will succeed.
    }
    return
  }

  const details = command ? ` (${command})` : ""
  throw new Error(`Port ${String(port)} is already in use by pid ${String(pid)}${details}`)
}

await ensureServerPortAvailable(serverPort)

const server = spawn(bunBin, ["run", "./scripts/dev-server.ts", "--no-open", "--port", String(serverPort), "--strict-port", ...serverArgs], {
  cwd,
  stdio: "inherit",
  env: process.env,
})

server.on("spawn", () => {
  if (server.pid) {
    mkdirSync(join(cwd, ".kanna"), { recursive: true })
    writeFileSync(serverPidFile, `${String(server.pid)}\n`, "utf8")
  }
  console.log(`${LOG_PREFIX.replace("]", ":server]")} started`)
})

const children = [server]
let shuttingDown = false

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    stopChild(child)
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGKILL")
      }
    }
  }, 2_000).unref()

  process.exit(exitCode)
}

function onChildExit(label: string, code: number | null, signal: NodeJS.Signals | null) {
  if (shuttingDown) return
  const exitCode = code ?? (signal ? 1 : 0)
  console.error(`${LOG_PREFIX.replace("]", `:${label}]`)} exited${signal ? ` via ${signal}` : ` with code ${String(exitCode)}`}`)
  shutdown(exitCode)
}

server.on("exit", (code, signal) => {
  removeServerPidFile()
  onChildExit("server", code, signal)
})

async function waitForServerReady(timeoutMs = 30_000) {
  const startedAt = Date.now()
  const healthUrl = `http://127.0.0.1:${serverPort}/health`

  while (Date.now() - startedAt < timeoutMs) {
    if (server.exitCode !== null) {
      throw new Error("Dev server exited before becoming ready")
    }

    try {
      const response = await fetch(healthUrl)
      if (response.ok) {
        return
      }
    } catch {
      // Keep polling until the server is reachable or times out.
    }

    await Bun.sleep(150)
  }

  throw new Error(`Timed out waiting for dev server at ${healthUrl}`)
}

process.on("SIGINT", () => {
  shutdown(0)
})

process.on("SIGTERM", () => {
  shutdown(0)
})

console.log(`${LOG_PREFIX} dev client: http://localhost:${clientPort}`)
console.log(`${LOG_PREFIX} dev server: http://localhost:${serverPort}`)

try {
  await waitForServerReady()
  const client = spawnLabeledProcess("client", ["x", "vite", "--host", "0.0.0.0", "--port", String(clientPort), "--strictPort"])
  children.unshift(client)
  client.on("exit", (code, signal) => {
    onChildExit("client", code, signal)
  })
} catch (error) {
  console.error(`${LOG_PREFIX.replace("]", ":dev]")} ${error instanceof Error ? error.message : String(error)}`)
  shutdown(1)
}
