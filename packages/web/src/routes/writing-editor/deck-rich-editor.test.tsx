// #1101 deck 富编辑（pptx 字节单一标准）— DeckRichEditor 行为测试。
// 视图器双形态：默认 mock stub（可编程触发 onContentChange 验证保存/冲突流），
// 用例可切 viewerReal 开关走真实 PowerPointViewer 挂载（jsdom polyfill 已集中
// 收口 src/test/setup.ts — spike #1102 验证过的挂载形态）。
import { describe, test, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import PptxGenJS from 'pptxgenjs';
import i18n from '@/i18n';
import { ApiError } from '@/lib/api';
import { DeckRichEditor } from './deck-rich-editor';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

// ---- '@/lib/api' mock（deck-view.test.tsx 同口径：ApiError 从工厂内提供）----
const { getDeckArtifactMock, putDeckArtifactMock } = vi.hoisted(() => ({
  getDeckArtifactMock: vi.fn(),
  putDeckArtifactMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class MockApiError extends Error {
    status: number;
    body: string;
    path: string;
    constructor(status: number, body: string) {
      super(`${body}`);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
      this.path = '/mock';
    }
  },
  api: { getDeckArtifact: getDeckArtifactMock, putDeckArtifact: putDeckArtifactMock },
}));

// ---- 'pptx-react-viewer' mock：默认 stub；viewerReal.value=true 时渲染真件 ----
const { viewerReal } = vi.hoisted(() => ({ viewerReal: { value: false } }));

vi.mock('pptx-react-viewer', async (importOriginal) => {
  const { createElement, useState } = await import('react');
  const actual = (await importOriginal()) as { PowerPointViewer: React.ComponentType<Record<string, unknown>> };
  // stub：content-length 自持状态 — simulate-edit 触发 onContentChange 后按
  // 新字节长度重渲染（模拟 viewer 内部 content state 被编辑替换的语义）。
  const StubViewer = (props: { content?: Uint8Array; canEdit?: boolean; onContentChange?: (bytes: Uint8Array) => void }) => {
    const [len, setLen] = useState(() => props.content?.length ?? 0);
    return createElement(
      'div',
      { 'data-testid': 'pptx-viewer-stub' },
      createElement('span', { 'data-testid': 'pptx-viewer-content-length' }, String(len)),
      createElement('span', { 'data-testid': 'pptx-viewer-can-edit' }, String(props.canEdit)),
      createElement('button', {
        'data-testid': 'pptx-viewer-simulate-edit',
        onClick: () => {
          setLen(4);
          props.onContentChange?.(new Uint8Array([1, 2, 3, 4]));
        },
      }),
    );
  };
  const Mock = (props: Record<string, unknown>) =>
    createElement(viewerReal.value ? actual.PowerPointViewer : StubViewer, props);
  return { PowerPointViewer: Mock };
});

// ---- pptx fixture（worker 测试同款思路：pptxgenjs 现场产真实 pptx 字节）----
async function buildPptxFixture(): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  const slide = pptx.addSlide();
  slide.addText('研究概览', { x: 0.5, y: 0.5, fontSize: 28 });
  slide.addText('EGFR 突变 NSCLC 免疫治疗', { x: 0.5, y: 1.5, fontSize: 18 });
  const data = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
  return new Uint8Array(data);
}

// mocked '@/lib/api' 的 ApiError 形（工厂内两参构造）— 类型侧仍指向真实 ApiError
// 三参签名，这里经局部工厂对齐 mock 语义。
const mkApiError = (status: number, body: string) =>
  new (ApiError as unknown as new (s: number, b: string) => Error & { status: number })(status, body);

function Harness({ docId, onNotice, onClose }: { docId: string; onNotice?: (text: string, ttlMs?: number) => void; onClose?: () => void }) {
  return (
    <I18nextProvider i18n={i18n}>
      <DeckRichEditor docId={docId} onNotice={onNotice} onClose={onClose ?? (() => {})} />
    </I18nextProvider>
  );
}

/** 种好 GET 工件元数据 + download_url 的全局 fetch 兜底（默认成功）。 */
async function seedArtifact(version = 'v1') {
  const bytes = await buildPptxFixture();
  getDeckArtifactMock.mockResolvedValue({ artifactId: 'art-1', version, download_url: '/api/v1/files/f1/download?token=t' });
  // 注意：Response 收 jsdom Blob 会被 undici 字符串化成 "[object Blob]" —
  // 必须直接给 ArrayBuffer。
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes.buffer as ArrayBuffer, { status: 200 })));
  return bytes;
}

describe('#1101 DeckRichEditor 装载', () => {
  beforeEach(() => {
    getDeckArtifactMock.mockReset();
    putDeckArtifactMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  test('GET 工件 + fetch 字节 → PowerPointViewer 以 canEdit 挂载', async () => {
    const bytes = await seedArtifact('v1');
    render(<Harness docId="d1" />);
    await screen.findByTestId('deck-rich-editor');
    const stub = await screen.findByTestId('pptx-viewer-stub');
    expect(stub).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('pptx-viewer-can-edit')).toHaveTextContent('true');
      expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(String(bytes.length));
    });
  });

  test('GET 404（尚无工件）→ 提示且不渲染编辑器', async () => {
    getDeckArtifactMock.mockRejectedValue(mkApiError(404, '{"error":{"code":"no_artifact"}}'));
    const notice = vi.fn();
    render(<Harness docId="d1" onNotice={notice} />);
    await screen.findByTestId('deck-rich-editor');
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('pptx 工件'), 6000);
    expect(screen.queryByTestId('pptx-viewer-stub')).not.toBeInTheDocument();
    expect(screen.getByText('该 deck 尚无 pptx 工件 — 让 AI 编排一次或手动导出后再进入富编辑')).toBeInTheDocument();
  });

  test('GET 网络失败 → 降级提示（stay graceful）', async () => {
    getDeckArtifactMock.mockRejectedValue(new Error('network down'));
    const notice = vi.fn();
    render(<Harness docId="d1" onNotice={notice} />);
    await screen.findByTestId('deck-rich-editor');
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('加载失败'), 6000);
    expect(screen.queryByTestId('pptx-viewer-stub')).not.toBeInTheDocument();
  });
});

