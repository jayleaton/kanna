import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const BACKGROUND_DIRS = [
  path.join(os.homedir(), ".local/share/backgrounds"),
  "/usr/share/backgrounds",
  "/Library/Desktop Pictures",
  path.join(os.homedir(), "Pictures"),
  process.platform === "win32" ? "C:\\Windows\\Web\\Wallpaper" : "",
].filter(Boolean)

export interface SystemBackground {
  id: string
  name: string
  url: string
}

export async function getSystemBackgrounds(): Promise<SystemBackground[]> {
  const backgrounds: SystemBackground[] = []
  const seen = new Set<string>()

  async function scanDir(dir: string, depth = 0) {
    if (depth > 3) return // Prevent excessive recursion depth

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await scanDir(path.join(dir, entry.name), depth + 1)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp") {
            const fullPath = path.join(dir, entry.name)
            if (seen.has(fullPath)) continue
            seen.add(fullPath)
            
            const id = Buffer.from(fullPath).toString('base64url')
            backgrounds.push({
              id,
              name: entry.name,
              url: `/api/backgrounds/${id}`
            })
          }
        }
      }
    } catch (err) {
      // Ignore if directory doesn't exist or is inaccessible
    }
  }

  for (const dir of BACKGROUND_DIRS) {
    if (!dir) continue
    await scanDir(dir)
  }
  
  return backgrounds
}

export async function resolveBackgroundPath(id: string): Promise<string | null> {
  try {
    const fullPath = Buffer.from(id, 'base64url').toString('utf-8')
    const isAllowed = BACKGROUND_DIRS.some(dir => dir && fullPath.startsWith(dir))
    if (!isAllowed) return null
    
    const stats = await fs.stat(fullPath)
    if (!stats.isFile()) return null
    
    return fullPath
  } catch {
    return null
  }
}
