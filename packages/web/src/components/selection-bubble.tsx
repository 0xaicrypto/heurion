import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BubbleMenu as TiptapBubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/react';
import { Bold, Italic, Underline as UnderlineIcon, Strikethrough, Link as LinkIcon, MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui';
import { BubbleResultPanel } from './BubbleResultPanel';

/**
 * #792 — Selection Bubble 抽取:气泡工具条 + 全程内联运行态卡片此前
 * (~130 行) 内联在 DocEditor,连带 6 个 bubble 回调 props 与 ref 存值 +
 * force setState 的输入 hack。抽出后:
 *   - 自定义指令输入改为受控 useState(input 态每次 run 以 startedAt
 *     remount,不需要 ref 强刷);
 *   - DocEditor props 14 → 10(onBubbleAction + bubble 单对象);
 *   - 气泡文案走 i18n(此前 14 条硬编码)。
 */

export interface BubbleRunState {
  action: string;
  status: 'input' | 'running' | 'done' | 'error';
  /** 正文流(应用时替换选区的内容)。 */
  stream: string;
  /** 模型思维链(折叠展示,部分模型不返回)。 */
  reasoning: string;
  error: string | null;
  startedAt: number;
  /** #778: 多轮 refine 轮次（≥2 显示「第 N 轮」）。 */
  round?: number;
}

export interface SelectionBubbleProps {
  editor: Editor;
  /** 审阅模式 live 判定(父组件持 reviewKeyRef,闭包取实时值)。 */
  isReviewing: () => boolean;
  /** #752-ux: 气泡内联运行态 — 整个润色过程(思考/流式/错误)在气泡里。 */
  run: BubbleRunState | null;
  /** 动作按钮分发(polish|rewrite|academic|summarize|自定义 preset id)。 */
  onAction: (action: string, sel: { text: string; from: number; to: number }) => void;
  /** input 态:用户提交自定义指令 → 开始运行。 */
  onStart: (instruction: string) => void;
  /** 应用 AI 结果到选区(finalText=面板内用户编辑后的最终版,#778)。 */
  onApply: (finalText: string) => void;
  /** 运行中=取消(abort);完成态=丢弃结果。 */
  onDiscard: () => void;
  /** 出错后原地重试同一动作。 */
  onRetry: () => void;
  /** #778: 多轮 — instruction=新要求,currentText=用户可能已改的当前版本。 */
  onRefine: (instruction: string, currentText: string) => void;
  /** #871: 送入聊天 — done 态把选区+指令转入聊天流。 */
  onSendToChat?: (instruction?: string) => void;
  /** #1040: 「添加评论」入口 — 选区作为 anchorText,由父组件弹输入框。 */
  onAddComment?: (sel: { text: string; from: number; to: number }) => void;
}

const ACTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['polish', '✨', 'bubblePolish'],
  ['rewrite', '📝', 'bubbleRewrite'],
  ['academic', '🔬', 'bubbleAcademic'],
  ['summarize', '📄', 'bubbleSummarize'],
];

/** #1037: 浮层配置固定引用 — BubbleMenu 在 options 身份变化时会派发
 * updateOptions 事务,本组件订阅事务重渲染,内联对象字面量会死循环。 */
const BUBBLE_OPTIONS = { placement: 'top', offset: 8 } as const;

/**
 * #1066-5: 工具栏/气泡「渲染相关」编辑器状态签名 — 事务订阅按签名变化才
 * 触发重渲染(此前每事务无条件 bumpTick,流式写入期间全组件重渲染放大)。
 * 覆盖两类消费方实际读取的全部状态:
 *   - 选区位置(from/to)+ 全部 active mark/块态(bold/italic/underline/
 *     strike/link/code/codeBlock/列表/引用/标题级别);
 *   - codeBlock 语言属性(下拉受控值);
 *   - undo/redo/表格行操作可用态(工具栏 disabled 依据)。
 * 选区/标记均未变的流式写入事务 → 签名不变 → 不重渲染。
 */
// eslint-disable-next-line react-refresh/only-export-components -- #1066-5: 工具栏(DocEditor)与气泡共用签名,与组件同文件避免跨文件扩散(#1066 改动范围受限)
export function editorUiStateSignature(ed: Editor): string {
  const active = (name: string) => (ed.isActive(name) ? 1 : 0);
  return [
    ed.state.selection.from,
    ed.state.selection.to,
    ([1, 2, 3] as const).find((l) => ed.isActive('heading', { level: l })) ?? 0,
    (ed.getAttributes('codeBlock').language as string | undefined) ?? '',
    active('bold'),
    active('italic'),
    active('underline'),
    active('strike'),
    active('link'),
    active('code'),
    active('codeBlock'),
    active('bulletList'),
    active('orderedList'),
    active('taskList'),
    active('blockquote'),
    ed.can().undo() ? 1 : 0,
    ed.can().redo() ? 1 : 0,
    ed.can().addRowAfter() ? 1 : 0,
    ed.can().deleteRow() ? 1 : 0,
  ].join('|');
}

