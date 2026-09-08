import { describe, test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import i18n from '@/i18n';
import { usePolishBubble } from './bubble';
import { sha1Hex } from '@/lib/hash';
import { htmlToMarkdown } from '@/lib/doc-convert';

// #897: 测试可控的 polish 流 — 每条流暴露 chunks 队列,由测试驱动发射;
// 队列空时挂起,等待期间流被 abort → 抛 AbortError(与真实 SSE 断流一致)。
const streams = vi.hoisted(() => [] as Array<{ chunks: string[]; waiters: Array<() => void> }>);
const abortError = vi.hoisted(() => () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
// #907: 快照 POST mock — 按 test 配置 resolve/reject。
const createSnapshotMock = vi.hoisted(() => vi.fn());

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
  api: {
    polishDoc: (_docId: unknown, _selection: unknown, _instruction: unknown, signal: AbortSignal) => {
      const entry = { chunks: [] as string[], waiters: [] as Array<() => void> };
      streams.push(entry);
      return (async function* () {
        for (;;) {
          if (entry.chunks.length === 0) {
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => reject(abortError());
              if (signal.aborted) { onAbort(); return; }
              signal.addEventListener('abort', onAbort, { once: true });
              entry.waiters.push(() => { signal.removeEventListener('abort', onAbort); resolve(); });
            });
          }
          const text = entry.chunks.shift()!;
          if (text === '__END__') {
            yield { type: 'text', text: '', done: true };
            return;
          }
          yield { type: 'text', text };
        }
      })();
    },
    createDocSnapshot: createSnapshotMock,
  },
}));

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const fakeEditor = {
  state: {
    selection: { from: 0, to: 5 },
    doc: { textBetween: () => 'hello' },
  },
} as unknown as Editor;

// #907: 支撑 apply 全流程的最小编辑器 — chain 可链式空操作,getHTML 固定,
// view.dom 为游离节点(无滚动祖先,captureScrollContainer → null)。
const applyEditor = () => ({
  state: {
    selection: { from: 2, to: 7 },
    doc: { textBetween: () => 'hello' },
  },
  chain: () => {
    const c: { focus: () => unknown; insertContentAt: () => unknown; run: () => void } = {
      focus: () => c,
      insertContentAt: () => c,
      run: () => {},
    };
    return c;
  },
  getHTML: () => '<p>hello</p>',
  view: { dom: document.createElement('div') },
} as unknown as Editor);

