import {
  Panel,
  Group,
  Separator,
  type GroupProps,
  type Orientation,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels"
import { cn } from "../../lib/utils"

const ResizablePanelGroup = ({
  className,
  ...props
}: GroupProps) => (
  <Group
    className={cn("flex h-full w-full", className)}
    {...props}
  />
)

const ResizablePanel = (props: PanelProps) => <Panel {...props} />

const ResizableHandle = ({
  withHandle,
  orientation,
  className,
  ...props
}: SeparatorProps & {
  withHandle?: boolean
  orientation: Orientation
}) => {
  void withHandle

  return (
    <Separator
      className={cn(
        "relative flex items-center justify-center bg-transparent focus-visible:outline-none",
        orientation === "vertical"
          ? "h-2 w-full -my-1 cursor-row-resize before:absolute before:inset-x-0 before:top-1/2 before:h-0.5 before:-translate-y-1/2 before:bg-border"
          : "h-full w-2 -mx-1 cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border",
        className
      )}
      {...props}
    >
      <span className="sr-only">{orientation === "vertical" ? "Resize rows" : "Resize columns"}</span>
    </Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
