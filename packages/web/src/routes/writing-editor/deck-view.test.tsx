// #1045: deck 幻灯片排序的键盘可访问替代方案 — 每张卡片补「上移/下移」按钮,
// 复用 deckCtl.moveDeckSlide（与拖拽共享同一状态更新逻辑,不新造排序实现）。
import { describe, test, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { chartBlockSchema } from '@heurion/contracts';
import i18n from '@/i18n';
import type { DeckWire } from '@/lib/types';
import type { DocCitationWire } from '@/lib/api';
import type { Slide } from '@/lib/deck';
import { useDeckAsset } from './deck-asset';
import { DeckView } from './deck-view';

// #1055: en 词条补齐后 jsdom 探测语言为 en,组件会渲染英文 — 固定 zh-CN 维持中文文案断言。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

// #1044: 图片插入复用 #1038 上传链路（api.uploadFile + getDownloadUrl）—
// mock 掉 '@/lib/api'，只提供本用例需要的方法（同 doc-editor-image.test.tsx 口径）。
const { uploadFileMock, getDownloadUrlMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
  getDownloadUrlMock: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  api: { uploadFile: uploadFileMock, getDownloadUrl: getDownloadUrlMock },
}));

// deck 资产 fixture — DeckWire 形状（contracts）,每页一个 bullet 便于断言。
const makeDeck = (titles: string[]): DeckWire => ({
  title: '测试 deck',
  slides: titles.map((title) => ({
    title,
    content: [{ type: 'paragraph', text: `${title}-要点`, style: 'bullet' }],
  })),
});

/** 测试挂载点:真实 useDeckAsset hook + 种子数据,DeckView 直连(与路由同构)。
 * #1087: onNotice 透传 DeckView（路由 showNotice 同款签名），断言丢弃提示用。
 * #review-4: citations/onCitationClick 透传 DeckView（路由 docCitations +
 * setActiveCitationId 同款），断言卡片引用徽标用。 */
function Harness({ initialDeck, onDeckChange, onNotice, sendChatText, slides, body, citations, onCitationClick, onEnterRichEdit }: { initialDeck: DeckWire; onDeckChange?: (deck: DeckWire | null) => void; onNotice?: (text: string, ttlMs?: number) => void; sendChatText?: (text: string) => Promise<void>; slides?: Slide[]; body?: string; citations?: DocCitationWire[]; onCitationClick?: (id: string) => void; onEnterRichEdit?: () => void }) {
  const ctl = useDeckAsset();
  const seededRef = useRef(false);
  // #1044 测试探针:deckAsset 每次变化回传最新 deck,断言 content 块形状用。
  const changeRef = useRef(onDeckChange);
  changeRef.current = onDeckChange;
  useEffect(() => {
    if (!seededRef.current) {
      seededRef.current = true;
      ctl.setDeckAsset(initialDeck);
    }
  });
  useEffect(() => {
    changeRef.current?.(ctl.deckAsset);
  }, [ctl.deckAsset]);
  return (
    <I18nextProvider i18n={i18n}>
      <DeckView
        deckAsset={ctl.deckAsset}
        slides={slides ?? []}
        body={body ?? ''}
        deckCtl={ctl}
        sendChatText={sendChatText ?? (async () => {})}
        onCardEdit={() => {}}
        onNotice={onNotice}
        citations={citations}
        onCitationClick={onCitationClick}
        onEnterRichEdit={onEnterRichEdit}
      />
    </I18nextProvider>
  );
}

const renderDeck = (titles: string[]) => render(<Harness initialDeck={makeDeck(titles)} />);

/** 自定义 content 的 deck fixture（#1047 table 块 / #1046 notes / #1050 富文本用）。 */
const makeDeckSlides = (slides: DeckWire['slides']): DeckWire => ({ title: '测试 deck', slides });

/** 当前卡片顺序 = 标题输入框（值恰为页名）在 DOM 中的出现次序。 */
const cardOrder = (): string[] =>
  screen
    .getAllByRole('textbox')
    .map((el) => (el as HTMLInputElement).value)
    .filter((v) => ['A', 'A1', 'A2', 'B', 'C'].includes(v));

/** 语言无关定位:t() 对缺失 key 回落中文默认值,任何 locale 下均如此。 */
const upButtons = () => screen.getAllByRole('button', { name: '上移此页' });
const downButtons = () => screen.getAllByRole('button', { name: '下移此页' });

describe('#1045 deck 卡片上移/下移按钮', () => {
  test('键盘聚焦「上移」按钮并触发 → slide 与前一张交换,与拖拽结果一致', () => {
    renderDeck(['A', 'B', 'C']);
    expect(cardOrder()).toEqual(['A', 'B', 'C']);

    // 键盘可达:第二张卡的「上移」按钮可聚焦（无 disabled）。
    const secondUp = upButtons()[1];
    secondUp.focus();
    expect(secondUp).toHaveFocus();

    fireEvent.click(secondUp);
    expect(cardOrder()).toEqual(['B', 'A', 'C']);
  });

  test('第一张的「上移」/最后一张的「下移」→ 禁用,点击不越界', () => {
    renderDeck(['A', 'B', 'C']);

    expect(upButtons()[0]).toBeDisabled();
    expect(downButtons()[downButtons().length - 1]).toBeDisabled();
    // 中间卡两个方向都可用。
    expect(upButtons()[1]).toBeEnabled();
    expect(downButtons()[0]).toBeEnabled();

    // 越界兜底:对禁用按钮触发 click,顺序不变（moveDeckSlide 越界保护 + disabled）。
    fireEvent.click(upButtons()[0]);
    fireEvent.click(downButtons()[2]);
    expect(cardOrder()).toEqual(['A', 'B', 'C']);
  });

  test('按钮排序与拖拽排序最终状态一致（同一 moveDeckSlide）', () => {
    // 拖拽:第 1 张拖到第 3 张位置。
    const dragged = renderDeck(['A', 'B', 'C']);
    const cards = dragged.container.querySelectorAll('[draggable="true"]');
    fireEvent.dragStart(cards[0], {
      dataTransfer: { setData: () => {}, effectAllowed: 'move' },
    });
    fireEvent.drop(cards[2], {
      // #1063: 收紧后的 drop 处理只认 dataTransfer.types 含专用 type 的内部拖拽。
      dataTransfer: { getData: () => '0', types: ['text/deck-index'] },
    });
    const afterDrag = cardOrder();
    expect(afterDrag).toEqual(['B', 'C', 'A']);
    dragged.unmount();

    // 按钮:第 1 张连按两次「下移」,应得到同一顺序。
    renderDeck(['A', 'B', 'C']);
    fireEvent.click(downButtons()[0]);
    fireEvent.click(downButtons()[1]);
    expect(cardOrder()).toEqual(afterDrag);
  });
});

// #1047 用例 3：deck 视图渲染 type:'table' 块（data JSON {rows, header?}）。
describe('#1047 deck 视图渲染 table 块', () => {
  test('table 块渲染为只读 HTML 表格，行列与 data 一致，header 行用 th', () => {
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          {
            title: 'S',
            content: [
              { type: 'table', data: JSON.stringify({ rows: [['指标', '值'], ['PFS', '5.2 个月'], ['ORR', '48%']], header: true }) },
              { type: 'paragraph', text: 'b-要点', style: 'bullet' },
            ],
          },
        ])}
      />,
    );
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    // 行列结构：3 行 × 2 列，顺序与 data.rows 一致。
    expect(table!.querySelectorAll('tr')).toHaveLength(3);
    const cells = [...table!.querySelectorAll('th,td')].map((c) => c.textContent);
    expect(cells).toEqual(['指标', '值', 'PFS', '5.2 个月', 'ORR', '48%']);
    expect(table!.querySelectorAll('th')).toHaveLength(2); // header: true → 首行 th
    // 表格之后的 bullet 仍可编辑（既有编辑能力不回退）。
    expect(screen.getAllByRole('textbox').map((el) => (el as HTMLInputElement).value)).toContain('b-要点');
  });

  test('table data 畸形（JSON.parse 失败）→ 占位文本降级，不崩溃不渲染半成品表格', () => {
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'S', content: [{ type: 'table', data: 'not-json{{' }] }])}
      />,
    );
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText('表格数据无法解析')).toBeTruthy();
  });

  test('编辑要点不丢弃同页 table 块（非文本块原位保留）', () => {
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          {
            title: 'S',
            content: [
              { type: 'paragraph', text: 'b-要点', style: 'bullet' },
              { type: 'table', data: JSON.stringify({ rows: [['a', 'b']] }) },
            ],
          },
        ])}
      />,
    );
    const bullet = screen.getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === 'b-要点')!;
    fireEvent.change(bullet, { target: { value: '改过的要点' } });
    expect(container.querySelector('table')).not.toBeNull();
    expect(screen.getAllByRole('textbox').map((el) => (el as HTMLInputElement).value)).toContain('改过的要点');
  });
});

