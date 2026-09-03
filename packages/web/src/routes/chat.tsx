import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Paperclip, FileText, Plus, X, BookOpen } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { mapWireMessages } from '@/lib/message-map';
import type { LlmStatus } from '@/lib/types';
import { useAuthStore } from '@/stores/auth';
import { useChatStore, type ChatMessage } from '@/stores/chat';
import { useAutoScrollOnStream } from '@/lib/use-auto-scroll';
import { AppShell } from '@/components/layout/AppShell';
import { SkillsBar } from '@/components/SkillsBar';
import { KbPicker, type KbPickerItem } from '@/components/KbPicker';
import { ChatMessages } from '@/components/chat/ChatMessages';
import { PluginExtensionPoint } from '@/components/plugins/PluginExtensionPoint';
import { NewSessionDialog } from '@/components/NewSessionDialog';
import { ContextUsageIndicator } from '@/components/ContextUsageIndicator';
import { isEnterSendKey } from '@/lib/chat-composer';
import { cn } from '@/lib/utils';
import { Radar } from 'lucide-react';
import { SkillCapturePrompt } from '@/components/SkillCapturePrompt';
import { Button, Textarea } from '@/components/ui';

/** §10.3 (#220): group separator when a gap exceeds this many minutes. — moved to ChatMessages (#456) */


interface ChatSessionItem {
  id: string;
  title: string;
  status: 'open' | 'closed' | undefined;
  created_at: string;
  message_count?: number;
}

