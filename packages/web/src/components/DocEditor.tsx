import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRafCallback } from '@/hooks/useRaf';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
// #1037: Link 显式登记(StarterKit 内置关闭,见 extensions 列表注释);
// TaskList/TaskItem 为 StarterKit 未含的任务列表扩展(@tiptap/extension-list)。
import { Link } from '@tiptap/extension-link';
import { TaskList, TaskItem } from '@tiptap/extension-list';
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
import { captureScrollContainer } from '@/lib/scroll-utils';
import { SelectionBubble, editorUiStateSignature } from './selection-bubble';
import { ProposalCard, type ProposalSource } from './ProposalCard';
import { SectionCardsExtension, setSectionCards, type SectionCardsData } from '@/lib/section-cards';
// #1040: 评论锚点高亮(decoration-only,不动 schema)。
import { CommentAnchorExtension, setCommentAnchors, type CommentAnchorsData } from '@/lib/comment-anchor';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import {
  Bold, Check, ChevronDown, Code, Image as ImageIcon, Italic, Link as LinkIcon, List, ListOrdered, ListTodo,
  Table as TableIcon, TextQuote, Plus, Trash2, Undo2, Redo2,
} from 'lucide-react';
import { api } from '@/lib/api';

/** AI 作者身份 — 审阅模式下的变更标记作者色。 */
const AI_AUTHOR: ChangeAuthor = { id: 'ai', name: 'AI', color: '#0ea5e9' };

/** #1040: 评论锚点空数据 — 模块级常量,避免内联对象身份抖动。 */
const EMPTY_COMMENTS: CommentAnchorsData = { items: [] };

/**
 * #1070: 选区是否落在同一段落（同一文本块）内 — 评论锚点创建入口的前置校验。
 * 跨块（跨两个段落/标题等）选区创建的评论,锚点算法设计上拒绝跨块 decoration
 * （comment-anchor.ts 按块扫描）— 正文高亮永不出现且无提示,形成
 * "侧边栏有、正文无痕"的无痕第三态;创建入口先拦,不产生这种评论。
 * 与 selection-bubble → writing-editor.tsx onStartComment 拦截处共用同一判定
 * （导出供测试接线复用,杜绝 harness 复制实现漂移）。位置非法时保守视为跨块。
 */
// eslint-disable-next-line react-refresh/only-export-components -- #1070: 判定与编辑器同域,与组件同文件避免跨文件扩散(改动范围受限,同 editorUiStateSignature 先例)
export function selectionWithinSingleBlock(ed: Editor, from: number, to: number): boolean {
  try {
    return ed.state.doc.resolve(from).sameParent(ed.state.doc.resolve(to));
  } catch {
    return false;
  }
}

/**
 * #996-followup: 标题级别选择器 — 正文 / H1 / H2 / H3（系统"节"口径
 * H1-H3：节卡片、作者/可信度元数据、节级 AI 编辑、聊天节跳转都认这三层；
 * H4+ 编辑器可输入但不建节）。替代原单一 H2 按钮。
 */