// #1046 用例 2：deck 视图备注编辑区 — 可折叠、显示导入备注、可编辑保存。
describe('#1046 deck 备注编辑区', () => {
  const notesDeck = (notes?: string): DeckWire => ({
    title: 't',
    slides: [
      {
        title: 'A',
        ...(notes !== undefined ? { notes } : {}),
        content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }],
      },
    ],
  });

  test('备注默认收起（textarea 不在 DOM）；展开后显示导入的备注', () => {
    render(<Harness initialDeck={notesDeck('导入的备注内容')} />);
    expect(screen.queryByLabelText('备注内容')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '备注' }));
    const ta = screen.getByLabelText('备注内容') as HTMLTextAreaElement;
    expect(ta.value).toBe('导入的备注内容');
  });

  test('备注可编辑并保存（经 deckCtl 写入 deckAsset 状态，折叠再展开仍在）', () => {
    render(<Harness initialDeck={notesDeck('原始备注')} />);
    fireEvent.click(screen.getByRole('button', { name: '备注' }));
    const ta = screen.getByLabelText('备注内容') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '编辑后的备注' } });
    expect(ta.value).toBe('编辑后的备注');
    // 折叠再展开：值来自 deckAsset.slides[].notes（hook 状态），证明写回成功。
    fireEvent.click(screen.getByRole('button', { name: '备注' }));
    expect(screen.queryByLabelText('备注内容')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '备注' }));
    expect((screen.getByLabelText('备注内容') as HTMLTextAreaElement).value).toBe('编辑后的备注');
  });

  test('导入时无备注 → 展开为空 textarea，可补录', () => {
    render(<Harness initialDeck={notesDeck(undefined)} />);
    fireEvent.click(screen.getByRole('button', { name: '备注' }));
    const ta = screen.getByLabelText('备注内容') as HTMLTextAreaElement;
    expect(ta.value).toBe('');
    fireEvent.change(ta, { target: { value: '补录的备注' } });
    expect((screen.getByLabelText('备注内容') as HTMLTextAreaElement).value).toBe('补录的备注');
  });
});

// #1050：slide 文本行内 markdown（bold/italic/strike/link）— 展示态渲染 + 编辑态快捷按钮。
describe('#1050 slide 文本行内 markdown', () => {
  const mdDeck = (text: string): DeckWire => ({
    title: 't',
    slides: [{ title: 'A', content: [{ type: 'paragraph', text, style: 'bullet' }] }],
  });
  /** 找到值为 text 的要点输入框。 */
  const bulletInput = (text: string): HTMLInputElement =>
    screen.getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === text)! as HTMLInputElement;

  test('用例 1：**bold**/*italic*/~~strike~~/[text](url) 渲染为真实标记而非原始符号', () => {
    const { container } = render(
      <Harness initialDeck={mdDeck('普通 **粗体** 与 *斜体* 与 ~~删除~~ 与 [链接](https://example.com)')} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('粗体');
    expect(container.querySelector('em')?.textContent).toBe('斜体');
    expect(container.querySelector('del')?.textContent).toBe('删除');
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
    expect(a?.textContent).toBe('链接');
  });

  test('用例 2：选中文字点击 Bold/Italic/Strike/Link 按钮 → markdown 语法包裹进 text 字段', () => {
    render(<Harness initialDeck={mdDeck('要点文字')} />);
    const input = bulletInput('要点文字');
    // Bold：选中「要点」
    fireEvent.focus(input);
    input.setSelectionRange(0, 2);
    fireEvent.click(screen.getByRole('button', { name: '粗体' }));
    expect(input.value).toBe('**要点**文字');
    // Italic：选中「文字」（'**要点**' 后的 6..8）
    input.setSelectionRange(6, 8);
    fireEvent.click(screen.getByRole('button', { name: '斜体' }));
    expect(input.value).toBe('**要点***文字*');
    // Strike：选中「要点」（2..4）
    input.setSelectionRange(2, 4);
    fireEvent.click(screen.getByRole('button', { name: '删除线' }));
    expect(input.value).toBe('**~~要点~~***文字*');
    // Link：选中「文字」（'**~~要点~~***' 后的 11..13）
    input.setSelectionRange(11, 13);
    fireEvent.click(screen.getByRole('button', { name: '链接' }));
    expect(input.value).toBe('**~~要点~~***[文字](https://)*');
  });

  test('用例 4（回归）：纯文本 slide 渲染不产出任何标记元素，展示文本与原文一致', () => {
    const { container } = render(<Harness initialDeck={mdDeck('PFS 5.2 个月')} />);
    expect(screen.getByText('PFS 5.2 个月')).toBeTruthy();
    expect(container.querySelector('strong,em,del,a')).toBeNull();
  });
});

// #1054：slide 文本 <u> 下划线 — 渲染（rehype-raw + sanitize 白名单）
// 与 U 按钮包裹/取消（与 B/I/S/Link 同排）。
describe('#1054 slide 文本 <u> 下划线', () => {
  const mdDeck = (text: string): DeckWire => ({
    title: 't',
    slides: [{ title: 'A', content: [{ type: 'paragraph', text, style: 'bullet' }] }],
  });
  const bulletInput = (text: string): HTMLInputElement =>
    screen.getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === text)! as HTMLInputElement;

  test('用例3a：含 <u> 的 slide 文本渲染真实下划线元素（非原始标签文本）', () => {
    const { container } = render(<Harness initialDeck={mdDeck('重点 <u>下划线内容</u> 结束')} />);
    const u = container.querySelector('u');
    expect(u).not.toBeNull();
    expect(u?.textContent).toBe('下划线内容');
    expect(container.textContent).not.toContain('<u>');
  });

  test('用例3a：渲染经 sanitize 白名单 — <u> 内嵌 <script> 被剥离', () => {
    const { container } = render(<Harness initialDeck={mdDeck('<u><script>alert(1)</script>安全文本</u>')} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).not.toContain('alert(1)');
    expect(container.querySelector('u')?.textContent).toBe('安全文本');
  });

  test('用例3b：U 按钮包裹 — 选中文字点击后 text 字段得到 <u>…</u>', () => {
    render(<Harness initialDeck={mdDeck('要点文字')} />);
    const input = bulletInput('要点文字');
    fireEvent.focus(input);
    input.setSelectionRange(0, 2);
    fireEvent.click(screen.getByRole('button', { name: '下划线' }));
    expect(input.value).toBe('<u>要点</u>文字');
  });

  test('用例3b：U 按钮取消 — 选中含完整标签对点击后解包', () => {
    render(<Harness initialDeck={mdDeck('<u>要点</u>文字')} />);
    const input = bulletInput('<u>要点</u>文字');
    fireEvent.focus(input);
    input.setSelectionRange(0, 9); // '<u>要点</u>'
    fireEvent.click(screen.getByRole('button', { name: '下划线' }));
    expect(input.value).toBe('要点文字');
  });

  test('用例3b：U 按钮取消 — 选区在标签内侧（紧邻 <u>/</u>）同样解包', () => {
    render(<Harness initialDeck={mdDeck('<u>要点</u>')} />);
    const input = bulletInput('<u>要点</u>');
    fireEvent.focus(input);
    input.setSelectionRange(3, 5); // '要点'
    fireEvent.click(screen.getByRole('button', { name: '下划线' }));
    expect(input.value).toBe('要点');
  });

  test('用例5（回归）：无 <u> 的纯文本渲染不产出 u 元素', () => {
    const { container } = render(<Harness initialDeck={mdDeck('PFS 5.2 个月')} />);
    expect(screen.getByText('PFS 5.2 个月')).toBeTruthy();
    expect(container.querySelector('u')).toBeNull();
  });
});

// #1044: deck 手动插入图片/图表 UI（与 AI 工具能力对齐）。
const pngFile = (name = '扫描.png') => new File(['x'], name, { type: 'image/png' });
/** #1044 探针回调类型（vi.fn 需显式函数泛型，Mock 才可赋给 Harness prop）。 */
const deckProbe = () => vi.fn<(deck: DeckWire | null) => void>();
/** 取探针回传的最新 deck。 */
const lastDeck = (onDeckChange: ReturnType<typeof deckProbe>): DeckWire => onDeckChange.mock.calls.at(-1)![0] as DeckWire;

