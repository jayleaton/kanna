import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "./ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog"
import { Textarea } from "./ui/textarea"

interface CursorCurlImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (curlCommand: string) => void | Promise<void>
}

const INSTRUCTIONS = `1. Sign in on the opened Cursor spending page.
2. Open DevTools > Network.
3. Refresh the page.
4. Right-click the get-current-period-usage request.
5. Copy > Copy as cURL.
6. Paste it here.`

export function CursorCurlImportModal({ open, onOpenChange, onSubmit }: CursorCurlImportModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [curlCommand, setCurlCommand] = useState("")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    setCurlCommand("")
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [open])

  async function pasteFromClipboard() {
    const text = await navigator.clipboard.readText()
    setCurlCommand(text)
  }

  async function copyInstructions() {
    await navigator.clipboard.writeText(INSTRUCTIONS)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const canSubmit = curlCommand.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit) return
            void onSubmit(curlCommand.trim())
          }}
        >
          <DialogBody className="space-y-4">
            <DialogTitle>Import Cursor Session</DialogTitle>
            <DialogDescription>
              Paste the copied <code>get-current-period-usage</code> curl command and Kanna will import the session for you.
            </DialogDescription>
            <div className="rounded-xl border border-border bg-card px-3 py-3 text-sm text-muted-foreground whitespace-pre-line">
              {INSTRUCTIONS}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => void pasteFromClipboard()}>
                Paste Clipboard
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void copyInstructions()}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ml-1">{copied ? "Copied" : "Copy Steps"}</span>
              </Button>
            </div>
            <Textarea
              ref={textareaRef}
              value={curlCommand}
              onChange={(event) => setCurlCommand(event.target.value)}
              rows={10}
              placeholder="Paste the copied curl command here"
              className="font-mono text-xs"
            />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="secondary" size="sm" disabled={!canSubmit}>
              Import Session
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
