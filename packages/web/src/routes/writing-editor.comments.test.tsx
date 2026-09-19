/**
 * #1040 — 评论创建 UI(选区高亮标注)+ 侧边栏线程列表(TDD,issue 用例表 4 条)。
 *
 * Mock 策略:mock lib/api 层(不 mock fetch/网络);组件测试渲染 DocEditor +
 * CommentsPanel 的组合 harness,接线方式与 writing-editor.tsx 保持一致
 * (气泡「添加评论」→ onStartComment → AddCommentModal → 创建 API →
 * comments 状态 → 编辑器 Decoration 高亮 + 侧边栏线程)。
 *
 * jsdom 适配:FakeRange 补 getClientRects/getBoundingClientRect(气泡
 * updatePosition 需要);气泡经 meta 'show' 事务强制展示(真实浮层定位依赖
 * 布局,jsdom 无布局)。
 */
import { describe, test, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react';
import { useRef, useState, type MutableRefObject } from 'react';
import type { Editor } from '@tiptap/react';
import { DocEditor, selectionWithinSingleBlock } from '@/components/DocEditor';
import { AddCommentModal, CommentsPanel } from './writing-editor/comments-panel';
import { api, type DocCommentWire } from '@/lib/api';
// i18n 初始化 — 组件内 t() 需插值。
import i18n from '@/i18n';

// #1056:读 index.css 源码原文做 CSS 规则存在性断言(防「decoration 类零 CSS」回归)。
// 本包 tsconfig types 未含 node/@types/node,故经非字面量动态 import 绕开模块类型解析;
// .css 的 ?raw 静态导入在 vitest 下返回空串,不可用。cwd 兼容 packages/web 与仓库根两种运行目录。
declare const process: { cwd(): string };

async function loadIndexCss(): Promise<string> {
  const fs: { readFileSync(path: string, encoding: string): string } = await import('node:fs' as string);
  for (const p of ['/src/index.css', '/packages/web/src/index.css']) {
    try {
      return fs.readFileSync(process.cwd() + p, 'utf8');
    } catch {
      /* 尝试下一候选路径 */
    }
  }
  return '';
}

// #1055: en 词条补齐后 jsdom 探测语言为 en,组件会渲染英文 — 固定 zh-CN 维持中文文案断言。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

class FakeRange {
  startContainer: Node = document;
  startOffset = 0;
  endContainer: Node = document;
  endOffset = 0;
  collapsed = true;
  commonAncestorContainer: Node = document;
  setStart() {}
  setEnd() {}
  collapse() {}
  selectNodeContents() {}
  deleteContents() {}
  insertNode() {}
  createContextualFragment = () => document.createDocumentFragment();
  toString = () => '';
  getClientRects = () => [{}] as unknown as DOMRectList;
  getBoundingClientRect = () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }) as DOMRect;
}

const apiMock = vi.hoisted(() => ({
  listDocComments: vi.fn(),
  createDocComment: vi.fn(),
  createDocCommentReply: vi.fn(),
  updateDocComment: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status?: number;
    code: string | null;
    messageText: string;
    constructor(message: string, opts?: { status?: number; code?: string | null }) {
      super(message);
      this.status = opts?.status;
      this.code = opts?.code ?? null;
      this.messageText = message;
    }
  },
  api: apiMock,
}));

const DOC_ID = 'd1';
const BODY = [
  '## Intro',
  '',
  '这是被评论的正文段落，足够长的一段文字用于选中测试。',
  '',
  '这是第二段正文内容，也足够长可以定位。',
  '',
].join('\n');

const PARA1 = '这是被评论的正文段落，足够长的一段文字用于选中测试。';
const PARA2 = '这是第二段正文内容，也足够长可以定位。';

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

type CommentFixture = {
  id: string;
  anchor_text: string;
  status: string;
  anchor?: { located: boolean; candidates?: Array<{ text: string; start: number; heading: string; similarity: number }> };
  replies?: Array<{ id: string; role: string; text: string; created_at: string }>;
};