describe('#1044 deck 手动插入图片（复用 #1038 上传链路）', () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    getDownloadUrlMock.mockReset();
  });

  test('用例1 点击「插入图片」选文件 → 触发上传，成功后 content 追加 image 块并渲染', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    uploadFileMock.mockResolvedValue({ file_id: 'file_deck_img1', name: '扫描.png', mime: 'image/png', size_bytes: 1 });
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_deck_img1', url: '/api/v1/files/download/file_deck_img1?token=tok' });

    // 文件选择:按钮 → 隐藏 input[type=file] change
    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [pngFile()] } });

    // 走既有上传链路（#1038 同款），成功后换 canonical 下载 URL
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledWith(expect.any(File)));
    await waitFor(() => expect(getDownloadUrlMock).toHaveBeenCalledWith('file_deck_img1'));

    // 渲染:该 slide 出现 img（src = canonical URL）
    const img = await waitFor(() => {
      const el = container.querySelector('img');
      expect(el).not.toBeNull();
      return el as HTMLImageElement;
    });
    expect(img.getAttribute('src')).toBe('/api/v1/files/download/file_deck_img1?token=tok');

    // content 追加 type:'image' 块（url/caption 字段），原 bullet 保留
    const deck = lastDeck(onDeckChange);
    expect(deck.slides[0].content.some((b) => b.type === 'image' && b.url === '/api/v1/files/download/file_deck_img1?token=tok')).toBe(true);
    expect(deck.slides[0].content.some((b) => b.text === 'A-要点')).toBe(true);
  });

  test('上传失败 → 行内错误提示（非静默），不追加坏块', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    uploadFileMock.mockRejectedValue(new Error('network down'));

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile()] } });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('network down'));
    expect(container.querySelector('img')).toBeNull();
    expect(lastDeck(onDeckChange).slides[0].content.some((b) => b.type === 'image')).toBe(false);
  });
});

describe('#1044 deck 手动插入图表（结构化 spec，非生成式）', () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    getDownloadUrlMock.mockReset();
  });
  let onDeckChange: ReturnType<typeof deckProbe>;
  beforeEach(() => {
    onDeckChange = deckProbe();
  });

  test('用例2 表单填结构化数据 → content 追加合法 chart 块，渲染确定性 SVG 图表', async () => {
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '插入图表' }));
    fireEvent.change(screen.getByLabelText('图表类型'), { target: { value: 'bar' } });
    fireEvent.change(screen.getByLabelText('数据标签 1'), { target: { value: 'PFS' } });
    fireEvent.change(screen.getByLabelText('数据值 1'), { target: { value: '5.2' } });
    fireEvent.change(screen.getByLabelText('数据标签 2'), { target: { value: 'ORR' } });
    fireEvent.change(screen.getByLabelText('数据值 2'), { target: { value: '48' } });
    fireEvent.click(screen.getByRole('button', { name: '确认插入' }));

    // 渲染:确定性 SVG（bar → 2 个矩形 + 数据标签），非生成式图片
    // （figure svg 定位到 chart 块本体 — 容器里还有 lucide 图标 svg）。
    await waitFor(() => expect(container.querySelectorAll('svg rect')).toHaveLength(2));
    expect(container.querySelector('figure svg')!.textContent).toContain('PFS');

    // content 追加 type:'chart' 块，spec 与 AI insert_chart 同一契约形状
    const chartBlock = lastDeck(onDeckChange).slides[0].content.find((b) => b.type === 'chart');
    expect(chartBlock).toBeTruthy();
    expect((chartBlock!.spec as { chart_type: string }).chart_type).toBe('bar');
    expect((chartBlock!.spec as { data: Array<{ label: string; value: number }> }).data).toEqual([
      { label: 'PFS', value: 5.2 },
      { label: 'ORR', value: 48 },
    ]);
  });

  test('校验失败（无有效数据行）→ 表单内错误提示，不入 content', () => {
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '插入图表' }));
    fireEvent.click(screen.getByRole('button', { name: '确认插入' }));

    expect(screen.getByRole('alert')).toBeTruthy();
    // 未追加 chart 块（content 仍只有原 bullet）
    expect(container.querySelector('svg rect')).toBeNull();
    expect(lastDeck(onDeckChange).slides[0].content.some((b) => b.type === 'chart')).toBe(false);
  });

  test('用例5 插入的 chart 块形状经 chartBlockSchema 校验通过（与 AI insert_chart 产出一致）', () => {
    render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '插入图表' }));
    fireEvent.change(screen.getByLabelText('图表类型'), { target: { value: 'line' } });
    fireEvent.change(screen.getByLabelText('数据标签 1'), { target: { value: '基线' } });
    fireEvent.change(screen.getByLabelText('数据值 1'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '确认插入' }));

    const chartBlock = lastDeck(onDeckChange).slides[0].content.find((b) => b.type === 'chart');
    expect(chartBlock).toBeTruthy();
    // 契约对齐：人工表单产出与 edit-deck-tool.ts insert_chart 走同一 chartBlockSchema。
    expect(chartBlockSchema.safeParse(chartBlock).success).toBe(true);
  });
});

describe('#1044 deck 图片/图表块替换与删除', () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    getDownloadUrlMock.mockReset();
  });

  const seededImg = { type: 'image', url: '/api/v1/files/download/file_old?token=t1', caption: '旧图' } as const;

  test('用例3 替换已有图片块 → 原位替换（url 更新，不追加新块）', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ ...seededImg }, { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    uploadFileMock.mockResolvedValue({ file_id: 'file_new', name: '新图.png', mime: 'image/png', size_bytes: 1 });
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_new', url: '/api/v1/files/download/file_new?token=t2' });

    fireEvent.click(screen.getByRole('button', { name: '替换图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('新图.png')] } });

    // 原位替换:img src 变为新 URL，image 块仍只有 1 个（非追加）
    await waitFor(() => expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('/api/v1/files/download/file_new?token=t2'));
    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content).toHaveLength(2);
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1);
    expect(content[0].url).toBe('/api/v1/files/download/file_new?token=t2');
    expect(content.some((b) => b.text === 'A-要点')).toBe(true);
  });

  test('用例4 删除图片块 → 对应块从 content 移除，其余块保留', () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ ...seededImg }, { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除图片' }));

    expect(container.querySelector('img')).toBeNull();
    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].text).toBe('A-要点');
  });

  test('删除 chart 块 → 对应块移除，SVG 不再渲染', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          {
            title: 'A',
            content: [
              { type: 'chart', spec: { chart_type: 'bar', data: [{ label: 'PFS', value: 5.2 }] } },
              { type: 'paragraph', text: 'A-要点', style: 'bullet' },
            ],
          },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    expect(container.querySelectorAll('svg rect').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '删除图表' }));

    await waitFor(() => expect(container.querySelector('svg rect')).toBeNull());
    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content.some((b) => b.type === 'chart')).toBe(false);
    expect(content[0].text).toBe('A-要点');
  });
});

// ── #1063: deck 视图交互健壮性批次 5 项 ─────────────────────────────
// 1) 编辑要点清空不产出 content: []（行不消失/不丢焦点，导出侧不再违约）
describe('#1063 编辑要点清空不产出 content 空数组', () => {
  test('清空唯一要点 → 保留一个空文本占位块，content 不为 []，该行仍在 DOM', () => {
    const onDeckChange = deckProbe();
    render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    const input = screen.getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === 'A-要点')!;
    fireEvent.change(input, { target: { value: '' } });

    // 行不消失：空文本输入框仍在 DOM（同一行以占位块形式保留，焦点不丢）
    expect(screen.getAllByRole('textbox').some((el) => (el as HTMLInputElement).value === '')).toBe(true);
    // content 不为 []：保留一个空文本块（编辑占位），不再违反导出契约 min(1)
    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].text).toBe('');
  });

  test('清空多条要点中的一条 → 该行保留为空占位，其余要点不受影响', () => {
    const onDeckChange = deckProbe();
    render(
      <Harness
        initialDeck={makeDeckSlides([
          {
            title: 'A',
            content: [
              { type: 'paragraph', text: 'b1', style: 'bullet' },
              { type: 'paragraph', text: 'b2', style: 'bullet' },
            ],
          },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    const input = screen.getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === 'b1')!;
    fireEvent.change(input, { target: { value: '' } });

    // 空占位行 + 未动要点按原序保留
    const texts = lastDeck(onDeckChange).slides[0].content.map((b) => b.text);
    expect(texts).toEqual(['', 'b2']);
  });
});

// 2) 「+ 要点」真正生效：追加空块不被 filter 吞掉，新行出现并自动聚焦
describe('#1063 「+ 要点」按钮真正生效', () => {
  test('点击「+ 要点」→ content 追加空文本块，新行出现并自动聚焦', () => {
    const onDeckChange = deckProbe();
    render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ 要点' }));

    // content 追加了一个空文本块（不再被 filter 吞掉）
    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content).toHaveLength(2);
    expect(content[1].text).toBe('');
    // 新行出现且自动聚焦（焦点管理补齐）
    const newInput = screen.getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === '')!;
    expect(newInput).toBeTruthy();
    expect(document.activeElement).toBe(newInput);
  });
});

