import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import BubbleMenu from '@tiptap/extension-bubble-menu';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Image from '@tiptap/extension-image';
import Mathematics from '@tiptap/extension-mathematics';
import 'katex/dist/katex.min.css';
import { TrackChangesExtension, getTrackedChanges, getPendingChangeCount, type ChangeAuthor } from 'tiptap-track-changes';
import { markdownToHtml, htmlToMarkdown } from '@/lib/doc-convert';
import { applyTrackedDiff, cleanupEmptyBlocks } from '@/lib/doc-diff';
import { Button } from '@/components/ui';
import {
  Bold, Italic, Heading2, List, ListOrdered, Table as TableIcon,
  Plus, Trash2, Undo2, Redo2, Check, X, Eye, RotateCcw, ChevronLeft, ChevronRight,
} from 'lucide-react';

/** AI 作者身份 — 审阅模式下的变更标记作者色。 */
const AI_AUTHOR: ChangeAuthor = { id: 'ai', name: 'AI', color: '#0ea5e9' };

export interface DiffReviewState {
  /** 审阅批次 key — 变化时重新应用 diff */
  key: string;
  /** 旧内容(markdown) */
  old: string;
  /** AI 新内容(markdown) */
  next: string;
}

interface DocEditorProps {
  value: string;        // markdown body
  onChange: (md: string) => void;
  className?: string;
  /** Receives the TipTap editor instance once created (selection access etc.). */
  editorRef?: { current: Editor | null };
  /**
   * #diff-review: 提供后进入 AI 修改审阅模式 — 新旧内容以 track-changes
   * 标记展示,支持逐条/全部接受或拒绝。
   */
  diffReview?: DiffReviewState | null;
  /** 审阅结束回调。cancelled=true 表示用户放弃本次 AI 修改。 */
  onDiffResolve?: (result: { md: string; accepted: number; rejected: number; cancelled: boolean }) => void;
  /** #693: 编辑器选中文本变化回调(空字符串=无选中;审阅模式下不触发)。 */
  onSelectionChange?: (text: string) => void;
  /**
   * #752: Selection Bubble 按钮动作回调(action: polish|rewrite|academic|summarize)。
   * 提供 after DocEditor 即渲染浮出工具条;审阅模式下自动隐藏。
   */
  onBubbleAction?: (action: string, sel: { text: string; from: number; to: number }) => void;
}

/**
 * Lark-style WYSIWYG canvas (TipTap). The document body stays markdown —
 * the editor converts on load (md → HTML) and on save (HTML → md).
 * 审阅模式下:AI 编辑以绿(插入)/红(删除)标记呈现,逐条或全部接受/拒绝。
 */