function makeComment(fx: CommentFixture) {
  return {
    id: fx.id,
    doc_id: DOC_ID,
    section_id: 's1',
    // #1051: 锚点判别字段 — 正文评论 fixture 恒为 section 锚点。
    target: 'section' as const,
    slide_index: null,
    block_index: null,
    anchor_text: fx.anchor_text,
    status: fx.status,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00Z',
    resolved_at: fx.status === 'resolved' ? '2026-01-02T00:00:00Z' : null,
    replies: fx.replies ?? [],
    ...(fx.status === 'open' && fx.anchor ? { anchor: fx.anchor } : {}),
  };
}

/** 与 writing-editor.tsx 相同的接线 — DocEditor + 弹窗 + 侧边栏面板。
 * #1070: 创建拦截同款 — 跨块选区不建草稿、showNotice 通道提示（这里以
 * 本地 state 具象化 notice,断言「有提示、无弹窗、无 API 调用」）。 */
function CommentsHarness({ initialComments, editorRefOut }: {
  initialComments: CommentFixture[];
  editorRefOut?: MutableRefObject<Editor | null>;
}) {
  const editorRef = useRef<Editor | null>(null);
  const refHolder = editorRefOut ?? editorRef;
  // #1051: 显式 DocCommentWire[] — makeComment 产出与服务端 wire 形状对齐。
  const [comments, setComments] = useState<DocCommentWire[]>(initialComments.map(makeComment));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string; from: number; to: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // #1070: showNotice 通道的 harness 具象（生产走路由 aiEditNotice 轻提示条）。
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (text: string) => {
    if (!draft) return;
    setSubmitting(true);
    try {
      const created = await api.createDocComment(DOC_ID, { section_id: 's1', anchor_text: draft.text, text });
      setComments((prev) => [...prev, { ...created, anchor: { located: true } }]);
      setActiveId(created.id);
      setDraft(null);
    } finally {
      setSubmitting(false);
    }
  };

  const reply = async (id: string, text: string) => {
    const r = await api.createDocCommentReply(DOC_ID, id, { role: 'user', text });
    setComments((prev) => prev.map((c) => (c.id === id ? { ...c, replies: [...c.replies, r] } : c)));
  };

  const toggleResolve = async (c: { id: string; status: string }) => {
    await api.updateDocComment(DOC_ID, c.id, c.status === 'open' ? 'resolved' : 'open');
    setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: c.status === 'open' ? 'resolved' : 'open' } : x)));
  };

  return (
    <div>
      <DocEditor
        value={BODY}
        onChange={() => {}}
        editorRef={refHolder}
        onBubbleAction={() => {}}
        bubble={{ run: null, onStart: () => {}, onApply: () => {}, onDiscard: () => {}, onRetry: () => {}, onRefine: () => {} }}
        onStartComment={(sel) => {
          // 与 writing-editor.tsx 拦截处同一逻辑（共用 selectionWithinSingleBlock）。
          const ed = refHolder.current;
          if (ed && !selectionWithinSingleBlock(ed, sel.from, sel.to)) {
            setNotice('评论仅支持同一段落内的选区');
            return;
          }
          setDraft(sel);
        }}
        comments={{
          items: comments.map((c) => ({
            commentId: c.id,
            anchorText: c.anchor_text,
            status: c.status,
            located: c.anchor?.located ?? true,
            candidates: c.anchor?.candidates?.map((x) => ({ text: x.text, similarity: x.similarity })),
          })),
          activeCommentId: activeId,
          onAnchorClick: (id) => setActiveId(id),
        }}
      />
      {notice && <div role="status" data-testid="cross-block-notice">{notice}</div>}
      {draft && (
        <AddCommentModal anchorText={draft.text} submitting={submitting} onClose={() => setDraft(null)} onSubmit={(text) => void submit(text)} />
      )}
      <CommentsPanel
        comments={comments}
        activeId={activeId}
        onSelect={(id) => setActiveId(id)}
        onReply={reply}
        onToggleResolve={(c) => void toggleResolve(c)}
      />
    </div>
  );
}