// ── #1073-4: 「+要点」聚焦改显式用户事件信号 ──────────────────────────
// 聚焦只由「用户点击 +要点」驱动（ref 置位期望值,effect 消费后清除）；
// AI 写回导致的块数变化不再误抢焦点（#1063 旧实现以数量变化为信号）。
describe('#1073-4 「+要点」聚焦改显式用户事件信号', () => {
  /** 可从外部触发「AI 写回」（setDeckAsset 替换整份 deck）的 harness — 与路由
   * 的写回落地 effect 同语义（写回 = setDeckAsset 新 deck,无点击事件）。 */
  function AiWriteBackHarness({ initial, aiDeck }: { initial: DeckWire; aiDeck: DeckWire }) {
    const ctl = useDeckAsset();
    const [deck, setDeck] = useState<DeckWire>(initial);
    useEffect(() => {
      ctl.setDeckAsset(deck);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- ctl 每次渲染为新对象,入依赖会每渲染重跑;deck 即数据源
    }, [deck]);
    return (
      <I18nextProvider i18n={i18n}>
        <button onClick={() => setDeck(aiDeck)}>模拟 AI 写回</button>
        <DeckView deckAsset={ctl.deckAsset} slides={[]} body="" deckCtl={ctl} sendChatText={async () => {}} onCardEdit={() => {}} />
      </I18nextProvider>
    );
  }

  test('AI 写回导致要点数增加 → 新行渲染但不抢焦点（无点击信号）', async () => {
    render(
      <AiWriteBackHarness
        initial={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        aiDeck={makeDeckSlides([
          { title: 'A', content: [
            { type: 'paragraph', text: 'A-要点', style: 'bullet' },
            { type: 'paragraph', text: 'AI 新增要点', style: 'bullet' },
          ] },
        ])}
      />,
    );
    // 触发「AI 写回」（setDeckAsset 替换整份 deck,与路由写回落地同语义,无 +要点 点击）
    fireEvent.click(screen.getByRole('button', { name: '模拟 AI 写回' }));
    // AI 写回落地：新要点行出现
    const newInput = await waitFor(() => {
      const el = screen.getAllByRole('textbox').find((x) => (x as HTMLInputElement).value === 'AI 新增要点');
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    });
    // 焦点未被动（旧实现：bulletCount 1→2 增加即聚焦）
    expect(document.activeElement).not.toBe(newInput);
    expect(document.activeElement).toBe(document.body);
  });

  test('回归：点击「+要点」仍自动聚焦新行（显式用户事件路径不回退）', () => {
    const onDeckChange = deckProbe();
    render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ 要点' }));
    const newInput = screen.getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === '')!;
    expect(document.activeElement).toBe(newInput);
  });
});

// 3) 替换图片异步竞态：await 后按块身份校验，目标块被删/变更时不再误替换
describe('#1063 替换图片竞态防护（块身份校验）', () => {
  const seededImg = { type: 'image', url: '/api/v1/files/download/file_old?token=t1', caption: '旧图' } as const;

  test('上传期间目标图片块被删除 → 上传完成后不误替换其他块', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ ...seededImg }, { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    let resolveUpload: (v: unknown) => void = () => {};
    uploadFileMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_new', url: '/api/v1/files/download/file_new?token=t2' });

    fireEvent.click(screen.getByRole('button', { name: '替换图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('竞态.png')] } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());

    // 上传 pending 期间：删除目标图片块（索引 0 此后指向原 bullet）
    fireEvent.click(screen.getByRole('button', { name: '删除图片' }));
    await waitFor(() => expect(container.querySelector('img')).toBeNull());

    // 上传完成：块身份已变 → 必须放弃替换，而非把新图写到 bullet 上
    await act(async () => {
      resolveUpload({ file_id: 'file_new', name: '竞态.png', mime: 'image/png', size_bytes: 1 });
    });

    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content.some((b) => b.type === 'image')).toBe(false);
    expect(content.some((b) => b.text === 'A-要点')).toBe(true);
    expect(container.querySelector('img')).toBeNull();
  });

  test('正常替换（期间无块变更）→ 原位替换不受身份校验影响（不回退）', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ ...seededImg }, { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    uploadFileMock.mockResolvedValue({ file_id: 'file_new', name: '新图.png', mime: 'image/png', size_bytes: 1 });
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_new', url: '/api/v1/files/download/file_new?token=t2' });

    fireEvent.click(screen.getByRole('button', { name: '替换图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('新图.png')] } });

    await waitFor(() => expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('/api/v1/files/download/file_new?token=t2'));
    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content).toHaveLength(2);
    expect(content[0].url).toBe('/api/v1/files/download/file_new?token=t2');
  });
});

// 4) 图表负值/非有限数：表单拒 ±Infinity；渲染保留符号（bar 向下/line 负区）
describe('#1063 图表非有限数校验与负值渲染', () => {
  let onDeckChange: ReturnType<typeof deckProbe>;
  beforeEach(() => {
    onDeckChange = deckProbe();
  });

  test('数值填 Infinity → 表单校验拒绝（alert 提示），不入 content', () => {
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '插入图表' }));
    fireEvent.change(screen.getByLabelText('数据标签 1'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('数据值 1'), { target: { value: 'Infinity' } });
    fireEvent.click(screen.getByRole('button', { name: '确认插入' }));

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(container.querySelectorAll('svg rect')).toHaveLength(0);
    expect(lastDeck(onDeckChange).slides[0].content.some((b) => b.type === 'chart')).toBe(false);
  });

  test('bar 图负值柱画在基线下方（不再 Math.abs 归一为向上）', () => {
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          {
            title: 'A',
            content: [{ type: 'chart', spec: { chart_type: 'bar', data: [{ label: '降', value: -5 }, { label: '升', value: 5 }] } }],
          },
        ])}
      />,
    );
    const svg = container.querySelector('figure svg')!;
    const baselineY = Number(svg.querySelector('line')!.getAttribute('y1'));
    const rects = [...svg.querySelectorAll('rect')].map((r) => ({ y: Number(r.getAttribute('y')), h: Number(r.getAttribute('height')) }));
    // 负值柱：柱体起点在基线上、向下延伸；正值柱：在基线上方收于基线
    expect(rects[0].y).toBeGreaterThanOrEqual(baselineY);
    expect(rects[1].y + rects[1].h).toBeCloseTo(baselineY, 5);
    expect(rects[1].y).toBeLessThan(baselineY);
  });

  test('line 图负值点位于基线下方（polyline 保留符号）', () => {
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          {
            title: 'A',
            content: [{ type: 'chart', spec: { chart_type: 'line', data: [{ label: '谷', value: -5 }, { label: '峰', value: 5 }] } }],
          },
        ])}
      />,
    );
    const svg = container.querySelector('figure svg')!;
    const baselineY = Number(svg.querySelector('line')!.getAttribute('y1'));
    const cys = [...svg.querySelectorAll('circle')].map((c) => Number(c.getAttribute('cy')));
    expect(cys[0]).toBeGreaterThan(baselineY);
    expect(cys[1]).toBeLessThan(baselineY);
  });
});

// ── #1075: deck 表格块删除/替换入口 — 对等原则缺口（唯一零操作块类型）──
// 与图片/图表块（#1044）对齐：onDelete 走既有 deleteDeckSlideBlock
// （min-1 防线沿用），onReplace 打开表格数据表单回填原 rows 原位替换。
describe('#1075 deck 表格块删除/替换', () => {
  const seededTable = (rows: string[][], header = true) =>
    ({ type: 'table', data: JSON.stringify({ rows, header }) }) as const;

  test('用例1 表格块点删除 → 块从 content 移除，其余块保留', () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [seededTable([['指标', '值'], ['PFS', '5.2']]), { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    expect(container.querySelector('table')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '删除表格' }));

    expect(container.querySelector('table')).toBeNull();
    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].text).toBe('A-要点');
  });

  test('用例2 表格是唯一内容块 → 删除被拒（min-1 防线，与图片/图表一致）', () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [seededTable([['a', 'b']])] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除表格' }));

    // content 仍保留该表格（不产出空数组，不违反导出契约 min(1)）
    expect(container.querySelector('table')).not.toBeNull();
    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('table');
  });

  test('数据无法解析的坏表格同样给删除入口（AI 导入/历史遗留可清理，不必整页删除）', () => {
    const onDeckChange = deckProbe();
    render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ type: 'table', data: 'not-json{{' }, { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    expect(screen.getByText('表格数据无法解析')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除表格' }));

    expect(screen.queryByText('表格数据无法解析')).toBeNull();
    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].text).toBe('A-要点');
  });

  test('替换：表单回填原 rows，确认后原位替换 data（不追加新块）', () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          {
            title: 'A',
            content: [
              seededTable([['指标', '值'], ['PFS', '5.2']]),
              { type: 'paragraph', text: 'A-要点', style: 'bullet' },
            ],
          },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '替换表格' }));

    // 表单回填原 rows（每行一条、单元格 | 分隔），header 勾选态沿用
    const textarea = screen.getByLabelText('表格数据（每行一条，单元格用 | 分隔）') as HTMLTextAreaElement;
    expect(textarea.value).toBe('指标 | 值\nPFS | 5.2');
    expect((screen.getByLabelText('首行为表头') as HTMLInputElement).checked).toBe(true);

    // 改写数据并确认 → 原位替换，块数不变
    fireEvent.change(textarea, { target: { value: '指标 | 值\nPFS | 6.0' } });
    fireEvent.click(screen.getByRole('button', { name: '确认替换' }));

    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('table');
    expect(JSON.parse((content[0] as { data: string }).data)).toEqual({ rows: [['指标', '值'], ['PFS', '6.0']], header: true });
    expect(content.some((b) => b.text === 'A-要点')).toBe(true);
    // 替换后的表格仍在视图渲染
    expect(container.querySelector('table')!.textContent).toContain('6.0');
  });

  test('替换：清空数据确认 → 表单内报错，不改 content', () => {
    const onDeckChange = deckProbe();
    render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [seededTable([['a', 'b']]), { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '替换表格' }));
    fireEvent.change(screen.getByLabelText('表格数据（每行一条，单元格用 | 分隔）'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '确认替换' }));

    expect(screen.getByRole('alert')).toBeTruthy();
    const content = lastDeck(onDeckChange).slides[0].content;
    expect(content[0].type).toBe('table');
    expect(JSON.parse((content[0] as { data: string }).data).rows).toEqual([['a', 'b']]);
  });
});

