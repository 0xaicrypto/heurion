import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api';
import { mapWireMessages } from '@/lib/message-map';
import type { UploadProgressState } from '@/components/UploadProgressModal';
import { useChatStore } from '@/stores/chat';
import { runUploadAttachFlow } from '@/lib/upload-flow';
import type { DeckWire } from '@/lib/types';

export interface DocChat {
  chatInput: string;
  setChatInput: React.Dispatch<React.SetStateAction<string>>;
  chatSelection: string;
  setChatSelection: React.Dispatch<React.SetStateAction<string>>;
  chatSession: ReturnType<typeof useChatStore.getState>['sessions'][string] | undefined;
  chatMessages: ReturnType<typeof useChatStore.getState>['sessions'][string]['messages'];
  chatLoading: boolean;
  chatPending: boolean;
  chatEndRef: React.RefObject<HTMLDivElement>;
  chatFileRef: React.RefObject<HTMLInputElement>;
  activeSkills: string[];
  setActiveSkills: React.Dispatch<React.SetStateAction<string[]>>;
  chatUploadingFile: boolean;
  uploadState: UploadProgressState | null;
  setUploadState: React.Dispatch<React.SetStateAction<UploadProgressState | null>>;
  kbDedupNotice: string | null;
  chatAttachedFiles: Array<{ name: string; fileId: string }>;
  stopStream: (sid: string) => void;
  sendChatText: (text: string) => Promise<void>;
  handleSendChat: () => Promise<void>;
  handleChatPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => Promise<void>;
  handleChatFile: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleDocUpload: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  docUploadRef: React.RefObject<HTMLInputElement>;
  cancelUpload: () => void;
  schedulePptxReload: () => void;
  appendMessage: ReturnType<typeof useChatStore.getState>['appendMessage'];
}

/**
 * #696 — doc-chat 面板全量逻辑（发送/排队/附件/粘贴/上传/进度/pptx 轮询）
 * 从 writing-editor 路由下沉。#653: chat store 订阅全部走 scoped selector。
 */
