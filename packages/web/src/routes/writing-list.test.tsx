import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { WritingPage } from './writing';

/**
 * #995 — 写作列表批量删除(多选模式):
 * checkbox 选择 → 批量操作栏 → 确认 → batch-delete API → 列表移除;
 * confirm 取消不触发;部分删除(partial)提示。
 */

const apiMock = vi.hoisted(() => ({
  listDocs: vi.fn(),
  batchDeleteDocs: vi.fn(),
  deleteDoc: vi.fn(),
  listSubmissionDrafts: vi.fn(),
  listFormatTemplates: vi.fn(),
  listStudies: vi.fn(),
  createDoc: vi.fn(),
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

const DOCS = [
  { id: 'doc_aaaaaaaaaaaaaaaa', title: 'Doc A', updated_at: '2026-09-01T00:00:00Z', ref_count: 0 },
  { id: 'doc_bbbbbbbbbbbbbbbb', title: 'Doc B', updated_at: '2026-09-02T00:00:00Z', ref_count: 0 },
  { id: 'doc_cccccccccccccccc', title: 'Doc C', updated_at: '2026-09-02T00:00:00Z', ref_count: 0 },
];

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/app/writing?tab=write']}>
      <WritingPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  apiMock.listDocs.mockResolvedValue({ docs: [...DOCS] });
  apiMock.batchDeleteDocs.mockResolvedValue({ deleted: 2, requested: 2 });
  apiMock.listSubmissionDrafts.mockResolvedValue({ drafts: [] });
  apiMock.listFormatTemplates.mockResolvedValue({ templates: [] });
  apiMock.listStudies.mockResolvedValue([]);
});

describe('#995 写作列表批量删除', () => {
  test('勾选 2 篇 → 批量操作栏出现 → 确认后单请求批量删除,列表移除', async () => {
    renderList();
    await screen.findByText('Doc A');
    expect(screen.queryByText(/已选/)).toBeNull();

    const checkboxes = screen.getAllByLabelText(/选择文档|Select document/);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    expect(screen.getAllByText(/已选 2 篇|2 selected/).length).toBeGreaterThan(0);
    // Button 内含 icon + 文本 — 经文本锚点再点其宿主 button
    fireEvent.click(screen.getByText(/删除 2 篇|Delete 2 selected/).closest('button')!);

    await waitFor(() => expect(apiMock.batchDeleteDocs).toHaveBeenCalledTimes(1));
    expect(apiMock.batchDeleteDocs).toHaveBeenCalledWith([DOCS[0].id, DOCS[1].id]);
    await waitFor(() => expect(screen.queryByText('Doc A')).toBeNull());
    expect(screen.getByText('Doc C')).toBeTruthy();
    // 删除后多选态清零,批量操作栏消失
    expect(screen.queryByText(/已选/)).toBeNull();
  });

  test('confirm 取消 → 不发请求', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderList();
    await screen.findByText('Doc A');
    fireEvent.click(screen.getAllByLabelText(/选择文档|Select document/)[0]);
    fireEvent.click(screen.getByText(/删除 1 篇|Delete 1 selected/).closest('button')!);
    expect(apiMock.batchDeleteDocs).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('全选 → 剩余全进批量操作(先勾 1 篇再全选)', async () => {
    renderList();
    await screen.findByText('Doc A');
    fireEvent.click(screen.getAllByLabelText(/选择文档|Select document/)[0]);
    // 勾选后栏内按钮文案为「全选」(补齐其余) — 点它应到 3 篇
    fireEvent.click(screen.getByText(/全选|Select all/));
    expect(screen.getAllByText(/已选 3 篇|3 selected/).length).toBeGreaterThan(0);
  });
});
