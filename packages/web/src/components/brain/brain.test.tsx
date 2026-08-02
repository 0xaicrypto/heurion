import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { render } from '@/test/render';
import { IngestionInbox } from './IngestionInbox';
import { BrainStatsCards } from './BrainStatsCards';
import { RecentActivityFeed } from './RecentActivityFeed';
import { BrainPage } from '@/routes/brain';
import { api } from '@/lib/api-client';
import i18n from '@/i18n';

interface MockResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

const pendingRequest = {
  id: 'apr_1',
  userId: 'u1',
  targetType: 'MedicalRecordEntry',
  targetId: 'mre_1',
  status: 'pending',
  payload: {
    id: 'mre_1',
    patientHash: 'p1',
    type: 'lab',
    title: '血常规检查',
    date: '2026-07-30T00:00:00.000Z',
    content: '白细胞 12.3×10⁹/L (偏高)',
    status: 'pending_review',
    createdBy: 'system',
    version: 1,
    linkedRecordIds: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  },
  createdAt: '2026-07-30T00:00:00.000Z',
};

const secondRequest = {
  ...pendingRequest,
  id: 'apr_2',
  targetId: 'mre_2',
  payload: { ...pendingRequest.payload, id: 'mre_2', type: 'imaging', title: '胸部CT', patientHash: 'p2', content: '右肺上叶磨玻璃结节 8mm' },
};

function mockPatients() {
  return [
    { patient_hash: 'p1', name: '李小明', study_count: 0, created_at: '2026-01-01T00:00:00Z' },
    { patient_hash: 'p2', name: '张小丽', study_count: 0, created_at: '2026-01-01T00:00:00Z' },
  ];
}

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('IngestionInbox', () => {
  it('renders pending entries from multiple patients with type filter', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests: [pendingRequest, secondRequest] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<IngestionInbox />);

    await waitFor(() => expect(screen.getByText('李小明')).toBeInTheDocument());
    expect(screen.getByText('张小丽')).toBeInTheDocument();
    expect(screen.getByText('血常规检查')).toBeInTheDocument();
    expect(screen.getByText('胸部CT')).toBeInTheDocument();
    expect(screen.getAllByText('pending_review')).toHaveLength(2);
    expect(screen.getByText('白细胞 12.3×10⁹/L (偏高)')).toBeInTheDocument();
  });

  it('filters rows by type', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests: [pendingRequest, secondRequest] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<IngestionInbox />);
    await waitFor(() => expect(screen.getByText('李小明')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('按类型筛选'), { target: { value: 'imaging' } });

    expect(screen.getByText('张小丽')).toBeInTheDocument();
    expect(screen.queryByText('血常规检查')).not.toBeInTheDocument();
  });

  it('confirms a single entry and removes it from the list', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests: [pendingRequest, secondRequest] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    const onChanged = vi.fn();
    render(<IngestionInbox onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText('李小明')).toBeInTheDocument());

    const confirmSpy = vi.spyOn(api, 'confirmApproval').mockResolvedValue({ ...pendingRequest, status: 'approved' });

    fireEvent.click(screen.getAllByRole('button', { name: /^确认$/ })[0]);

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith('apr_1'));
    await waitFor(() => expect(screen.queryByText('血常规检查')).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalled();
  });

  it('rejects via dialog with reason', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests: [pendingRequest] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<IngestionInbox />);
    await waitFor(() => expect(screen.getByText('李小明')).toBeInTheDocument());

    const rejectSpy = vi.spyOn(api, 'rejectApproval').mockResolvedValue({ ...pendingRequest, status: 'rejected' });

    fireEvent.click(screen.getAllByRole('button', { name: /^拒绝$/ })[0]);
    const input = await screen.findByPlaceholderText('原因（选填）');
    fireEvent.change(input, { target: { value: '重复报告' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^拒绝$/ }));

    await waitFor(() => expect(rejectSpy).toHaveBeenCalledWith('apr_1', '重复报告'));
    await waitFor(() => expect(screen.getByText('所有分析结果已处理')).toBeInTheDocument());
  });

  it('batch confirms selected entries', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests: [pendingRequest, secondRequest] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<IngestionInbox />);
    await waitFor(() => expect(screen.getByText('李小明')).toBeInTheDocument());

    const confirmSpy = vi.spyOn(api, 'confirmApproval').mockResolvedValue({ ...pendingRequest, status: 'approved' });
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole('button', { name: /批量确认/ }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith('apr_1');
      expect(confirmSpy).toHaveBeenCalledWith('apr_2');
    });
    await waitFor(() => expect(screen.getByText('所有分析结果已处理')).toBeInTheDocument());
  });

  it('shows empty state when nothing pending', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<IngestionInbox />);

    await waitFor(() => expect(screen.getByText('所有分析结果已处理')).toBeInTheDocument());
    expect(screen.getByText('暂无需审批的条目')).toBeInTheDocument();
  });

  it('renders error without crashing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));

    render(<IngestionInbox />);

    await waitFor(() => expect(screen.getByText(/boom/i)).toBeInTheDocument());
  });
});

