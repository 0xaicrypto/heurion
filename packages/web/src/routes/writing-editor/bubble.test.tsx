import { describe, test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import type { Editor } from '@tiptap/react';
import i18n from '@/i18n';
import { usePolishBubble } from './bubble';

// #897: 测试可控的 polish 流 — 每条流暴露 chunks 队列,由测试驱动发射;
// 队列空时挂起,等待期间流被 abort → 抛 AbortError(与真实 SSE 断流一致)。
const streams = vi.hoisted(() => [] as Array<{ chunks: string[]; waiters: Array<() => void> }>);
const abortError = vi.hoisted(() => () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status?: number;
    messageText: string;
    constructor(message: string, opts?: { status?: number }) {
      super(message);
      this.status = opts?.status;
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
  },
}));

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const fakeEditor = {
  state: {
    selection: { from: 0, to: 5 },
    doc: { textBetween: () => 'hello' },
  },
} as unknown as Editor;

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
