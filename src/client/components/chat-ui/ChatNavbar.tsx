import { Flower, Code, FolderOpen, Menu, PanelLeft, SquarePen, Terminal } from "lucide-react"
import { Button } from "../ui/button"
import { CardHeader } from "../ui/card"
import { cn } from "../../lib/utils"

interface Props {
  sidebarCollapsed: boolean
  onOpenSidebar: () => void
  onExpandSidebar: () => void
  onNewChat: () => void
  localPath?: string
  onOpenExternal?: (action: "open_finder" | "open_terminal" | "open_editor") => void
}

export function ChatNavbar({
  sidebarCollapsed,
  onOpenSidebar,
  onExpandSidebar,
  onNewChat,
  localPath,
  onOpenExternal,
}: Props) {
  return (
    <CardHeader
      className={cn(
        "absolute top-0 md:top-2 left-0 right-0 z-10 px-2.5 pr-4 border-border/0 md:pb-0 flex items-center justify-center",
        "backdrop-blur-lg md:backdrop-blur-none bg-gradient-to-b from-background md:from-transparent border-b border-x-0 md:border-x border-border md:border-none"
      )}
    >
      <div className="relative flex items-center gap-2 w-full">
        <div className="flex items-center gap-1 flex-shrink-0 border-l border-border/0">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={onOpenSidebar}
          >
            <Menu className="h-5 w-5" />
          </Button>
          {sidebarCollapsed && (
            <>
              <div className="flex items-center justify-center w-[40px] h-[40px]">
                <Flower className="h-4 w-4 sm:h-5 sm:w-5 text-logo ml-1 hidden md:block" />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="hidden md:flex"
                onClick={onExpandSidebar}
                title="Expand sidebar"
              >
                <PanelLeft className="h-5 w-5" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onNewChat}
            title="Compose"
          >
            <SquarePen className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 min-w-0" />

        <div className="flex items-center gap-1 flex-shrink-0">
          {localPath && onOpenExternal && (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onOpenExternal("open_finder")}
                title="Open in Finder"
                className="border border-border/0"
              >
                <FolderOpen className="h-4.5 w-4.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onOpenExternal("open_terminal")}
                title="Open in Terminal"
                className="border border-border/0"
              >
                <Terminal className="h-4.5 w-4.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onOpenExternal("open_editor")}
                title="Open in Cursor"
                className="border border-border/0"
              >
                <Code className="h-4.5 w-4.5" />
              </Button>
            </>
          )}
        </div>
      </div>
    </CardHeader>
  )
}
