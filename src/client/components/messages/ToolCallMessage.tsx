import { UserRound, X } from "lucide-react"
import type { ProcessedToolCall } from "./types"
import { MetaRow, MetaLabel, MetaCodeBlock, ExpandableRow, VerticalLineContainer, getToolIcon } from "./shared"
import { useMemo } from "react"
import { stripWorkspacePath } from "../../lib/pathUtils"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { toTitleCase } from "../../lib/formatters"
import { FileContentView } from "./FileContentView"

interface Props {
  message: ProcessedToolCall
  isLoading?: boolean
  localPath?: string | null
}

export function ToolCallMessage({ message, isLoading = false, localPath }: Props) {
  const hasResult = message.result !== undefined
  const showLoadingState = !hasResult && isLoading

  const name = useMemo(() => {
    if (message.toolKind === "skill") {
      return message.input.skill
    }
    if (message.toolKind === "glob") {
      return `Search files ${message.input.pattern === "**/*" ? "in all directories" : `matching ${message.input.pattern}`}`
    }
    if (message.toolKind === "grep") {
      const pattern = message.input.pattern
      const outputMode = message.input.outputMode
      if (outputMode === "count") {
        return `Count \`${pattern}\` occurrences`
      }
      if (outputMode === "content") {
        return `Find \`${pattern}\` in text`
      }
      return `Find \`${pattern}\` in files`
    }
    if (message.toolKind === "bash") {
      return message.input.description || message.input.command || "Bash"
    }
    if (message.toolKind === "web_search") {
      return message.input.query || "Web Search"
    }
    if (message.toolKind === "read_file") {
      return `Read ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "write_file") {
      return `Write ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "edit_file") {
      return `Edit ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "mcp_generic") {
      return `${toTitleCase(message.input.tool)} from ${toTitleCase(message.input.server)}`
    }
    if (message.toolKind === "subagent_task") {
      return message.input.subagentType || message.toolName
    }
    return message.toolName
  }, [message.input, message.toolName, localPath])

  const isAgent = useMemo(() => message.toolKind === "subagent_task", [message.toolKind])
  const description = useMemo(() => {
    if (message.toolKind === "skill") {
      return message.input.skill
    }
  }, [message.input, message.toolKind])

  const isBashTool = message.toolKind === "bash"
  const isWriteTool = message.toolKind === "write_file"
  const isEditTool = message.toolKind === "edit_file"
  const isReadTool = message.toolKind === "read_file"

  const resultText = useMemo(() => {
    if (typeof message.result === "string") return message.result
    if (!message.result) return ""
    if (typeof message.result === "object" && message.result !== null && "content" in message.result) {
      const content = (message.result as { content?: unknown }).content
      if (typeof content === "string") return content
    }
    return JSON.stringify(message.result, null, 2)
  }, [message.result])

  const inputText = useMemo(() => {
    switch (message.toolKind) {
      case "bash":
        return message.input.command
      case "write_file":
        return message.input.content
      default:
        return JSON.stringify(message.input, null, 2)
    }
  }, [message])

  return (
    <MetaRow className="w-full">
      <ExpandableRow
        expandedContent={
          <VerticalLineContainer className="my-4 text-sm">
            <div className="flex flex-col gap-2">
              {isEditTool ? (
                <FileContentView
                  content=""
                  isDiff
                  oldString={message.input.oldString}
                  newString={message.input.newString}
                />
              ) : !isReadTool && !isWriteTool && (
                <MetaCodeBlock label={
                  isBashTool ? (
                    <span className="flex items-center gap-2 w-full">
                      <span>Command</span>
                      {!!message.input.timeoutMs && (
                        <span className="text-muted-foreground">timeout: {String(message.input.timeoutMs)}ms</span>
                      )}
                      {!!message.input.runInBackground && (
                        <span className="text-muted-foreground">background</span>
                      )}
                    </span>
                  ) : isWriteTool ? "Contents" : "Input"
                } copyText={inputText}>
                  {inputText}
                </MetaCodeBlock>
              )}
              {hasResult && isReadTool && !message.isError && (
                <FileContentView
                  content={resultText}
                />
              )}
              {isWriteTool && !message.isError && (
                <FileContentView
                  content={message.input.content}
                />
              )}
              {hasResult && !isReadTool && !(isWriteTool && !message.isError) && !(isEditTool && !message.isError) && (
                <MetaCodeBlock label={message.isError ? "Error" : "Result"} copyText={resultText}>
                  {resultText}
                </MetaCodeBlock>
              )}
            </div>
          </VerticalLineContainer>
        }
      >

        <div className={`w-5 h-5 relative flex items-center justify-center`}>
          {(() => {
            if (message.isError) {
              return <X className="size-4 text-destructive" />
            }
            if (isAgent) {
              return <UserRound className="size-4 text-muted-icon" />
            }
            const Icon = getToolIcon(message.toolName)

            return <Icon className="size-4 text-muted-icon" />
          })()}
        </div>
        <MetaLabel className="text-left transition-opacity duration-200 truncate">
          <AnimatedShinyText
            animate={showLoadingState}
            shimmerWidth={Math.max(20, ((description || name)?.length ?? 33) * 3)}
          >
            {description || name}
          </AnimatedShinyText>
        </MetaLabel>



      </ExpandableRow>
    </MetaRow>
  )
}
