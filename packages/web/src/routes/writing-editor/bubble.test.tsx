import { describe, test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import i18n from '@/i18n';
import { usePolishBubble, findUniqueTextRange } from './bubble';
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
          // #926: 四态抽查 — error chunk 哨兵(服务端错误经 SSE error 事件送达)。
          if (text === '__ERROR__') {
            yield { type: 'error', message: '润色服务超时' };
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

// #927: C3 漂移重锚 — 漂移后按 snap.original 全文唯一命中重定位,未命中/
// 多命中维持拒绝行为。findUniqueTextRange 用极简替身复刻 prosemirror
// 遍历顺序(段落在前、文本节点随后,坐标 = 段开位置/内容起始)。
describe('#927 C3 漂移重锚', () => {
  /** 复刻 prosemirror 单层段落文档的 nodesBetween 顺序与坐标:
   *  每段占 [nodePos, nodePos + 2 + len),文本节点位于 nodePos+1。 */
  function fakeDoc(blocks: string[]) {
    const calls: Array<{ node: any; pos: number }> = [];
    let pos = 0;
    let size = 2;
    for (const text of blocks) {
      calls.push({ node: { isText: false, isBlock: true }, pos });
      calls.push({ node: { isText: true, text, isBlock: false }, pos: pos + 1 });
      size += text.length + 2;
      pos += text.length + 2;
    }
    return {
      content: { size },
      nodesBetween: (_from: number, _to: number, cb: (node: any, pos: number) => void) => {
        for (const c of calls) cb(c.node, c.pos);
      },
    } as any;
  }

  test('唯一命中 → 返回 ProseMirror 坐标(单块/跨块/多段文档)', () => {
    // ["hello","world"] → 文本 "hello\nworld";t1@1,t2@8,size 14
    const doc = fakeDoc(['hello', 'world']);
    expect(findUniqueTextRange(doc, 'hello')).toEqual({ from: 1, to: 6 });
    expect(findUniqueTextRange(doc, 'world')).toEqual({ from: 8, to: 13 });
    // 跨块选区(needle 含块分隔符)
    expect(findUniqueTextRange(doc, 'hello\nworld')).toEqual({ from: 1, to: 13 });
    expect(findUniqueTextRange(doc, 'lo\nwo')).toEqual({ from: 4, to: 10 });
  });

  test('未命中/多命中/空 needle → null(维持拒绝行为,不猜)', () => {
    const doc = fakeDoc(['hello', 'world']);
    expect(findUniqueTextRange(doc, 'xyz')).toBeNull();
    expect(findUniqueTextRange(fakeDoc(['hello', 'hello']), 'hello')).toBeNull();
    expect(findUniqueTextRange(doc, '')).toBeNull();
  });

  test('漂移后重锚应用:坐标更新到唯一命中处;多命中维持拒绝', async () => {
    let drift = false;
    const insertRanges: Array<unknown> = [];
    const makeDriftedEditor = (duplicate: boolean) => ({
      state: {
        selection: { from: 2, to: 7 },
        doc: {
          // C3 检查点:漂移开关翻转后,snap.from/to 处的文本变为 'jello'
          textBetween: (from: number, to: number) => (from === 2 && to === 7 ? (drift ? 'jello' : 'hello') : 'hello'),
          content: { size: 12 },
          // 单段落 "hello tail":段@0,文本@1(len 10);多命中场景两段同文
          nodesBetween: (_f: number, _t: number, cb: (node: any, pos: number) => void) => {
            if (duplicate) {
              cb({ isText: false, isBlock: true }, 0);
              cb({ isText: true, text: 'hello', isBlock: false }, 1);
              cb({ isText: false, isBlock: true }, 7);
              cb({ isText: true, text: 'hello', isBlock: false }, 8);
              return;
            }
            cb({ isText: false, isBlock: true }, 0);
            cb({ isText: true, text: 'hello tail', isBlock: false }, 1);
          },
        },
      },
      chain: () => {
        const c: { focus: () => unknown; insertContentAt: (r: unknown) => unknown; run: () => void } = {
          focus: () => c,
          insertContentAt: (r: unknown) => { insertRanges.push(r); return c; },
          run: () => {},
        };
        return c;
      },
      getHTML: () => '<p>hello tail</p>',
      view: { dom: document.createElement('div') },
    } as unknown as Editor);

    const runToDone = async (result: { current: ReturnType<typeof usePolishBubble> }) => {
      // handleBubbleAction 记录 bubbleSel 并以空指令开流(rewrite 预设)。
      await act(async () => { result.current.handleBubbleAction('rewrite', { text: 'hello', from: 2, to: 7 }); });
      const entry = streams[streams.length - 1];
      entry.chunks.push('AI 结果', '__END__');
      entry.waiters.forEach((w) => w());
      entry.waiters.length = 0;
      await act(async () => { await wait(); });
      expect(result.current.bubbleRun?.status).toBe('done');
    };

    // 场景 A:漂移但全文唯一命中 → 重定位坐标应用
    {
      createSnapshotMock.mockReset();
      createSnapshotMock.mockResolvedValue({ ok: true });
      const editorRef = { current: makeDriftedEditor(false) };
      const onNotice = vi.fn();
      const { result } = renderHook(() => usePolishBubble({ docId: 'doc-1', editorRef, onNotice }), { wrapper });
      await runToDone(result);
      drift = true; // 应用时刻选区文本已漂移
      insertRanges.length = 0;
      await act(async () => { result.current.handleBubbleApply('AI 结果'); await wait(10); });
      // snap.original('hello',来自 runPolish 时的 textBetween(2,7))在全文
      // 唯一命中于文本节点@1 → 坐标重定位为 {from:1,to:6}。
      expect(insertRanges).toEqual([{ from: 1, to: 6 }]);
      expect(onNotice).not.toHaveBeenCalledWith(expect.stringMatching(/选区内容已变化|Selection content changed/), 4000);
    }

    // 场景 B:漂移且全文两处命中 → 维持拒绝行为(提示 + 不替换)
    {
      drift = false; // runToDone 期间未漂移,snap.original 仍为 'hello'
      const editorRef = { current: makeDriftedEditor(true) };
      const onNotice = vi.fn();
      const { result } = renderHook(() => usePolishBubble({ docId: 'doc-1', editorRef, onNotice }), { wrapper });
      await runToDone(result);
      drift = true;
      insertRanges.length = 0;
      await act(async () => { result.current.handleBubbleApply('AI 结果'); await wait(10); });
      expect(insertRanges).toEqual([]);
      expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/选区内容已变化|Selection content changed/), 4000);
    }
  });
});