export function ChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAuthenticated, clearSession } = useAuthStore();
  // #653/#462: scoped selectors — a chunk arriving for another session no
  // longer re-renders this page (was a full-store subscription).
  const [sessionId, setSessionId] = useState<string>('');
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // #712: 历史加载骨架 + 失败重试。
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const session = useChatStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopStream = useChatStore((s) => s.stopStream);
  const clearChatSession = useChatStore((s) => s.clearSession);
  const setMessages = useChatStore((s) => s.setMessages);
  const setContextUsage = useChatStore((s) => s.setContextUsage);
  const appendMessage = useChatStore((s) => s.appendMessage);
  const runDeepAnalysis = useChatStore((s) => s.runDeepAnalysis);
  const regenerate = useChatStore((s) => s.regenerate);
  const patchMessage = useChatStore((s) => s.patchMessage);
  const [globalSessions, setGlobalSessions] = useState<ChatSessionItem[]>([]);
  const currentSessionTitle =
    globalSessions.find((s) => s.id === sessionId)?.title ?? '';

  const [input, setInput] = useState('');
  // Per-session drafts: switching sessions must never leak half-typed text
  // into another conversation.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  // #553: 附件按会话隔离(仿 drafts)— 切换会话不得把 A 会话附件带到 B。
  // #598: 附件持久化到 localStorage,刷新页面后按会话恢复(否则已上传
  // 附件刷新即消失)。
  const ATTACH_KEY = 'nexus-chat-attached-files';
  const [attachedFiles, setAttachedFiles] = useState<Record<string, Array<{name: string; fileId: string}>>>(() => {
    try {
      const raw = localStorage.getItem(ATTACH_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(ATTACH_KEY, JSON.stringify(attachedFiles)); } catch { /* ignore */ }
  }, [attachedFiles]);
  const currentAttachedFiles = attachedFiles[sessionId] ?? [];
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  // #420: parallel deep analysis entry.
  const [deepOpen, setDeepOpen] = useState(false);
  const [deepTopics, setDeepTopics] = useState<string[]>(['literature', 'clinical']);
  const [deepQuestion, setDeepQuestion] = useState('');
  const [deepBusy, setDeepBusy] = useState(false);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // #619: 上传命中知识库(sha256 dedup)提示。
  const [kbDedupNotice, setKbDedupNotice] = useState<string | null>(null);
  // #620: 知识库选择器 — 显式选定文章加入上下文.
  const [kbPickerOpen, setKbPickerOpen] = useState(false);
  // #721: kbPicker 搜索 debounce。
  // #712: kbPicked 按会话隔离(同 attachedFiles 模式) — A 会话选的文章
  // 不得静默带入 B 会话。#786: 保留完整 item(id+title+kind+summary),
  // KbPicker 打开时按 item 回显勾选。
  const [kbPickedBySession, setKbPickedBySession] = useState<Record<string, KbPickerItem[]>>({});
  const kbPicked = kbPickedBySession[sessionId] ?? [];
  // #516: per-session entry scene — switching sessions must not leak the
  // previous mode into a different conversation.
  const [kbChecked, setKbChecked] = useState<Record<string, boolean>>({});
  const [kbAdded, setKbAdded] = useState<Record<string, boolean>>({});
  const [downloadUrls, setDownloadUrls] = useState<Record<string, string>>({});
  const [downloadLoading, setDownloadLoading] = useState<Record<string, boolean>>({});
  const { bottomRef, containerRef, isAtBottom, scrollToBottom } = useAutoScrollOnStream(session?.messages);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadGlobalSessions = useCallback(() => {
    api.listSessions(false, 'global')
      .then((r) => {
        const sessions = r.sessions.map((s) => ({ id: s.id, title: s.title, status: s.status, created_at: s.created_at, message_count: s.message_count }));
        setGlobalSessions(sessions);
        // After a refresh / returning to the page, restore the most recent
        // open session so conversations don't appear to vanish (the
        // selector stays disabled while nothing is selected).
        setSessionId((prev) => {
          if (prev) return prev;
          const open = sessions.filter((s) => s.status !== 'closed');
          return open.length > 0 ? open[0].id : '';
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadGlobalSessions();
  }, [loadGlobalSessions]);

  const handleNewSession = () => {
    // User-initiated: let them name the session first.
    setNewSessionOpen(true);
  };

  const insertSession = (res: { id: string; title: string; created_at: string }) => {
    // Synchronously prepend the new session so the selector is immediately
    // consistent — no waiting on the async list refresh.
    setGlobalSessions((prev) => [
      { id: res.id, title: res.title, status: 'open', created_at: res.created_at, message_count: 0 },
      ...prev,
    ]);
    setSessionId(res.id);
    clearChatSession(res.id);
  };

  const handleSessionCreated = (session: { id: string; title: string; created_at: string }) => {
    insertSession(session);
  };

  const handleCloseSession = async () => {
    setConfirmCloseOpen(true);
  };

  const confirmCloseSession = async () => {
    const closingId = sessionId;
    setConfirmCloseOpen(false);
    try {
      await api.closeSession(closingId);
      // Remove the closed session from the selector and clean up local state.
      setGlobalSessions((prev) => prev.filter((s) => s.id !== closingId));
      clearChatSession(closingId);
      setDrafts((prev) => { const next = { ...prev }; delete next[closingId]; return next; });
      setAttachedFiles((prev) => {
        if (!(closingId in prev)) return prev;
        const next = { ...prev };
        delete next[closingId];
        return next;
      });
      // Pick the next open session; if none remains, show the empty state
      // (no implicit default session).
      const next = globalSessions.find((s) => s.id !== closingId && s.status === 'open');
      setSessionId(next ? next.id : '');
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login', { replace: true });
      return;
    }
    api
      .getLlmStatus()
      .then(setLlmStatus)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) clearSession();
        else setError(err instanceof ApiError ? err.messageText : t('common.loading'));
      });
  }, [isAuthenticated, navigate, clearSession, t]);

  // Load history + context budget exactly once per session id. NOTE: the
  // store must NOT be a dependency here — setContextUsage below updates the
  // store, which would re-run this effect → an infinite request/render loop
  // (observed: first message in a brand-new session never got a reply).
  useEffect(() => {
    if (!sessionId) return; // no session selected — nothing to load
    const existing = useChatStore.getState().sessions[sessionId]?.messages?.length;
    if (existing) return;
    // #712: 历史加载中显示骨架,避免"空会话闪现 → 历史突然出现"。
    setHistoryLoading(true);
    setHistoryError(null);
    api.getMessages(sessionId, 50).then((r) => {
      // #461: single wire→UI mapper (restores download / knowledge payload).
      const msgs = mapWireMessages(r.messages);
      if (msgs.length > 0) setMessages(sessionId, msgs);
    }).catch(() => setHistoryError(t('chat.historyLoadFailed', '历史加载失败，点击重试')))
      .finally(() => setHistoryLoading(false));
    // U3: show the context budget immediately for sessions with history.
    api.getContextUsage(sessionId).then((u) => {
      setContextUsage(sessionId, {
        historyTokens: u.history_tokens,
        historyBudget: u.history_budget,
        historyTurns: u.history_turns,
        omittedTurns: u.omitted_turns,
        willCompact: u.will_compact,
      });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store must not be a dependency (setContextUsage would re-trigger this effect forever).
  }, [sessionId]);

  const handleSend = async () => {
    if (!input.trim() || session?.loading || session?.compacting) return;
    // No session? Require an explicit creation — never auto-create one
    // behind the user's back.
    if (!sessionId) {
      setNewSessionOpen(true);
      return;
    }
    const text = input.trim();
    setInput('');
    setDrafts((prev) => { const next = { ...prev }; delete next[sessionId]; return next; });
    setError(null);
    await sendMessage(sessionId, {
      text,
      sessionId,
      attachments: currentAttachedFiles.map((a) => a.fileId),
      skills: activeSkills,
      pickedKbIds: kbPicked.map((k) => k.id),
    });
    // #707: 附件随本条消息消费后清空 — 避免连续消息重复附带同一文件。
    setAttachedFiles((prev) => ({ ...prev, [sessionId]: [] }));
  };

  const handleStop = () => stopStream(sessionId);

  /** #420: parallel deep analysis — topics spawn concurrently, results append.
   *  #685: the whole SSE consumption lives in the store (runDeepAnalysis) —
   *  same reducer + batching as a normal turn. */
  const handleDeepAnalysis = async () => {
    if (!sessionId || deepBusy || deepTopics.length === 0) return;
    const question = deepQuestion.trim() || (session?.messages ?? []).slice().reverse().find((m) => m.role === 'user')?.text || '';
    if (!question) { setError(t('chat.deepNeedQuestion', '请输入分析问题')); return; }
    setDeepBusy(true);
    setDeepOpen(false);
    setError(null);
    try {
      await runDeepAnalysis(sessionId, { question, topics: deepTopics, patientHash: undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeepBusy(false);
      setDeepQuestion('');
    }
  };

  /** §10.3 (#220): re-run the last user turn. */
  const handleRegenerate = async () => {
    if (session?.loading || session?.compacting) return;
    setError(null);
    await regenerate(sessionId, {
      sessionId,
      text: '',
      // #708: 附件由 store 从原 user 消息恢复 — 不传空数组。
      skills: activeSkills,
    });
  };

  /** §10.3 (#220): retry a failed turn — same text as the last user message. */
  const handleRetry = async () => {
    const msgs = session?.messages ?? [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUser || session?.loading || session?.compacting) return;
    setError(null);
    await regenerate(sessionId, {
      sessionId,
      text: lastUser.text,
      // #708: 附件由 store 从原 user 消息恢复 — 不传空数组。
      skills: activeSkills,
    });
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // ignore
    }
  };

  const handleAddToKnowledge = async (msg: ChatMessage) => {
    if (!msg.knowledgePayload) return;
    await api.createKnowledgeArticle(msg.knowledgePayload).catch(() => {});
    setKbAdded(prev => ({ ...prev, [msg.id]: true }));
  };

  const resolveDownloadUrl = async (fileId: string) => {
    if (downloadUrls[fileId]) return downloadUrls[fileId];
    setDownloadLoading(prev => ({ ...prev, [fileId]: true }));
    try {
      const info = await api.getExecutionFileDownload(fileId);
      setDownloadUrls(prev => ({ ...prev, [fileId]: info.download_url }));
      return info.download_url;
    } catch {
      return '';
    } finally {
      setDownloadLoading(prev => ({ ...prev, [fileId]: false }));
    }
  };

  const handleDownloadClick = async (msg: ChatMessage) => {
    if (!msg.download) return;
    const url = msg.download.url || await resolveDownloadUrl(msg.download.fileId);
    if (url) window.open(url, '_blank');
  };


  /** #582: 附件编辑结果落地 — 保存为文档 / 导出 PDF / 继续讨论。 */
  const handleExportChoice = async (
    m: ChatMessage,
    option: 'save_as_document' | 'export_pdf' | 'continue_discussion',
  ) => {
    if (option === 'continue_discussion') {
      patchMessage(sessionId, m.id, { exportOptions: undefined });
      return;
    }
    if (m.exportState === 'saving' || !m.text) return;
    // #725: 标题取消息首句(可读、可区分),不再固定 "AI 润色结果"。
    const firstLine = m.text.split('\n').map((s) => s.trim()).find(Boolean) || t('chat.defaultDocTitle', 'AI 润色结果');
    const title = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
    patchMessage(sessionId, m.id, { exportState: 'saving' });
    try {
      const doc = await api.createDoc(title);
      await api.updateDoc(doc.id, { title: doc.title || title, body: m.text });
      // #fix: 导出 PDF 走真实 PDF 渲染(?format=pdf),不再误下载 docx。
      if (option === 'export_pdf') {
        await api.exportDoc(doc.id, 'pdf', title);
      }
      // #725: 记录 docId — 消息内显示"打开文档"跳转链接。
      patchMessage(sessionId, m.id, { exportState: 'saved', savedDocId: doc.id });
    } catch (err) {
      patchMessage(sessionId, m.id, { exportState: undefined });
      setError(err instanceof ApiError ? err.messageText : String(err));
    }
  };

  const toggleSkill = (name: string) => {
    setActiveSkills((prev) => prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = ''; // #707: 同一文件可重复选择。
    setUploadingFile(true);
    setUploadProgress(0);
    try {
      const result = await api.uploadFile(f, undefined, (p) => setUploadProgress(p));
      setAttachedFiles((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), { name: result.name, fileId: result.file_id }] }));
      // #619: 上传命中知识库(sha256 dedup)→ 提示,不重复存储.
      if (result.dedup) {
        setKbDedupNotice(`📚 已在知识库,已加入上下文: ${result.name}`);
        setTimeout(() => setKbDedupNotice(null), 4000);
      }
      // #598: 上传即入聊天历史(服务端 user_message),刷新后仍可见.
      if (sessionId) {
        appendMessage(sessionId, { id: crypto.randomUUID(), role: 'user', text: `[📎 已上传] ${result.name}`, createdAt: Date.now() });
        api.logAttachments(sessionId, [{ name: result.name, file_id: result.file_id }]).catch(() => {});
      }
    } catch (err) {
      // #fix: 大文件/上传失败此前静默吞掉,用户以为传上了 — 现在明示。
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setUploadingFile(false);
      setUploadProgress(null);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const arr = Array.from(items);
    // Rich-text copies (Word / browser) attach a bitmap (image/png, image/emf)
    // for non-HTML targets in addition to the real text. When actual text is
    // present, those attached images are decorations — never treat them as a
    // pasted file (they would upload as phantom images and even trigger AI
    // analysis). Only pure file pastes (e.g. a .docx or a screenshot) upload.
    const hasRichText = arr.some((i) => i.type === 'text/plain' || i.type === 'text/html');
    for (const item of arr) {
      if (item.kind !== 'file') continue;
      if (hasRichText && (item.type.startsWith('image/') || item.type === 'image/emf')) {
        continue;
      }
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      setUploadingFile(true);
      setUploadProgress(0);
      try {
        const result = await api.uploadFile(file, undefined, (p) => setUploadProgress(p));
        setAttachedFiles((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), { name: result.name, fileId: result.file_id }] }));
        // #619: 上传命中知识库(sha256 dedup)→ 提示.
        if (result.dedup) {
          setKbDedupNotice(`📚 已在知识库,已加入上下文: ${result.name}`);
          setTimeout(() => setKbDedupNotice(null), 4000);
        }
        // #598: 上传即入聊天历史.
        if (sessionId) {
          appendMessage(sessionId, { id: crypto.randomUUID(), role: 'user', text: `[📎 已上传] ${result.name}`, createdAt: Date.now() });
          api.logAttachments(sessionId, [{ name: result.name, file_id: result.file_id }]).catch(() => {});
        }
      } catch (err) {
        // #fix: 大文件/上传失败此前静默吞掉 — 现在明示。
        setError(err instanceof ApiError ? err.messageText : String(err));
      }
      finally { setUploadingFile(false); setUploadProgress(null); }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // #704: IME 组词阶段按 Enter 确认候选词 — 不能触发发送。
    if (!isEnterSendKey(e)) return;
    e.preventDefault();
    handleSend();
  };

  const messages = sessionId ? (session?.messages || []) : [];

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 sm:px-6">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <h1 className="shrink-0 font-semibold text-text-primary">{t('chat.title')}</h1>
              <select
              value={sessionId}
              onChange={(e) => {
                // Save the draft of the session we are leaving, restore the
                // draft of the one we enter.
                setDrafts((prev) => ({ ...prev, [sessionId]: input }));
                setInput(drafts[e.target.value] ?? '');
                setSessionId(e.target.value);
              }}
              className="h-8 min-w-0 flex-1 max-w-[220px] rounded-lg border border-border bg-surface-elevated px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              aria-label={t('chat.selectSession', 'Session')}
              disabled={!sessionId}
            >
              {sessionId === '' && <option value="">{t('chat.noSessionSelected', '未选择会话')}</option>}
              {globalSessions.filter((s) => s.status !== 'closed').map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
            </select>
            <button
              onClick={handleNewSession}
              className="shrink-0 rounded-lg border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary hover:bg-surface"
              title={t('chat.newSession', 'New Session')}
            >
              <Plus size={13} className="mr-1 inline" />
              {t('chat.newSession', 'New Session')}
            </button>
            <button
              onClick={handleCloseSession}
              className="shrink-0 rounded-lg border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary hover:bg-error/10 hover:text-error"
              title={t('chat.closeSession', 'Close Session')}
            >
              {t('chat.closeSession', 'Close')}
            </button>
            {llmStatus && (
              <span className="hidden shrink-0 rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary sm:inline">
                {llmStatus.provider}/{llmStatus.model}
              </span>
            )}
          </div>
        </header>

        <main ref={containerRef} className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            <ChatMessages
              variant="full"
              messages={messages}
              streamNote={session?.streamNote}
              bottomRef={bottomRef}
              onCopy={handleCopy}
              copiedId={copiedId}
              onDownloadClick={handleDownloadClick}
              downloadLoading={downloadLoading}
              onAddToKnowledge={handleAddToKnowledge}
              onKbCheckedChange={(id, checked) => setKbChecked(prev => ({ ...prev, [id]: checked }))}
              kbChecked={kbChecked}
              kbAdded={kbAdded}
              onRegenerate={handleRegenerate}
              onRetry={handleRetry}
              onExportChoice={handleExportChoice}
              stallSince={session?.stallSince}
              emptyState={
                <div className="py-20 text-center text-text-tertiary">
                  {historyLoading ? (
                    <>
                      <div className="mx-auto mb-4 h-3 w-40 animate-pulse rounded bg-surface-elevated" />
                      <div className="mx-auto mb-3 h-3 w-64 animate-pulse rounded bg-surface-elevated" />
                      <div className="mx-auto mb-3 h-3 w-56 animate-pulse rounded bg-surface-elevated" />
                      <div className="mx-auto mb-3 h-3 w-72 animate-pulse rounded bg-surface-elevated" />
                      <p className="text-sm">{t('chat.loadingHistory', '正在加载历史记录…')}</p>
                    </>
                  ) : historyError ? (
                    <>
                      <p className="text-lg text-error">{historyError}</p>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="mt-4"
                        onClick={() => {
                          setHistoryLoading(true);
                          setHistoryError(null);
                          api.getMessages(sessionId, 50).then((r) => {
                            const msgs = mapWireMessages(r.messages);
                            if (msgs.length > 0) setMessages(sessionId, msgs);
                          }).catch(() => setHistoryError(t('chat.historyLoadFailed', '历史加载失败，点击重试')))
                            .finally(() => setHistoryLoading(false));
                        }}
                      >
                        {t('common.retry', '重试')}
                      </Button>
                    </>
                  ) : sessionId ? (
                    <>
                      <p className="text-lg">{t('chat.startConversation')}</p>
                      <p className="text-sm">{t('chat.contextHint')}</p>
                      <div className="mt-5 flex flex-wrap justify-center gap-2 text-xs">
                        {[
                          t('chat.exampleChart', '画一张对比柱状图'),
                          t('chat.examplePathway', '画一下 EGFR 信号通路图'),
                          t('chat.exampleMechanism', '示意 TKI 耐药机制'),
                          t('chat.exampleStats', '对这两组数据做 t 检验'),
                        ].map((ex) => (
                          <button
                            key={ex}
                            onClick={() => setInput(ex)}
                            className="rounded-full border border-border bg-surface-elevated px-3 py-1.5 text-text-secondary transition-colors hover:border-accent/50 hover:text-accent"
                          >
                            {ex}
                          </button>
                        ))}
                        <span className="py-1.5 text-text-tertiary">{t('chat.chartHint', '· 安装 heurion/chart 与 heurion/bioscene 插件后可用')}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-lg">{t('chat.noSession', '还没有会话')}</p>
                      <p className="text-sm mb-5">{t('chat.noSessionHint', '创建一个新会话开始对话。')}</p>
                      <Button onClick={handleNewSession} variant="secondary">
                        <Plus size={14} className="mr-1.5" />
                        {t('chat.newSession', 'New Session')}
                      </Button>
                    </>
                  )}
                </div>
              }
            />
          </div>
          {!isAtBottom && (
            <button
              onClick={scrollToBottom}
              className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text-secondary shadow-lg transition-colors hover:bg-surface hover:text-text-primary"
            >
              {t('chat.scrollToBottom', '回到底部')}
            </button>
          )}
        </main>

        {error && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <div className="flex items-start justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
              <span>{error}</span>
              <button
                onClick={() => setError(null)}
                className="rounded p-0.5 text-error/70 transition-colors hover:bg-error/10 hover:text-error"
                aria-label={t('common.dismiss', '关闭')}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        <footer className="border-t border-border bg-surface px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {/* #298: offer to capture a reusable procedure as a skill */}
            {session?.skillCapture && messages.length > 1 && (
              <SkillCapturePrompt
                conversation={messages.slice(-4).map((m) => `${m.role === 'user' ? t('chat.doctor', '医生') : 'AI'}: ${m.text}`).join('\n')}
                sessionId={sessionId}
                onDone={() => {
                  useChatStore.setState((st) => {
                    const s = st.sessions[sessionId];
                    if (!s) return st;
                    return { sessions: { ...st.sessions, [sessionId]: { ...s, skillCapture: undefined } } };
                  });
                }}
              />
            )}
            {(session?.compacting || session?.contextUsage) && (
              <div className="flex items-center justify-between gap-2">
                {session?.compacting && (
                  <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-text-secondary">
                    <span className="animate-pulse">🧠</span>
                    {t('chat.compacting', '正在压缩会话历史，请稍候…')}
                  </div>
                )}
                <div className="ml-auto">
                  <ContextUsageIndicator usage={session?.contextUsage} />
                </div>
              </div>
            )}
            <SkillsBar active={activeSkills} onToggle={toggleSkill} />
            {kbDedupNotice && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-text-secondary">{kbDedupNotice}</div>
            )}
            {currentAttachedFiles.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {currentAttachedFiles.map((f) => (
                  <span key={f.fileId} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-elevated px-2 py-1 text-xs text-text-secondary">
                    <FileText size={12} className="shrink-0" />
                    <span className="max-w-[180px] truncate">{f.name}</span>
                    <button
                      onClick={() => setAttachedFiles((prev) => ({ ...prev, [sessionId]: (prev[sessionId] ?? []).filter((a) => a.fileId !== f.fileId) }))}
                      className="rounded p-0.5 text-text-tertiary transition-colors hover:bg-surface hover:text-error"
                      aria-label={t('chat.removeAttachment', 'Remove attachment')}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {uploadingFile && uploadProgress !== null && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <span className="shrink-0">{t('chat.uploading', '上传中…')}</span>
                <div className="h-1.5 w-32 overflow-hidden rounded-full bg-surface">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${uploadProgress}%` }} />
                </div>
                <span className="shrink-0">{uploadProgress}%</span>
              </div>
            )}
            {deepOpen && (
              <div className="rounded-xl border border-border bg-surface-elevated p-4 shadow-lg">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-text-secondary">{t('chat.deepAnalysis', '深度分析')}</span>
                  <button onClick={() => setDeepOpen(false)} className="text-text-tertiary hover:text-text-primary"><X size={14} /></button>
                </div>
                <textarea
                  value={deepQuestion}
                  onChange={(e) => setDeepQuestion(e.target.value)}
                  rows={2}
                  placeholder={t('chat.deepQuestion', '分析问题（默认用最近一次提问）')}
                  className="mb-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {(['literature', 'stats', 'clinical'] as const).map((topic) => (
                    <button
                      key={topic}
                      onClick={() => setDeepTopics((prev) => (prev.includes(topic) ? prev.filter((t2) => t2 !== topic) : [...prev, topic]))}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                        deepTopics.includes(topic) ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-text-secondary',
                      )}
                    >
                      {t(`chat.deepTopic_${topic}`, topic)}
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setDeepOpen(false)}>{t('common.cancel', '取消')}</Button>
                  <Button size="sm" onClick={handleDeepAnalysis} isLoading={deepBusy} disabled={deepTopics.length === 0}>
                    {t('chat.deepRun', '并行分析')}
                  </Button>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFile}
                className="hidden"
                disabled={uploadingFile}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setDeepOpen(true); setDeepQuestion(''); }}
                disabled={session?.loading || uploadingFile || !sessionId}
                className="shrink-0"
                title={t('chat.deepAnalysis', '深度分析（并行子任务）')}
              >
                <Radar size={14} className="mr-1" /> {t('chat.deepAnalysisShort', '深度分析')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                // #707: 无会话上传会静默丢失(附件按 sessionId 存空键) — 禁用。
                disabled={session?.loading || uploadingFile || !sessionId}
                isLoading={uploadingFile}
                className="shrink-0"
              >
                <Paperclip size={16} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setKbPickerOpen(true)}
                disabled={session?.loading || !sessionId}
                className="shrink-0"
                title={t('chat.kbPicker', '从知识库添加')}
              >
                <BookOpen size={16} />
              </Button>
               <Textarea
                 value={input}
                 onChange={(e) => {
                   setInput(e.target.value);
                   // #721: 输入框随内容自动增高(最多 160px 后内部滚动)。
                   e.target.style.height = 'auto';
                   e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                 }}
                 onKeyDown={handleKeyDown}
                 onPaste={handlePaste}
                 maxLength={32000}
                 placeholder={!sessionId
                   ? t('chat.needSession', '请先新建一个会话')
                   : (currentSessionTitle ? `${t('chat.placeholder')} — ${currentSessionTitle}` : t('chat.placeholder'))}
                 disabled={session?.loading || !sessionId || false}
                 rows={1}
                 className="min-h-0 flex-1 resize-none overflow-y-auto py-3"
                 style={{ maxHeight: '160px' }}
               />
              <PluginExtensionPoint
                point="chat_toolbar"
                context={{ sessionId }}
                layout="row"
                fallback={null}
              />
              {session?.loading ? (
                <Button onClick={handleStop} variant="secondary">
                  {t('common.stop')}
                </Button>
              ) : !sessionId ? (
                <Button onClick={handleNewSession}>
                  <Plus size={14} className="mr-1" />
                  {t('chat.newSession', 'New Session')}
                </Button>
              ) : (
                <Button onClick={handleSend} disabled={!input.trim() || !!session?.compacting || uploadingFile}>
                  {session?.compacting ? t('chat.compactingShort', '压缩中…') : t('common.send')}
                </Button>
              )}
            </div>
          </div>
        </footer>
      </div>
      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        onCreated={handleSessionCreated}
      />
      {confirmCloseOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-lg">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-text-primary">{t('chat.confirmCloseTitle', '关闭会话')}</h2>
            </div>
            <p className="mb-4 text-sm text-text-secondary">
              {t('chat.confirmCloseBody', '关闭「{{title}}」后，该会话的聊天记录将被清除且无法恢复。确定关闭吗？', { title: currentSessionTitle || '?' })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmCloseOpen(false)}>
                {t('common.cancel', '取消')}
              </Button>
              <Button variant="danger" onClick={confirmCloseSession}>
                {t('chat.closeSession', 'Close')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {/* #620: 知识库选择器弹窗 */}
      {/* #757: 共享 KbPicker — 搜索/防抖/上限统一维护 */}
      <KbPicker
        open={kbPickerOpen}
        onClose={() => setKbPickerOpen(false)}
        onConfirm={(items) => {
          // #712: 按会话隔离存储。
          setKbPickedBySession((prevBySession) => ({ ...prevBySession, [sessionId]: items }));
        }}
        initialItems={kbPicked}
        max={3}
      />
    </AppShell>
  );
}