async function renderHarness(initialComments: CommentFixture[] = []) {
  const editorRef = { current: null } as MutableRefObject<Editor | null>;
  const utils = render(<CommentsHarness initialComments={initialComments} editorRefOut={editorRef} />);
  await wait(250);
  const editor = editorRef.current as Editor;
  expect(editor).toBeTruthy();
  return { ...utils, editor, editorRef };
}

/**
 * #1056:decoration 覆盖的正文文本 — 聚合同 data-comment-id 的全部 span
 * (PM 可能在节点边界拆分 inline decoration,拼接后与 anchorText 全等比对)。
 * 只断言 class 存在曾让 off-by-one 逃逸,文本内容断言才是定位精度的守门员。
 */
function coveredText(container: HTMLElement, commentId: string): string {
  return Array.from(container.querySelectorAll(`.comment-anchor[data-comment-id="${commentId}"]`))
    .map((el) => el.textContent)
    .join('');
}

/** 展示气泡:设置选区后经 meta 'show' 事务强制展示(同 BubbleMenu transactionHandler)。 */
async function showBubbleWithSelection(container: HTMLElement, editor: Editor, from: number, to: number) {
  const pm = container.querySelector('.ProseMirror') as HTMLElement;
  act(() => {
    pm.focus();
    editor.commands.setTextSelection({ from, to });
  });
  await wait(250); // updateDelay 150ms debounce
  act(() => {
    editor.view.dispatch(editor.view.state.tr.setMeta('bubbleMenu$', 'show'));
  });
  await wait(30);
}