// 5) 外部拖拽不触发排序：dataTransfer 无专用 type（文件拖入等）→ 忽略
describe('#1063 外部拖拽不误触发卡片排序', () => {
  test('dataTransfer types 不含 text/deck-index（外部文件拖入）→ 顺序不变', () => {
    const { container } = renderDeck(['A', 'B']);
    const cards = container.querySelectorAll('[draggable="true"]');
    fireEvent.drop(cards[1], {
      dataTransfer: { getData: () => '', types: ['Files'] },
    });
    expect(cardOrder()).toEqual(['A', 'B']);
  });

  test('内部拖拽（types 含 text/deck-index）→ 排序照常（不回退）', () => {
    const { container } = renderDeck(['A', 'B']);
    const cards = container.querySelectorAll('[draggable="true"]');
    fireEvent.drop(cards[1], {
      dataTransfer: { getData: () => '0', types: ['text/deck-index'] },
    });
    expect(cardOrder()).toEqual(['B', 'A']);
  });
});

// ── #1071-4: slide 稳定 id（结构类变更回填 + key 稳定）─────────────────
describe('#1071-4 slide 稳定 id', () => {
  test('新建 slide 携带稳定 id（添加一页 → 新页有 slide_ 前缀 id,后续变更不漂移）；既有 slide 不整批回填（避免 key 整批更换引发卡片重挂）', () => {
    const onDeckChange = deckProbe();
    render(
      <Harness
        initialDeck={makeDeck(['A', 'B'])}
        onDeckChange={onDeckChange}
      />,
    );
    // 添加一页 → 新页携带稳定 id；既有页不回填（key 不整批更换,本地状态不重置）
    fireEvent.click(screen.getByRole('button', { name: '添加一页' }));
    let deck = lastDeck(onDeckChange);
    expect(deck.slides).toHaveLength(3);
    expect(deck.slides[2].id).toMatch(/^slide_/);
    expect(deck.slides[0].id).toBeUndefined();
    expect(deck.slides[1].id).toBeUndefined();
    const newId = deck.slides[2].id;
    // 再次结构变更（删除一页）→ 其余 slide id 稳定不漂移
    fireEvent.click(screen.getAllByRole('button', { name: '删除此页' })[0]);
    deck = lastDeck(onDeckChange);
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides.map((s) => s.id)).toEqual([undefined, newId]);
  });

  test('排序后卡片本地状态跟随 slide（key 用稳定 id）— 展开的备注不错挂到别的页', () => {
    // fixture 带显式 id（wire 合法形态：服务端/迁移后的 deck 可携带 id）
    render(
      <Harness
        initialDeck={makeDeckSlides([
          { id: 'slide_a', title: 'A', notes: 'A 的备注', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
          { id: 'slide_b', title: 'B', content: [{ type: 'paragraph', text: 'B-要点', style: 'bullet' }] },
        ])}
      />,
    );
    // 展开 A 卡（第 1 张）的备注 — 卡片级 UI 状态
    fireEvent.click(screen.getAllByRole('button', { name: '备注' })[0]);
    expect((screen.getByLabelText('备注内容') as HTMLTextAreaElement).value).toBe('A 的备注');

    // A 卡下移一位（B 补到第 1 位）— 旧实现 key={i}：展开态错挂到位置 0（现在是 B）
    fireEvent.click(downButtons()[0]);
    const areas = screen.getAllByLabelText('备注内容');
    expect(areas).toHaveLength(1);
    // 展开态仍属于 A（value 为 A 的备注,而非 B 的空备注）
    expect((areas[0] as HTMLTextAreaElement).value).toBe('A 的备注');
  });

  test('文本编辑不漂移已有 id（updateDeckSlide 保留 id 字段）', () => {
    const onDeckChange = deckProbe();
    render(
      <Harness
        initialDeck={makeDeckSlides([{ id: 'slide_keep', title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    const input = screen.getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === 'A-要点')!;
    fireEvent.change(input, { target: { value: '改过的要点' } });
    expect(lastDeck(onDeckChange).slides[0].id).toBe('slide_keep');
  });
});

// ── #1071-3: 插入路径竞态防护（slide 身份校验,对齐 #1063 expectBlock）──
describe('#1071-3 插入图片竞态防护（slide 身份校验）', () => {
  test('上传期间目标 slide 被删 → 上传完成后不误插到别的页', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
          { title: 'B', content: [{ type: 'paragraph', text: 'B-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    let resolveUpload: (v: unknown) => void = () => {};
    uploadFileMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_new', url: '/api/v1/files/download/file_new?token=t2' });

    // 卡 A（第 1 张）发起插入图片 → 上传 pending
    fireEvent.click(screen.getAllByRole('button', { name: '插入图片' })[0]);
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('竞态.png')] } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());

    // pending 期间删除卡 A（B 补位到 index 0 — 无守卫时会把图插进 B）
    fireEvent.click(screen.getAllByRole('button', { name: '删除此页' })[0]);

    // 上传完成 → slide 身份不符（引用不同且无 id 可消歧）→ 放弃插入
    await act(async () => {
      resolveUpload({ file_id: 'file_new', name: '竞态.png', mime: 'image/png', size_bytes: 1 });
    });
    const deck = lastDeck(onDeckChange);
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0].title).toBe('B');
    expect(deck.slides[0].content.some((b) => b.type === 'image')).toBe(false);
    expect(container.querySelector('img')).toBeNull();
  });

  test('上传期间同页被编辑（对象重建但稳定 id 不变）→ 插入仍落地（id 消歧,不误伤正常编辑）', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          { id: 'slide_a1', title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    let resolveUpload: (v: unknown) => void = () => {};
    uploadFileMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_new', url: '/api/v1/files/download/file_new?token=t2' });

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('并发.png')] } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());

    // pending 期间编辑同页标题（updateDeckSlide 重建 slide 对象,id 保留）
    fireEvent.change(screen.getByDisplayValue('A'), { target: { value: 'A（编辑中）' } });

    // 上传完成 → 稳定 id 命中 → 图片照常插入该页
    await act(async () => {
      resolveUpload({ file_id: 'file_new', name: '并发.png', mime: 'image/png', size_bytes: 1 });
    });
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const deck = lastDeck(onDeckChange);
    expect(deck.slides[0].title).toBe('A（编辑中）');
    expect(deck.slides[0].content.some((b) => b.type === 'image' && b.url === '/api/v1/files/download/file_new?token=t2')).toBe(true);
  });
});

