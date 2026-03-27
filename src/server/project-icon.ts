import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { resolveLocalPath } from "./paths"

const MAX_ICON_BYTES = 128 * 1024
const ICON_CANDIDATE_PATHS = [
  "icon.svg",
  "icon.png",
  "icon.jpg",
  "icon.jpeg",
  "icon.webp",
  "icon.gif",
  "icon.avif",
  "icon.ico",
  ".kanna/icon.svg",
  ".kanna/icon.png",
  ".kanna/icon.jpg",
  ".kanna/icon.jpeg",
  ".kanna/icon.webp",
  ".kanna/icon.gif",
  ".kanna/icon.avif",
  ".kanna/icon.ico",
  "favicon.svg",
  "favicon.png",
  "favicon.jpg",
  "favicon.jpeg",
  "favicon.webp",
  "favicon.gif",
  "favicon.avif",
  "favicon.ico",
  "public/favicon.svg",
  "public/favicon.png",
  "public/favicon.jpg",
  "public/favicon.jpeg",
  "public/favicon.webp",
  "public/favicon.gif",
  "public/favicon.avif",
  "public/favicon.ico",
  "public/icon.svg",
  "public/icon.png",
  "public/icon.jpg",
  "public/icon.jpeg",
  "public/icon.webp",
  "public/icon.gif",
  "public/icon.avif",
  "public/icon.ico",
  "app/favicon.svg",
  "app/favicon.png",
  "app/favicon.jpg",
  "app/favicon.jpeg",
  "app/favicon.webp",
  "app/favicon.gif",
  "app/favicon.avif",
  "app/favicon.ico",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.jpg",
  "app/icon.jpeg",
  "app/icon.webp",
  "app/icon.gif",
  "app/icon.avif",
  "app/icon.ico",
  "src/favicon.svg",
  "src/favicon.png",
  "src/favicon.jpg",
  "src/favicon.jpeg",
  "src/favicon.webp",
  "src/favicon.gif",
  "src/favicon.avif",
  "src/favicon.ico",
  "src/app/favicon.svg",
  "src/app/favicon.png",
  "src/app/favicon.jpg",
  "src/app/favicon.jpeg",
  "src/app/favicon.webp",
  "src/app/favicon.gif",
  "src/app/favicon.avif",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/icon.jpg",
  "src/app/icon.jpeg",
  "src/app/icon.webp",
  "src/app/icon.gif",
  "src/app/icon.avif",
  "src/app/icon.ico",
]
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/root.tsx",
  "src/root.tsx",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
]
const LINK_ICON_HTML_RE = /<link[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*href=["']([^"'?]+)/i
const LINK_ICON_OBJ_RE = /rel:\s*["'](?:icon|shortcut icon)["'][^}]*href:\s*["']([^"'?]+)/i

function getMimeType(extension: string) {
  switch (extension) {
    case ".svg":
      return "image/svg+xml"
    case ".png":
      return "image/png"
    case ".ico":
      return "image/vnd.microsoft.icon"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    case ".gif":
      return "image/gif"
    case ".avif":
      return "image/avif"
    default:
      return null
  }
}

function compareIconNames(a: string, b: string) {
  const aExt = path.extname(a).toLowerCase()
  const bExt = path.extname(b).toLowerCase()
  const aIndex = getExtensionPriority(aExt)
  const bIndex = getExtensionPriority(bExt)
  if (aIndex !== bIndex) return aIndex - bIndex
  return a.localeCompare(b)
}

function getExtensionPriority(extension: string) {
  switch (extension) {
    case ".svg":
      return 0
    case ".png":
      return 1
    case ".jpg":
    case ".jpeg":
      return 2
    case ".webp":
      return 3
    case ".gif":
      return 4
    case ".avif":
      return 5
    case ".ico":
      return 6
    default:
      return Number.MAX_SAFE_INTEGER
  }
}

function findFixedIconCandidates(projectPath: string) {
  try {
    const existingPaths = new Map<string, string>()

    for (const relativePath of ICON_CANDIDATE_PATHS) {
      const extension = path.extname(relativePath).toLowerCase()
      if (getMimeType(extension) === null) continue

      const absolutePath = resolveCaseInsensitiveProjectPath(projectPath, relativePath)
      if (!absolutePath) continue
      existingPaths.set(relativePath, absolutePath)
    }

    return [...existingPaths.entries()]
      .sort((a, b) => {
        const pathCompare = ICON_CANDIDATE_PATHS.indexOf(a[0]) - ICON_CANDIDATE_PATHS.indexOf(b[0])
        if (pathCompare !== 0) return pathCompare
        return compareIconNames(a[0], b[0])
      })
      .map(([, absolutePath]) => absolutePath)
  } catch {
    return []
  }
}

function findAppWorkspaceIconCandidates(projectPath: string) {
  const appsPath = path.join(projectPath, "apps")

  try {
    const appDirectories = readdirSync(appsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))

    const existingPaths = new Map<string, string>()

    for (const appDirectory of appDirectories) {
      for (const relativePath of ICON_CANDIDATE_PATHS) {
        if (relativePath.startsWith(".kanna/")) continue
        const appRelativePath = path.join("apps", appDirectory, relativePath)
        const extension = path.extname(appRelativePath).toLowerCase()
        if (getMimeType(extension) === null) continue

        const absolutePath = resolveCaseInsensitiveProjectPath(projectPath, appRelativePath)
        if (!absolutePath) continue
        existingPaths.set(appRelativePath, absolutePath)
      }
    }

    return [...existingPaths.entries()]
      .sort((a, b) => {
        const [aPath] = a
        const [bPath] = b
        const aRelative = aPath.replace(/^apps\/[^/]+\//, "")
        const bRelative = bPath.replace(/^apps\/[^/]+\//, "")
        const pathCompare = ICON_CANDIDATE_PATHS.indexOf(aRelative) - ICON_CANDIDATE_PATHS.indexOf(bRelative)
        if (pathCompare !== 0) return pathCompare
        return compareIconNames(aPath, bPath)
      })
      .map(([, absolutePath]) => absolutePath)
  } catch {
    return []
  }
}

function resolveCaseInsensitiveProjectPath(projectPath: string, relativePath: string) {
  const segments = relativePath.split("/").filter(Boolean)
  let currentPath = projectPath

  for (const [index, segment] of segments.entries()) {
    let entries: string[]
    try {
      entries = readdirSync(currentPath)
    } catch {
      return null
    }

    const matchedEntry = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase())
    if (!matchedEntry) {
      return null
    }

    currentPath = path.join(currentPath, matchedEntry)

    try {
      const stat = statSync(currentPath)
      const isLast = index === segments.length - 1
      if (isLast) {
        return stat.isFile() ? currentPath : null
      }
      if (!stat.isDirectory()) {
        return null
      }
    } catch {
      return null
    }
  }

  return null
}

function extractDeclaredIconHref(source: string) {
  const htmlMatch = source.match(LINK_ICON_HTML_RE)
  if (htmlMatch?.[1]) return htmlMatch[1]
  const objMatch = source.match(LINK_ICON_OBJ_RE)
  if (objMatch?.[1]) return objMatch[1]
  return null
}

function resolveDeclaredIconCandidates(projectPath: string, href: string) {
  const cleanHref = href.replace(/^\//, "")
  return [
    path.join(projectPath, "public", cleanHref),
    path.join(projectPath, cleanHref),
  ]
}

function findDeclaredIconCandidates(projectPath: string) {
  const candidates: string[] = []

  for (const sourceFile of ICON_SOURCE_FILES) {
    const sourcePath = path.join(projectPath, sourceFile)

    try {
      const source = readFileSync(sourcePath, "utf8")
      const href = extractDeclaredIconHref(source)
      if (!href) continue

      for (const candidatePath of resolveDeclaredIconCandidates(projectPath, href)) {
        const extension = path.extname(candidatePath).toLowerCase()
        if (getMimeType(extension) === null) continue
        if (!candidates.includes(candidatePath)) {
          candidates.push(candidatePath)
        }
      }
    } catch {
      continue
    }
  }

  return candidates
}

function tryReadImageDataUrl(filePath: string) {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_ICON_BYTES) {
      return null
    }

    const extension = path.extname(filePath).toLowerCase()
    const mimeType = getMimeType(extension)
    if (!mimeType) {
      return null
    }

    if (extension === ".svg") {
      const svg = readFileSync(filePath, "utf8").trim()
      if (!svg.includes("<svg")) {
        return null
      }

      return `data:${mimeType};utf8,${encodeURIComponent(svg)}`
    }

    const image = readFileSync(filePath)
    return `data:${mimeType};base64,${image.toString("base64")}`
  } catch {
    return null
  }

  return null
}

export function resolveProjectIconDataUrl(localPath: string): string | null {
  const projectPath = resolveLocalPath(localPath)
  const candidatePaths = [
    ...findFixedIconCandidates(projectPath),
    ...findAppWorkspaceIconCandidates(projectPath),
    ...findDeclaredIconCandidates(projectPath),
  ]

  for (const candidatePath of candidatePaths) {
    const dataUrl = tryReadImageDataUrl(candidatePath)
    if (dataUrl) {
      return dataUrl
    }
  }

  return null
}