describe('BrainStatsCards', () => {
  it('renders three stat cards from stats', () => {
    render(<BrainStatsCards stats={{ pending: 12, confirmedToday: 5, totalEntries: 247 }} loading={false} />);

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('247')).toBeInTheDocument();
    expect(screen.getByText('待审批')).toBeInTheDocument();
    expect(screen.getByText('今日已确认')).toBeInTheDocument();
    expect(screen.getByText('总条目数')).toBeInTheDocument();
  });

  it('renders skeletons while loading', () => {
    render(<BrainStatsCards stats={null} loading />);
    expect(document.querySelectorAll('.animate-pulse, [class*="animate-pulse"]').length).toBeGreaterThan(0);
  });
});

describe('RecentActivityFeed', () => {
  it('renders audit logs with patient names', async () => {
    const logs = [
      {
        id: 'log_1',
        actor: 'u1',
        action: 'approval.confirmed',
        targetType: 'MedicalRecordEntry',
        targetId: 'mre_1',
        createdAt: '2026-07-30T00:00:00.000Z',
        entry: { id: 'mre_1', patientHash: 'p1', title: '血常规检查', type: 'lab' },
      },
      {
        id: 'log_2',
        actor: 'u1',
        action: 'approval.rejected',
        targetType: 'MedicalRecordEntry',
        targetId: 'mre_2',
        createdAt: '2026-07-30T01:00:00.000Z',
        entry: { id: 'mre_2', patientHash: 'p2', title: '胸部CT', type: 'imaging' },
      },
    ];
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ logs }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<RecentActivityFeed refreshKey={0} />);

    await waitFor(() => expect(screen.getByText(/确认了 血常规检查/)).toBeInTheDocument());
    expect(screen.getByText(/李小明 ·/)).toBeInTheDocument();
    expect(screen.getByText(/拒绝了 胸部CT/)).toBeInTheDocument();
    expect(screen.getByText(/张小丽 ·/)).toBeInTheDocument();
  });

  it('shows empty state', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ logs: [] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<RecentActivityFeed refreshKey={0} />);

    await waitFor(() => expect(screen.getByText('暂无活动记录')).toBeInTheDocument());
  });
});

describe('BrainPage', () => {
  it('renders stats, inbox and activity feed together', async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url)
      if (u.includes('/brain/stats')) return Promise.resolve(jsonResponse({ pending: 12, confirmedToday: 5, totalEntries: 247 }))
      if (u.includes('/approvals/pending')) return Promise.resolve(jsonResponse({ requests: [pendingRequest] }))
      if (u.includes('/audit')) return Promise.resolve(jsonResponse({ logs: [] }))
      return Promise.resolve(jsonResponse(mockPatients()))
    });

    render(<BrainPage />);

    await waitFor(() => expect(screen.getByText('Brain · 概览')).toBeInTheDocument());
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('247')).toBeInTheDocument();
    expect(screen.getByText('李小明')).toBeInTheDocument();
    expect(screen.getByText('暂无活动记录')).toBeInTheDocument();
  });
});
