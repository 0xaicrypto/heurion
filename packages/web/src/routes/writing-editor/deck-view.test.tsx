// #1045: deck 幻灯片排序的键盘可访问替代方案 — 每张卡片补「上移/下移」按钮,
// 复用 deckCtl.moveDeckSlide（与拖拽共享同一状态更新逻辑,不新造排序实现）。
import { describe, test, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { useEffect, useRef } from 'react';
import { chartBlockSchema } from '@heurion/contracts';
import i18n from '@/i18n';
import type { DeckWire } from '@/lib/types';
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

/** 测试挂载点:真实 useDeckAsset hook + 种子数据,DeckView 直连(与路由同构)。 */
function Harness({ initialDeck, onDeckChange }: { initialDeck: DeckWire; onDeckChange?: (deck: DeckWire | null) => void }) {
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
        slides={[]}
        body=""
        deckCtl={ctl}
        sendChatText={async () => {}}
        onCardEdit={() => {}}
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
    .filter((v) => ['A', 'B', 'C'].includes(v));

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
      dataTransfer: { getData: () => '0' },
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