export function DocEditor({ value, onChange, className, editorRef, diffReview, onDiffResolve, onSelectionChange, onBubbleAction }: DocEditorProps) {
  const applyMdRef = useRef<string | null>(null);
  const reviewKeyRef = useRef<string | null>(null);
  const [reviewStats, setReviewStats] = useState<{ pending: number; accepted: number; rejected: number }>({ pending: 0, accepted: 0, rejected: 0 });
  const [selectedChange, setSelectedChange] = useState<{ id: string; text: string } | null>(null);
  // #752: bubble 菜单挂载点 — extension 需要真实 DOM element;动作按钮由
  // BubbleActions 内部渲染,点击回调 ref 透传父组件(onBubbleAction)。
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const onActionRef = useRef(onBubbleAction);
  onActionRef.current = onBubbleAction;
  /** 当前非空选区(>10 字符),供动作点击时读取。 */
  const selRef = useRef<{ text: string; from: number; to: number } | null>(null);
  // #fix: 逐条确认导航 — 修改处列表中的当前位置(第 N/M 处),进入审阅
  // 自动聚焦第一处,接受/拒绝后自动跳下一处。
  const [changeNav, setChangeNav] = useState<{ idx: number; total: number }>({ idx: -1, total: 0 });
  const statsRef = useRef({ accepted: 0, rejected: 0 });
  // #693: useEditor 选项只在创建时生效 — 经 ref 取最新回调。
  const onSelRef = useRef(onSelectionChange);
  onSelRef.current = onSelectionChange;
  const onResolveRef = useRef(onDiffResolve);
  onResolveRef.current = onDiffResolve;

  const editor = useEditor({
    extensions: [
      StarterKit,
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Image.configure({ allowBase64: false, inline: false }),
      // #fix: 学术论文渲染 — $...$ / $$...$$ LaTeX 以 KaTeX 渲染成数学符号。
      Mathematics.configure({ katexOptions: { throwOnError: false } }),
      TrackChangesExtension.configure({ author: AI_AUTHOR, mode: 'edit' }),
    ],
    content: markdownToHtml(value),
    onUpdate: ({ editor }) => {
      // Programmatic AI updates bypass the onChange round-trip.
      if (applyMdRef.current !== null || reviewKeyRef.current !== null) return;
      onChange(htmlToMarkdown(editor.getHTML()));
    },
    onSelectionUpdate: ({ editor }) => {
      const sel = editor.state.selection;
      // #693: 非审阅模式下把选中文本上报给外部(选中即引用);审阅模式下
      // 选中的是 diff 内容,不构成引用。
      if (reviewKeyRef.current === null) {
        onSelRef.current?.(editor.state.doc.textBetween(sel.from, sel.to, '\n').trim());
        return;
      }
      if (sel.empty) { setSelectedChange(null); return; }
      const covering = getTrackedChanges(editor)
        .filter((c) => c.from <= sel.from && c.to >= sel.to)
        .sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
      setSelectedChange(covering ? { id: covering.changeId, text: covering.text.slice(0, 40) } : null);
    },
  });

  // #752: BubbleMenu extension 在 editor 创建后动态注册(useEditor 的
  // extensions 数组只在创建时生效);审阅模式通过 shouldShow 拦截(此时
  // 选区是 diff 导航语义)。150ms updateDelay 避免拖动选择闪烁。
  useEffect(() => {
    if (!editor || !bubbleRef.current || !onActionRef.current) return;
    const ext = BubbleMenu.configure({
      element: bubbleRef.current,
      updateDelay: 150,
      shouldShow: ({ state, from, to }) => {
        if (reviewKeyRef.current !== null) return false;
        const text = state.doc.textBetween(from, to, '\n').trim();
        return text.length > 10;
      },
    });
    const pluginKey = (ext as any).config?.name ?? 'bubbleMenu';
    editor.registerPlugin(ext as unknown as Parameters<typeof editor.registerPlugin>[0]);
    // 选区变化时记录范围(bubble 按钮动作需要 from/to + 文本)。
    const report = () => {
      if (reviewKeyRef.current !== null) { selRef.current = null; return; }
      const { from, to } = editor.state.selection;
      const text = editor.state.doc.textBetween(from, to, '\n').trim();
      selRef.current = text.length > 10 ? { text, from, to } : null;
    };
    editor.on('selectionUpdate', report);
    editor.on('transaction', report);
    return () => {
      editor.off('selectionUpdate', report);
      editor.off('transaction', report);
      try { editor.unregisterPlugin(pluginKey); } catch { /* plugin already gone */ }
    };
  }, [editor]);

  useEffect(() => {
    if (editorRef && editor) editorRef.current = editor;
    return () => {
      if (editorRef) editorRef.current = null;
    };
  }, [editor, editorRef]);

  // External markdown update (AI edit / doc load) → convert and apply.
  useEffect(() => {
    if (!editor) return;
    // 审阅中不响应外部 value 更新(审阅内容由 diffReview 驱动)
    if (reviewKeyRef.current !== null) return;
    applyMdRef.current = value;
    editor.commands.setContent(markdownToHtml(value), { emitUpdate: false });
    applyMdRef.current = null;
  }, [value, editor]);

  // 审阅模式:应用 AI diff 并进入只读审阅
  useEffect(() => {
    if (!editor) return;
    if (!diffReview) {
      reviewKeyRef.current = null;
      setReviewStats({ pending: 0, accepted: 0, rejected: 0 });
      statsRef.current = { accepted: 0, rejected: 0 };
      setSelectedChange(null);
      setChangeNav({ idx: -1, total: 0 });
      (editor.commands as any).setTrackChangesMode('edit');
      // 退出审阅(含"放弃修改")→ 还原为当前正文
      applyMdRef.current = value;
      editor.commands.setContent(markdownToHtml(value), { emitUpdate: false });
      applyMdRef.current = null;
      return;
    }
    if (reviewKeyRef.current === diffReview.key) return;
    reviewKeyRef.current = diffReview.key;
    statsRef.current = { accepted: 0, rejected: 0 };
    applyMdRef.current = value;
    applyTrackedDiff(editor, markdownToHtml(diffReview.old), markdownToHtml(diffReview.next), AI_AUTHOR);
    applyMdRef.current = null;
    (editor.commands as any).setTrackChangesMode('view');
    setReviewStats({ pending: getPendingChangeCount(editor), accepted: 0, rejected: 0 });
    setSelectedChange(null);
    // #fix: 进入审阅自动聚焦第一处修改(用户可逐条遍历确认/拒绝)。
    const changes = groupedChanges(editor);
    setChangeNav({ idx: changes.length > 0 ? 0 : -1, total: changes.length });
    if (changes.length > 0) {
      editor.commands.setTextSelection({ from: changes[0].from, to: changes[0].to });
      editor.commands.scrollIntoView();
      // #fix: 同步选中第一处(见 jumpTo)。
      const first = getTrackedChanges(editor).find((x) => x.changeId === changes[0].changeId);
      setSelectedChange(first ? { id: first.changeId, text: first.text.slice(0, 40) } : null);
    }
  }, [diffReview, editor, value]);

  const finishReview = (cancelled: boolean) => {
    if (!onResolveRef.current) return;
    const stats = statsRef.current;
    if (cancelled) {
      reviewKeyRef.current = null;
      onResolveRef.current({ md: '', accepted: stats.accepted, rejected: stats.rejected, cancelled: true });
      return;
    }
    applyMdRef.current = value;
    const md = htmlToMarkdown(editor!.getHTML());
    reviewKeyRef.current = null;
    applyMdRef.current = null;
    onResolveRef.current({ md, accepted: stats.accepted, rejected: stats.rejected, cancelled: false });
  };

  const resolveAll = (accept: boolean) => {
    if (!editor) return;
    const stats = statsRef.current;
    const all = getTrackedChanges(editor);
    // 全部接受/拒绝按 changeId 计数(替换=一组)
    const ids = new Set(all.map((c) => c.changeId));
    const n = ids.size;
    applyMdRef.current = value;
    if (accept) {
      (editor.commands as any).acceptAll();
      stats.accepted += n;
    } else {
      (editor.commands as any).rejectAll();
      stats.rejected += n;
    }
    cleanupEmptyBlocks(editor);
    applyMdRef.current = null;
    setReviewStats({ pending: getPendingChangeCount(editor), accepted: stats.accepted, rejected: stats.rejected });
    setSelectedChange(null);
    finishReview(false);
  };

  // #fix: 修改处按 changeId 分组 — 一次替换可能拆成多个 change
  // (delete+insert),但接受/拒绝按 changeId 整组生效;导航粒度与
  // "N 处待处理"保持一致。
  const groupedChanges = (ed: Editor) => {
    const byId = new Map<string, { from: number; to: number }>();
    for (const c of getTrackedChanges(ed).sort((a, b) => a.from - b.from)) {
      const prev = byId.get(c.changeId);
      byId.set(c.changeId, prev
        ? { from: Math.min(prev.from, c.from), to: Math.max(prev.to, c.to) }
        : { from: c.from, to: c.to });
    }
    return Array.from(byId.entries()).map(([changeId, range]) => ({ changeId, ...range }));
  };

  const resolveOne = (changeId: string, accept: boolean) => {
    if (!editor) return;
    const stats = statsRef.current;
    applyMdRef.current = value;
    if (accept) { (editor.commands as any).acceptChange(changeId); stats.accepted += 1; }
    else { (editor.commands as any).rejectChange(changeId); stats.rejected += 1; }
    cleanupEmptyBlocks(editor);
    applyMdRef.current = null;
    setSelectedChange(null);
    setReviewStats({ pending: getPendingChangeCount(editor), accepted: stats.accepted, rejected: stats.rejected });
    if (getPendingChangeCount(editor) === 0) {
      setChangeNav({ idx: -1, total: 0 });
      finishReview(false);
      return;
    }
    // #fix: 处理完当前处自动跳到下一处 — 逐条确认流程不断档。
    const changes = groupedChanges(editor);
    const nextIdx = Math.min(changeNav.idx, changes.length - 1);
    setChangeNav({ idx: nextIdx, total: changes.length });
    if (nextIdx >= 0) {
      const c = changes[nextIdx];
      editor.commands.setTextSelection({ from: c.from, to: c.to });
      editor.commands.scrollIntoView();
      // #fix: 同步选中(见 jumpTo — 覆盖判定对导航选区不成立)。
      const first = getTrackedChanges(editor).find((x) => x.changeId === c.changeId);
      setSelectedChange(first ? { id: first.changeId, text: first.text.slice(0, 40) } : null);
    }
  };

  // #fix: 逐条导航 — 上一处/下一处(移动选区到对应修改)。
  const jumpTo = (idx: number) => {
    if (!editor) return;
    const changes = groupedChanges(editor);
    if (changes.length === 0) return;
    const clamped = Math.max(0, Math.min(changes.length - 1, idx));
    const c = changes[clamped];
    setChangeNav({ idx: clamped, total: changes.length });
    editor.commands.setTextSelection({ from: c.from, to: c.to });
    editor.commands.scrollIntoView();
    // #fix: 导航即选中 — onSelectionUpdate 的覆盖判定要求单个 change
    // 完全覆盖选区,而导航选区是整组范围(超集)永远不匹配,按钮不出现。
    // 这里直接用该组的第一个 change 设置 selectedChange。
    const first = getTrackedChanges(editor).find((x) => x.changeId === c.changeId);
    setSelectedChange(first ? { id: first.changeId, text: first.text.slice(0, 40) } : null);
  };

  if (!editor) return null;

  const isActive = (name: string, attrs?: Record<string, unknown>) =>
    editor.isActive(name, attrs as any);

  const reviewing = reviewKeyRef.current !== null;

  return (
    <div className={className}>
      {reviewing && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/40">
          <span className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
            <Eye size={13} /> 审阅 AI 修改
            <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[11px] dark:bg-amber-900">
              {reviewStats.pending} 处待处理 · 已接受 {reviewStats.accepted} · 已拒绝 {reviewStats.rejected}
            </span>
          </span>
          {selectedChange && (
            <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
              选中修改:「{selectedChange.text}」
              <Button size="sm" variant="primary" onClick={() => resolveOne(selectedChange.id, true)}>
                <Check size={12} /> 接受
              </Button>
              <Button size="sm" variant="danger" onClick={() => resolveOne(selectedChange.id, false)}>
                <X size={12} /> 拒绝
              </Button>
            </span>
          )}
          {/* #fix: 逐条确认导航 — 上一处/下一处,接受/拒绝当前处后自动跳转。 */}
          <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={changeNav.total === 0 || changeNav.idx <= 0} onClick={() => jumpTo(changeNav.idx - 1)} title="上一处修改">
              <ChevronLeft size={13} />
            </Button>
            <span className="text-xs tabular-nums text-amber-700 dark:text-amber-300">
              {changeNav.total > 0 ? `第 ${changeNav.idx + 1}/${changeNav.total} 处` : '无修改'}
            </span>
            <Button size="sm" variant="ghost" disabled={changeNav.total === 0 || changeNav.idx >= changeNav.total - 1} onClick={() => jumpTo(changeNav.idx + 1)} title="下一处修改">
              <ChevronRight size={13} />
            </Button>
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="primary" disabled={reviewStats.pending === 0} onClick={() => resolveAll(true)}>
              <Check size={13} /> 全部接受
            </Button>
            <Button size="sm" variant="danger" disabled={reviewStats.pending === 0} onClick={() => resolveAll(false)}>
              <X size={13} /> 全部拒绝
            </Button>
            <Button size="sm" variant="ghost" onClick={() => finishReview(true)}>
              <RotateCcw size={13} /> 放弃修改
            </Button>
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <Button size="sm" variant="ghost" className={isActive('bold') ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
          <Bold size={14} />
        </Button>
        <Button size="sm" variant="ghost" className={isActive('italic') ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
          <Italic size={14} />
        </Button>
        <Button size="sm" variant="ghost" className={isActive('heading', { level: 2 }) ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">
          <Heading2 size={14} />
        </Button>
        <Button size="sm" variant="ghost" className={isActive('bulletList') ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleBulletList().run()} title="List">
          <List size={14} />
        </Button>
        <Button size="sm" variant="ghost" className={isActive('orderedList') ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered list">
          <ListOrdered size={14} />
        </Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button size="sm" variant="ghost" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run()} title="Insert table">
          <TableIcon size={14} />
        </Button>
        <Button size="sm" variant="ghost" disabled={!editor.can().addRowAfter()} onClick={() => editor.chain().focus().addRowAfter().run()} title="Add row">
          <Plus size={14} />
        </Button>
        <Button size="sm" variant="ghost" disabled={!editor.can().deleteRow()} onClick={() => editor.chain().focus().deleteRow().run()} title="Delete row">
          <Trash2 size={14} />
        </Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button size="sm" variant="ghost" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()} title="Undo">
          <Undo2 size={14} />
        </Button>
        <Button size="sm" variant="ghost" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()} title="Redo">
          <Redo2 size={14} />
        </Button>
      </div>
      {/* #517-followup: prose defaults are light-theme colors — without
          dark:prose-invert the editor body is unreadable on dark surface.
          Semantic overrides keep headings/links/code on theme tokens.
          #fix: 学术论文排版 — 衬线字体、宽松行距、标题层级、公式/图片居中。 */}
      <div className="prose prose-sm max-w-none p-4 dark:prose-invert [&_.ProseMirror]:min-h-[300px] [&_.ProseMirror]:outline-none [&_.ProseMirror]:font-serif [&_.ProseMirror]:text-[15px] [&_.ProseMirror]:leading-loose prose-headings:text-text-primary prose-headings:font-semibold prose-p:text-text-secondary prose-p:leading-relaxed prose-a:text-accent hover:prose-a:underline prose-strong:text-text-primary prose-code:text-text-primary prose-code:bg-surface prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[13px] prose-code:font-mono prose-ol:text-text-secondary prose-ul:text-text-secondary prose-li:my-0.5 prose-blockquote:border-l-4 prose-blockquote:border-accent prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-text-secondary prose-hr:border-border [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_th]:border [&_th]:border-border [&_th]:bg-surface-elevated [&_th]:p-1.5 [&_th]:text-left [&_img]:my-2 [&_img]:max-h-72 [&_img]:rounded-lg [&_img]:border [&_img]:border-border [&_.ProseMirror_img]:mx-auto [&_[data-type='block-math']]:my-4 [&_[data-type='block-math']]:overflow-x-auto [&_[data-type='inline-math']]:px-0.5">
        <EditorContent editor={editor} />
        {/* #752: Selection Bubble 挂载点 — extension 控制 visibility 并把该
            元素 appendChild 到编辑器视图定位到选区上方;内容常驻渲染。
            点按动作读 selRef 当前选区后交回父组件。 */}
        {onBubbleAction && (
          <div
            ref={bubbleRef}
            style={{ visibility: 'hidden', opacity: 0 }}
            className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-elevated px-1 py-0.5 shadow-lg"
          >
            {([
              ['polish', '✨', '润色'],
              ['rewrite', '📝', '改写'],
              ['academic', '🔬', '更学术'],
              ['summarize', '📄', '总结'],
            ] as const).map(([id, icon, label]) => (
              <button
                key={id}
                onMouseDown={(e) => {
                  // 防止 mousedown 抢焦点清空 selection(TipTap 文档建议)
                  e.preventDefault();
                  if (selRef.current && onActionRef.current) onActionRef.current(id, selRef.current);
                }}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary"
                title={label}
              >
                <span aria-hidden>{icon}</span>{label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
