import { describe, test, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { DocEditor } from './DocEditor';
// i18n 初始化 — 气泡/工具栏按钮文案经 t() 解析,未初始化时拿到 key 原串。
import i18n from '@/i18n';

// #1055: en 词条补齐后 jsdom 探测语言为 en,组件会渲染英文 — 固定 zh-CN 维持中文文案断言。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

// TipTap needs a real selection API in jsdom(与 doc-editor.test.tsx 同款桩)
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
  getClientRects = () => [] as unknown as DOMRectList;
  getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}
if (!(Range.prototype as unknown as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects = () => [] as unknown as DOMRectList;
}
if (!(Range.prototype as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect) {
  (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

/** #792 形态的 bubble 回调包 — 提供后 SelectionBubble 随编辑器挂载。 */
const bubbleProp = {
  run: null,
  onStart: () => {},
  onApply: () => {},
  onDiscard: () => {},
  onRetry: () => {},
  onRefine: () => {},
};

/** 渲染带气泡的 DocEditor 并等待编辑器水合。 */
async function setupEditor(value: string, onChange = vi.fn()) {
  const ref: { current: Editor | null } = { current: null };
  const utils = render(
    <DocEditor value={value} onChange={onChange} onBubbleAction={() => {}} bubble={bubbleProp} editorRef={ref} />,
  );
  await wait(250);
  return { ref, onChange, ...utils };
}

/** 选区 15 字(>10 触发气泡阈值)。 */
const LONG_TEXT = '这是一段用于选区测试的正文内容，长度足够。';

/** 选中一段文字并等气泡(150ms 防抖 + 浮层挂载余量)弹出。 */
async function showBubble(ref: { current: Editor | null }) {
  ref.current!.commands.setTextSelection({ from: 1, to: 16 });
  await wait(450);
}

function spyRange() {
  vi.spyOn(document, 'createRange' as any).mockImplementation(() => new FakeRange() as any);
}

// #1037 用例 1:选中文字后气泡菜单渲染 — 手动格式化按钮与 AI 按钮共存。
describe('#1037 用例1 选中文字后气泡菜单渲染', () => {
  test('Bold/Italic/Underline/Strike/Link 按钮可见,且不替代已有 AI 按钮', async () => {
    spyRange();
    const { ref } = await setupEditor(LONG_TEXT);
    await showBubble(ref);

    expect(screen.getByTitle('加粗')).toBeInTheDocument();
    expect(screen.getByTitle('斜体')).toBeInTheDocument();
    expect(screen.getByTitle('下划线')).toBeInTheDocument();
    expect(screen.getByTitle('删除线')).toBeInTheDocument();
    expect(screen.getByTitle('链接')).toBeInTheDocument();
    // AI 动作按钮不受影响,共存于同一气泡(测试环境语言检测为 en → 英文文案)
    expect(screen.getByTitle(/润色|Polish/)).toBeInTheDocument();
    expect(screen.getByTitle(/改写|Rewrite/)).toBeInTheDocument();
  });
});

// #1037 用例 2:点击 Bold/Italic — mark 正确包裹,再次点击取消,选中态同步。
describe('#1037 用例2 点击 Bold/Italic toggle', () => {
  test('选区文字包裹对应 mark,再次点击取消;按钮选中态高亮同步', async () => {
    spyRange();
    const { ref } = await setupEditor(LONG_TEXT);
    await showBubble(ref);

    const boldBtn = screen.getByTitle('加粗');
    fireEvent.pointerDown(boldBtn);
    expect(ref.current!.getHTML()).toContain('<strong>');
    expect(boldBtn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.pointerDown(boldBtn);
    expect(ref.current!.getHTML()).not.toContain('<strong>');
    expect(boldBtn.getAttribute('aria-pressed')).toBe('false');

    const italicBtn = screen.getByTitle('斜体');
    fireEvent.pointerDown(italicBtn);
    expect(ref.current!.getHTML()).toContain('<em>');
    expect(italicBtn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.pointerDown(italicBtn);
    expect(ref.current!.getHTML()).not.toContain('<em>');
    expect(italicBtn.getAttribute('aria-pressed')).toBe('false');
  });
});

// #1037 用例 3:点击 Link — 弹出 URL 输入,确认后选区变为链接,Esc 取消不生效。
describe('#1037 用例3 点击 Link 按钮(气泡内)', () => {
  test('确认后选区变为链接;Esc 取消不应用链接', async () => {
    spyRange();
    const { ref } = await setupEditor(LONG_TEXT);
    await showBubble(ref);

    // 打开链接输入,确认 → 选区加链接
    fireEvent.pointerDown(screen.getByTitle('链接'));
    const input = screen.getByPlaceholderText('https://example.com');
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByTitle('确认链接'));
    expect(ref.current!.getHTML()).toContain('href="https://example.com"');

    // 等气泡防抖周期走完(按钮仍在),重开输入 → 预填当前 href
    await wait(300);
    fireEvent.pointerDown(screen.getByTitle('链接'));
    const reopened = screen.getByPlaceholderText('https://example.com');
    expect(reopened).toHaveValue('https://example.com');
    // Esc 取消 → 不落任何变更
    fireEvent.change(reopened, { target: { value: 'https://other.example.org' } });
    fireEvent.keyDown(reopened, { key: 'Escape' });
    expect(ref.current!.getHTML()).not.toContain('other.example.org');
  });
});

// #1037 用例 4:插入链接后保存再重新加载 — markdown round-trip 链接不丢失。
describe('#1037 用例4 链接 markdown round-trip', () => {
  test('插入链接保存(md)后重新加载,链接 mark 仍存在', async () => {
    spyRange();
    const { ref, onChange, unmount } = await setupEditor(LONG_TEXT);
    await showBubble(ref);
    fireEvent.pointerDown(screen.getByTitle('链接'));
    fireEvent.change(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByTitle('确认链接'));

    // 保存形态应为 GFM 链接语法
    const savedMd = onChange.mock.calls.map((c) => String(c[0])).find((md) => md.includes('https://example.com'));
    expect(savedMd).toBeTruthy();
    expect(savedMd!).toContain('](https://example.com)');
    unmount();

    // 重新加载到全新编辑器 — 链接 mark 还原(Link 扩展会补 target/rel 属性)
    const ref2: { current: Editor | null } = { current: null };
    render(<DocEditor value={savedMd!} onChange={() => {}} editorRef={ref2} />);
    await wait(250);
    expect(ref2.current!.getHTML()).toContain('href="https://example.com"');
  });
});

// #1037 用例 5:插入 TaskList — 可勾选/取消,勾选态经 round-trip 保留(- [x] 语法)。
describe('#1037 用例5 TaskList 勾选与 round-trip', () => {
  test('工具栏插入任务列表,勾选/取消写回 - [x]/- [ ];重载后勾选态保留', async () => {
    spyRange();
    const { ref, onChange, unmount } = await setupEditor('待办内容。');
    ref.current!.commands.setTextSelection({ from: 1, to: 5 });
    fireEvent.click(screen.getByTitle('任务列表'));
    expect(ref.current!.getHTML()).toContain('data-type="taskList"');

    // 勾选 → markdown 为 - [x]
    fireEvent.click(screen.getByRole('checkbox'));
    expect(ref.current!.getHTML()).toContain('data-checked="true"');
    const checkedMd = onChange.mock.calls.map((c) => String(c[0])).find((md) => md.includes('- [x]'));
    expect(checkedMd).toBeTruthy();
    expect(checkedMd!).toContain('- [x] 待办内容。');

    // 取消勾选 → 回到 - [ ]
    fireEvent.click(screen.getByRole('checkbox'));
    expect(ref.current!.getHTML()).toContain('data-checked="false"');
    unmount();

    // 重新加载:markdown 勾选态还原到节点(含未勾选项)
    const ref2: { current: Editor | null } = { current: null };
    render(<DocEditor value={'- [x] 待办内容。\n- [ ] 另一项'} onChange={() => {}} editorRef={ref2} />);
    await wait(250);
    const html = ref2.current!.getHTML();
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('data-checked="false"');
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
  });
});

// #1037 用例 6:顶部工具栏新按钮 active 态 — 光标落在对应格式内时按钮高亮。
describe('#1037 用例6 顶部工具栏新按钮 active 态', () => {
  test('Blockquote:光标进入引用块高亮,退出后熄灭', async () => {
    spyRange();
    const { ref } = await setupEditor('引用测试段落。');
    const quoteBtn = screen.getByTitle('Blockquote');
    fireEvent.click(quoteBtn);
    expect(ref.current!.getHTML()).toContain('<blockquote');
    // 按激活类名按 token 断言(Button 基类含 hover:bg-surface,不能用子串匹配)
    expect(quoteBtn.className.split(/\s+/)).toContain('bg-surface');
    fireEvent.click(quoteBtn);
    expect(quoteBtn.className.split(/\s+/)).not.toContain('bg-surface');
  });

  test('CodeBlock:高亮且出现语言选择,选语言写入 language 属性', async () => {
    spyRange();
    const { ref } = await setupEditor('代码测试段落。');
    const codeBtn = screen.getByTitle('Code block');
    fireEvent.click(codeBtn);
    expect(ref.current!.getHTML()).toContain('<pre');
    expect(codeBtn.className.split(/\s+/)).toContain('bg-surface');
    const langSelect = screen.getByTitle('Code language') as HTMLSelectElement;
    expect(langSelect).toBeInTheDocument();
    fireEvent.change(langSelect, { target: { value: 'python' } });
    expect(ref.current!.getHTML()).toContain('language-python');
  });

  test('TaskList:光标在任务列表内时按钮高亮', async () => {
    spyRange();
    const { ref } = await setupEditor('任务测试段落。');
    const taskBtn = screen.getByTitle('任务列表');
    fireEvent.click(taskBtn);
    expect(ref.current!.getHTML()).toContain('data-type="taskList"');
    expect(taskBtn.className.split(/\s+/)).toContain('bg-surface');
  });

  test('Link:工具栏弹层输入 URL 确认后,光标在链接内按钮高亮', async () => {
    spyRange();
    const { ref } = await setupEditor('链接测试段落。');
    ref.current!.commands.setTextSelection({ from: 1, to: 5 });
    fireEvent.click(screen.getByTitle('Link'));
    const input = screen.getByPlaceholderText('https://example.com');
    fireEvent.change(input, { target: { value: 'https://heurion.ai' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ref.current!.getHTML()).toContain('href="https://heurion.ai"');
    expect(screen.getByTitle('Link').className.split(/\s+/)).toContain('bg-surface');
  });
});
