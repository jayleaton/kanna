import process from "node:process"
import {
  fetchLatestPackageVersion,
  installLatestPackage,
  openUrl,
  relaunchCli,
  runCli,
} from "./cli-runtime"
import { startKannaServer } from "./server"

// Read version from package.json at the package root
const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
const VERSION: string = pkg.version ?? "0.0.0"

const result = await runCli(process.argv.slice(2), {
  version: VERSION,
  bunVersion: Bun.version,
  startServer: startKannaServer,
  fetchLatestVersion: fetchLatestPackageVersion,
  installLatest: installLatestPackage,
  relaunch: relaunchCli,
  openUrl,
  log: console.log,
  warn: console.warn,
})

if (result.kind === "exited") {
  process.exit(result.code)
}

const shutdown = async () => {
  await result.stop()
  process.exit(0)
}

process.on("SIGINT", () => {
  void shutdown()
})
process.on("SIGTERM", () => {
  void shutdown()
})
