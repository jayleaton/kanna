import type { ReactNode } from "react"
import { cn } from "../../lib/utils"

interface ProjectIconProps {
  iconDataUrl?: string | null
  alt: string
  className?: string
  fallback?: ReactNode
}

export function ProjectIcon({ iconDataUrl, alt, className, fallback = null }: ProjectIconProps) {
  if (!iconDataUrl) {
    return <>{fallback}</>
  }

  return (
    <img
      src={iconDataUrl}
      alt={alt}
      className={cn("shrink-0 object-contain", className)}
    />
  )
}