describe('#1040 评论 UI(issue 用例表)', () => {
  beforeEach(() => {
    vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    apiMock.listDocComments.mockResolvedValue({ comments: [] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /** 用例 1:选中文字点「添加评论」→ 弹出输入框,提交后侧边栏新线程 + 正文高亮。 */
  test('选中文字点添加评论:输入框出现,提交后侧边栏新线程 + 正文高亮', async () => {
    // 创建 API 回显语义:anchor_text 取提交时的选区文字
    apiMock.createDocComment.mockImplementation(async (_docId: string, data: { anchor_text: string; text: string }) =>
      makeComment({ id: 'c1', anchor_text: data.anchor_text, status: 'open', replies: [{ id: 'r1', role: 'user', text: data.text, created_at: 't0' }] }));

    const { container, editor } = await renderHarness();

    // 1. 选中文本(第一段内,跨块命中会被守卫跳过)→ 气泡出现
    await showBubbleWithSelection(container, editor, 9, 22);
    const addBtn = container.querySelector('[data-testid="bubble-add-comment"]') as HTMLButtonElement;
    expect(addBtn).toBeTruthy();

    // 2. 点「添加评论」→ 输入框出现,预览选区文字
    fireEvent.pointerDown(addBtn);
    await wait(30);
    const input = screen.getByTestId('comment-input') as HTMLTextAreaElement;
    const preview = screen.getByTestId('comment-anchor-preview');
    expect(preview.textContent!.length).toBeGreaterThan(0);

    // 3. 提交 → 调创建 API,选区文字作为 anchorText
    fireEvent.change(input, { target: { value: '这段需要补数据来源' } });
    fireEvent.click(screen.getByTestId('comment-submit'));
    await wait(50);
    await act(async () => {});
    expect(apiMock.createDocComment).toHaveBeenCalledTimes(1);
    const [, payload] = apiMock.createDocComment.mock.calls[0];
    expect(payload.anchor_text).toBe(preview.textContent);

    // 4. 侧边栏出现新线程(含首条回复)
    const thread = await screen.findByTestId('comment-thread-c1');
    expect(thread.getAttribute('data-status')).toBe('open');
    expect(thread.textContent).toContain('这段需要补数据来源');

    // 5. 正文对应位置出现高亮 decoration,且覆盖文本与选区文字全等(#1056 定位精度)
    const highlight = container.querySelector('.comment-anchor[data-comment-id="c1"]');
    expect(highlight).toBeTruthy();
    expect(highlight!.classList.contains('comment-anchor-pending')).toBe(false);
    expect(coveredText(container, 'c1')).toBe(payload.anchor_text);
  });

  /** 用例 2:点击正文高亮 → 侧边栏滚动定位并展开对应线程(jsdom 断言展开态)。 */
  test('点击正文高亮:对应线程展开并激活(resolved 收起态被点开)', async () => {
    const { container } = await renderHarness([
      { id: 'c1', anchor_text: PARA1, status: 'open', anchor: { located: true }, replies: [{ id: 'r1', role: 'user', text: '首条评论', created_at: 't0' }] },
      { id: 'c2', anchor_text: PARA2, status: 'resolved', replies: [{ id: 'r2', role: 'user', text: '已解决的评论', created_at: 't1' }] },
    ]);

    // resolved 线程默认收起
    const thread2 = screen.getByTestId('comment-thread-c2');
    expect(thread2.getAttribute('data-expanded')).toBe('false');

    // 点击正文 resolved 置灰高亮 → 线程展开
    const grey = container.querySelector('.comment-anchor[data-comment-id="c2"]');
    expect(grey).toBeTruthy();
    expect(grey!.classList.contains('comment-anchor-resolved')).toBe(true);
    expect(coveredText(container, 'c2')).toBe(PARA2); // #1056: 覆盖文本全等
    // 高亮点击经插件 view.dom 事件委托 — fireEvent.click 即达。
    fireEvent.click(grey!);
    await wait(30);
    expect(thread2.getAttribute('data-expanded')).toBe('true');
    expect(thread2.textContent).toContain('已解决的评论');

    // 点击 open 高亮 → 线程激活(active 联动)
    const solid = container.querySelector('.comment-anchor[data-comment-id="c1"]') as HTMLElement;
    expect(solid).toBeTruthy();
    expect(solid.classList.contains('comment-anchor-resolved')).toBe(false);
    expect(coveredText(container, 'c1')).toBe(PARA1); // #1056: 覆盖文本全等
    fireEvent.click(solid);
    await wait(30);
    expect(screen.getByTestId('comment-thread-c1').getAttribute('data-active')).toBe('true');
    // 滚动定位:jsdom 无真实滚动,scrollIntoView 需存在且可调用(已 stub)
  });

  /** 用例 3:评论 resolved → 高亮变化(置灰),线程收起。 */
  test('标记已解决:高亮置灰,线程收起', async () => {
    const { container } = await renderHarness([
      { id: 'c1', anchor_text: PARA1, status: 'open', anchor: { located: true }, replies: [{ id: 'r1', role: 'user', text: '首条评论', created_at: 't0' }] },
    ]);

    // 初始:open 高亮 + 线程展开
    expect(container.querySelector('.comment-anchor[data-comment-id="c1"]')!.classList.contains('comment-anchor-resolved')).toBe(false);
    expect(screen.getByTestId('comment-thread-c1').getAttribute('data-expanded')).toBe('true');

    // 面板点「标记已解决」→ PATCH resolved
    fireEvent.click(screen.getByRole('button', { name: /标记已解决|Resolve/ }));
    await wait(30);
    await act(async () => {});
    expect(apiMock.updateDocComment).toHaveBeenCalledWith(DOC_ID, 'c1', 'resolved');

    // 高亮变置灰、线程收起
    const grey = container.querySelector('.comment-anchor[data-comment-id="c1"]') as HTMLElement;
    expect(grey).toBeTruthy();
    expect(grey.classList.contains('comment-anchor-resolved')).toBe(true);
    expect(coveredText(container, 'c1')).toBe(PARA1); // #1056: 置灰后定位仍精确
    const thread = screen.getByTestId('comment-thread-c1');
    expect(thread.getAttribute('data-status')).toBe('resolved');
    expect(thread.getAttribute('data-expanded')).toBe('false');
  });

  /** 用例 4:anchorText 漂移(mock 列表返回 located:false)→ 高亮显示「待重新定位」而非消失/报错。 */
  test('锚点漂移:候选兜底高亮为提示态,面板展示待重新定位徽标', async () => {
    const { container } = await renderHarness([
      {
        id: 'c1',
        anchor_text: '这段文字已经被改得面目全非了。',
        status: 'open',
        anchor: { located: false, candidates: [{ text: PARA1, start: 10, heading: 'Intro', similarity: 0.9 }] },
      },
    ]);

    // 面板:线程不报错,展示「待重新定位」徽标
    const badge = screen.getByTestId('comment-anchor-drifted');
    expect(badge.textContent).toContain('待重新定位');

    // 正文:候选命中处渲染提示态高亮(而非静默消失)
    const pending = container.querySelector('.comment-anchor-pending[data-comment-id="c1"]') as HTMLElement;
    expect(pending).toBeTruthy();
    expect(pending.getAttribute('title')).toContain('待重新定位');
    expect(pending.classList.contains('comment-anchor-resolved')).toBe(false);
    expect(coveredText(container, 'c1')).toBe(PARA1); // #1056: 候选兜底覆盖文本全等
  });

  /** 用例 4 补充:候选也定位不到 → 不渲染正文高亮,面板徽标兜底,不报错。 */
  test('锚点漂移且候选不可定位:无正文高亮,面板徽标兜底', async () => {
    const { container } = await renderHarness([
      {
        id: 'c1',
        anchor_text: '完全不存在于正文的锚点。',
        status: 'open',
        anchor: { located: false, candidates: [{ text: '正文里也没有的句子。', start: 0, heading: '', similarity: 0.4 }] },
      },
    ]);
    expect(container.querySelector('.comment-anchor[data-comment-id="c1"]')).toBeNull();
    expect(screen.getByTestId('comment-anchor-drifted')).toBeTruthy();
    // 线程仍可用(可回复)
    expect(screen.getByTestId('comment-thread-c1')).toBeTruthy();
  });

  /** #1056 用例 1:anchorText 命中段落中间 → decoration 覆盖文本与 anchorText 逐字全等(off-by-one 防回归)。 */
  test('高亮 decoration 覆盖文本与 anchorText 逐字一致(无偏移)', async () => {
    const { container } = await renderHarness([
      { id: 'c1', anchor_text: '足够长的一段文字', status: 'open', anchor: { located: true }, replies: [{ id: 'r1', role: 'user', text: '首条评论', created_at: 't0' }] },
    ]);
    const covered = coveredText(container, 'c1');
    // off-by-one 时首字符漏亮、尾部多吞一字符 → 覆盖文本会变成「够长的一段文字用」
    expect(covered).toBe('足够长的一段文字');
    // 首字符必须被高亮覆盖(此前实现高亮整体右移一位导致漏亮)
    expect(container.querySelector('.comment-anchor[data-comment-id="c1"]')!.textContent!.startsWith('足')).toBe(true);
  });

  /** #1056 用例 2:四个 decoration 类在 index.css 有规则定义(防「decoration 类零 CSS」回归)。 */
  test('评论高亮四个类在 index.css 均有 CSS 规则', async () => {
    const css = await loadIndexCss();
    expect(css).not.toBe('');
    // 基类独立成规则(后随 { ),派生类允许出现在选择器列表中(后随 { 或 ,)
    expect(css).toMatch(/\.comment-anchor\s*\{/);
    expect(css).toMatch(/\.comment-anchor-resolved\s*[,{]/);
    expect(css).toMatch(/\.comment-anchor-pending\s*[,{]/);
    expect(css).toMatch(/\.comment-anchor-active\s*[,{]/);
  });
});

/**
 * #1070 — 跨段落评论创建拦截（消灭"侧边栏有、正文无痕且无提示"的无痕第三态）。
 * 方案 1（限制创建）：跨块选区点「添加评论」→ 创建被拦,showNotice 通道明确
 * 提示,不创建;单块创建回归不变。
 */
describe('#1070 跨块评论创建拦截', () => {
  /** 文档内文本首个字符的 ProseMirror 位置（按子串定位,段落内选点用）。 */
  const posOf = (editor: Editor, needle: string): number => {
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && typeof node.text === 'string' && node.text.includes(needle)) {
        found = pos + node.text.indexOf(needle);
      }
    });
    expect(found).toBeGreaterThanOrEqual(0);
    return found;
  };

  test('判定:同段选区在单块内,跨段/跨标题选区判为跨块', async () => {
    const { editor } = await renderHarness();
    const p1 = posOf(editor, '足够长');
    const p1End = posOf(editor, '测试。') + 2; // 段内两处仍在同一文本块
    expect(selectionWithinSingleBlock(editor, p1, p1End)).toBe(true);
    // 跨两个段落 → 不同父文本块
    const p2 = posOf(editor, '第二段');
    expect(selectionWithinSingleBlock(editor, p1, p2)).toBe(false);
    // 标题 → 段落 同样跨块
    const heading = posOf(editor, 'Intro');
    expect(selectionWithinSingleBlock(editor, heading, p1)).toBe(false);
    // 空选区（折叠）恒视为单块 — 不拦
    expect(selectionWithinSingleBlock(editor, p1, p1)).toBe(true);
  });

  test('用例1 跨两段落选区点添加评论 → 不弹输入框、提示可见、不调创建 API', async () => {
    const { container, editor } = await renderHarness();

    // 选区从第一段跨到第二段 → 气泡出现（气泡本身不拦跨块）
    const from = posOf(editor, '足够长');
    const to = posOf(editor, '第二段正文内容') + 6;
    await showBubbleWithSelection(container, editor, from, to);
    const addBtn = container.querySelector('[data-testid="bubble-add-comment"]') as HTMLButtonElement;
    expect(addBtn).toBeTruthy();

    // 点「添加评论」→ 创建被拦:无输入框弹窗,提示可见（showNotice 通道）
    fireEvent.pointerDown(addBtn);
    await wait(30);
    expect(screen.queryByTestId('comment-input')).toBeNull();
    expect(apiMock.createDocComment).not.toHaveBeenCalled();
    expect(screen.getByTestId('cross-block-notice').textContent).toContain('评论仅支持同一段落内的选区');
    // 侧边栏无线程产生（不创建）
    expect(screen.queryByTestId(/^comment-thread-/)).toBeNull();
  });

  test('用例2 单段内选区创建回归不变 → 弹窗照常打开,无拦截提示', async () => {
    const { container, editor } = await renderHarness();

    const from = posOf(editor, '足够长');
    const to = from + 12; // 同段内 12 字（气泡 shouldShow 阈值 selText > 10）
    await showBubbleWithSelection(container, editor, from, to);
    const addBtn = container.querySelector('[data-testid="bubble-add-comment"]') as HTMLButtonElement;
    expect(addBtn).toBeTruthy();

    fireEvent.pointerDown(addBtn);
    await wait(30);
    // 弹窗照常打开（创建链路不受拦截影响,既有 #1040 用例1 验证高亮落地）
    expect(screen.getByTestId('comment-input')).toBeTruthy();
    expect(screen.queryByTestId('cross-block-notice')).toBeNull();
  });
});