/** #1037: 手动格式化按钮定义 — 与 AI 动作并列,直接对当前选区 toggle。 */
interface FormatTool {
  id: string;
  label: string;
  icon: ReactNode;
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

export function SelectionBubble({ editor, isReviewing, run, onAction, onStart, onApply, onDiscard, onRetry, onRefine, onSendToChat, onAddComment }: SelectionBubbleProps) {
  const { t } = useTranslation();
  const [instruction, setInstruction] = useState('');
  /** pointerdown/click 双通道去重:同一次按下只分发一次。 */
  const busyRef = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** #752-ux: 最新运行态 — shouldShow 闭包经 updateOptions 每轮刷新可读。 */
  const runRef = useRef(run);
  runRef.current = run;
  // #1037: isReviewing 同样经 ref 读取 — shouldShow 必须是稳定引用:
  // BubbleMenu 组件在 shouldShow 身份变化时会向编辑器派发 updateOptions
  // 事务,而本组件(#1037 起)订阅事务重渲染,闭包不固定会造成
  // "渲染→派发→重渲染"死循环。
  const isReviewingRef = useRef(isReviewing);
  isReviewingRef.current = isReviewing;

  // #1037: 手动格式化按钮的选中态高亮 — BubbleMenu 组件不因编辑器事务
  // 重渲染子树(active 判定读 editor 状态),订阅事务强制同步。
  // #1066-5: 按「渲染相关状态签名」变化才 bump — 流式写入等渲染无关
  // 事务(选区/标记均未变)不再触发重渲染。
  const [, bumpFormatTick] = useState(0);
  useEffect(() => {
    let lastSig = editorUiStateSignature(editor);
    const onTx = () => {
      const sig = editorUiStateSignature(editor);
      if (sig === lastSig) return;
      lastSig = sig;
      bumpFormatTick((n) => n + 1);
    };
    editor.on('transaction', onTx);
    return () => { editor.off('transaction', onTx); };
  }, [editor]);

  // #1037: 气泡内 Link 输入 — 打开时预填当前 href,确认落 setLink,Esc/取消不生效。
  const [linkEditing, setLinkEditing] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const openLinkInput = () => {
    setLinkUrl((editor.getAttributes('link').href as string | undefined) ?? '');
    setLinkEditing(true);
  };
  const applyLink = () => {
    const href = linkUrl.trim();
    if (href) editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    else editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkEditing(false);
  };
  const cancelLink = () => setLinkEditing(false);

  const formatTools: FormatTool[] = [
    {
      id: 'bold',
      label: t('writing.bubbleBold', '加粗'),
      icon: <Bold size={14} />,
      isActive: (ed) => ed.isActive('bold'),
      run: (ed) => { ed.chain().focus().toggleBold().run(); },
    },
    {
      id: 'italic',
      label: t('writing.bubbleItalic', '斜体'),
      icon: <Italic size={14} />,
      isActive: (ed) => ed.isActive('italic'),
      run: (ed) => { ed.chain().focus().toggleItalic().run(); },
    },
    {
      id: 'underline',
      label: t('writing.bubbleUnderline', '下划线'),
      icon: <UnderlineIcon size={14} />,
      isActive: (ed) => ed.isActive('underline'),
      run: (ed) => { ed.chain().focus().toggleUnderline().run(); },
    },
    {
      id: 'strike',
      label: t('writing.bubbleStrike', '删除线'),
      icon: <Strikethrough size={14} />,
      isActive: (ed) => ed.isActive('strike'),
      run: (ed) => { ed.chain().focus().toggleStrike().run(); },
    },
  ];

  const fireAction = (id: string) => {
    if (busyRef.current === id) return;
    const sel = editor.state.selection;
    const text = editor.state.doc.textBetween(sel.from, sel.to, '\n').trim();
    busyRef.current = id;
    setBusy(id);
    try {
      onAction(id, { text, from: sel.from, to: sel.to });
    } finally {
      // 菜单即将随选区消费而隐藏;下一轮选中重置 busy。
      window.setTimeout(() => { busyRef.current = null; setBusy(null); }, 300);
    }
  };

  // #1037: 稳定化的 shouldShow(依赖全部走 ref)— 见 isReviewingRef 注释。
  const shouldShow = useCallback(({ state, from, to }: { state: { doc: { textBetween: (f: number, t: number, s: string) => string } }; from: number; to: number }) => {
    if (isReviewingRef.current()) return false;
    // #752-ux: 运行/完成卡片不被选区塌陷或点击空白打断
    if (runRef.current && runRef.current.status !== 'error') return true;
    if (runRef.current?.status === 'error') return true;
    const selText = state.doc.textBetween(from, to, '\n').trim();
    return selText.length > 10;
  }, []);

  return (
    <TiptapBubbleMenu
      editor={editor}
      updateDelay={150}
      options={BUBBLE_OPTIONS}
      shouldShow={shouldShow}
    >
      {run ? (
        /* #752-ux: 全过程内联气泡 — 思考过程(折叠)/流式正文/结果操作,
            不再弹出顶部面板。Apply 用运行开始时的 from/to。 */
        <div className="w-[min(420px,88vw)] rounded-lg border border-border bg-surface-elevated p-2.5 shadow-lg">
        {run.status === 'input' ? (
          /* #752-ux: ✨润色 = 气泡内自定义指令输入,支持任意 prompt。
              key=startedAt — 每次 run 进入 input 态重置输入框。 */
          <div>
            <textarea
              key={run.startedAt}
              autoFocus
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={t('writing.bubblePlaceholder', '告诉 AI 怎么改(可留空直接润色),如:压缩到 200 字 / 强调安全性信号 / 改写成投稿信语气')}
              rows={3}
              className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onStart(instruction.trim());
                }
              }}
            />
            <div className="mt-1.5 flex items-center justify-between">
              <span className="text-[10px] text-text-tertiary">{t('writing.bubbleKeyHint', '⌘/Ctrl + Enter 开始')}</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); onDiscard(); }}>{t('writing.bubbleCancel', '取消')}</Button>
                <Button size="sm" onClick={(e) => { e.preventDefault(); onStart(instruction.trim()); }}>{t('writing.bubbleStart', '开始')}</Button>
              </div>
            </div>
          </div>
        ) : (
          /* #778: 运行/结果卡片渲染收敛到 BubbleResultPanel — done 态
             可直接编辑结果,refine 输入框发起新一轮。 */
          <BubbleResultPanel
            run={run}
            onApply={onApply}
            onDiscard={onDiscard}
            onRetry={onRetry}
            onRefine={onRefine}
            onSendToChat={onSendToChat}
          />
          )}
        </div>
      ) : linkEditing ? (
        /* #1037: 气泡内 Link URL 输入 — 确认落 setLink(空值清除链接),
            Esc/取消不落变更;输入期间选区保持在编辑器状态里。 */
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-elevated p-1 shadow-lg">
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
              else if (e.key === 'Escape') { e.preventDefault(); cancelLink(); }
            }}
            placeholder="https://example.com"
            aria-label={t('writing.bubbleLinkInput', '链接地址')}
            className="h-7 w-48 rounded-md border border-border bg-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button size="sm" onClick={(e) => { e.preventDefault(); applyLink(); }} title={t('writing.bubbleLinkConfirm', '确认链接')}>
            {t('writing.bubbleLinkConfirm', '确认链接')}
          </Button>
          <Button size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); cancelLink(); }} title={t('writing.bubbleLinkCancel', '取消')}>
            {t('writing.bubbleLinkCancel', '取消')}
          </Button>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-surface-elevated px-1 py-0.5 shadow-lg">
        {/* #1037: 手动格式化按钮组 — 排在 AI 动作之前,点击直接对选区
            toggle(mousedown preventDefault 保选区),选中态高亮。 */}
        {formatTools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            aria-pressed={tool.isActive(editor)}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              tool.run(editor);
            }}
            onClick={(e) => e.stopPropagation()}
            className={
              tool.isActive(editor)
                ? 'flex items-center rounded-md px-1.5 py-1 text-accent bg-accent/10'
                : 'flex items-center rounded-md px-1.5 py-1 text-text-secondary hover:bg-surface hover:text-text-primary'
            }
            title={tool.label}
          >
            {tool.icon}
          </button>
        ))}
        {/* #1037: Link 按钮 — 打开气泡内 URL 输入;光标在链接内时高亮。 */}
        <button
          type="button"
          aria-pressed={editor.isActive('link')}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openLinkInput();
          }}
          onClick={(e) => e.stopPropagation()}
          className={
            editor.isActive('link')
              ? 'flex items-center rounded-md px-1.5 py-1 text-accent bg-accent/10'
              : 'flex items-center rounded-md px-1.5 py-1 text-text-secondary hover:bg-surface hover:text-text-primary'
          }
          title={t('writing.bubbleLink', '链接')}
        >
          <LinkIcon size={14} />
        </button>
        <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
        {ACTIONS.map(([id, icon, labelKey]) => (
          <button
            key={id}
            // #752-feedback: pointerdown 主通道 — 在任何 focus/可见性
            // 逻辑之前触发;click 兜底并按 action 去重防止双发。
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              fireAction(id);
            }}
            onClick={(e) => e.stopPropagation()}
            disabled={busy === id}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-60"
            title={t(`writing.${labelKey}`)}
          >
            <span aria-hidden>{busy === id ? '⏳' : icon}</span>{t(`writing.${labelKey}`)}
          </button>
        ))}
        {onAddComment && (
          /* #1040: 「添加评论」— 选区作为 anchorText,弹出评论输入框;
              pointerdown preventDefault 保选区(与格式化按钮同纪律)。 */
          <button
            type="button"
            data-testid="bubble-add-comment"
            aria-label={t('writing.bubbleAddComment', '添加评论')}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const sel = editor.state.selection;
              onAddComment({ text: editor.state.doc.textBetween(sel.from, sel.to, '\n').trim(), from: sel.from, to: sel.to });
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary"
            title={t('writing.bubbleAddComment', '添加评论')}
          >
            <MessageSquarePlus size={14} />
            <span>{t('writing.bubbleAddComment', '添加评论')}</span>
          </button>
        )}
      </div>
      )}
    </TiptapBubbleMenu>
  );
}