// ── #1087: 插入竞态判据重构 — 结构 epoch（快照 {index, epoch}）─────────────
// 旧判据（#1071-3 引用/稳定 id）对无 id slide 的同页文本编辑会误判「页已变」→
// 上传结果静默丢弃。epoch 判据：标题/要点等文本编辑不动 epoch；删页/移页/
// 整 deck 替换（AI 写回）才失配 — 失配放弃插入并经 onNotice 可见提示（非静默）。
describe('#1087 插入竞态判据 — 结构 epoch', () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    getDownloadUrlMock.mockReset();
  });

  /** 上传挂起（手动放行）+ canonical URL mock；返回放行函数。 */
  const holdUpload = () => {
    let resolveUpload: (v: unknown) => void = () => {};
    uploadFileMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_new', url: '/api/v1/files/download/file_new?token=t2' });
    return () => resolveUpload({ file_id: 'file_new', name: '竞态.png', mime: 'image/png', size_bytes: 1 });
  };

  /** AI 写回 harness（可从外部整 deck 替换）— 与路由写回落地 effect 同语义。 */
  function AiReplaceHarness({ initial, aiDeck, onNotice }: { initial: DeckWire; aiDeck: DeckWire; onNotice?: (text: string, ttlMs?: number) => void }) {
    const ctl = useDeckAsset();
    const [deck, setDeck] = useState<DeckWire | null>(initial);
    useEffect(() => {
      ctl.setDeckAsset(deck);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- ctl 每次渲染为新对象,deck 即数据源(同 #1073-4 harness 口径)
    }, [deck]);
    return (
      <I18nextProvider i18n={i18n}>
        <button onClick={() => setDeck(aiDeck)}>模拟 AI 写回</button>
        <DeckView deckAsset={ctl.deckAsset} slides={[]} body="" deckCtl={ctl} sendChatText={async () => {}} onCardEdit={() => {}} onNotice={onNotice} />
      </I18nextProvider>
    );
  }

  test('用例1 上传期间同页改标题+加要点（无 id slide）→ 插入成功落本页，无丢弃提示', async () => {
    const onDeckChange = deckProbe();
    const onNotice = vi.fn<(text: string, ttlMs?: number) => void>();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
        onNotice={onNotice}
      />,
    );
    const release = holdUpload();

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('并发.png')] } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());

    // pending 期间同页文本编辑（无 id slide — 旧引用判据在此误杀）
    fireEvent.change(screen.getByDisplayValue('A'), { target: { value: 'A（编辑中）' } });
    fireEvent.click(screen.getByRole('button', { name: '+ 要点' }));

    await act(async () => { release(); });
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const deck = lastDeck(onDeckChange);
    expect(deck.slides[0].title).toBe('A（编辑中）');
    expect(deck.slides[0].content.some((b) => b.type === 'image' && b.url === '/api/v1/files/download/file_new?token=t2')).toBe(true);
    // 正常落地不走丢弃提示（非静默通道只用于真丢弃）
    expect(onNotice).not.toHaveBeenCalled();
  });

  test('用例2 上传期间删除目标页 → 放弃插入 + onNotice 可见提示（非静默）', async () => {
    const onDeckChange = deckProbe();
    const onNotice = vi.fn<(text: string, ttlMs?: number) => void>();
    const { container } = render(
      <Harness
        initialDeck={makeDeck(['A', 'B'])}
        onDeckChange={onDeckChange}
        onNotice={onNotice}
      />,
    );
    const release = holdUpload();

    fireEvent.click(screen.getAllByRole('button', { name: '插入图片' })[0]);
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('竞态.png')] } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());

    // pending 期间删除目标页（B 补位到 index 0）
    fireEvent.click(screen.getAllByRole('button', { name: '删除此页' })[0]);
    await act(async () => { release(); });

    const deck = lastDeck(onDeckChange);
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0].content.some((b) => b.type === 'image')).toBe(false);
    expect(container.querySelector('img')).toBeNull();
    // 非静默：经 onNotice 通道明示（路由横幅）
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('未能自动插入'), 6000));
  });

  test('用例2b 上传期间拖动页序（目标页被移位）→ 放弃 + 提示', async () => {
    const onDeckChange = deckProbe();
    const onNotice = vi.fn<(text: string, ttlMs?: number) => void>();
    const { container } = render(
      <Harness initialDeck={makeDeck(['A', 'B'])} onDeckChange={onDeckChange} onNotice={onNotice} />,
    );
    const release = holdUpload();

    fireEvent.click(screen.getAllByRole('button', { name: '插入图片' })[0]);
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('竞态.png')] } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());

    // pending 期间 A 下移一位（index 0 此后指向 B — 快照 {0, epoch} 失配）
    fireEvent.click(screen.getAllByRole('button', { name: '下移此页' })[0]);
    await act(async () => { release(); });

    expect(cardOrder()).toEqual(['B', 'A']);
    const deck = lastDeck(onDeckChange);
    expect(deck.slides.every((s) => s.content.every((b) => b.type !== 'image'))).toBe(true);
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('未能自动插入'), 6000));
  });

  test('用例3 上传期间 AI 写回整 deck 替换 → 放弃 + 提示；错误条重试落新 deck（保留重试）', async () => {
    const onNotice = vi.fn<(text: string, ttlMs?: number) => void>();
    const { container } = render(
      <AiReplaceHarness
        initial={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        aiDeck={makeDeckSlides([{ title: 'A（AI 重写）', content: [{ type: 'paragraph', text: 'AI-要点', style: 'bullet' }] }])}
        onNotice={onNotice}
      />,
    );
    const release = holdUpload();

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('竞态.png')] } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());

    // pending 期间 AI 写回整 deck 替换（全体 epoch 重置 → 在途快照全部失配）
    fireEvent.click(screen.getByRole('button', { name: '模拟 AI 写回' }));
    await act(async () => { release(); });

    expect(container.querySelector('img')).toBeNull();
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('未能自动插入'), 6000));
    // 行内错误条同样可见（卡片存活场景），并提供重试路径
    expect(screen.getByRole('alert').textContent).toContain('未能自动插入');
    const retryBtn = screen.getByRole('button', { name: '重试' });
    expect(retryBtn).toBeTruthy();

    // 重试走同链路、快照刷新 → 落到当前（AI 写回后）的页
    uploadFileMock.mockResolvedValue({ file_id: 'file_retry', name: '竞态.png', mime: 'image/png', size_bytes: 1 });
    fireEvent.click(retryBtn);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('回归：既有 #1071-3 身份校验场景在 epoch 判据下不回退（同页编辑落地/删页放弃）', async () => {
    // 同页文本编辑（带 id）→ 落地（#1071-3 用例2 场景在 epoch 判据下语义不变）
    const onDeckChange = deckProbe();
    const onNotice = vi.fn<(text: string, ttlMs?: number) => void>();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ id: 'slide_a1', title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
        onNotice={onNotice}
      />,
    );
    const release = holdUpload();
    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('并发.png')] } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());
    fireEvent.change(screen.getByDisplayValue('A'), { target: { value: 'A（编辑中）' } });
    await act(async () => { release(); });
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(lastDeck(onDeckChange).slides[0].title).toBe('A（编辑中）');
    expect(onNotice).not.toHaveBeenCalled();
  });
});

// ── #1089 deck 侧反馈一致性（1 唯一块删除提示 / 2 上传失败重试 / 3 pulse 占位 / 4 表单错误样式对齐）──
describe('#1089-1 唯一内容块删除 — 显式提示（非静默拒绝）', () => {
  test('唯一内容块（table）删除被 min-1 防线拒绝 → onNotice 明示「每页至少保留一个内容块」，块保留', () => {
    const onDeckChange = deckProbe();
    const onNotice = vi.fn<(text: string, ttlMs?: number) => void>();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'table', data: JSON.stringify({ rows: [['a', 'b']] }) }] }])}
        onDeckChange={onDeckChange}
        onNotice={onNotice}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除表格' }));

    // 块保留（min-1 防线既有行为不回退）+ 提示可见
    expect(container.querySelector('table')).not.toBeNull();
    expect(lastDeck(onDeckChange).slides[0].content).toHaveLength(1);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('每页至少保留一个内容块'));
  });

  test('非唯一块删除正常移除，不触发提示', () => {
    const onDeckChange = deckProbe();
    const onNotice = vi.fn<(text: string, ttlMs?: number) => void>();
    render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ type: 'table', data: JSON.stringify({ rows: [['a', 'b']] }) }, { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
        onNotice={onNotice}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除表格' }));
    expect(lastDeck(onDeckChange).slides[0].content).toHaveLength(1);
    expect(onNotice).not.toHaveBeenCalled();
  });
});

describe('#1089-2 上传失败错误条补「重试」按钮（对齐 DocEditor）', () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    getDownloadUrlMock.mockReset();
  });

  test('上传失败 → 错误条含重试/忽略；点击重试走同链路成功，错误清除', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    uploadFileMock.mockRejectedValueOnce(new Error('network down'));
    uploadFileMock.mockResolvedValue({ file_id: 'file_new', name: '失败.png', mime: 'image/png', size_bytes: 1 });
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_new', url: '/api/v1/files/download/file_new?token=t2' });

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('失败.png')] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('network down'));

    // 重试/忽略按钮在错误条上（对齐 DocEditor 错误态结构）
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    // 重试走同链路（再次 uploadFile → getDownloadUrl → 插入），成功后错误清除
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(lastDeck(onDeckChange).slides[0].content.some((b) => b.type === 'image')).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('忽略按钮清除错误条，不产生插入', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    uploadFileMock.mockRejectedValue(new Error('network down'));

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('失败.png')] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('network down'));

    fireEvent.click(screen.getByRole('button', { name: '忽略' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(lastDeck(onDeckChange).slides[0].content.some((b) => b.type === 'image')).toBe(false);
  });
});