function HeadingMenu({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = ([1, 2, 3] as const).find((level) => editor.isActive('heading', { level }));
  const options: Array<{ key: string; label: string; active: boolean; run: () => void }> = [
    {
      key: 'paragraph',
      label: t('writing.paragraphStyle', '正文'),
      active: !current,
      run: () => { editor.chain().focus().setParagraph().run(); },
    },
    ...([1, 2, 3] as const).map((level) => ({
      key: `h${level}`,
      label: `H${level}`,
      active: current === level,
      // review 复核(写回批#7): menuitemradio 语义下点击已选中项应是确认
      // 而非取消 — 此前统一走 toggleHeading,用户点当前 H2 想确认样式却把
      // 标题降成正文。已生效 → no-op;切换只从其他级别经 setHeading 进入。
      run: () => {
        if (current === level) return;
        editor.chain().focus().setHeading({ level }).run();
      },
    })),
  ];

  return (
    <div ref={rootRef} className="relative">
      <Button
        size="sm"
        variant="ghost"
        className={cn('min-w-[36px] px-1.5', current && 'bg-surface')}
        aria-label={t('writing.textStyle', '文本样式')}
        aria-expanded={open}
        title={t('writing.textStyle', '文本样式')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-xs font-semibold">{current ? `H${current}` : '¶'}</span>
        <ChevronDown size={10} className="ml-0.5 opacity-60" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 w-28 rounded-lg border border-border bg-surface-elevated p-1 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="menuitemradio"
              aria-checked={opt.active}
              onClick={() => { opt.run(); setOpen(false); }}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                opt.active ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-surface',
              )}
            >
              <span className={opt.key === 'paragraph' ? '' : 'font-serif font-semibold'}>{opt.label}</span>
              {opt.active && <Check size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** #1037: 代码块常用语言 — 语言选择下拉的固定清单(空值 = 无语言标注)。 */
const CODE_LANGUAGES = ['typescript', 'javascript', 'python', 'rust', 'go', 'java', 'c', 'cpp', 'sql', 'json', 'bash'];

/**
 * #1037: CodeBlock 工具栏入口 — 点击 toggle 代码块;光标在代码块内时
 * 出现语言选择下拉(updateAttributes 写 language,round-trip 保留 ```lang)。
 */
function CodeBlockMenu({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const active = editor.isActive('codeBlock');
  const language = (editor.getAttributes('codeBlock').language as string | undefined) ?? '';
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className={active ? 'bg-surface' : ''}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        title="Code block"
      >
        <Code size={14} />
      </Button>
      {active && (
        <select
          title="Code language"
          value={language}
          onChange={(e) => editor.chain().focus().updateAttributes('codeBlock', { language: e.target.value || null }).run()}
          className="h-8 rounded-lg border border-border bg-surface-elevated px-1 text-xs text-text-primary"
        >
          <option value="">{t('writing.codeLanguagePlain', '纯文本')}</option>
          {CODE_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>{lang}</option>
          ))}
        </select>
      )}
    </>
  );
}

/** #1037: 工具栏 Link 入口 — 弹层 URL 输入;确认落 setLink(空值清除),
 * Esc/失焦关闭不落变更;光标在链接内时按钮高亮。与 HeadingMenu 同模式。 */
function LinkMenuButton({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const apply = () => {
    const href = url.trim();
    if (href) editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    else editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        size="sm"
        variant="ghost"
        className={editor.isActive('link') ? 'bg-surface' : ''}
        aria-label={t('writing.toolbarLink', '链接')}
        aria-expanded={open}
        title="Link"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (open) { setOpen(false); return; }
          setUrl((editor.getAttributes('link').href as string | undefined) ?? '');
          setOpen(true);
        }}
      >
        <LinkIcon size={14} />
      </Button>
      {open && (
        <div
          className="absolute left-0 top-full z-30 mt-1 flex items-center gap-1 rounded-lg border border-border bg-surface-elevated p-1 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); apply(); }
            }}
            placeholder="https://example.com"
            aria-label={t('writing.toolbarLinkInput', '链接地址')}
            className="h-7 w-48 rounded-md border border-border bg-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button size="sm" onClick={apply} title={t('writing.toolbarLinkConfirm', '确认链接')}>
            {t('writing.toolbarLinkConfirm', '确认链接')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** #1038: Image 节点扩展 — 上传占位态属性(loading/uploadId),仅在上传流程
 *  内部使用:parseHTML 不回读,占位态不持久化,markdown round-trip 不受影响。 */
const UploadableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      uploadId: {
        default: null,
        parseHTML: () => null,
        renderHTML: (attrs: Record<string, unknown>) =>
          (attrs.uploadId ? { 'data-upload-id': String(attrs.uploadId) } : {}),
      },
      loading: {
        default: null,
        parseHTML: () => null,
        renderHTML: (attrs: Record<string, unknown>) =>
          (attrs.loading ? { 'data-loading': 'true' } : {}),
      },
    };
  },
});

/** #1038: 按 uploadId 定位占位图片节点 — 成功写回真实 src,失败整节点移除
 *  (不留坏图片节点)。占位已被用户删掉时返回 false,不误伤其他内容。 */
function finalizeImageNode(ed: Editor, uploadId: string, attrs: Record<string, unknown> | null): boolean {
  let targetPos = -1;
  let nodeSize = 0;
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.uploadId === uploadId) {
      targetPos = pos;
      nodeSize = node.nodeSize;
      return false;
    }
    return true;
  });
  if (targetPos < 0) return false;
  const tr = ed.state.tr;
  if (attrs) tr.setNodeMarkup(targetPos, undefined, attrs);
  else tr.delete(targetPos, targetPos + nodeSize);
  ed.view.dispatch(tr);
  return true;
}

/** #1038: 工具栏「插入图片」入口 — 触发隐藏 file input;选择文件后与
 *  拖拽/粘贴走同一条上传链路(runImageUpload)。 */