export function useDocChat<const TDoc extends { body: string; updated_at: string; title?: string }>(input: {
  docId: string | undefined;
  /** 编辑框当前正文（ref — 发送前比对保存）。 */
  bodyRef: React.MutableRefObject<string>;
  /** 服务端已保存正文（ref — 内容有变化才先 PUT）。 */
  lastSavedBody: React.MutableRefObject<string | null>;
  /** 本地未保存 dirty（pptx 轮询不覆盖本地编辑）。 */
  dirtyRef: React.MutableRefObject<boolean>;
  diffReview: unknown;
  /**
   * #896: 发送前预保存回调 — 由路由层提供(内部走 saveDoc 完整语义:
   * 带 base_sha 并发保护 + 成功后同步 serverBodyRef/lastSavedBody)。
   * 此前 hook 内裸 PUT 不带 base_sha,与其他窗口/审阅落地路径并发时必然
   * 假 409。失败由本 hook 吞掉,不阻断发送。
   */
  presave: () => Promise<{ body?: string | null }>;
  chatSelection: string;
  setChatSelection: React.Dispatch<React.SetStateAction<string>>;
  setBody: React.Dispatch<React.SetStateAction<string>>;
  setDoc: React.Dispatch<React.SetStateAction<TDoc | null>>;
  setError: (e: string) => void;
  onNotice: (text: string, ttlMs?: number) => void;
  loadReferences: () => Promise<void>;
  /** #773: deck 写回轮询需要 lastSavedDeck/appliedDocDeck/setDeckAsset。 */
  lastSavedDeck: React.MutableRefObject<string>;
  appliedDocDeck: React.MutableRefObject<string>;
  setDeckAsset: React.Dispatch<React.SetStateAction<DeckWire | null>>;
  setViewMode: (mode: 'document' | 'deck') => void;
  /** 外部已有的编辑器选中文本(选中即引用)。 */
  editorSelection: () => string;
}): DocChat {
  const { t } = useTranslation();
  const { docId, bodyRef, lastSavedBody, dirtyRef, diffReview } = input;

  const [chatInput, setChatInput] = useState('');
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [chatUploadingFile, setChatUploadingFile] = useState(false);
  const [uploadState, setUploadState] = useState<UploadProgressState | null>(null);
  const [kbDedupNotice, setKbDedupNotice] = useState<string | null>(null);
  const [chatAttachedFiles, setChatAttachedFiles] = useState<Array<{ name: string; fileId: string }>>([]);
  // #402-merge: the right panel hosts Doc Chat and the chart library.
  const chatSessionId = docId ? `doc-${docId}` : '';
  // #653/#462: scoped selectors — doc-chat chunks no longer re-render the
  // whole editor (was a full-store subscription).
  const chatSession = useChatStore((s) => (chatSessionId ? s.sessions[chatSessionId] : undefined));
  const sendMessageQueued = useChatStore((s) => s.sendMessageQueued);
  const stopStream = useChatStore((s) => s.stopStream);
  const appendMessage = useChatStore((s) => s.appendMessage);
  const setMessages = useChatStore((s) => s.setMessages);
  const chatMessages = chatSession?.messages ?? [];
  const chatLoading = chatSession?.loading ?? false;
  const chatPending = useChatStore((s) => (chatSessionId ? !!s.sessions[chatSessionId]?.pending : false));

  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatFileRef = useRef<HTMLInputElement>(null);
  const docUploadRef = useRef<HTMLInputElement>(null);

  // #297: doc chat history lives on the server (event log under doc-<id>);
  // reload it on mount so a refresh doesn't lose the conversation. The
  // store must NOT be a dependency (same infinite-loop trap as #272).
  useEffect(() => {
    if (!chatSessionId) return;
    const existing = useChatStore.getState().sessions[chatSessionId]?.messages?.length;
    if (existing) return;
    api.getMessages(chatSessionId, 50).then((r) => {
      // #461: single wire→UI mapper (restores download / knowledge payload).
      const msgs = mapWireMessages(r.messages);
      if (msgs.length > 0) setMessages(chatSessionId, msgs);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store excluded deliberately
  }, [chatSessionId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatSession?.messages]);

  // #553: 切换文档时重置聊天本地状态。
  const prevDocId = useRef(docId);
  useEffect(() => {
    if (prevDocId.current !== docId) {
      prevDocId.current = docId;
      setChatInput('');
      setChatAttachedFiles([]);
      setActiveSkills([]);
    }
  }, [docId]);

  // #770: 统一发送管道（先保存编辑框内容再走 doc- 工具循环）—
  // 幻灯片视图的一键指令（AI 拆页 / AI 导出 PPT）与 chat 输入框共用；
  // 不新建旁路 API，保持"AI 在工具循环里决策"单管道。
  const sendChatText = async (text: string) => {
    if (!docId || !text.trim()) return;
    // §15.4: the writing chat runs through the unified pipeline (session
    // doc-{docId}); the doc context is injected via the docs/current source.
    // #fix: 上传的 doc/pdf 必须随消息传给服务端 — 此前只传 text,附件
    // 从未到达 buildAttachmentParts,AI 读不到文件内容。
    // #693: 选中即引用 — 编辑器选中文本随消息携带,服务端注入上下文,
    // 模型 old_text 从选中逐字复制,同源保证锚点必然命中。
    let selection = '';
    if (!diffReview) selection = input.editorSelection();
    if (!selection) selection = input.chatSelection.trim();
    if (selection.length > 20000) selection = selection.slice(0, 20000);
    const attachments = chatAttachedFiles.map((a) => a.fileId);
    if (attachments.length > 0) setChatAttachedFiles([]);
    // #fix: 发送前总是把编辑框当前内容保存到服务端(内容有变化才 PUT) —
    // 上下文注入的是数据库 body,必须与用户看到的编辑框一致;否则模型
    // 基于旧内容编辑写回,会覆盖/丢失用户未保存的本地修改。
    // #896: 预保存统一走路由注入的 presave(saveDoc 语义 — 带 base_sha,
    // 成功后同步 serverBodyRef/lastSavedBody),不再裸 PUT。
    if (lastSavedBody.current !== bodyRef.current) {
      try {
        const saved = await input.presave();
        lastSavedBody.current = saved.body ?? bodyRef.current;
      } catch {
        // 保存失败仍继续发送 — 锚点不匹配时由服务端归一化兜底/报错引导。
      }
    }
    // #fix: 追加问题排队发送 — 回复进行中调用时不打断(工具写回中的
    // doc_updated 若被中断,前端与文档状态会不一致),由 store 在当前
    // turn 完成后自动发出;排队状态经 session.pending 在输入框上方提示。
    await sendMessageQueued(`doc-${docId}`, {
      text,
      sessionId: `doc-${docId}`,
      patientHash: null,
      skills: activeSkills,
      attachments,
      // #516: writing chat is always the document scene (server also infers
      // from the doc- session id).
      scene: 'document',
      selection: selection || undefined,
    });
  };

  const handleSendChat = async () => {
    if (!docId || !chatInput.trim()) return;
    const text = chatInput.trim();
    setChatInput('');
    await sendChatText(text);
  };

  const attachUploaded = async (file: File) => {
    // #922: 上传落地公共流程收敛到 lib/upload-flow(与 chat.tsx 同一实现);
    // doc 专属后续(addDocReference / pptx 轮询)留在本调用点。
    const result = await runUploadAttachFlow(
      () => uploadWithProgress(file),
      {
        addAttached: (entry) => setChatAttachedFiles((prev) => [...prev, entry]),
        setKbDedupNotice,
        appendMessage,
      },
      {
        sessionId: chatSessionId,
        // dedup 提示保持本处已有 i18n 行为(chat.tsx 为硬编码中文,见 lib/upload-flow TODO)。
        dedupNoticeText: (name) => t('writing.kbDedup', '📚 已在知识库,已加入上下文: {{name}}', { name }),
      },
    );
    if (docId) api.addDocReference(docId, { kind: 'file', content: result.name, label: result.name }).catch(() => {});
    // #777: pptx 上传即后台解析 — 轮询刷新 deck。
    if (/\.pptx$/i.test(result.name)) schedulePptxReload();
    return result;
  };

  const handleChatPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        setChatUploadingFile(true);
        try {
          await attachUploaded(file);
        } catch (err) {
          // #fix: 大文件/上传失败此前静默吞掉,用户以为传上了 — 现在明示。
          input.setError(err instanceof ApiError ? err.messageText : String(err));
        }
        finally {
          setChatUploadingFile(false);
          setUploadState(null);
        }
      }
    }
  };

  const handleChatFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setChatUploadingFile(true);
    try {
      await attachUploaded(f);
    } catch (err) {
      // #fix: 大文件/上传失败此前静默吞掉 — 现在明示。
      input.setError(err instanceof ApiError ? err.messageText : String(err));
    }
    finally {
      setChatUploadingFile(false);
      setUploadState(null);
    }
  };

  // #fix: 统一上传入口 — 驱动进度 Modal(uploading → importing)。
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadWithProgress = async (f: File) => {
    setUploadState({ fileName: f.name, percent: 0, stage: 'uploading' });
    const abort = new AbortController();
    uploadAbortRef.current = abort;
    try {
      const result = await api.uploadFile(f, undefined, (p) => {
        setUploadState((prev) => (prev ? { ...prev, percent: p } : prev));
      });
      // 上传完成 → 服务端导入阶段(提取文字/图片/公式)。
      setUploadState((prev) => (prev ? { ...prev, percent: 100, stage: 'importing' } : prev));
      return result;
    } catch (err) {
      // #714: 主动取消不视为错误。
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      setUploadState((prev) => (prev ? { ...prev, error: err instanceof ApiError ? err.messageText : t('common.uploadFailed', '上传失败') } : prev));
      throw err;
    }
  };

  /** #714: 取消上传(分片场景服务端清理 upload-abort,单次场景中止 XHR)。 */
  const cancelUpload = () => {
    uploadAbortRef.current?.abort();
    setUploadState(null);
  };

  /** #777: pptx 上传后后台解析（deck 落点）— 轮询刷新；dirty 时不覆盖本地编辑。
   * #792: timer 全部登记,卸载/切文档时清理 — 旧实现卸载后仍 setState 且
   * .catch(()=>{}) 静默吞错(#743 反模式)。 */
  const pptxReloadTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const schedulePptxReload = () => {
    if (!docId) return;
    for (const delay of [3000, 7000, 13000]) {
      const timer = setTimeout(() => {
        api.getDoc(docId).then((d) => {
          if (dirtyRef.current) return;
          if (d.body && !bodyRef.current.trim()) {
            input.setBody(d.body);
            lastSavedBody.current = d.body;
            input.setDoc((prev) => (prev ? { ...prev, body: d.body, updated_at: d.updated_at } : prev));
          }
          const deck = (d.deck && typeof d.deck === 'object' ? d.deck : null) as DeckWire | null;
          if (deck) {
            const key = JSON.stringify(deck);
            if (key !== input.lastSavedDeck.current) {
              input.lastSavedDeck.current = key;
              input.appliedDocDeck.current = key;
              input.setDeckAsset(deck);
              input.setViewMode('deck');
            }
          }
        }).catch(() => {
          input.onNotice(t('writing.pptxReloadFailed', '解析结果刷新失败,可稍后手动刷新页面'));
        });
      }, delay);
      pptxReloadTimers.current.push(timer);
    }
  };

  // #792: 卸载/切换文档时清理未触发的轮询 timer(旧实现泄漏)。
  useEffect(() => {
    return () => {
      for (const timer of pptxReloadTimers.current) clearTimeout(timer);
      pptxReloadTimers.current = [];
    };
  }, [docId]);

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !docId) return;
    try {
      // #fix: 上传按钮的附件必须同时挂到聊天消息(attachments),否则首条
      // 消息只带"参考材料里的文件名",LLM 读不到正文。
      const result = await uploadWithProgress(f);
      setChatAttachedFiles((prev) => [...prev, { name: result.name, fileId: result.file_id }]);
      // #fix: 上传即草稿 — 空文档 + 文件类参考时服务端自动导入正文,
      // 响应携带 imported_body,前端立即刷新编辑框(用户马上看到原文)。
      // #714: 已存在的同名参考不重复写入(服务端 dedup 命中时 result.dedup)。
      let refResult: Awaited<ReturnType<typeof api.addDocReference>> | null = null;
      if (!result.dedup) {
        refResult = await api.addDocReference(docId, {
          kind: f.name.endsWith('.pdf') ? 'pdf' : f.name.endsWith('.docx') || f.name.endsWith('.doc') ? 'docx' : 'file',
          content: f.name,
          label: f.name,
        });
      }
      // #777: pptx 上传即后台解析（deck/正文双落点）— 轮询刷新。
      if (/\.pptx$/i.test(f.name)) {
        schedulePptxReload();
        input.onNotice(t('writing.pptxParsing', 'PPT 后台解析中 — 稍后 deck 视图将呈现每一页'), 6000);
      }
      void input.loadReferences();
      if (refResult?.imported && !bodyRef.current.trim()) {
        const importedBody = refResult.imported_body || undefined;
        if (importedBody) {
          input.setBody(importedBody);
          input.setDoc((prev) => (prev ? { ...prev, body: importedBody, updated_at: new Date().toISOString() } : prev));
          lastSavedBody.current = importedBody;
          // #fix: 引导 — 已导入原文,可直接编辑草稿或与 AI 对话调整。
          input.onNotice(t('writing.importedBody', '已导入原文，可直接编辑草稿，或在右侧与 AI 对话调整内容'), 6000);
        }
      }
      input.setError('');
      // #714: 不再强制打开 chat 面板 + 预填英文 prompt — 导入是独立动作,
      // 用 toast 引导即可;用户想对话时自己点开。
      input.onNotice(`已上传 ${f.name} 并挂为参考材料`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      input.setError(err instanceof ApiError ? err.messageText : 'Upload failed');
    } finally {
      // #fix: 导入完成(或失败)关闭进度 Modal。
      setUploadState(null);
    }
    if (e.target) e.target.value = '';
  };

  return {
    chatInput,
    setChatInput,
    chatSelection: input.chatSelection,
    setChatSelection: input.setChatSelection,
    chatSession,
    chatMessages,
    chatLoading,
    chatPending,
    chatEndRef,
    chatFileRef,
    activeSkills,
    setActiveSkills,
    chatUploadingFile,
    uploadState,
    setUploadState,
    kbDedupNotice,
    chatAttachedFiles,
    stopStream,
    sendChatText: (text) => sendChatText(text),
    handleSendChat,
    handleChatPaste: (e) => handleChatPaste(e),
    handleChatFile: (e) => handleChatFile(e),
    handleDocUpload: (e) => handleDocUpload(e),
    docUploadRef,
    cancelUpload,
    schedulePptxReload,
    appendMessage,
  };
}
