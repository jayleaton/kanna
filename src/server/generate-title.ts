import { query } from "@anthropic-ai/claude-agent-sdk"

export async function generateTitleForChat(messageContent: string): Promise<string | null> {
  try {
    const q = query({
      prompt: `Generate a short, descriptive title (under 30 chars) for a conversation that starts with this message. Return JSON matching the schema.\n\n${messageContent}`,
      options: {
        model: "haiku",
        tools: [],
        systemPrompt: "",
        effort: "low",
        permissionMode: "bypassPermissions",
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        env: { ...process.env },
      },
    })

    try {
      for await (const message of q) {
        if ("result" in message) {
          const output = (message as Record<string, unknown>).structured_output as { title?: string } | undefined
          return typeof output?.title === "string" ? output.title.slice(0, 80) : null
        }
      }
    } finally {
      q.close()
    }

    return null
  } catch {
    return null
  }
}
