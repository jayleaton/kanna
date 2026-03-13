export const APP_NAME = "Kanna"
export const CLI_COMMAND = "kanna"
export const DATA_ROOT_NAME = ".kanna"
export const PACKAGE_NAME = "kanna-code"
export const SDK_CLIENT_APP = "kanna/0.1.0"
export const LOG_PREFIX = "[kanna]"
export const DEFAULT_NEW_PROJECT_ROOT = `~/${APP_NAME}`

export function getDataRootName() {
  return DATA_ROOT_NAME
}

export function getDataDir(homeDir: string) {
  return `${homeDir}/${DATA_ROOT_NAME}/data`
}

export function getDataDirDisplay() {
  return `~/${DATA_ROOT_NAME.slice(1)}/data`
}

export function getCliInvocation(arg?: string) {
  return arg ? `${CLI_COMMAND} ${arg}` : CLI_COMMAND
}
