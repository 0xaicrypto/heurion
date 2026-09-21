import { Paperclip, Pin, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SkillsBar } from '@/components/SkillsBar';
import { ChatMessages, ChatChangeCard } from '@/components/chat/ChatMessages';
import { ChartLibrary } from '@/components/chat/ChartLibrary';
import { Button, Textarea } from '@/components/ui';
import { isEnterSendKey } from '@/lib/chat-composer';
import { cn } from '@/lib/utils';
import type { DocChat } from './doc-chat';

/** #688: 右侧 Doc Chat / Charts 面板 UI — 从 writing-editor 路由机械拆出；
 * chat 状态经 useDocChat 保持在路由（chat 控制器整体透传），宽度/审阅等
 * 路由侧状态经 props 回调操作。 */
export function ChatPanel(input: {
  chat: DocChat;
  chatWidth: number;
  sidePanelTab: 'chat' | 'charts';
  setSidePanelTab: React.Dispatch<React.SetStateAction<'chat' | 'charts'>>;
  onClose: () => void;
  onResizeStart: (e: React.MouseEvent<HTMLDivElement>) => void;
  chatSessionId: string;
  onInsertChart: (markdown: string) => void;
  /** #996/#1003: 聊天 ↔ 文档跳转（节标签/改动卡 → 编辑器节卡片）。 */
  onJumpToSection: (sectionId: string) => void;
  /** #1032: 临时附件固定为引用（登记 SessionReference，后续轮次持续生效）。 */
  onPinAttachment: (f: { name: string; fileId: string }) => void;
  attachmentPinning?: boolean;
}) {
  const { t } = useTranslation();
  const { chat, chatWidth, sidePanelTab, setSidePanelTab, onClose, onResizeStart, chatSessionId, onInsertChart, onJumpToSection, onPinAttachment, attachmentPinning } = input;
  const { chatInput, setChatInput, chatMessages, chatSession, chatLoading, chatPending, chatPendingCount, chatEndRef, chatSelection, setChatSelection } = chat;
  return (
    <>
              {/* #351: tap the scrim to close the mobile chat drawer */}
              <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={onClose} />
              <aside
                style={{ ['--chatw' as string]: `${chatWidth}px` }}
                className="fixed inset-y-0 right-0 z-40 flex w-[85vw] max-w-sm flex-col border-l border-border bg-surface shadow-xl md:relative md:inset-auto md:z-auto md:w-[var(--chatw)] md:max-w-none md:shrink-0 md:border-l-0 md:shadow-none"
              >
                {/* #382: desktop resize handle — drag to change chat width.
                    #fix 2026-09: aside 此前是 md:static(非定位),absolute 把手
                    锚到外层定位祖先,把手从面板左缘消失 → 无法拖拽。
                    改 md:relative(不改变文档流,同时成为把手包含块)。 */}
                <div
                  onMouseDown={onResizeStart}
                  className="absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize bg-border/40 hover:bg-accent/60 md:block"
                  style={{ width: 6 }}
                />
              <div className="flex h-10 items-center justify-between border-b border-border px-3">
                <div className="flex gap-1">
                  <button
                    onClick={() => setSidePanelTab('chat')}
                    className={cn('rounded-lg px-2.5 py-1 text-xs font-medium transition-colors', sidePanelTab === 'chat' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary')}
                  >Chat</button>
                  <button
                    onClick={() => setSidePanelTab('charts')}
                    className={cn('rounded-lg px-2.5 py-1 text-xs font-medium transition-colors', sidePanelTab === 'charts' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary')}
                  >Charts</button>
                </div>
                <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
                  <X size={14} />
                </button>
              </div>
              {sidePanelTab === 'chat' && (
                <>
              <SkillsBar active={chat.activeSkills} onToggle={(name) => chat.setActiveSkills((prev) => prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name])} />
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                <ChatMessages
                  variant="compact"
                  messages={chatMessages}
                  streamNote={chatSession?.streamNote}
              plan={chatSession?.lastPlan}
                  stallSince={chatSession?.stallSince}
                  bottomRef={chatEndRef}
                  onJumpToSection={onJumpToSection}
                  emptyState={
                    <p className="text-sm text-text-tertiary text-center mt-4 leading-relaxed">
                      Ask the AI to write or research content.<br />
                      It will update this document automatically.<br />
                      <span className="text-xs">e.g. "Write a clinical review on..."</span>
                    </p>
                  }
                />
                {/* #996/#1003: 实时改动卡 — 本轮（最近一轮）写回的节 + 迷你 diff
                    (SSE 聚合于 chat-reducer;turn 完成即呈现)。历史重建卡在
                    assistant 消息上(ChatChangeCard via docSections)。 */}
                {chatSession?.lastTurnChanges && !chatSession?.loading && (
                  <ChatChangeCard
                    sections={chatSession.lastTurnChanges.sections}
                    rows={chatSession.lastTurnChanges.rows}
                    onJumpToSection={onJumpToSection}
                  />
                )}
              </div>
              <div className="border-t border-border p-3">
                {chat.kbDedupNotice && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-text-secondary">{chat.kbDedupNotice}</div>
            )}
            {chat.chatAttachedFiles.length > 0 && (
                  <div className="mb-2 flex gap-1 flex-wrap">
                    {chat.chatAttachedFiles.map((f) => (
                      <span key={f.fileId} className="inline-flex items-center gap-1 rounded-full bg-surface-elevated border border-border px-2 py-0.5 text-xs text-text-secondary">
                        {f.name}
                        {/* #1032: 与主 chat 一致的"固定为引用"。 */}
                        <button
                          onClick={() => onPinAttachment(f)}
                          disabled={attachmentPinning}
                          className="rounded p-0.5 text-text-tertiary transition-colors hover:text-accent disabled:opacity-50"
                          title={t('chat.pinAsReference', '固定为引用（本会话持续生效）')}
                          aria-label={t('chat.pinAsReference', '固定为引用（本会话持续生效）')}
                        >
                          <Pin size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {/* #fix: 追加问题排队提示 — 回复完成后自动发送,不打断。
                    #1095 复审 #5: 多槽队列 — 显示条数 + ✕ 撤回最后一条
                    （评论指令槽撤回经 turnId 清账；提示不再对多条排队静默）。 */}
                {chatPending && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2 py-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                      {chatPendingCount > 1
                        ? t('writing.chatQueuedCount', '已排队 {{n}} 条 — 逐条自动发送（最后一条可撤回）', { n: chatPendingCount })
                        : t('writing.chatQueuedOne', '已排队 — 当前回复完成后自动发送')}
                    </span>
                    <button
                      onClick={() => chat.dropLastQueued(chatSessionId)}
                      className="shrink-0 text-text-tertiary transition-colors hover:text-text-primary"
                      title={t('writing.chatQueuedDropLast', '撤回最后一条排队消息')}
                      aria-label={t('writing.chatQueuedDropLast', '撤回最后一条排队消息')}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                {/* #693: 选中即引用 — 当前编辑器选中文本将随下一条消息发送。 */}
                {chatSelection && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2 py-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                      {chatSelection.length > 48 ? `${chatSelection.slice(0, 48)}…` : chatSelection}
                    </span>
                    <button
                      onClick={() => setChatSelection('')}
                      className="shrink-0 text-text-tertiary hover:text-text-primary"
                      title="Clear selection reference"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                <div className="flex gap-2">
                  <input ref={chat.chatFileRef} type="file" onChange={chat.handleChatFile} className="hidden" disabled={chat.chatUploadingFile} />
                  <Button variant="ghost" size="sm" onClick={() => chat.chatFileRef.current?.click()} disabled={chatLoading || chat.chatUploadingFile} isLoading={chat.chatUploadingFile} className="shrink-0">
                    <Paperclip size={16} />
                  </Button>
                  <Textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (!isEnterSendKey(e)) return; e.preventDefault(); void chat.handleSendChat(); }}
                    onPaste={chat.handleChatPaste}
                    placeholder="Ask a question..."
                    rows={1}
                    className="min-h-0 flex-1 resize-none py-1.5"
                    style={{ maxHeight: '120px' }}
                  />
                  {/* #fix: 回复进行中显示 Stop(停止分析,含排队消息);平时发送=排队。 */}
                  {chatLoading ? (
                    <Button size="sm" variant="secondary" onClick={() => chat.stopStream(chatSessionId)} className="shrink-0">
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => void chat.handleSendChat()} disabled={!chatInput.trim()} className="shrink-0">
                      Send
                    </Button>
                  )}
                </div>
              </div>
                </>
              )}
              {sidePanelTab === 'charts' && (
                <ChartLibrary onInsert={onInsertChart} />
              )}
              </aside>
    </>
  );
}