describe('#1089-3 插入等待期 pulse 占位块', () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    getDownloadUrlMock.mockReset();
  });

  test('上传 pending → 卡片内占位块可见；成功 → 占位移除、图片落地', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    let resolveUpload: (v: unknown) => void = () => {};
    uploadFileMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_new', url: '/api/v1/files/download/file_new?token=t2' });

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('占位.png')] } });

    // 等待期：pulse 占位块可见（本地 state，非 content 块 — 不落 deck 数据）
    expect(screen.getByRole('status')).toBeTruthy();
    expect(lastDeck(onDeckChange).slides[0].content.every((b) => b.type !== 'image')).toBe(true);

    await act(async () => {
      resolveUpload({ file_id: 'file_new', name: '占位.png', mime: 'image/png', size_bytes: 1 });
    });
    // 成功：占位移除、图片落地
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('上传失败 → 占位移除，错误条出现（不留悬挂占位）', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    uploadFileMock.mockRejectedValue(new Error('network down'));

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('占位.png')] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('network down'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('#1089-4 表单错误提示样式对齐（同为行内 alert）', () => {
  test('表格替换表单与上传错误条走同一 DeckInlineAlert 类名（中性灰底防漂移），不再是红色错误条', async () => {
    // 表格表单：空数据提交 → 行内 alert，捕获类名
    const table = render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ type: 'table', data: JSON.stringify({ rows: [['a', 'b']] }) }, { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '替换表格' }));
    // 清空预填数据再确认 → 触发行内校验错误（同 #1075 既有用例口径）
    fireEvent.change(screen.getByLabelText('表格数据（每行一条，单元格用 | 分隔）'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '确认替换' }));
    const tableAlert = screen.getByRole('alert');
    expect(tableAlert.textContent).toContain('数据未通过校验');
    const tableAlertClass = tableAlert.className;
    table.unmount();

    // 上传错误条：失败 → 行内 alert（同一 DeckInlineAlert 渲染路径），捕获类名
    uploadFileMock.mockRejectedValue(new Error('boom'));
    const upload = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(upload.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('对齐.png')] } });
    const uploadAlert = await screen.findByRole('alert');
    const uploadAlertClass = uploadAlert.className;
    upload.unmount();

    // #1094 样式对齐锁定：两处错误条同一套类名（共享 DeckInlineAlert,防漂移）
    expect(tableAlertClass).toBe(uploadAlertClass);
    // 中性灰底（对齐 DocEditor 错误条语言）— 不再是手写红色配色
    expect(tableAlertClass).toContain('bg-surface');
    expect(tableAlertClass).toContain('border-border');
    expect(tableAlertClass).not.toContain('border-error');
    expect(tableAlertClass).not.toContain('bg-error');
    expect(tableAlertClass).not.toContain('text-error');
  });
});

describe('#1094 上传错误条走 DeckInlineAlert（中性灰底防漂移）', () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    getDownloadUrlMock.mockReset();
  });

  test('上传失败错误条：中性灰底信息条（role=alert），重试/忽略按钮仍在，无红色配色', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    uploadFileMock.mockRejectedValue(new Error('network down'));

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('失败.png')] } });
    const alert = await screen.findByRole('alert');

    // 类名断言防漂移：DeckInlineAlert 的中性灰底结构（对齐 DocEditor 错误条）
    expect(alert.className).toContain('bg-surface');
    expect(alert.className).toContain('border-border');
    expect(alert.className).toContain('rounded');
    expect(alert.className).not.toContain('border-error');
    expect(alert.className).not.toContain('bg-error');
    expect(alert.className).not.toContain('text-error');
    // 操作槽：共享 Button 渲染的重试/忽略仍可用（既有重试链路不回退）
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '忽略' })).toBeTruthy();
  });
});

