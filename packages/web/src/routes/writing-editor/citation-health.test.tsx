/**
 * #1081 — 悬挂引用可视化提示与清理入口（组件测试）。
 *
 * Mock 策略：mock @/lib/api（diagnostics/delete），jsdom 渲染断言。
 * 用例：1) 有悬挂 → 警示横幅渲染（不崩溃、不静默隐藏）
 *      2) 「删除该引用」→ DELETE 调用 + 条目移除
 *      3) 「重新检索绑定」→ sendChatText 携带 insert_citation 引导指令
 *      4) 多个悬挂引用各自独立可处理，互不影响
 *      5) 无悬挂 → 不渲染（零噪音）
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { CitationHealthBanner } from './citation-health';

const apiMock = vi.hoisted(() => ({
  listDanglingCitations: vi.fn(),
  deleteDocCitation: vi.fn(),
  removeDanglingCitation: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: apiMock }));

const DOC = 'd1';
const ITEM_A = { id: 'cite_ghostA', occurrences: 2 };
const ITEM_B = { id: 'cite_ghostB', occurrences: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.deleteDocCitation.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe('#1081 悬挂引用可视化与清理', () => {
  test('正文含未知 citationId → 警示横幅渲染（不崩溃、不静默）', async () => {
    apiMock.listDanglingCitations.mockResolvedValue({ dangling: [ITEM_A], citations: [] });
    render(<CitationHealthBanner docId={DOC} />);
    await waitFor(() => expect(screen.getByTestId('citation-dangling-banner')).toBeTruthy());
    expect(screen.getByTestId('citation-dangling-banner').textContent).toContain('悬挂引用');
    expect(screen.getByTestId('citation-dangling-item').getAttribute('data-citation-id')).toBe('cite_ghostA');
  });

  test('复审 #2 — 点击「删除该引用」→ 以客户端基线调用清除端点 + 新正文同步', async () => {
    apiMock.listDanglingCitations.mockResolvedValue({ dangling: [ITEM_A], citations: [] });
    apiMock.removeDanglingCitation.mockResolvedValue({ ok: true, body: '正文已无标记', deck: null, removed: 2 });
    const onCleanupApplied = vi.fn();
    const onNotice = vi.fn();
    render(
      <CitationHealthBanner
        docId={DOC}
        currentBody="用户正在编辑的未保存正文 [cite:cite_ghostA]"
        serverBase="服务端基线"
        onCleanupApplied={onCleanupApplied}
        onNotice={onNotice}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('citation-dangling-item')).toBeTruthy());
    fireEvent.click(screen.getByTestId('citation-dangling-delete-cite_ghostA'));
    // 复审 #2: 客户端当前正文作为 base_body 随请求传输 — 用户未保存编辑参与
    // 清除计算，服务端旧版本不覆盖未保存修改
    await waitFor(() =>
      expect(apiMock.removeDanglingCitation).toHaveBeenCalledWith(DOC, 'cite_ghostA', {
        base_body: '用户正在编辑的未保存正文 [cite:cite_ghostA]',
        server_base: '服务端基线',
        base_deck: undefined,
      }),
    );
    expect(apiMock.deleteDocCitation).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('citation-dangling-item')).toBeNull());
    // 新正文同步到编辑器 + 成功提示可见（空 catch 静默退役）
    await waitFor(() => expect(onCleanupApplied).toHaveBeenCalledWith({ body: '正文已无标记', deck: null }));
    expect(onNotice).toHaveBeenCalled();
  });

  test('复审 #3 — currentDeck 基线随请求传给服务端（deck 内悬挂同帧清除）', async () => {
    apiMock.listDanglingCitations.mockResolvedValue({ dangling: [ITEM_A], citations: [] });
    apiMock.removeDanglingCitation.mockResolvedValue({ ok: true, body: '正文', deck: '{"slides":[]}', removed: 1 });
    const onCleanupApplied = vi.fn();
    render(
      <CitationHealthBanner
        docId={DOC}
        currentBody="B [cite:cite_ghostA]"
        serverBase="B [cite:cite_ghostA]"
        currentDeck={'{"slides":[{"title":"页 [cite:cite_ghostA]"}]}'}
        onCleanupApplied={onCleanupApplied}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('citation-dangling-item')).toBeTruthy());
    fireEvent.click(screen.getByTestId('citation-dangling-delete-cite_ghostA'));
    await waitFor(() =>
      expect(apiMock.removeDanglingCitation).toHaveBeenCalledWith(DOC, 'cite_ghostA', {
        base_body: 'B [cite:cite_ghostA]',
        server_base: 'B [cite:cite_ghostA]',
        base_deck: '{"slides":[{"title":"页 [cite:cite_ghostA]"}]}',
      }),
    );
    await waitFor(() => expect(onCleanupApplied).toHaveBeenCalledWith({ body: '正文', deck: '{"slides":[]}' }));
  });

  test('删除失败（含 409 并发冲突）→ 可见提示（不再空 catch 静默），条目保留可重试', async () => {
    apiMock.listDanglingCitations.mockResolvedValue({ dangling: [ITEM_A], citations: [] });
    apiMock.removeDanglingCitation.mockRejectedValue(new Error('409'));
    const onNotice = vi.fn();
    render(<CitationHealthBanner docId={DOC} onNotice={onNotice} />);
    await waitFor(() => expect(screen.getByTestId('citation-dangling-item')).toBeTruthy());
    fireEvent.click(screen.getByTestId('citation-dangling-delete-cite_ghostA'));
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('citation-dangling-item')).toBeTruthy());
  });

  test('点击「重新检索绑定」→ sendChatText 发出含 insert_citation 引导的指令', async () => {
    apiMock.listDanglingCitations.mockResolvedValue({ dangling: [ITEM_A], citations: [] });
    const sendChatText = vi.fn().mockResolvedValue(undefined);
    render(<CitationHealthBanner docId={DOC} sendChatText={sendChatText} />);
    await waitFor(() => expect(screen.getByTestId('citation-dangling-item')).toBeTruthy());
    fireEvent.click(screen.getByTestId('citation-dangling-rebind-cite_ghostA'));
    await waitFor(() => expect(sendChatText).toHaveBeenCalledTimes(1));
    const text = String(sendChatText.mock.calls[0][0]);
    expect(text).toContain('cite_ghostA');
    expect(text).toContain('search_citation');
    expect(text).toContain('DOI');
  });

  test('多个悬挂引用各自独立处理，互不影响', async () => {
    apiMock.listDanglingCitations.mockResolvedValue({ dangling: [ITEM_A, ITEM_B], citations: [] });
    apiMock.removeDanglingCitation.mockResolvedValue({ ok: true, body: 'x', deck: null, removed: 1 });
    render(<CitationHealthBanner docId={DOC} />);
    await waitFor(() => {
      const items = screen.getAllByTestId('citation-dangling-item');
      expect(items).toHaveLength(2);
    });
    fireEvent.click(screen.getByTestId('citation-dangling-delete-cite_ghostA'));
    await waitFor(() => expect(screen.getAllByTestId('citation-dangling-item')).toHaveLength(1));
    // B 仍在且可独立操作
    expect(screen.getByTestId('citation-dangling-item').getAttribute('data-citation-id')).toBe('cite_ghostB');
    expect(screen.getByTestId('citation-dangling-rebind-cite_ghostB')).toBeTruthy();
  });

  test('无悬挂 → 不渲染（零噪音）', async () => {
    apiMock.listDanglingCitations.mockResolvedValue({ dangling: [], citations: [] });
    render(<CitationHealthBanner docId={DOC} />);
    await waitFor(() => expect(apiMock.listDanglingCitations).toHaveBeenCalled());
    expect(screen.queryByTestId('citation-dangling-banner')).toBeNull();
  });
});