// #926: 四态缺口抽查 — 既有覆盖只到达 running/done;input(polish 自定义
// 指令态)与 error(SSE error 事件)两条转移此前零覆盖,补最小用例。
describe('#926 气泡四态抽查(input / error 转移)', () => {
  test('polish 动作先入 input 态;开始后 input→running,流完成 done', async () => {
    const editorRef = { current: fakeEditor };
    const { result } = renderHook(
      () => usePolishBubble({ docId: 'doc-1', editorRef, onNotice: () => {} }),
      { wrapper },
    );

    await act(async () => { result.current.handleBubbleAction('polish', { text: 'hello', from: 2, to: 7 }); });
    expect(result.current.bubbleRun?.status).toBe('input');

    // onStart 语义 = runPolish(instruction, 'polish')(路由层同一调用)。
    await act(async () => { void result.current.runPolish('压到 200 字', 'polish'); });
    expect(result.current.bubbleRun?.status).toBe('running');

    const entry = streams[streams.length - 1];
    entry.chunks.push('润色完成', '__END__');
    entry.waiters.forEach((w) => w());
    entry.waiters.length = 0;
    await act(async () => { await wait(); });
    expect(result.current.bubbleRun?.status).toBe('done');
    expect(result.current.bubbleRun?.stream).toContain('润色完成');
  });

  test('error 事件 → running 转 error 并带错误文案;重试 error→running→done', async () => {
    const editorRef = { current: fakeEditor };
    const onNotice = vi.fn();
    const { result } = renderHook(() => usePolishBubble({ docId: 'doc-1', editorRef, onNotice }), { wrapper });

    await act(async () => { result.current.handleBubbleAction('rewrite', { text: 'hello', from: 2, to: 7 }); });
    expect(result.current.bubbleRun?.status).toBe('running');

    const entry = streams[streams.length - 1];
    entry.chunks.push('__ERROR__');
    entry.waiters.forEach((w) => w());
    entry.waiters.length = 0;
    await act(async () => { await wait(); });
    expect(result.current.bubbleRun?.status).toBe('error');
    expect(result.current.bubbleRun?.error).toContain('润色服务超时');

    // 原地重试:同一动作开新流,可正常完成。
    await act(async () => { result.current.handleBubbleRetry(); });
    expect(result.current.bubbleRun?.status).toBe('running');
    const retry = streams[streams.length - 1];
    retry.chunks.push('重试结果', '__END__');
    retry.waiters.forEach((w) => w());
    retry.waiters.length = 0;
    await act(async () => { await wait(); });
    expect(result.current.bubbleRun?.status).toBe('done');
    expect(result.current.bubbleRun?.stream).toContain('重试结果');
  });
});
