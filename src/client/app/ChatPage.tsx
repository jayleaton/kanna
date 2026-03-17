import { ArrowDown, Flower } from "lucide-react"
import { useOutletContext } from "react-router-dom"
import { ChatInput } from "../components/chat-ui/ChatInput"
import { ChatNavbar } from "../components/chat-ui/ChatNavbar"
import { ProcessingMessage } from "../components/messages/ProcessingMessage"
import { Card, CardContent } from "../components/ui/card"
import { ScrollArea } from "../components/ui/scroll-area"
import { cn } from "../lib/utils"
import type { KannaState } from "./useKannaState"
import { KannaTranscript } from "./KannaTranscript"

export function ChatPage() {
  const state = useOutletContext<KannaState>()

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
      <Card className="bg-background flex-1 flex flex-col overflow-hidden border-0 rounded-none relative">
        <CardContent className="flex-1 p-0 overflow-hidden relative">
          <ChatNavbar
            sidebarCollapsed={state.sidebarCollapsed}
            onOpenSidebar={state.openSidebar}
            onExpandSidebar={state.expandSidebar}
            onNewChat={state.handleCompose}
            localPath={state.navbarLocalPath}
            onOpenExternal={(action) => {
              void state.handleOpenExternal(action)
            }}
          />

          <ScrollArea
            ref={state.scrollRef}
            onScroll={state.updateScrollState}
            className="h-full px-4 scroll-pt-[72px]"
          >
            <div
              className="animate-fade-in space-y-5 pt-[72px] max-w-[800px] mx-auto"
              style={{ paddingBottom: state.transcriptPaddingBottom }}
            >
              {state.messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center min-h-[40vh] text-muted-foreground gap-4">
                  <Flower strokeWidth={1.5} className="size-8 text-muted-foreground"></Flower>
                  <div className="text-base font-normal text-muted-foreground text-center max-w-xs">
                    What are we making?
                  </div>
                </div>
              ) : (
                <KannaTranscript
                  messages={state.messages}
                  isLoading={state.isProcessing}
                  localPath={state.runtime?.localPath}
                  latestToolIds={state.latestToolIds}
                  onAskUserQuestionSubmit={state.handleAskUserQuestion}
                  onExitPlanModeConfirm={state.handleExitPlanMode}
                />
              )}

              {state.isProcessing ? <ProcessingMessage status={state.runtime?.status} /> : null}
              {state.commandError ? (
                <div className="text-sm text-destructive border border-destructive/20 bg-destructive/5 rounded-xl px-4 py-3">
                  {state.commandError}
                </div>
              ) : null}
              <div className="flex-1 min-h-[10vh]" aria-hidden="true" />
            </div>
          </ScrollArea>

          <div
            style={{ bottom: state.transcriptPaddingBottom - 36 }}
            className={cn(
              "absolute left-1/2 -translate-x-1/2 z-10 transition-all",
              state.showScrollButton
                ? "scale-100 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                : "scale-60 duration-300 ease-out pointer-events-none blur-sm opacity-0"
            )}
          >
            <button
              onClick={state.scrollToBottom}
              className="flex items-center transition-colors gap-1.5 px-2 bg-white hover:bg-muted border border-border rounded-full aspect-square cursor-pointer text-sm text-primary hover:text-foreground dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-100 dark:border-slate-600"
            >
              <ArrowDown className="h-5 w-5" />
            </button>
          </div>
        </CardContent>

        <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
          <div className="bg-gradient-to-t from-background via-background pointer-events-auto" ref={state.inputRef}>
            <ChatInput
              key={state.activeChatId ?? "new-chat"}
              onSubmit={state.handleSend}
              onCancel={() => {
                void state.handleCancel()
              }}
              disabled={!state.hasSelectedProject || state.runtime?.status === "waiting_for_user"}
              canCancel={state.canCancel}
              chatId={state.activeChatId}
              activeProvider={state.runtime?.provider ?? null}
              availableProviders={state.availableProviders}
            />
          </div>
        </div>
      </Card>
    </div>
  )
}
