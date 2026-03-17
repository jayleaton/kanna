import type {
  AskUserQuestionItem,
  AskUserQuestionToolResult,
  ExitPlanModeToolResult,
  HydratedToolCall,
  NormalizedToolCall,
  ReadFileToolResult,
  TodoItem,
} from "./types"

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function normalizeToolCall(args: {
  toolName: string
  toolId: string
  input: Record<string, unknown>
}): NormalizedToolCall {
  const { toolName, toolId, input } = args

  switch (toolName) {
    case "AskUserQuestion":
      return {
        kind: "tool",
        toolKind: "ask_user_question",
        toolName,
        toolId,
        input: {
          questions: Array.isArray(input.questions) ? (input.questions as AskUserQuestionItem[]) : [],
        },
        rawInput: input,
      }
    case "ExitPlanMode":
      return {
        kind: "tool",
        toolKind: "exit_plan_mode",
        toolName,
        toolId,
        input: {
          plan: typeof input.plan === "string" ? input.plan : undefined,
          summary: typeof input.summary === "string" ? input.summary : undefined,
        },
        rawInput: input,
      }
    case "TodoWrite":
      return {
        kind: "tool",
        toolKind: "todo_write",
        toolName,
        toolId,
        input: {
          todos: Array.isArray(input.todos) ? (input.todos as TodoItem[]) : [],
        },
        rawInput: input,
      }
    case "Skill":
      return {
        kind: "tool",
        toolKind: "skill",
        toolName,
        toolId,
        input: {
          skill: typeof input.skill === "string" ? input.skill : "",
        },
        rawInput: input,
      }
    case "Glob":
      return {
        kind: "tool",
        toolKind: "glob",
        toolName,
        toolId,
        input: {
          pattern: typeof input.pattern === "string" ? input.pattern : "",
        },
        rawInput: input,
      }
    case "Grep":
      return {
        kind: "tool",
        toolKind: "grep",
        toolName,
        toolId,
        input: {
          pattern: typeof input.pattern === "string" ? input.pattern : "",
          outputMode: typeof input.output_mode === "string" ? input.output_mode : undefined,
        },
        rawInput: input,
      }
    case "Bash":
      return {
        kind: "tool",
        toolKind: "bash",
        toolName,
        toolId,
        input: {
          command: typeof input.command === "string" ? input.command : "",
          description: typeof input.description === "string" ? input.description : undefined,
          timeoutMs: typeof input.timeout === "number" ? input.timeout : undefined,
          runInBackground: Boolean(input.run_in_background),
        },
        rawInput: input,
      }
    case "WebSearch":
      return {
        kind: "tool",
        toolKind: "web_search",
        toolName,
        toolId,
        input: {
          query: typeof input.query === "string" ? input.query : "",
        },
        rawInput: input,
      }
    case "Read":
      return {
        kind: "tool",
        toolKind: "read_file",
        toolName,
        toolId,
        input: {
          filePath: typeof input.file_path === "string" ? input.file_path : "",
        },
        rawInput: input,
      }
    case "Write":
      return {
        kind: "tool",
        toolKind: "write_file",
        toolName,
        toolId,
        input: {
          filePath: typeof input.file_path === "string" ? input.file_path : "",
          content: typeof input.content === "string" ? input.content : "",
        },
        rawInput: input,
      }
    case "Edit":
      return {
        kind: "tool",
        toolKind: "edit_file",
        toolName,
        toolId,
        input: {
          filePath: typeof input.file_path === "string" ? input.file_path : "",
          oldString: typeof input.old_string === "string" ? input.old_string : "",
          newString: typeof input.new_string === "string" ? input.new_string : "",
        },
        rawInput: input,
      }
  }

  const mcpMatch = toolName.match(/^mcp__(.+?)__(.+)$/)
  if (mcpMatch) {
    return {
      kind: "tool",
      toolKind: "mcp_generic",
      toolName,
      toolId,
      input: {
        server: mcpMatch[1],
        tool: mcpMatch[2],
        payload: input,
      },
      rawInput: input,
    }
  }

  if (typeof input.subagent_type === "string") {
    return {
      kind: "tool",
      toolKind: "subagent_task",
      toolName,
      toolId,
      input: {
        subagentType: input.subagent_type,
      },
      rawInput: input,
    }
  }

  return {
    kind: "tool",
    toolKind: "unknown_tool",
    toolName,
    toolId,
    input: {
      payload: input,
    },
    rawInput: input,
  }
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function hydrateToolResult(tool: NormalizedToolCall, raw: unknown): HydratedToolCall["result"] {
  const parsed = parseJsonValue(raw)

  switch (tool.toolKind) {
    case "ask_user_question": {
      const record = asRecord(parsed)
      const answers = asRecord(record?.answers) ?? (record ? record : {})
      return { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, String(value)])) } satisfies AskUserQuestionToolResult
    }
    case "exit_plan_mode": {
      const record = asRecord(parsed)
      return {
        confirmed: typeof record?.confirmed === "boolean" ? record.confirmed : undefined,
        clearContext: typeof record?.clearContext === "boolean" ? record.clearContext : undefined,
        message: typeof record?.message === "string" ? record.message : undefined,
      } satisfies ExitPlanModeToolResult
    }
    case "read_file":
      if (typeof parsed === "string") {
        return parsed
      }
      const record = asRecord(parsed)
      return {
        content: typeof record?.content === "string" ? record.content : JSON.stringify(parsed, null, 2),
      } satisfies ReadFileToolResult
    default:
      return parsed
  }
}
