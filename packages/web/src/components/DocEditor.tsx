import { useEffect, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Image from '@tiptap/extension-image';
import { markdownToHtml, htmlToMarkdown } from '@/lib/doc-convert';
import { Button } from '@/components/ui';
import {
  Bold, Italic, Heading2, List, ListOrdered, Table as TableIcon,
  Plus, Trash2, Undo2, Redo2,
} from 'lucide-react';

interface DocEditorProps {
  value: string;        // markdown body
  onChange: (md: string) => void;
  className?: string;
}

/**
 * Lark-style WYSIWYG canvas (TipTap). The document body stays markdown —
 * the editor converts on load (md → HTML) and on save (HTML → md).
 */
export function DocEditor({ value, onChange, className }: DocEditorProps) {
  const applyMdRef = useRef<string | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Image.configure({ allowBase64: false, inline: false }),
    ],
    content: markdownToHtml(value),
    onUpdate: ({ editor }) => {
      // Programmatic AI updates bypass the onChange round-trip.
      if (applyMdRef.current !== null) return;
      onChange(htmlToMarkdown(editor.getHTML()));
    },
  });

  // External markdown update (AI edit / doc load) → convert and apply.
  useEffect(() => {
    if (!editor) return;
    applyMdRef.current = value;
    editor.commands.setContent(markdownToHtml(value), { emitUpdate: false });
    applyMdRef.current = null;
  }, [value, editor]);

  if (!editor) return null;

  const isActive = (name: string, attrs?: Record<string, unknown>) =>
    editor.isActive(name, attrs as any);

  return (
    <div className={className}>
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
      <div className="prose prose-sm max-w-none p-4 [&_.ProseMirror]:min-h-[300px] [&_.ProseMirror]:outline-none [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_th]:border [&_th]:border-border [&_th]:bg-surface-elevated [&_th]:p-1.5 [&_th]:text-left [&_img]:my-2 [&_img]:max-h-72 [&_img]:rounded-lg [&_img]:border [&_img]:border-border">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
