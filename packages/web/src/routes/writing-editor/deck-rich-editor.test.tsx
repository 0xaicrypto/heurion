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
  const { createElement, useEffect, useState } = await import('react');
  const actual = (await importOriginal()) as { PowerPointViewer: React.ComponentType<Record<string, unknown>> };
  // stub：content-length 自持状态 — simulate-edit 触发 onContentChange 后按
  // 新字节长度重渲染（模拟 viewer 内部 content state 被编辑替换的语义）。
  const StubViewer = (props: { content?: Uint8Array; canEdit?: boolean; onContentChange?: (bytes: Uint8Array) => void }) => {
    const [len, setLen] = useState(() => props.content?.length ?? 0);
    // #1113: 外部（AI 写回/撤销）替换 content 身份时同步展示新字节长度；
    // 本地 simulate-edit 只改自己的 len（父级 content 身份不变，不重置）。
    useEffect(() => { setLen(props.content?.length ?? 0); }, [props.content]);
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

function Harness({ docId, onNotice, onClose, onDirtyChange, aiDeckVersion, turnBoundary }: {
  docId: string;
  onNotice?: (text: string, ttlMs?: number) => void;
  onClose?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  aiDeckVersion?: string | null;
  turnBoundary?: number;
}) {
  return (
    <I18nextProvider i18n={i18n}>
      <DeckRichEditor
        docId={docId}
        onNotice={onNotice}
        onClose={onClose ?? (() => {})}
        onDirtyChange={onDirtyChange}
        aiDeckVersion={aiDeckVersion}
        turnBoundary={turnBoundary}
      />
    </I18nextProvider>
  );
}

/** 种好 GET 工件元数据 + download_url 的全局 fetch 兜底（默认成功）。 */
async function seedArtifact(version = 'v1') {
  const bytes = await buildPptxFixture();
  // wire 命名与 deck-artifact.router.ts 序列化对齐（snake_case artifact_id）。
  getDeckArtifactMock.mockResolvedValue({ artifact_id: 'art-1', version, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', updated_at: '2026-01-01T00:00:00Z', download_url: '/api/v1/files/f1/download?token=t' });
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
    putDeckArtifactMock.mockResolvedValue({ ok: true, artifact_id: 'art-2', version: 'v2', changed: true });
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

  test('#review-3 PUT 409 → 重建基线并自动重试（不再死锁，用户编辑不丢）', { timeout: 15_000 }, async () => {
    await seedArtifact('v1');
    putDeckArtifactMock
      .mockRejectedValueOnce(mkApiError(409, '{"error":{"code":"deck_conflict"}}'))
      .mockResolvedValueOnce({ ok: true, artifact_id: 'art-2', version: 'v2', changed: true });
    const notice = vi.fn();
    render(<Harness docId="d1" onNotice={notice} />);
    await screen.findByTestId('pptx-viewer-simulate-edit');

    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    await waitFor(
      () => {
        expect(notice).toHaveBeenCalledWith(expect.stringContaining('已基于最新版本继续保存'), 6000);
      },
      { timeout: 6000 },
    );
    // 自动重试落地 → dirty 清空，用户字节保留。
    await waitFor(() => expect(putDeckArtifactMock).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(Array.from(putDeckArtifactMock.mock.calls[1][1] as Uint8Array)).toEqual([1, 2, 3, 4]);
    await waitFor(() => expect(screen.getByText('已同步')).toBeInTheDocument(), { timeout: 8000 });
  });

  test('「保存并返回卡片流」→ 冲刷保存 → onClose', async () => {
    await seedArtifact('v1');
    putDeckArtifactMock.mockResolvedValue({ ok: true, artifact_id: 'art-2', version: 'v2', changed: true });
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

  // #review-fix（debounce 竞态）: 保存飞行中的新编辑不得被迟到的 dirty 清零
  // 吞掉 — 代数守护：完成时代数已前移 → dirty 保持 + 补拍发送最新字节。
  // （两个连续 2.5s debounce 拍,用例超时放宽到 12s。）
  test('保存飞行中的新编辑 → dirty 保持待补拍，第二拍带新版本戳发送最新字节', { timeout: 12_000 }, async () => {
    await seedArtifact('v1');
    let resolvePut1: (value: { ok: boolean; artifact_id: string; version: string; changed: boolean }) => void = () => {};
    const putCalls: Array<{ bytes: Uint8Array; base?: string }> = [];
    putDeckArtifactMock.mockImplementation((_docId: string, bytes: Uint8Array, base?: string) => {
      putCalls.push({ bytes, base });
      if (putCalls.length === 1) {
        return new Promise((resolve) => { resolvePut1 = resolve; });
      }
      return Promise.resolve({ ok: true, artifact_id: 'art-3', version: 'v3', changed: true });
    });
    render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-simulate-edit');

    // 第一次编辑 → debounce 到期 → PUT#1 挂起（手动控制完成时机）
    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    await waitFor(() => expect(putDeckArtifactMock).toHaveBeenCalledTimes(1), { timeout: 5000 });
    // PUT#1 在飞时再次编辑（代数前移）
    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    resolvePut1({ ok: true, artifact_id: 'art-2', version: 'v2', changed: true });
    // PUT#1 迟到成功 — 但代数已前移,不得清 dirty（修复前此处显示「已同步」）
    await waitFor(() => {
      expect(screen.getByText('● 未保存')).toBeInTheDocument();
      expect(screen.queryByText('已同步')).not.toBeInTheDocument();
    });
    // 补拍自动触发：发送最新字节、基于前移后的版本戳
    await waitFor(() => expect(putDeckArtifactMock).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(Array.from(putCalls[1].bytes)).toEqual([1, 2, 3, 4]);
    expect(putCalls[1].base).toBe('v2');
    expect(await screen.findByText('已同步')).toBeInTheDocument();
  });

  // #review-fix（dirty 上报）: onDirtyChange 随编辑检出/保存完成如实上报,
  // 父级 leaveEditor / beforeunload 守护据此纳入画布未保存编辑。
  test('onDirtyChange 编辑上报 true、保存完成后上报 false', async () => {
    await seedArtifact('v1');
    putDeckArtifactMock.mockResolvedValue({ ok: true, artifact_id: 'art-2', version: 'v2', changed: true });
    const onDirtyChange = vi.fn();
    render(<Harness docId="d1" onDirtyChange={onDirtyChange} />);
    await screen.findByTestId('pptx-viewer-simulate-edit');

    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false), { timeout: 5000 });
    expect(onDirtyChange).toHaveBeenCalledTimes(2);
  });

  test('onDirtyChange 卸载时上报 false（会话结束撤守护）', async () => {
    await seedArtifact('v1');
    const onDirtyChange = vi.fn();
    const { unmount } = render(<Harness docId="d1" onDirtyChange={onDirtyChange} />);
    await screen.findByTestId('pptx-viewer-simulate-edit');
    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

// ── #1115: 直接下载 PPTX + 无工件 AI 生成入口 ──
describe('#1115 DeckRichEditor 直接下载 / 生成入口', () => {
  beforeEach(() => {
    getDeckArtifactMock.mockReset();
    putDeckArtifactMock.mockReset();
    // jsdom 未实现 object URL — downloadBlob 依赖它。
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    vi.restoreAllMocks();
  });

  test('有工件：点击下载 → GET 工件 + fetch 字节 → 触发浏览器下载（文件名取文档标题）', async () => {
    await seedArtifact('v1');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(
      <I18nextProvider i18n={i18n}>
        <DeckRichEditor docId="d1" docTitle="研究方案 v2" onClose={() => {}} />
      </I18nextProvider>,
    );
    await screen.findByTestId('pptx-viewer-stub');

    fireEvent.click(screen.getByTestId('deck-rich-editor-download'));
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('研究方案 v2.pptx');
    // 不经过聊天/AI — 仅装载 + 下载两次工件元数据调用，无聊天发送。
    expect(getDeckArtifactMock).toHaveBeenCalledTimes(2);
  });

  test('装载成功但下载请求失败 → 明确提示，不产生下载', async () => {
    await seedArtifact('v1');
    const notice = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<Harness docId="d1" onNotice={notice} />);
    await screen.findByTestId('pptx-viewer-stub');
    // 下载时的元数据请求失败（装载那一次已成功）。
    getDeckArtifactMock.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByTestId('deck-rich-editor-download'));
    await waitFor(() => expect(notice).toHaveBeenCalledWith('PPTX 下载失败，请重试', 6000));
    expect(clickSpy).not.toHaveBeenCalled();
  });

  test('无工件：显示 AI 生成入口并回调（有/无工件两入口区分）', async () => {
    getDeckArtifactMock.mockRejectedValue(mkApiError(404, '{"error":{"code":"no_artifact"}}'));
    const onGenerateDeck = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <DeckRichEditor docId="d1" onClose={() => {}} onGenerateDeck={onGenerateDeck} />
      </I18nextProvider>,
    );
    await screen.findByTestId('deck-rich-editor');
    const gen = await screen.findByTestId('deck-rich-editor-generate');
    fireEvent.click(gen);
    expect(onGenerateDeck).toHaveBeenCalledTimes(1);
    // 无工件时不出现「下载 PPTX」。
    expect(screen.queryByTestId('deck-rich-editor-download')).not.toBeInTheDocument();
  });

  test('无工件且未提供生成回调 → 不渲染生成按钮', async () => {
    getDeckArtifactMock.mockRejectedValue(mkApiError(404, '{"error":{"code":"no_artifact"}}'));
    render(<Harness docId="d1" />);
    await screen.findByTestId('deck-rich-editor');
    expect(screen.queryByTestId('deck-rich-editor-generate')).not.toBeInTheDocument();
  });
});

// ── #1113/#1114: AI 写回实时落地 + 整轮撤销 + 未保存编辑排队 ──
describe('#1113/#1114 DeckRichEditor AI 写回', () => {
  beforeEach(() => {
    getDeckArtifactMock.mockReset();
    putDeckArtifactMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  /** 多个工件版本（装载 v1 → AI v2/v3） + 按 download_url 分发的 fetch。 */
  async function seedTwoVersions(v2Len = 999) {
    const v1 = await buildPptxFixture();
    const v2 = new Uint8Array(v2Len).fill(7);
    const meta = (version: string, file: string) => ({
      artifact_id: `art-${version}`,
      version,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      updated_at: '2026-01-01T00:00:00Z',
      download_url: `/api/v1/files/${file}/download?token=t`,
    });
    getDeckArtifactMock
      .mockResolvedValueOnce(meta('v1', 'f1'))
      .mockResolvedValueOnce(meta('v2', 'f2'))
      .mockResolvedValueOnce(meta('v3', 'f3'))
      .mockResolvedValue(meta('v4', 'f4'));
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/f1/') ? new Response(v1.buffer as ArrayBuffer, { status: 200 }) : new Response(v2.buffer as ArrayBuffer, { status: 200 })));
    return { v1, v2 };
  }

  test('空闲时收到 AI 写回版本 → 自动拉新字节并展示整轮撤销横幅', async () => {
    const { v2 } = await seedTwoVersions();
    const { rerender } = render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-stub');

    rerender(<Harness docId="d1" aiDeckVersion="v2" turnBoundary={0} />);
    await waitFor(() => expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(String(v2.length)));
    expect(await screen.findByTestId('deck-ai-undo-banner')).toBeInTheDocument();
  });

  test('整轮合批：同 turn 多次写回只捕获一次快照，撤销回滚到 AI 修改前字节', async () => {
    const { v1 } = await seedTwoVersions();
    const { rerender } = render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-stub');

    rerender(<Harness docId="d1" aiDeckVersion="v2" turnBoundary={0} />);
    await screen.findByTestId('deck-ai-undo-banner');
    // 同一 turn 第二笔写回（v3 → 复用 v2 字节 stub）— 不重置快照。
    rerender(<Harness docId="d1" aiDeckVersion="v3" turnBoundary={0} />);
    await waitFor(() => expect(getDeckArtifactMock).toHaveBeenCalledTimes(3)); // 装载 + v2 + v3

    putDeckArtifactMock.mockResolvedValueOnce({ ok: true, artifact_id: 'art-old', version: 'v-old', changed: true });
    fireEvent.click(screen.getByTestId('deck-ai-undo'));
    await waitFor(() => expect(putDeckArtifactMock).toHaveBeenCalledTimes(1));
    const [, bytesArg, baseArg] = putDeckArtifactMock.mock.calls[0];
    expect(Array.from(bytesArg as Uint8Array)).toEqual(Array.from(v1));
    expect(baseArg).toBe('v3');
    await waitFor(() => expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(String(v1.length)));
    expect(screen.queryByTestId('deck-ai-undo-banner')).not.toBeInTheDocument();
  });

  test('#1113 跨 turn 边界：下一轮 AI 写回开启新撤销快照（撤销只回滚本轮）', async () => {
    await seedTwoVersions();
    // 第二轮写入用不同字节（复用 v2 stub 999，无法区分 — 用独立响应覆盖）。
    const round2Bytes = new Uint8Array(777).fill(9);
    const { rerender } = render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-stub');

    // 第一轮 v2（boundary 0）→ 快照 = v1。
    rerender(<Harness docId="d1" aiDeckVersion="v2" turnBoundary={0} />);
    await screen.findByTestId('deck-ai-undo-banner');
    // turn 收口 → boundary 前移；下一轮 v3 用新字节。
    getDeckArtifactMock.mockResolvedValue({
      artifact_id: 'art-v3', version: 'v3', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      updated_at: '2026-01-03T00:00:00Z', download_url: '/api/v1/files/f3/download?token=t',
    });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/f3/') ? new Response(round2Bytes.buffer as ArrayBuffer, { status: 200 }) : new Response(new Uint8Array(999).fill(7).buffer as ArrayBuffer, { status: 200 })));
    rerender(<Harness docId="d1" aiDeckVersion="v3" turnBoundary={1} />);
    await waitFor(() => expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(String(round2Bytes.length)));

    // 撤销 → 回到第二轮写入前的字节（v2 stub 长度 999），而非第一轮前的 v1。
    putDeckArtifactMock.mockResolvedValueOnce({ ok: true, artifact_id: 'art-back', version: 'v-back', changed: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByTestId('deck-ai-undo'));
    await waitFor(() => expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent('999'));
    expect(clickSpy).not.toHaveBeenCalled();
  });

  test('#fix 首次生成：missing 态收到 AI 版本 → 自动装载画布（不必退出重进）', async () => {
    const v1 = await buildPptxFixture();
    const meta = {
      artifact_id: 'art-1', version: 'v1',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      updated_at: '2026-01-01T00:00:00Z', slide_count: 1,
      download_url: '/api/v1/files/f1/download?token=t',
    };
    // 首次装载 404（missing）；AI 写入版本后重载成功。
    getDeckArtifactMock
      .mockRejectedValueOnce(mkApiError(404, '{"error":{"code":"no_artifact"}}'))
      .mockResolvedValue(meta);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(v1.buffer as ArrayBuffer, { status: 200 })));

    const { rerender } = render(<Harness docId="d1" />);
    await screen.findByTestId('deck-rich-editor');
    expect(await screen.findByText(/尚无 pptx 工件/)).toBeInTheDocument();

    rerender(<Harness docId="d1" aiDeckVersion="v1" turnBoundary={0} />);
    await screen.findByTestId('pptx-viewer-stub');
    expect(screen.queryByText(/尚无 pptx 工件/)).not.toBeInTheDocument();
    expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(String(v1.length));
  });

  test('#review-1 用户手动保存后撤销窗口失效 — 撤销绝不反向吞掉用户手改', async () => {
    const { v2 } = await seedTwoVersions();
    const { rerender } = render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-simulate-edit');

    // AI 落地 → 撤销横幅出现。
    rerender(<Harness docId="d1" aiDeckVersion="v2" turnBoundary={0} />);
    await screen.findByTestId('deck-ai-undo-banner');
    expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(String(v2.length));

    // 用户手动编辑并保存（版本前移 ≠ aiVersion）→ 撤销窗口立即失效。
    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    putDeckArtifactMock.mockResolvedValueOnce({ ok: true, artifact_id: 'art-user', version: 'v-user', changed: true });
    fireEvent.click(screen.getByTestId('deck-rich-editor-save'));
    await waitFor(() => expect(putDeckArtifactMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('deck-ai-undo-banner')).not.toBeInTheDocument());
    // 保存的正是用户字节（base 为 AI 版本）。
    const [, userBytes, userBase] = putDeckArtifactMock.mock.calls[0];
    expect(Array.from(userBytes as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(userBase).toBe('v2');
  });

  test('#review-3 409 冲突：重建基线后自动重试，不再死锁、不丢用户编辑', { timeout: 15_000 }, async () => {
    await seedTwoVersions();
    render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-simulate-edit');

    // 第一次 PUT 409（其他窗口），rebase 时 GET 返回 v2；第二次 PUT 成功。
    putDeckArtifactMock
      .mockRejectedValueOnce(mkApiError(409, '{"error":{"code":"deck_conflict"}}'))
      .mockResolvedValueOnce({ ok: true, artifact_id: 'art-rebased', version: 'v-rebased', changed: true });

    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    // 409 → rebase（getDeckArtifact 第二调）→ 2.5s 后重试 → 成功清 dirty。
    await waitFor(() => expect(putDeckArtifactMock).toHaveBeenCalledTimes(2), { timeout: 9000 });
    const [docArg1] = putDeckArtifactMock.mock.calls[0];
    const [docArg2, , base2] = putDeckArtifactMock.mock.calls[1];
    expect(docArg1).toBe('d1');
    expect(base2).toBe('v2'); // 重试基于 rebase 后的服务端版本
    expect(docArg2).toBe('d1');
    await waitFor(() => expect(screen.getByText('已同步')).toBeInTheDocument(), { timeout: 9000 });
  });

  test('#review-4 AI 落地单飞：并发到达的新旧版本不交错，最终收敛到最新', { timeout: 15_000 }, async () => {
    // mount v1；v2 GET 挂起；期间到达 v3 → 单飞后按最新排队续拉。
    const v1 = await buildPptxFixture();
    const v2Bytes = new Uint8Array(999).fill(7);
    const v3Bytes = new Uint8Array(777).fill(5);
    const meta = (version: string, file: string) => ({
      artifact_id: `art-${version}`, version,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      updated_at: '2026-01-01T00:00:00Z', download_url: `/api/v1/files/${file}/download?token=t`,
    });
    // 对象持有 resolve：回调内赋值对 TS 控制流可见（裸 let 会被窄化为 never）。
    const deferred: { resolve: ((v: unknown) => void) | null } = { resolve: null };
    getDeckArtifactMock
      .mockResolvedValueOnce(meta('v1', 'f1'))
      .mockImplementationOnce(() => new Promise((resolve) => { deferred.resolve = resolve; }))
      .mockResolvedValueOnce(meta('v3', 'f3'))
      .mockResolvedValue(meta('v4', 'f3'));
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/f1/')) return new Response(v1.buffer as ArrayBuffer, { status: 200 });
      if (u.includes('/f2/')) return new Response(v2Bytes.buffer as ArrayBuffer, { status: 200 });
      return new Response(v3Bytes.buffer as ArrayBuffer, { status: 200 });
    }));

    const { rerender } = render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-stub');
    rerender(<Harness docId="d1" aiDeckVersion="v2" turnBoundary={0} />);
    await waitFor(() => expect(getDeckArtifactMock).toHaveBeenCalledTimes(2));
    // v2 在飞期间 v3 到达（若并发会交错覆盖）→ 单飞：v2 完成后再拉 v3。
    rerender(<Harness docId="d1" aiDeckVersion="v3" turnBoundary={0} />);
    deferred.resolve?.(meta('v2', 'f2'));
    await waitFor(() => expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(String(v3Bytes.length)), { timeout: 5000 });
    // 最终版本 = v3（base 前移）；撤销快照只捕获一次（本轮）。
    expect(getDeckArtifactMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test('#review-5 AI 字节拉取瞬时失败：排队保留 + 自动重试收敛，不永久卡旧内容', { timeout: 15_000 }, async () => {
    // 独立链：装载 v1 → AI 同步首次失败 → 重试成功 v2。
    const v1 = await buildPptxFixture();
    const v2 = new Uint8Array(999).fill(7);
    const meta = (version: string, file: string) => ({
      artifact_id: `art-${version}`, version,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      updated_at: '2026-01-01T00:00:00Z', download_url: `/api/v1/files/${file}/download?token=t`,
    });
    getDeckArtifactMock
      .mockResolvedValueOnce(meta('v1', 'f1'))
      .mockRejectedValueOnce(new Error('transient network'))
      .mockResolvedValue(meta('v2', 'f2'));
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/f2/') ? new Response(v2.buffer as ArrayBuffer, { status: 200 }) : new Response(v1.buffer as ArrayBuffer, { status: 200 })));

    const { rerender } = render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-simulate-edit');
    rerender(<Harness docId="d1" aiDeckVersion="v2" turnBoundary={0} />);
    // 失败后排队提示仍在（版本未被丢弃）。
    await screen.findByTestId('deck-ai-queued-banner');
    // 3s 自动重试 → 拉到 v2 字节。
    await waitFor(() => expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent('999'), { timeout: 10_000 });
    expect(screen.queryByTestId('deck-ai-queued-banner')).not.toBeInTheDocument();
  });

  test('#1114 有未保存编辑：AI 写回不覆盖画布，排队等待；保存后自动应用', async () => {
    const { v2 } = await seedTwoVersions();
    const { rerender } = render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-simulate-edit');

    // 用户本地编辑（dirty，字节 [1,2,3,4]）。
    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    expect(screen.getByText('● 未保存')).toBeInTheDocument();

    rerender(<Harness docId="d1" aiDeckVersion="v2" turnBoundary={0} />);
    await screen.findByTestId('deck-ai-queued-banner');
    // 画布仍是用户未保存字节，未被 AI 覆盖；也没有提前拉 AI 字节。
    expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(/^4$/);
    expect(getDeckArtifactMock).toHaveBeenCalledTimes(1);

    // 保存本地编辑（PUT 成功）→ 排队写回自动应用。
    putDeckArtifactMock.mockResolvedValueOnce({ ok: true, artifact_id: 'art-user', version: 'v-user', changed: true });
    fireEvent.click(screen.getByTestId('deck-rich-editor-save'));
    await waitFor(() => expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(String(v2.length)), { timeout: 5000 });
    expect(screen.queryByTestId('deck-ai-queued-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('deck-ai-undo-banner')).toBeInTheDocument();
  });

  test('#1114 排队期间用户点击撤销本轮 → 排队写回一并作废（不被覆盖）', async () => {
    await seedTwoVersions();
    const { rerender } = render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-simulate-edit');

    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    rerender(<Harness docId="d1" aiDeckVersion="v2" turnBoundary={0} />);
    await screen.findByTestId('deck-ai-queued-banner');

    // 先保存本地（v-user），排队 v2 立即应用并弹出撤销横幅。
    putDeckArtifactMock.mockResolvedValueOnce({ ok: true, artifact_id: 'art-user', version: 'v-user', changed: true });
    fireEvent.click(screen.getByTestId('deck-rich-editor-save'));
    await screen.findByTestId('deck-ai-undo-banner');
    // 撤销 → 回滚到 AI 前（用户保存前快照）并清空排队。
    putDeckArtifactMock.mockResolvedValueOnce({ ok: true, artifact_id: 'art-back', version: 'v-back', changed: true });
    fireEvent.click(screen.getByTestId('deck-ai-undo'));
    await waitFor(() => expect(screen.queryByTestId('deck-ai-undo-banner')).not.toBeInTheDocument());
    expect(screen.queryByTestId('deck-ai-queued-banner')).not.toBeInTheDocument();
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

/**
 * P1 回归 — 拉取 AI 版本期间的用户编辑不得被覆盖。
 *
 * 此前 applyAiTurn 在 getDeckArtifact/fetch 返回后无条件 setContent：
 * 请求在飞期间用户开始编辑（generation 前移），AI 旧字节仍会盖回画布并
 * 清 dirty —— 用户刚打的编辑静默丢失。现在按编辑代数丢弃过期应用，
 * 排队版本保留，本地保存落地后再冲刷。
 */
describe('P1 DeckRichEditor 拉取竞态', () => {
  beforeEach(() => {
    getDeckArtifactMock.mockReset();
    putDeckArtifactMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  test('AI 版本拉取在飞时用户编辑 → 画布保留用户字节，AI 版本排队不丢', async () => {
    const v1 = await seedArtifact('v1');
    const { rerender } = render(<Harness docId="d1" />);
    await screen.findByTestId('pptx-viewer-stub');

    // 第二个 getDeckArtifact（AI 版本）手动控制返回时机。
    let releaseArtifact: (meta: unknown) => void = () => {};
    getDeckArtifactMock.mockImplementationOnce(() => new Promise((resolve) => { releaseArtifact = resolve; }));
    const aiBytes = new Uint8Array(777).fill(7);
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/f1/')
        ? new Response(v1.buffer as ArrayBuffer, { status: 200 })
        : new Response(aiBytes.buffer as ArrayBuffer, { status: 200 })));

    rerender(<Harness docId="d1" aiDeckVersion="v2" turnBoundary={0} />);
    await waitFor(() => expect(getDeckArtifactMock).toHaveBeenCalledTimes(2));

    // 拉取未返回：用户编辑画布（字节 4 + dirty）。
    fireEvent.click(screen.getByTestId('pptx-viewer-simulate-edit'));
    expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(/^4$/);

    // AI 版本此刻才返回 — 不得覆盖用户编辑。
    releaseArtifact({
      artifact_id: 'art-2', version: 'v2',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      updated_at: '2026-01-02T00:00:00Z', download_url: '/api/v1/files/f2/download?token=t',
    });
    await new Promise((r) => setTimeout(r, 80));

    expect(screen.getByTestId('pptx-viewer-content-length')).toHaveTextContent(/^4$/);
    // 本地编辑仍是未保存态（AI 应用不得清 dirty；顶部徽标 + 排队横幅均含
    // "未保存" 字样，至少一处可见）。
    expect(screen.getAllByText(/未保存/).length).toBeGreaterThan(0);
  });
});