describe('#1101 DeckRichEditor 保存流', () => {
  beforeEach(() => {
    getDeckArtifactMock.mockReset();
    putDeckArtifactMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  test('编辑 → 2.5s debounce 自动保存（带 baseVersion），版本戳前移', async () => {
    await seedArtifact('v1');
    putDeckArtifactMock.mockResolvedValue({ ok: true, artifactId: 'art-1', version: 'v2' });
    render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-stub');

    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(/^4$/);
    // debounce 未到期不保存
    expect(putDeckArtifactMock).not.toHaveBeenCalled();
    expect(screen.getByText('● 未保存')).toBeInTheDocument();

    await waitFor(
      () => {
        expect(putDeckArtifactMock).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000 },
    );
    const [docIdArg, bytesArg, baseArg] = putDeckArtifactMock.mock.calls[0];
    expect(docIdArg).toBe('d1');
    expect(bytesArg).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytesArg as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(baseArg).toBe('v1');
    // 保存成功后版本戳前移（dirty 清零 → 已同步徽标）
    expect(await screen.findByText('已同步')).toBeInTheDocument();
  });

  test('PUT 409 → 冲突提示（乐观锁语义），dirty 保持待重试', async () => {
    await seedArtifact('v1');
    putDeckArtifactMock.mockRejectedValue(mkApiError(409, '{"error":{"code":"deck_conflict"}}'));
    const notice = vi.fn();
    render(<Harness docId="d1" onNotice={notice} />);
    await screen.findByTestId('pptx-viewer-simulate-edit');

    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    await waitFor(
      () => {
        expect(notice).toHaveBeenCalledWith('deck 工件已被其他窗口修改，请重试', 6000);
      },
      { timeout: 5000 },
    );
    expect(screen.getByText('● 未保存')).toBeInTheDocument();
  });

  test('「保存并返回卡片流」→ 冲刷保存 → onClose', async () => {
    await seedArtifact('v1');
    putDeckArtifactMock.mockResolvedValue({ ok: true, artifactId: 'art-1', version: 'v2' });
    const onClose = vi.fn();
    render(<Harness docId="d1" onClose={onClose} />);
    await screen.findByTestId('pptx-viewer-simulate-edit');

    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    fireEvent.click(screen.getByTestId('deck-rich-editor-save'));
    await waitFor(() => expect(putDeckArtifactMock).toHaveBeenCalledTimes(1));
    // debounce 计时器已被保存按钮清掉，不重复保存
    await new Promise((r) => setTimeout(r, 2700));
    expect(putDeckArtifactMock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('无未保存编辑时「保存并返回」不发起 PUT，直接关闭', async () => {
    await seedArtifact('v1');
    const onClose = vi.fn();
    render(<Harness docId="d1" onClose={onClose} />);
    await screen.findByTestId('pptx-viewer-simulate-edit');
    fireEvent.click(screen.getByTestId('deck-rich-editor-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(putDeckArtifactMock).not.toHaveBeenCalled();
  });

  test('「返回」有未保存编辑 → confirm 放弃后关闭（不再保存）', async () => {
    await seedArtifact('v1');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onClose = vi.fn();
    render(<Harness docId="d1" onClose={onClose} />);
    await screen.findByTestId('pptx-viewer-simulate-edit');

    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    fireEvent.click(screen.getByTestId('deck-rich-editor-close'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 2700));
    expect(putDeckArtifactMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('「返回」无未保存编辑 → 直接关闭（无 confirm）', async () => {
    await seedArtifact('v1');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onClose = vi.fn();
    render(<Harness docId="d1" onClose={onClose} />);
    await screen.findByTestId('pptx-viewer-simulate-edit');
    fireEvent.click(screen.getByTestId('deck-rich-editor-close'));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});

// ── 真实 PowerPointViewer 挂载（spike #1102 用例 5 的 vitest 形态）──
describe('#1101 DeckRichEditor 真实 viewer 挂载', () => {
  beforeEach(() => {
    getDeckArtifactMock.mockReset();
    putDeckArtifactMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  test('真实 PowerPointViewer 渲染幻灯片 DOM 与编辑器 chrome', { timeout: 90_000 }, async () => {
    viewerReal.value = true;
    try {
      await seedArtifact('v1');
      render(<Harness docId="d1" />);
      await screen.findByTestId('deck-rich-editor');
      // 真件挂载：解析 fixture 字节 → [data-pptx-viewer] 树 + 幻灯片文本
      await waitFor(
        () => {
          const root = document.querySelector('[data-pptx-viewer]');
          expect(root).not.toBeNull();
          expect((root as HTMLElement).textContent ?? '').toContain('研究概览');
        },
        { timeout: 60_000 },
      );
    } finally {
      viewerReal.value = false;
    }
  });
});