function ImageMenuButton({ onPick }: { onPick: (files: FileList) => void }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t('writing.toolbarImage', '插入图片')}
        title={t('writing.toolbarImage', '插入图片')}
        onClick={() => inputRef.current?.click()}
      >
        <ImageIcon size={14} />
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          if (e.target.files?.length) onPick(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

export interface DiffReviewState {
  /** 审阅批次 key — 变化时重新应用 diff */
  key: string;
  /** 旧内容(markdown) */
  old: string;
  /** AI 新内容(markdown) */
  next: string;
  /** #996/#998: 提议来源 — ProposalCard 表头变体(缺省按 ai_edit 呈现)。 */
  source?: ProposalSource;
  /** #996/#998: 副标题(节名/来源说明,如 "2. Methods")。 */
  subject?: string;
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
  /**
   * #752-ux/#792: 气泡运行态与回调单对象 — 此前 5 个散装 props
   * (bubbleRun/onBubbleStart/onBubbleApply/onBubbleDiscard/onBubbleRetry)。
   */
  bubble?: {
    run: BubbleRunState | null;
    onStart: (instruction: string) => void;
    onApply: (finalText: string) => void;
    onDiscard: () => void;
    onRetry: () => void;
    onRefine: (instruction: string, currentText: string) => void;
    /** #871: 送入聊天 — 选区+指令转聊天流。 */
    onSendToChat?: (instruction?: string) => void;
  };
  /** #764: 审阅模式标题(restore 场景显示「审阅版本恢复」)。 */
  reviewTitle?: string;
  /** #837-ux: 累计修改队列的剩余轮数(banner 内展示"还有 N 轮排队")。 */
  queuedRounds?: number;
  /**
   * #996/#1002: 节卡片化数据流 — 投影对位/节级徽标/AI 编辑高亮/流式迷你 diff。
   * 折叠态由 DocEditor 内部持有（与审阅互斥：审阅期间清空装饰）。
   */
  sectionCards?: SectionCardsData;
  /**
   * #1040: 评论锚点数据流 — open/resolved 评论的高亮 decoration 与点击联动
   * (点击高亮 → onAnchorClick 通知侧边栏定位线程)。缺省不渲染任何装饰。
   */
  comments?: CommentAnchorsData;
  /**
   * #1040: 气泡「添加评论」入口 — 提供后气泡出现该按钮;点击回调选区
   * (text/from/to),弹窗与创建 API 由父组件处理。
   */
  onStartComment?: (sel: { text: string; from: number; to: number }) => void;
}

/** #792: BubbleRunState 移至 selection-bubble.tsx,这里 re-export 兼容旧 import。 */
import type { BubbleRunState } from './selection-bubble';
export type { BubbleRunState } from './selection-bubble';

/**
 * Lark-style WYSIWYG canvas (TipTap). The document body stays markdown —
 * the editor converts on load (md → HTML) and on save (HTML → md).
 * 审阅模式下:AI 编辑以绿(插入)/红(删除)标记呈现,逐条或全部接受/拒绝。
 */
export function DocEditor({ value, onChange, className, editorRef, diffReview, onDiffResolve, onSelectionChange, onBubbleAction, bubble, reviewTitle, queuedRounds, sectionCards, comments, onStartComment }: DocEditorProps) {
  const { t } = useTranslation();
  const applyMdRef = useRef<string | null>(null);
  const reviewKeyRef = useRef<string | null>(null);
  const [reviewStats, setReviewStats] = useState<{ pending: number; accepted: number; rejected: number }>({ pending: 0, accepted: 0, rejected: 0 });
  const [selectedChange, setSelectedChange] = useState<{ id: string; text: string } | null>(null);
  // #996/#1002: 节折叠态（DocEditor 内部持有；与审阅互斥 — 审阅期间清空装饰）。
  const [collapsedKeys, setCollapsedKeys] = useState<string[]>([]);
  // #996/#1001: 移动端默认折叠 — 每篇文档一次性初始化：收起全部节、保留
  // 正在编辑节（AI 编辑中）或最近改动节（section_meta.updatedAt）或第一节。
  const mobileDefaultDoneRef = useRef(false);
  const sectionCardsData = useMemo<SectionCardsData>(() => ({
    ...(sectionCards ?? {}),
    collapsedKeys,
    onToggleCollapse: (key: string) =>
      setCollapsedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])),
  }), [sectionCards, collapsedKeys]);
  // 折叠态随文档切换/重挂载清零（value 全量替换即新文档形态）。
  useEffect(() => {
    setCollapsedKeys([]);
    mobileDefaultDoneRef.current = false;
  }, [value]);
  /** #752: bubble 动作点击时读取当前选区后分发给父组件。 */
  const onActionRef = useRef(onBubbleAction);
  onActionRef.current = onBubbleAction;
  // #fix: 逐条确认导航 — 修改处列表中的当前位置(第 N/M 处),进入审阅
  // 自动聚焦第一处,接受/拒绝后自动跳下一处。
  const [changeNav, setChangeNav] = useState<{ idx: number; total: number }>({ idx: -1, total: 0 });
  const statsRef = useRef({ accepted: 0, rejected: 0 });
  // #693: useEditor 选项只在创建时生效 — 经 ref 取最新回调。
  const onResolveRef = useRef(onDiffResolve);
  onResolveRef.current = onDiffResolve;

  // #927: 选区上报 rAF 合帧(#797 气泡流同模式)— 拖动选区时
  // onSelectionUpdate 高频触发,每次 setState 上游(writing-editor)整页
  // 重渲染;#949 抽为共享 hook（ref 最新回调 + 每帧一次上报,卸载取消挂起帧）。
  const reportSelection = useRafCallback(onSelectionChange);

  // #1038: 图片上传插入 — editorProps(handleDrop/handlePaste)在 useEditor
  // 创建时固定,上传逻辑经 ref 转发取最新闭包;editor 实例就绪后写入 ref。
  const liveEditorRef = useRef<Editor | null>(null);
  const [imageError, setImageError] = useState<{ file: File; pos: number | null; message: string } | null>(null);
  // #1066-2: 上传成功但占位节点已不存在(外部内容替换等) — 结果无处落时
  // 给出提示,不再静默丢弃。文案为中文常量:#1066 批次禁改 locales(其他
  // 批次在途),待 locale 解冻后补 t('writing.imageUploadResultDropped') 词条。
  const [imageNotice, setImageNotice] = useState<string | null>(null);

  const runImageUpload = useCallback(async (file: File, pos: number | null) => {
    const ed = liveEditorRef.current;
    if (!ed) return;
    const uploadId = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // 插入 loading 占位节点 — 与 editor.commands.setImage 同构(insertContent
    // image 节点,见 @tiptap/extension-image 的 setImage 实现),额外携带
    // loading/uploadId 占位态。
    const at = Math.min(pos ?? ed.state.selection.from, ed.state.doc.content.size);
    ed.chain().focus().insertContentAt(at, { type: 'image', attrs: { src: '', alt: file.name, uploadId, loading: true } }).run();
    try {
      // 复用既有上传端点(api.uploadFile,不新建),成功后经 download-url
      // 换取带 token 的 canonical 图片 URL — 与 AI 出图(render_scene)同形态。
      const up = await api.uploadFile(file);
      const { url } = await api.getDownloadUrl(up.file_id);
      // #1066-2: 占位已被外部内容替换(applyExternalContent 重建文档)时
      // finalizeImageNode 返回 false — 上传成功但图片无处落,提示而非静默。
      const placed = finalizeImageNode(ed, uploadId, { src: url, alt: file.name, uploadId: null, loading: null });
      if (!placed) setImageNotice(t('writing.imageUploadResultDropped', '图片已上传成功，但原插入位置已被替换，未能插入文档'));
    } catch (err) {
      // 失败:移除占位(不留坏图片节点),给出可重试错误提示(非静默失败)。
      finalizeImageNode(ed, uploadId, null);
      setImageError({ file, pos, message: err instanceof Error ? err.message : String(err) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 稳定引用回调(经 ref 转发),t 变化不重挂上传链
  }, []);

  const insertImageFilesRef = useRef<(files: File[], pos: number | null) => void>(() => {});
  insertImageFilesRef.current = (files, pos) => {
    // #1069: 多图循环复用同一固定 pos → 每次都插在同一位置,后插占位顶在
    // 先插占位前面(落地顺序与操作顺序相反)。改为维护插入游标:首个文件用
    // 给定 pos/当前光标,后续文件插到上一占位之后 — 占位恰 1 节点,
    // insertContentAt 默认 updateSelection 会把光标落到刚插入内容之后,
    // 依次读 selection.from 即得下一个插入点(段落分裂/块边界两种几何
    // 通用,见 doc-editor-image.test.tsx #1069 用例)。异步 finalize 按
    // uploadId 原位定位替换,不依赖 pos — 与占位插入顺序解耦。
    let cursor: number | null = pos;
    for (const f of files) {
      void runImageUpload(f, cursor);
      const ed = liveEditorRef.current;
      cursor = ed ? ed.state.selection.from : null;
    }
  };

  const retryImageUpload = () => {
    if (!imageError) return;
    const { file } = imageError;
    setImageError(null);
    // #1066-1: 重试不携带过期 pos — 失败到重试之间内容可能已位移,旧 pos
    // 会把占位节点插到错误位置;传 null 由 runImageUpload 按当前光标位置
    // (selection.from)重算。
    void runImageUpload(file, null);
  };

  const editor = useEditor({
    extensions: [
      // #1037: StarterKit 自带 Link 扩展(v3 起)——关闭内置版,统一走下方
      // 显式配置:编辑器内点击链接不跳走(openOnClick:false),避免写作中丢焦点。
      StarterKit.configure({ link: false }),
      // #1037: Link mark — 粘贴/输入的链接不再丢 mark;autolink 保持开输入即转链接。
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow' },
      }),
      // #1037: GFM 任务列表(- [ ] / - [x]),markdown round-trip 由 doc-convert 双向支撑。
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      // #1038: 图片手动插入 — 上传占位态需要自定义 attrs(loading/uploadId)。
      UploadableImage.configure({ allowBase64: false, inline: false }),
      // #fix: 学术论文渲染 — $...$ / $$...$$ LaTeX 以 KaTeX 渲染成数学符号。
      Mathematics.configure({ katexOptions: { throwOnError: false } }),
      TrackChangesExtension.configure({ author: AI_AUTHOR, mode: 'edit' }),
      // #996/#1002: 节卡片化 chrome（decoration 驱动，不改文档结构）。
      SectionCardsExtension,
      // #1040: 评论锚点高亮（decoration-only，不动 schema/正文）。
      CommentAnchorExtension,
    ],
    content: markdownToHtml(value),
    editorProps: {
      // #1038: 拖拽/粘贴图片文件走统一上传链路(与工具栏按钮同一条);
      // 非图片文件或编辑器内部拖动(moved)交给默认行为。
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        let pos: number | null = null;
        try {
          pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
        } catch {
          pos = null;
        }
        insertImageFilesRef.current(files, pos);
        return true;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        insertImageFilesRef.current(files, null);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      // Programmatic AI updates bypass the onChange round-trip.
      if (applyMdRef.current !== null || reviewKeyRef.current !== null) return;
      onChange(htmlToMarkdown(editor.getHTML()));
    },
    onSelectionUpdate: ({ editor }) => {
      const sel = editor.state.selection;
      // #693: 非审阅模式下把选中文本上报给外部(选中即引用);审阅模式下
      // 选中的是 diff 内容,不构成引用。#927: 上报走 rAF 合帧。
      if (reviewKeyRef.current === null) {
        reportSelection(editor.state.doc.textBetween(sel.from, sel.to, '\n').trim());
        return;
      }
      if (sel.empty) { setSelectedChange(null); return; }
      const covering = getTrackedChanges(editor)
        .filter((c) => c.from <= sel.from && c.to >= sel.to)
        .sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
      setSelectedChange(covering ? { id: covering.changeId, text: covering.text.slice(0, 40) } : null);
    },
  });

  // #1037: 工具栏 active 态实时刷新 — 按钮高亮读编辑器状态,而组件重渲染
  // 仅由 value 变更驱动(纯 mark 切换/光标移动不改 markdown 时高亮会滞后),
  // 订阅事务强制同步。
  // #1066-5: 按「渲染相关状态签名」变化才 bump(selection-bubble 的
  // editorUiStateSignature,覆盖工具栏/气泡读取的全部 active/disabled 态) —
  // 此前每事务无条件 bump,流式写入期间全组件重渲染开销放大。
  const [, bumpToolbarTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    let lastSig = editorUiStateSignature(editor);
    const onTx = () => {
      const sig = editorUiStateSignature(editor);
      if (sig === lastSig) return;
      lastSig = sig;
      bumpToolbarTick((n) => n + 1);
    };
    editor.on('transaction', onTx);
    return () => { editor.off('transaction', onTx); };
  }, [editor]);

  useEffect(() => {
    if (editorRef && editor) editorRef.current = editor;
    return () => {
      if (editorRef) editorRef.current = null;
    };
  }, [editor, editorRef]);

  // #1038: 供上传链路取最新 editor 实例(editorProps 闭包早于实例创建)。
  useEffect(() => {
    liveEditorRef.current = editor;
  }, [editor]);


  /** #752-cursor: 编辑器最近的滚动容器(main.overflow-y-auto 等)。
   *  外部更新重建文档/插入内容都会引发浏览器滚动,这里统一快照恢复。
   *  #792: DOM 上溯逻辑抽至 lib/scroll-utils(writing-editor 气泡 Apply
   *  共用同一实现)。 */
  const captureScroll = useCallback((): { el: HTMLElement; top: number } | null => {
    if (!editor) return null
    return captureScrollContainer(editor.view.dom as HTMLElement)
  }, [editor])

  /** #752-cursor/#812: 外部内容替换的统一入口 — 快照当前选区+滚动位置,
   *  setContent 后原位恢复。所有 AI apply / restore / doc load 的内容替换
   *  都走这里,用户不再被甩到文档末尾。 */
  const applyExternalContent = useCallback((md: string) => {
    const { from, to } = editor.state.selection;
    const sc = captureScroll();
    applyMdRef.current = md;
    editor.commands.setContent(markdownToHtml(md), { emitUpdate: false });
    applyMdRef.current = null;
    const size = editor.state.doc.content.size;
    editor.commands.setTextSelection({
      from: Math.min(from, size),
      to: Math.min(to, size),
    });
    if (sc) sc.el.scrollTop = sc.top;
  }, [editor, captureScroll]);

  // #996/#1002: 节卡片装饰下发 — 审阅期间清空（track-changes 内容与节
  // chrome 错位，且审阅本身有 ProposalCard 呈现）。
  useEffect(() => {
    if (!editor) return;
    if (reviewKeyRef.current !== null || diffReview) {
      setSectionCards(editor, {});
      return;
    }
    setSectionCards(editor, sectionCardsData);
  }, [editor, sectionCardsData, diffReview]);

  // #1040: 评论锚点装饰下发 — 空数据用模块级常量,避免内联对象身份抖动
  // 造成无谓重建(见 #1037 BUBBLE_OPTIONS 同类教训)。
  const onStartCommentRef = useRef(onStartComment);
  onStartCommentRef.current = onStartComment;
  useEffect(() => {
    if (!editor) return;
    setCommentAnchors(editor, comments ?? EMPTY_COMMENTS);
  }, [editor, comments]);

  // External markdown update (AI edit / doc load) → convert and apply.
  useEffect(() => {
    if (!editor) return;
    // 审阅中不响应外部 value 更新(审阅内容由 diffReview 驱动)
    if (reviewKeyRef.current !== null) return;
    // #752-cursor: round-trip no-op guard — 自己的 insertContentAt 已更新
    // 文档,onChange → 父组件 setBody → value 回流;若此处再 setContent 会
    // 重建文档并把光标冲到文末(AI apply 后跳到文档末尾的根因)。
    // incoming 与当前编辑器内容等价时直接跳过。
    const currentMd = htmlToMarkdown(editor.getHTML());
    if (currentMd === value) return;
    applyExternalContent(value);
  }, [value, editor, captureScroll, applyExternalContent]);

  useEffect(() => {
    if (!editor || mobileDefaultDoneRef.current) return;
    const sections = (sectionCardsData.projection?.nodes ?? []).filter((n) => n.kind === 'section');
    if (sections.length === 0) return;
    mobileDefaultDoneRef.current = true;
    // 桌面不自动折叠（设计口径为移动端扫读形态）。
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    const editingFirst = sectionCardsData.editingIds?.[0];
    let keepId = editingFirst;
    if (!keepId) {
      const latest = Object.entries(sectionCardsData.meta ?? {})
        .sort((a, b) => (b[1].updated_at || '').localeCompare(a[1].updated_at || ''));
      keepId = latest[0]?.[0] ?? sections[0]?.id;
    }
    // #996-followup: 折叠按大纲语义级联隐藏子孙 — keepId 的祖先节必须一并
    // 保持展开,否则父节折叠会把正在编辑的嵌套子节整段盖住(移动端自动
    // 折叠本意是聚焦当前节,反而看不见 AI 正在改哪儿)。祖先判定用投影 span
    // 包含关系(父节 span 含子树)+ level 更浅。
    const keepIds = new Set<string>();
    const keep = sections.find((s) => s.id === keepId);
    if (keep) {
      keepIds.add(keep.id);
      for (const s of sections) {
        if (s.id !== keep.id && (s.level ?? 0) < (keep.level ?? 0) &&
            s.start <= keep.start && s.end >= keep.end) {
          keepIds.add(s.id);
        }
      }
    } else if (keepId) {
      keepIds.add(keepId);
    }
    setCollapsedKeys(sections.map((s) => s.id).filter((id) => !keepIds.has(id)));
  }, [editor, sectionCardsData]);

    // 审阅模式:应用 AI diff 并进入只读审阅
  useEffect(() => {
    if (!editor) return;
    if (!diffReview) {
      reviewKeyRef.current = null;
      setReviewStats({ pending: 0, accepted: 0, rejected: 0 });
      statsRef.current = { accepted: 0, rejected: 0 };
      setSelectedChange(null);
      setChangeNav({ idx: -1, total: 0 });
      // #909: 退出审阅恢复编辑能力(审阅期 setEditable(false) 的对称操作;
      // 初次渲染时本 effect 由 editor 就绪触发,无需 onCreate 兜底)。
      editor.setEditable(true);
      (editor.commands).setTrackChangesMode('edit');
      // 退出审阅(含"放弃修改")→ 还原为当前正文。
      // #812: accept 后的落地也走位置保持 — 用户停在原选区/滚动处,
      // 不再被 setContent 甩到文档末尾。
      applyExternalContent(value);
      return;
    }
    if (reviewKeyRef.current === diffReview.key) return;
    reviewKeyRef.current = diffReview.key;
    statsRef.current = { accepted: 0, rejected: 0 };
    applyMdRef.current = value;
    // #812: 进入审阅同样保持滚动位置 — 用户视线不被拽走。
    const sc = captureScroll();
    const savedTop = sc?.top ?? null;
    // #837: 直接传 markdown 源 — 块标记/空行保留,插入侧能还原真实块结构。
    applyTrackedDiff(editor, diffReview.old, diffReview.next, AI_AUTHOR);
    applyMdRef.current = null;
    if (sc && savedTop !== null) sc.el.scrollTop = savedTop;
    (editor.commands).setTrackChangesMode('view');
    // #909: 审阅只读化 — 此前仅靠 onUpdate 抑制,IME 组合/撤销栈等旁路
    // 仍可在带标记的文档上改写内容;显式 setEditable(false) 封死入口,
    // ←/→ 键也因编辑器失焦而空闲给审阅导航使用。
    editor.setEditable(false);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #812: applyExternalContent/captureScroll 闭包读最新 value/编辑器实例,故意不进 deps
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
      (editor.commands).acceptAll();
      stats.accepted += n;
    } else {
      (editor.commands).rejectAll();
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
    if (accept) { (editor.commands).acceptChange(changeId); stats.accepted += 1; }
    else { (editor.commands).rejectChange(changeId); stats.rejected += 1; }
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

  // #837-ux: 审阅时 ←/→ 逐处导航(编辑被禁用,方向键空闲可用)。
  // hooks 规则:必须在 early return 之前注册。
  const navIdx = changeNav.idx;
  const navTotal = changeNav.total;
  useEffect(() => {
    if (reviewKeyRef.current === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // #909: target 判定 — 输入框/textarea/contenteditable(聊天输入、
      // 标题框、气泡面板)里 ←/→ 是文本光标导航,不得被审阅导航劫持;
      // 仅页面级方向键(编辑器区域/空白处)才做逐处导航。
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target?.isContentEditable) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); jumpTo(Math.min(navIdx + 1, navTotal - 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); jumpTo(Math.max(navIdx - 1, 0)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jumpTo 读最新 editor
  }, [navIdx, navTotal]);

  if (!editor) return null;

  const isActive = (name: string, attrs?: Record<string, unknown>) =>
    editor.isActive(name, attrs);

  const reviewing = reviewKeyRef.current !== null;

  return (
    <div className={className}>
      {reviewing && diffReview && (
        /* #996/#998: 统一变更提议卡(ProposalCard) — 四触发场景同构表头,
           审阅能力(逐条/全部接受拒绝、←/→ 导航、排队轮数)与旧横幅一致。 */
        <ProposalCard
          sticky
          source={diffReview.source ?? 'ai_edit'}
          subject={diffReview.subject}
          titleOverride={reviewTitle}
          queuedRounds={queuedRounds}
          review={{
            stats: reviewStats,
            changeNav,
            selectedChange,
            onJumpTo: jumpTo,
            onResolveOne: resolveOne,
            onResolveAll: resolveAll,
            onFinish: finishReview,
          }}
        />
      )}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <Button size="sm" variant="ghost" className={isActive('bold') ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
          <Bold size={14} />
        </Button>
        <Button size="sm" variant="ghost" className={isActive('italic') ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
          <Italic size={14} />
        </Button>
        <HeadingMenu editor={editor} />
        <Button size="sm" variant="ghost" className={isActive('bulletList') ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleBulletList().run()} title="List">
          <List size={14} />
        </Button>
        <Button size="sm" variant="ghost" className={isActive('orderedList') ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered list">
          <ListOrdered size={14} />
        </Button>
        {/* #1037: 工具栏补齐 — Link(弹层输入)/ TaskList / Blockquote / CodeBlock(带语言)。 */}
        <LinkMenuButton editor={editor} />
        <Button size="sm" variant="ghost" className={isActive('taskList') ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleTaskList().run()} title="任务列表">
          <ListTodo size={14} />
        </Button>
        <Button size="sm" variant="ghost" className={isActive('blockquote') ? 'bg-surface' : ''} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Blockquote">
          <TextQuote size={14} />
        </Button>
        <CodeBlockMenu editor={editor} />
        {/* #1038: 工具栏「插入图片」入口 — 文件选择后走 api.uploadFile 链路。 */}
        <ImageMenuButton onPick={(files) => insertImageFilesRef.current(Array.from(files), null)} />
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
      {imageNotice && (
        /* #1066-2: 上传成功但占位已失效 — 结果不静默丢弃,提示可见。 */
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-2 py-1.5 text-xs text-text-secondary">
          <span>{imageNotice}</span>
          <Button size="sm" variant="ghost" onClick={() => setImageNotice(null)}>{t('writing.imageDismiss', '忽略')}</Button>
        </div>
      )}
      {imageError && (
        /* #1038: 上传失败可重试错误态 — 占位节点已移除,提示不静默。 */
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-2 py-1.5 text-xs text-text-secondary">
          <span className="font-medium text-text-primary">{t('writing.imageUploadFailed', '图片上传失败')}</span>
          <span className="truncate">{imageError.file.name}: {imageError.message}</span>
          <Button size="sm" variant="ghost" onClick={retryImageUpload}>{t('writing.imageRetry', '重试')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setImageError(null)}>{t('writing.imageDismiss', '忽略')}</Button>
        </div>
      )}
      {/* #517-followup: prose defaults are light-theme colors — without
          dark:prose-invert the editor body is unreadable on dark surface.
          Semantic overrides keep headings/links/code on theme tokens.
          #fix: 学术论文排版 — 宽松行距、标题层级、公式/图片居中。
          WRITING_MODULE_REDESIGN 视觉系统:正文/界面 = 无衬线,标题/节名 = 衬线。 */}
      <div className="prose prose-sm max-w-none p-4 dark:prose-invert [&_.ProseMirror]:min-h-[300px] [&_.ProseMirror]:outline-none [&_.ProseMirror]:font-sans [&_.ProseMirror]:text-[15px] [&_.ProseMirror]:leading-loose prose-headings:font-serif prose-headings:text-text-primary prose-headings:font-semibold prose-p:text-text-secondary prose-p:leading-relaxed prose-a:text-accent hover:prose-a:underline prose-strong:text-text-primary prose-code:text-text-primary prose-code:bg-surface prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[13px] prose-code:font-mono prose-ol:text-text-secondary prose-ul:text-text-secondary prose-li:my-0.5 prose-blockquote:border-l-4 prose-blockquote:border-accent prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-text-secondary prose-hr:border-border [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_th]:border [&_th]:border-border [&_th]:bg-surface-elevated [&_th]:p-1.5 [&_th]:text-left [&_img]:my-2 [&_img]:max-h-72 [&_img]:rounded-lg [&_img]:border [&_img]:border-border [&_.ProseMirror_img]:mx-auto
          [&_img[data-loading='true']]:h-24 [&_img[data-loading='true']]:w-full [&_img[data-loading='true']]:animate-pulse [&_img[data-loading='true']]:rounded-lg [&_img[data-loading='true']]:border [&_img[data-loading='true']]:border-dashed [&_img[data-loading='true']]:border-border [&_img[data-loading='true']]:bg-surface [&_img[data-loading='true']]:opacity-70 [&_[data-type='block-math']]:my-4 [&_[data-type='block-math']]:overflow-x-auto [&_[data-type='inline-math']]:px-0.5">
        <EditorContent editor={editor} />
        {onBubbleAction && editor && bubble && (
          /* #752/#792: Selection Bubble — 组件与运行态卡片已抽至
             selection-bubble.tsx(官方 React 组件管理插件生命周期);
             审阅模式由 shouldShow 拦截;150ms 延迟防拖动闪烁。 */
          <SelectionBubble
            editor={editor}
            isReviewing={() => reviewKeyRef.current !== null}
            run={bubble.run}
            onAction={(action, sel) => onActionRef.current?.(action, sel)}
            onStart={bubble.onStart}
            onApply={bubble.onApply}
            onDiscard={bubble.onDiscard}
            onRetry={bubble.onRetry}
            onRefine={bubble.onRefine}
            onSendToChat={bubble.onSendToChat}
            onAddComment={onStartComment ? (sel) => onStartCommentRef.current?.(sel) : undefined}
          />
        )}
      </div>
    </div>
  );
}
