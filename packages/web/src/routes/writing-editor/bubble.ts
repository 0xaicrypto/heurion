import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@tiptap/react';
import type { BubbleRunState } from '@/components/DocEditor';
import { sanitizePolishOutput } from '@/lib/polish-sanitize';
import { captureScrollContainer } from '@/lib/scroll-utils';
import { api, ApiError } from '@/lib/api';
import { markdownToHtml, htmlToMarkdown } from '@/lib/doc-convert';

// #792: 润色预设提为模块级常量 — 此前定义在组件体内,每次渲染重建数组。
export const POLISH_PRESETS: Array<{ id: string; icon: string; label: string; instruction: string }> = [
  { id: 'academic', icon: '🔬', label: '学术语气强化', instruction: '强化学术语气:使用正式、客观、精确的学术表达,避免口语化措辞。' },
  { id: 'concise', icon: '📐', label: '压缩至字数限制', instruction: '在保留全部关键信息的前提下压缩篇幅,删除冗余表述与重复论证。' },
  { id: 'terminology', icon: '🧪', label: '方法学术语统一', instruction: '统一方法学部分的术语与单位表达,确保同一概念前后用词一致。' },
  { id: 'hedging', icon: '⚖️', label: '结论弱化限定', instruction: '为结论添加适当的学术限定语(hedging),避免超出证据强度的断言。' },
  { id: 'proofread', icon: '✅', label: '语法标点检查', instruction: '只修正语法错误、标点与格式问题,不改写句子结构。' },
];

export interface PolishBubble {
  bubbleSel: { text: string; from: number; to: number } | null;
  bubbleRun: BubbleRunState | null;
  bubbleRunRef: React.MutableRefObject<BubbleRunState | null>;
  runPolish: (instruction: string, action?: string, opts?: { selection?: string; round?: number }) => Promise<void>;
  handleBubbleApply: (finalText?: string) => void;
  handleBubbleDiscard: () => void;
  handleBubbleRetry: () => void;
  handleBubbleRefine: (instruction: string, currentText: string) => void;
  handleBubbleAction: (action: string, sel: { text: string; from: number; to: number }) => void;
  /** #871: 送入聊天 — 选区上下文随行,任务超出单段润色时转聊天流。 */
  handleSendToChat: (instruction?: string) => void;
}

/**
 * #696 — Selection Bubble 润色状态机,从 writing-editor 路由下沉:
 * 选区快照(C3 漂移校验)/并发守卫(C2)/净化(C1)/多轮 refine。
 * #797(web 半): 流式 chunk 经 rAF 合帧 — 每 chunk setState 导致
 * 999 行组件逐字重渲染,现在 16ms 合批(LlmContent 节流先例)。
 */
