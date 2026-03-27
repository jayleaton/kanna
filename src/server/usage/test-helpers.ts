import type { TranscriptEntry } from "../../shared/types"

export function transcriptEntry(overrides: Partial<TranscriptEntry> & Pick<TranscriptEntry, "kind">): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: 1,
    ...overrides,
  } as TranscriptEntry
}