describe('#1094 替换模式等待期半透明 pulse 覆盖层', () => {
  beforeEach(() => {
    uploadFileMock.mockReset();
    getDownloadUrlMock.mockReset();
  });

  const seededImg = { type: 'image', url: '/api/v1/files/download/file_old?token=t1', caption: '旧图' } as const;

  test('替换 pending：旧图仍在 + 覆盖层可见（旧块不删）；完成后覆盖层移除、src 换新', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ ...seededImg }, { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    let resolveUpload: (v: unknown) => void = () => {};
    uploadFileMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_new', url: '/api/v1/files/download/file_new?token=t2' });

    fireEvent.click(screen.getByRole('button', { name: '替换图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('新图.png')] } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());

    // 等待期：旧图仍在（不删旧块）+ 半透明 pulse 覆盖层可见
    expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(seededImg.url);
    expect(screen.getByTestId('deck-replace-pending-0')).toBeTruthy();
    expect(screen.getByRole('status').className).toContain('animate-pulse');
    // deck 数据不变（覆盖层是本地 state,不落 content）
    expect(lastDeck(onDeckChange).slides[0].content[0].url).toBe(seededImg.url);

    // 完成：旧块原位换 src、覆盖层移除、无错误条
    await act(async () => {
      resolveUpload({ file_id: 'file_new', name: '新图.png', mime: 'image/png', size_bytes: 1 });
    });
    await waitFor(() => expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('/api/v1/files/download/file_new?token=t2'));
    expect(screen.queryByTestId('deck-replace-pending-0')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(lastDeck(onDeckChange).slides[0].content).toHaveLength(2);
    expect(lastDeck(onDeckChange).slides[0].content.filter((b) => b.type === 'image')).toHaveLength(1);
  });

  test('替换失败：覆盖层移除、旧图仍在、错误条出现（不留悬挂覆盖）', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ ...seededImg }, { type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        onDeckChange={onDeckChange}
      />,
    );
    uploadFileMock.mockRejectedValue(new Error('network down'));

    fireEvent.click(screen.getByRole('button', { name: '替换图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('失败.png')] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('network down'));

    // 覆盖层已移除、旧图保留、content 未被写坏
    expect(screen.queryByTestId('deck-replace-pending-0')).toBeNull();
    expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(seededImg.url);
    expect(lastDeck(onDeckChange).slides[0].content[0].url).toBe(seededImg.url);
  });

  test('插入模式回归：等待期渲染行尾占位条（DeckInlineAlert role=status,不走覆盖层）', async () => {
    const onDeckChange = deckProbe();
    const { container } = render(
      <Harness
        initialDeck={makeDeckSlides([{ title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] }])}
        onDeckChange={onDeckChange}
      />,
    );
    let resolveUpload: (v: unknown) => void = () => {};
    uploadFileMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    getDownloadUrlMock.mockResolvedValue({ file_id: 'file_new', url: '/api/v1/files/download/file_new?token=t2' });

    fireEvent.click(screen.getByRole('button', { name: '插入图片' }));
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [pngFile('占位.png')] } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());

    // 等待期：占位条可见（无旧图可覆盖,不渲染替换覆盖层）
    const pending = screen.getByTestId('deck-upload-pending-0');
    expect(pending.className).toContain('bg-surface');
    expect(pending.className).not.toContain('border-error');
    expect(container.querySelector('img')).toBeNull();

    await act(async () => {
      resolveUpload({ file_id: 'file_new', name: '占位.png', mime: 'image/png', size_bytes: 1 });
    });
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// ── #1098: 无 deck 资产时缺「生成幻灯片」入口与引导 ──────────────────────
// 「AI 帮我拆页」只改 ## 分页,建不出可编辑 deck 资产（仅 AI 的 edit_deck 工具能建）
// — fallback 分支需有显式生成入口 + 只读投影卡片旁的引导文案。
describe('#1098 无 deck 资产时的「生成可编辑幻灯片」入口', () => {
  /** 只读投影 slides fixture（fallback 卡片网格渲染用）。 */
  const projectionSlides = (): Slide[] => [
    { title: 'A', headingRaw: '## A', blocks: [{ type: 'paragraph', text: 'A-要点' }] },
  ];

  test('无 deckAsset：生成按钮存在，点击 sendChatText 恰一次且指令含 edit_deck', async () => {
    const sendChatText = vi.fn<(text: string) => Promise<void>>();
    render(<Harness initialDeck={null as unknown as DeckWire} slides={projectionSlides()} body="## A\n要点" sendChatText={sendChatText} />);
    // initialDeck=null 时不 seed deck（Harness 种子逻辑仅在有 deck 时落地,此处直接以 null 走 fallback）。
    await waitFor(() => expect(screen.getByRole('button', { name: '生成可编辑幻灯片' })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '生成可编辑幻灯片' }));
    });
    expect(sendChatText).toHaveBeenCalledTimes(1);
    expect(String(sendChatText.mock.calls[0][0])).toContain('edit_deck');
    // 原「AI 帮我拆页」仍保留为次级选项。
    expect(screen.getByRole('button', { name: 'AI 帮我拆页' })).toBeTruthy();
  });

  test('无 deckAsset：只读投影卡片旁出现引导文案（指向生成入口）', () => {
    render(<Harness initialDeck={null as unknown as DeckWire} slides={projectionSlides()} body="## A\n要点" />);
    expect(screen.getByText('想要直接编辑卡片？点击上方“生成可编辑幻灯片”创建 deck 资产')).toBeTruthy();
  });

  test('有 deckAsset：不出现生成按钮与引导文案（展示可编辑 UI）', () => {
    renderDeck(['A']);
    expect(screen.queryByRole('button', { name: '生成可编辑幻灯片' })).toBeNull();
    expect(screen.queryByText(/想要直接编辑卡片/)).toBeNull();
    // 可编辑 UI 仍在：添加一页入口。
    expect(screen.getByRole('button', { name: '添加一页' })).toBeTruthy();
  });
});

// #1090-1: deck 编辑撤销栈（限深 10）+ 撤销按钮 + Cmd/Ctrl+Z 快捷键 —
// 对比正文完整 Undo 历史的 deck 侧补齐；恢复态经 deckJson 由既有 dirty/autosave 落盘。
describe('#1090-1 deck 编辑撤销', () => {
  test('删页 → 撤销按钮出现，点击恢复被删页（顺序回到 A/B/C）', async () => {
    renderDeck(['A', 'B', 'C']);
    await screen.findByDisplayValue('A');
    // 未编辑时无撤销按钮。
    expect(screen.queryByTestId('deck-undo-btn')).toBeNull();

    // 删除第一页（A）→ 撤销按钮出现
    fireEvent.click(screen.getAllByRole('button', { name: '删除此页' })[0]);
    await waitFor(() => expect(cardOrder()).toEqual(['B', 'C']));
    const undoBtn = screen.getByTestId('deck-undo-btn');

    // 点击撤销 → 恢复 A/B/C
    fireEvent.click(undoBtn);
    await waitFor(() => expect(cardOrder()).toEqual(['A', 'B', 'C']));
    // 撤销到空栈 → 按钮消失
    await waitFor(() => expect(screen.queryByTestId('deck-undo-btn')).toBeNull());
  });

  test('文本编辑 800ms 合帧（连击一帧）；⌘Z 快捷键在输入框外可撤销', async () => {
    renderDeck(['A', 'B']);
    await screen.findByDisplayValue('A');
    // 未编辑时无撤销按钮。
    expect(screen.queryByTestId('deck-undo-btn')).toBeNull();
    // 文本编辑（标题输入）— 800ms 内连击只占一帧：一次撤销回到原文。
    const titleByValue = (v: string) => screen.getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === v)!;
    expect(titleByValue('A')).toBeTruthy();
    fireEvent.change(titleByValue('A'), { target: { value: 'A1' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    fireEvent.change(titleByValue('A1'), { target: { value: 'A2' } });
    await waitFor(() => expect(cardOrder()[0]).toBe('A2'));
    expect(screen.getByTestId('deck-undo-btn')).toBeTruthy();

    // ⌘Z（焦点不在输入框）→ 一次撤销回到 A
    fireEvent.keyDown(document, { key: 'z', metaKey: true });
    await waitFor(() => expect(cardOrder()[0]).toBe('A'));
    // 合帧语义：一次撤销即回到初态（两连击只占一帧）
    await waitFor(() => expect(screen.queryByTestId('deck-undo-btn')).toBeNull());
  });

  test('栈深上限 10 — 连续 12 次添加后撤销最多回到第 10 步（最早 2 步丢失）', async () => {
    renderDeck(['A', 'B']);
    await screen.findByDisplayValue('A');
    // 连续添加 12 页（每次结构操作入栈）
    for (let i = 0; i < 12; i++) {
      fireEvent.click(screen.getByRole('button', { name: '添加一页' }));
      await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
    }
    expect(slidesNow()).toBe(14);
    // 撤销 10 次 → 回到 12 次添加前（栈深截断，最早 2 步丢失）
    for (let i = 0; i < 10; i++) {
      fireEvent.click(screen.getByTestId('deck-undo-btn'));
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
    expect(slidesNow()).toBe(4);
    expect(screen.queryByTestId('deck-undo-btn')).toBeNull();
  });
});

/** 当前 slide 总数（删除按钮数 = 页数）。 */
function slidesNow(): number {
  return screen.getAllByRole('button', { name: '删除此页' }).length;
}

// ── #review-4: deck 卡片引用徽标 — deck 非 TipTap（无 decoration 管道）， ──
// 卡片内容下方叠加 [n]/[?] 徽标行：编号与正文/References/导出同源
// （assignCitationNumbers，每页独立作用域），点击弹 CitationPreviewModal。
const CITE_A: DocCitationWire = {
  id: 'cite_aaa',
  doi: '10.1000/aaa',
  title: 'Trial A',
  authors: ['Zhang S'],
  journal: 'J Clin Oncol',
  year: 2024,
  source: 'pubmed',
};
const CITE_B: DocCitationWire = {
  id: 'cite_bbb',
  doi: '10.1000/bbb',
  title: 'Trial B',
  authors: ['Li Q'],
  journal: 'Lancet Oncol',
  year: 2023,
  source: 'crossref',
};

describe('#review-4 deck 卡片引用徽标', () => {
  test('两个不同 shortcode → [1]/[2] 徽标（首现顺序编号），点击回调带正确 id，原始 shortcode 保留在输入框', () => {
    const onCitationClick = vi.fn<(id: string) => void>();
    render(
      <Harness
        initialDeck={makeDeckSlides([
          {
            title: 'A',
            content: [
              { type: 'paragraph', text: '结果 [cite:cite_aaa]', style: 'bullet' },
              { type: 'paragraph', text: '结论 [cite:cite_bbb]', style: 'bullet' },
            ],
          },
        ])}
        citations={[CITE_A, CITE_B]}
        onCitationClick={onCitationClick}
      />,
    );

    const badge0 = screen.getByTestId('deck-citation-badge-0');
    const badge1 = screen.getByTestId('deck-citation-badge-1');
    expect(badge0.textContent).toBe('[1]');
    expect(badge0.getAttribute('data-citation-id')).toBe('cite_aaa');
    expect(badge1.textContent).toBe('[2]');
    expect(badge1.getAttribute('data-citation-id')).toBe('cite_bbb');
    // tooltip = 元数据摘要（title · journal · year · doi）。
    expect(badge0.getAttribute('title')).toContain('Trial A');

    // 点击 → 路由层（onCitationClick）拿到被点的引用 id。
    fireEvent.click(badge1);
    expect(onCitationClick).toHaveBeenCalledTimes(1);
    expect(onCitationClick).toHaveBeenCalledWith('cite_bbb');

    // 编辑面不动：原始 shortcode 文本仍在要点输入框内。
    expect(screen.getAllByRole('textbox').map((el) => (el as HTMLInputElement).value)).toContain('结果 [cite:cite_aaa]');
  });

  test('未知 id → [?] 悬挂警示徽标（warning 样式），点击同样回调该 id', () => {
    const onCitationClick = vi.fn<(id: string) => void>();
    render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ type: 'paragraph', text: '悬挂 [cite:cite_ghost]', style: 'bullet' }] },
        ])}
        citations={[CITE_A]}
        onCitationClick={onCitationClick}
      />,
    );

    const badge = screen.getByTestId('deck-citation-badge-0');
    expect(badge.textContent).toBe('[?]');
    expect(badge.getAttribute('data-citation-id')).toBe('cite_ghost');
    expect(badge.className).toContain('text-warning');
    expect(badge.getAttribute('title')).toContain('未解析的引用标记');

    fireEvent.click(badge);
    expect(onCitationClick).toHaveBeenCalledWith('cite_ghost');
  });

  test('无 shortcode 的 slide → 不渲染徽标行', () => {
    render(
      <Harness
        initialDeck={makeDeckSlides([
          { title: 'A', content: [{ type: 'paragraph', text: 'A-要点', style: 'bullet' }] },
        ])}
        citations={[CITE_A]}
      />,
    );
    expect(screen.queryByTestId('deck-citation-badges')).toBeNull();
    expect(screen.queryByTestId('deck-citation-badge-0')).toBeNull();
  });
});

// #1101: 富编辑入口 — deck 资产在场时展示「富编辑（画布）」按钮，点击回调
// onEnterRichEdit（路由据此挂载 DeckRichEditor）。
describe('#1101 富编辑入口按钮', () => {
  test('deckAsset 模式 → 入口在场，点击回调 onEnterRichEdit', () => {
    const onEnterRichEdit = vi.fn();
    render(
      <Harness
        initialDeck={makeDeck(['A'])}
        onEnterRichEdit={onEnterRichEdit}
      />,
    );
    const entry = screen.getByTestId('deck-rich-edit-entry');
    expect(entry.textContent).toContain('富编辑（画布）');
    fireEvent.click(entry);
    expect(onEnterRichEdit).toHaveBeenCalledTimes(1);
  });

  test('无 onEnterRichEdit → 不渲染入口（可选 prop 兼容）', () => {
    renderDeck(['A', 'B']);
    expect(screen.queryByTestId('deck-rich-edit-entry')).toBeNull();
  });
});