export function usePolishBubble(input: {
  docId: string | undefined;
  editorRef: React.MutableRefObject<Editor | null>;
  /** 顶部轻提示(与 aiEditNotice 同一通道)。 */
  onNotice: (text: string, ttlMs?: number) => void;
  /** #871: 送入聊天 — 由路由层接(chatSelection/chatInput/chatOpen)。 */
  onSendToChat?: (selection: string, instruction: string) => void;
}): PolishBubble {
  const { t } = useTranslation();
  const { docId, editorRef, onNotice, onSendToChat } = input;

  const [bubbleSel, setBubbleSel] = useState<{ text: string; from: number; to: number } | null>(null);
  const [bubbleRun, setBubbleRun] = useState<BubbleRunState | null>(null);
  const bubbleRunRef = useRef<BubbleRunState | null>(null);
  bubbleRunRef.current = bubbleRun;
  // #752-ux-cancel: 运行中的 AbortController — 取消即断流。
  const polishAbortRef = useRef<AbortController | null>(null);
  // C3: 运行开始时的选区快照 — apply 前校验漂移。
  const polishRangeRef = useRef<{ from: number; to: number; original: string } | null>(null);

  // #753: Polish 执行体 — 气泡内联(润色全文按钮已移除;全文场景可全选
  // 后走气泡,或用 doc-chat)。错误写入 bubbleRun.error 展示。
  // #778: opts.selection — 多轮 refine 时发用户手上的当前版本(不再重读
  // 编辑器选区文本);opts.round — 轮次透传给结果面板展示。
  const runPolish = useCallback(async (instruction: string, action = 'rewrite', opts: { selection?: string; round?: number } = {}) => {
    const editor = editorRef.current;
    if (!docId || !editor) return;
    const sel = editor.state.selection;
    const from = sel.from; const to = sel.to;
    const selection = opts.selection ?? editor.state.doc.textBetween(from, to, '\n').trim();
    if (!selection) {
      setBubbleRun({ action, status: 'error', stream: '', reasoning: '', error: t('writing.selectFirst', '请先选中一段文字'), startedAt: Date.now() });
      return;
    }

    // C2 并发守卫:上一轮仍在跑 → 先 abort,状态归零再开新流
    if (polishAbortRef.current) {
      polishAbortRef.current.abort();
      polishAbortRef.current = null;
    }
    const controller = new AbortController();
    polishAbortRef.current = controller;
    setBubbleRun({ action, status: 'running', stream: '', reasoning: '', error: null, startedAt: Date.now(), round: opts.round ?? 1 });
    polishRangeRef.current = { from, to, original: selection };
    // #797: rAF 合帧 — chunk 先积累,每帧最多 flush 一次。
    let streamText = '';
    let reasoningText = '';
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      setBubbleRun((prev) => (prev ? { ...prev, stream: streamText, reasoning: reasoningText } : prev));
    };
    const schedule = () => {
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };
    try {
      for await (const chunk of api.polishDoc(docId, selection.slice(0, 20000), instruction || undefined, controller.signal)) {
        // #797: PolishStreamChunk 契约收窄 — 不再 as any。
        if (chunk.type === 'error') throw new Error(String(chunk.message || 'AI 服务返回错误'));
        if (chunk.type === 'reasoning') {
          reasoningText += String(chunk.text ?? '');
          schedule();
          continue;
        }
        if (typeof chunk.text === 'string' && chunk.text) streamText += chunk.text;
        schedule();
        if (chunk.done) break;
      }
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      setBubbleRun((prev) => (prev ? { ...prev, stream: streamText, reasoning: reasoningText } : prev));
      if (!streamText.trim()) {
        const msg = reasoningText
          ? t('writing.polishReasoningNoOutput', '模型思考了 {{n}} 字但未产出正文 — 请点「重试」,通常第二次会正常输出', { n: reasoningText.length })
          : t('writing.polishNoContent', 'AI 未返回内容,请重试或检查模型配置');
        setBubbleRun((prev) => (prev ? { ...prev, status: 'error', error: msg } : prev));
        return;
      }
      setBubbleRun((prev) => (prev ? { ...prev, status: 'done' } : prev));
    } catch (err) {
      // 用户主动取消 → 静默收起,不算错误
      if ((err as Error)?.name === 'AbortError') {
        setBubbleRun(null);
        return;
      }
      const msg = err instanceof ApiError ? err.messageText : String((err as Error)?.message || err);
      setBubbleRun((prev) => (prev ? { ...prev, status: 'error', error: msg } : prev));
    } finally {
      if (rafId !== null) cancelAnimationFrame(rafId);
      polishAbortRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 引用稳定
  }, [docId, editorRef]);

  /** #752-ux: 气泡内「替换选中」 — 用运行开始时记录的 from/to 应用结果,
      不重读选区(点击应用按钮时选区可能已变化)。 */
  const handleBubbleApply = useCallback((finalText?: string) => {
    const editor = editorRef.current;
    const run = bubbleRunRef.current;
    if (!editor || !run || run.status !== 'done' || !run.stream.trim()) return;
    const range = bubbleSel;
    const snap = polishRangeRef.current;
    if (!range || !snap || range.to <= range.from) {
      onNotice(t('writing.selectionStale', '选区已失效,请重新选择后再试'));
      return;
    }
    // C3 漂移校验:流式期间用户编辑过该区域 → 拒绝盲替换,防错位
    const current = editor.state.doc.textBetween(snap.from, snap.to, '\n').trim();
    if (current !== snap.original) {
      onNotice(t('writing.selectionChanged', '选区内容已变化,为避免错位替换未应用 — 请重新选中后重试'), 4000);
      return;
    }
    // C1 净化:元评论/javascript: 链接不得进入文档
    // #778: 应用的是面板内用户编辑后的最终版(未改即 AI 原文)
    const clean = sanitizePolishOutput(finalText ?? run.stream);
    if (!clean) { onNotice(t('writing.polishEmpty', 'AI 结果为空,已丢弃')); return; }
    // #752-cursor: focus()+插入会触发浏览器 scrollIntoView — 快照/恢复
    // 滚动位置,把用户留在当前修改处。#792: 复用 lib/scroll-utils。
    const scrollEl = captureScrollContainer(editor.view.dom as HTMLElement);
    const savedTop = scrollEl?.top ?? 0;
    editor.chain().focus().insertContentAt({ from: snap.from, to: snap.to }, markdownToHtml(clean)).run();
    if (scrollEl) scrollEl.el.scrollTop = savedTop;
    // #870: 补版本快照 — 与聊天 edit_document 的 'AI edit' 快照对齐
    // (撤销/审计一致)。fire-and-forget,失败不阻塞编辑。
    if (docId) {
      try {
        const md = htmlToMarkdown(editor.getHTML());
        void api.createDocSnapshot(docId, md, 'AI polish').catch(() => {});
      } catch { /* best-effort */ }
    }
    setBubbleRun(null);
    onNotice(t('writing.polishApplied', '✨ 已按 AI 结果替换选中文本'));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 引用稳定
  }, [bubbleSel, editorRef, onNotice]);

  const handleBubbleDiscard = useCallback(() => {
    // #752-ux-cancel: running 态 = 取消(abort 断流);done 态 = 丢弃结果。
    if (bubbleRunRef.current?.status === 'running') {
      polishAbortRef.current?.abort();
      polishAbortRef.current = null;
    }
    setBubbleRun(null);
  }, []);

  const handleBubbleRetry = useCallback(() => {
    const run = bubbleRunRef.current;
    const sel = bubbleSel;
    setBubbleRun(null);
    if (sel) handleBubbleAction(run?.action ?? 'rewrite', sel);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hoisted below
  }, [bubbleSel]);

  /** #778: 多轮继续修改 — selection=用户改过的当前版本,服务端零改动
   *  (polish(selection, instruction) 天然支持);轮次 +1。 */
  const handleBubbleRefine = useCallback((instruction: string, currentText: string) => {
    const round = (bubbleRunRef.current?.round ?? 1) + 1;
    void runPolish(instruction, bubbleRunRef.current?.action ?? 'polish', { selection: currentText, round });
  }, [runPolish]);

  /** #752: Selection Bubble 动作分发 — 所有动作都打开面板跑流式,用户始终
   *  看得到生成过程与取消入口(此前一键预设后台静默执行,零反馈)。
   *  #752-feedback: 到达性 console 标记 — 若用户端仍"无响应",console 有
   *  [bubble] 日志即可区分「handler 未触发」与「下游失败」。 */
  function handleBubbleAction(action: string, sel: { text: string; from: number; to: number }) {
    console.info('[bubble] action=', action, 'selLen=', sel.text.length, 'from=', sel.from, 'to=', sel.to);
    setBubbleSel(sel);
    if (action === 'polish') {
      // ✨润色 = 气泡内输入自定义指令(可留空),⌘+Enter 或「开始」执行
      setBubbleRun({ action, status: 'input', stream: '', reasoning: '', error: null, startedAt: Date.now() });
      return;
    }
    const preset = POLISH_PRESETS.find((p) => p.id === action);
    // #752-ux: 全程气泡内联 — 不再弹顶部面板
    void runPolish(preset?.instruction ?? '', action);
  }

  /** #871: 送入聊天 — 选区文本走聊天上下文通道(chatSelection),指令预填
   *  聊天输入,由用户确认发送。任务超出单段润色(多步/跨段/带引用)时用。 */
  const handleSendToChat = useCallback((instruction?: string) => {
    const snap = polishRangeRef.current;
    if (!snap || !onSendToChat) return;
    onSendToChat(
      snap.original,
      instruction?.trim() || t('writing.sendToChatDefault', '请基于我选中的这段文字继续优化'),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 引用稳定
  }, [onSendToChat]);

  return {
    bubbleSel,
    bubbleRun,
    bubbleRunRef,
    runPolish,
    handleBubbleApply,
    handleBubbleDiscard,
    handleBubbleRetry,
    handleBubbleRefine,
    handleBubbleAction,
    handleSendToChat,
  };
}