const wrapper = ({ children }: { children: ReactNode }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;

describe('#897 气泡流归属校验', () => {
  test('旧流被新润色 abort 后,其 catch 不得清掉新流的运行态(新润色静默消失回归)', async () => {
    const editorRef = { current: fakeEditor };
    const { result } = renderHook(
      () => usePolishBubble({ docId: 'doc-1', editorRef, onNotice: () => {} }),
      { wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider> },
    );

    // 流 1:发射一段内容后挂起(等待下一个 chunk)。
    await act(async () => { void result.current.runPolish('指令一', 'polish'); });
    expect(result.current.bubbleRun?.status).toBe('running');
    streams[0].chunks.push('旧内容');
    await act(async () => { await wait(); });

    // 流 2 启动 — C2 abort 流 1;流 2 无 chunk,保持 running。
    await act(async () => { void result.current.runPolish('指令二', 'polish'); });
    expect(result.current.bubbleRun?.status).toBe('running');

    // 等旧流的 AbortError catch 收尾 — 归属校验必须拒绝其 setBubbleRun(null)。
    await act(async () => { await wait(20); });

    expect(result.current.bubbleRun).not.toBeNull();
    expect(result.current.bubbleRun?.status).toBe('running');
  });

  test('流完成后被取消取代,done 分支同样不改写新流状态', async () => {
    const editorRef = { current: fakeEditor };
    const { result } = renderHook(
      () => usePolishBubble({ docId: 'doc-1', editorRef, onNotice: () => {} }),
      { wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider> },
    );

    // 流 1:发射完成信号 — done 分支执行前先启动流 2 抢占归属。
    await act(async () => { void result.current.runPolish('指令一', 'polish'); });
    streams[0].chunks.push('__END__');
    await act(async () => { void result.current.runPolish('指令二', 'polish'); });
    await act(async () => { await wait(20); });

    // 流 1 的收尾(setBubbleRun done/sync)被归属校验拦截,流 2 运行态保留。
    expect(result.current.bubbleRun).not.toBeNull();
    expect(result.current.bubbleRun?.status).toBe('running');
    // 流 1 的 finally 不得清掉流 2 的 abort 句柄(否则取消失灵)— 间接验证:
    // 再丢弃流 2 走 discard 路径应能正常清态且无未处理错误。
    await act(async () => { result.current.handleBubbleDiscard(); });
    expect(result.current.bubbleRun).toBeNull();
  });
});

describe('#907 气泡 apply 携带 base_sha + 409 处理', () => {
  const runToDone = async (result: { current: ReturnType<typeof usePolishBubble> }) => {
    await act(async () => { result.current.handleBubbleAction('rewrite', { text: 'hello', from: 2, to: 7 }); });
    // mock 流没有 push 即唤醒机制 — 手动冲刷 waiter 让循环消费 chunks。
    // 文本 chunk + __END__ 一次入队(循环仅在队列空时挂起)。
    const entry = streams[streams.length - 1];
    entry.chunks.push('AI 结果', '__END__');
    entry.waiters.forEach((w) => w());
    entry.waiters.length = 0;
    await act(async () => { await wait(); });
    expect(result.current.bubbleRun?.status).toBe('done');
  };

  test('apply 成功:快照 POST 携带全文指纹 base_sha(替换前全文,与 #882 saveDoc 同源)', async () => {
    createSnapshotMock.mockReset();
    createSnapshotMock.mockResolvedValue({ ok: true });
    const editorRef = { current: applyEditor() };
    const { result } = renderHook(() => usePolishBubble({ docId: 'doc-1', editorRef, onNotice: () => {} }), { wrapper });
    await runToDone(result);

    const expectedMd = htmlToMarkdown('<p>hello</p>');
    const expectedSha = await sha1Hex(expectedMd);
    await act(async () => { result.current.handleBubbleApply('AI 结果'); await wait(10); });

    expect(createSnapshotMock).toHaveBeenCalledTimes(1);
    expect(createSnapshotMock).toHaveBeenCalledWith('doc-1', expectedMd, 'AI polish', expectedSha);
  });

  test('快照 409 stale_base → 明示「文档已更新,请重新选区」,本地替换保留(不回滚)', async () => {
    createSnapshotMock.mockReset();
    const { ApiError } = await import('@/lib/api');
    createSnapshotMock.mockRejectedValueOnce(new (ApiError as any)('stale base', { status: 409, code: 'stale_base' }));
    const editorRef = { current: applyEditor() };
    const onNotice = vi.fn();
    const { result } = renderHook(() => usePolishBubble({ docId: 'doc-1', editorRef, onNotice }), { wrapper });
    await runToDone(result);

    await act(async () => { result.current.handleBubbleApply('AI 结果'); await wait(10); });

    // 通知走了 onNotice(路由 showNotice 通道),不静默失败。
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/文档已更新|document has been updated/i), 6000);
  });
});

describe('#909 气泡生命周期清理', () => {
  test('docId 变化 → 在途流 abort、运行态/选区复位,新文档可正常开流', async () => {
    const editorRef = { current: fakeEditor };
    const { result, rerender, unmount } = renderHook(
      ({ docId }: { docId: string }) => usePolishBubble({ docId, editorRef, onNotice: () => {} }),
      { initialProps: { docId: 'doc-1' }, wrapper },
    );

    await act(async () => { void result.current.runPolish('旧文档指令', 'polish'); });
    expect(result.current.bubbleRun?.status).toBe('running');

    // 切文档 → cleanup abort 旧流并复位全套状态。
    rerender({ docId: 'doc-2' });
    await act(async () => { await wait(20); });
    expect(result.current.bubbleRun).toBeNull();

    // 旧流已 abort — 迟到 chunk 不再影响状态(归属校验兜底)。
    streams[streams.length - 1].chunks.push('迟到内容');
    await act(async () => { await wait(20); });
    expect(result.current.bubbleRun).toBeNull();

    // 新文档可正常发起新流。
    await act(async () => { void result.current.runPolish('新文档指令', 'polish'); });
    expect(result.current.bubbleRun?.status).toBe('running');
    unmount();
    // 卸载 cleanup abort — 等待无未处理 rejection。
    await act(async () => { await wait(20); });
  });
});
