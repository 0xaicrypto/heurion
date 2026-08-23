import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Image from '@tiptap/extension-image';
import { TrackChangesExtension, getTrackedChanges, getPendingChangeCount, type ChangeAuthor } from 'tiptap-track-changes';
import { markdownToHtml, htmlToMarkdown } from '@/lib/doc-convert';
import { applyTrackedDiff, cleanupEmptyBlocks } from '@/lib/doc-diff';
import { Button } from '@/components/ui';
import {
  Bold, Italic, Heading2, List, ListOrdered, Table as TableIcon,
  Plus, Trash2, Undo2, Redo2, Check, X, Eye, RotateCcw,
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
}

/**
 * Lark-style WYSIWYG canvas (TipTap). The document body stays markdown —
 * the editor converts on load (md → HTML) and on save (HTML → md).
 * 审阅模式下:AI 编辑以绿(插入)/红(删除)标记呈现,逐条或全部接受/拒绝。
 */
export function DocEditor({ value, onChange, className, editorRef, diffReview, onDiffResolve }: DocEditorProps) {
  const applyMdRef = useRef<string | null>(null);
  const reviewKeyRef = useRef<string | null>(null);
  const [reviewStats, setReviewStats] = useState<{ pending: number; accepted: number; rejected: number }>({ pending: 0, accepted: 0, rejected: 0 });
  const [selectedChange, setSelectedChange] = useState<{ id: string; text: string } | null>(null);
  const statsRef = useRef({ accepted: 0, rejected: 0 });
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
      TrackChangesExtension.configure({ author: AI_AUTHOR, mode: 'edit' }),
    ],
    content: markdownToHtml(value),
    onUpdate: ({ editor }) => {
      // Programmatic AI updates bypass the onChange round-trip.
      if (applyMdRef.current !== null || reviewKeyRef.current !== null) return;
      onChange(htmlToMarkdown(editor.getHTML()));
    },
    onSelectionUpdate: ({ editor }) => {
      if (reviewKeyRef.current === null) return;
      const sel = editor.state.selection;
      if (sel.empty) { setSelectedChange(null); return; }
      const covering = getTrackedChanges(editor)
        .filter((c) => c.from <= sel.from && c.to >= sel.to)
        .sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
      setSelectedChange(covering ? { id: covering.changeId, text: covering.text.slice(0, 40) } : null);
    },
  });

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
    if (getPendingChangeCount(editor) === 0) finishReview(false);
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
          Semantic overrides keep headings/links/code on theme tokens. */}
      <div className="prose prose-sm max-w-none p-4 dark:prose-invert [&_.ProseMirror]:min-h-[300px] [&_.ProseMirror]:outline-none prose-headings:text-text-primary prose-headings:font-semibold prose-p:text-text-secondary prose-p:leading-relaxed prose-a:text-accent hover:prose-a:underline prose-strong:text-text-primary prose-code:text-text-primary prose-code:bg-surface prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[13px] prose-code:font-mono prose-ol:text-text-secondary prose-ul:text-text-secondary prose-li:my-0.5 prose-blockquote:border-l-4 prose-blockquote:border-accent prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-text-secondary prose-hr:border-border [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_th]:border [&_th]:border-border [&_th]:bg-surface-elevated [&_th]:p-1.5 [&_th]:text-left [&_img]:my-2 [&_img]:max-h-72 [&_img]:rounded-lg [&_img]:border [&_img]:border-border">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
