import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { PendingIngestionsWidget } from './PendingIngestionsWidget';
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
    title: '血常规',
    date: '2026-07-30T00:00:00.000Z',
    content: 'WBC 11.2',
    status: 'pending_review',
    createdBy: 'system',
    version: 1,
    linkedRecordIds: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  },
  createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
};

function mockPatients() {
  return [{ patient_hash: 'p1', name: '李小明', study_count: 0, created_at: '2026-01-01T00:00:00Z' }];
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

describe('PendingIngestionsWidget', () => {
  it('renders pending entries with patient name, type badge and relative time', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests: [pendingRequest] }))
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<PendingIngestionsWidget />);

    await waitFor(() => expect(screen.getByText('李小明')).toBeInTheDocument());
    expect(screen.getByText('血常规')).toBeInTheDocument();
    expect(screen.getByText('lab')).toBeInTheDocument();
    expect(screen.getByText('30分钟前')).toBeInTheDocument();
    expect(screen.getByText('待审批的报告（1）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /确认/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /拒绝/i })).toBeInTheDocument();
  });

  it('shows empty state when nothing is pending', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<PendingIngestionsWidget />);

    await waitFor(() => expect(screen.getByText('所有报告已处理')).toBeInTheDocument());
  });

  it('renders error inside widget without throwing', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse([]));

    render(<PendingIngestionsWidget />);

    await waitFor(() => expect(screen.getByText(/boom/i)).toBeInTheDocument());
  });

  it('confirm calls confirmApproval and updates count via onCountChange', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests: [pendingRequest] }))
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    const onCountChange = vi.fn();
    render(<PendingIngestionsWidget onCountChange={onCountChange} />);
    await waitFor(() => expect(screen.getByText('血常规')).toBeInTheDocument());

    const confirmSpy = vi.spyOn(api, 'confirmApproval').mockResolvedValue({ ...pendingRequest, status: 'approved' });
    fetchMock.mockResolvedValue(jsonResponse({ requests: [] }));

    fireEvent.click(screen.getByRole('button', { name: /确认/i }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith('apr_1'));
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));
    await waitFor(() => expect(screen.getByText('所有报告已处理')).toBeInTheDocument());
  });

  it('reject works without a reason (reason optional, #149) and with one', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests: [pendingRequest] }))
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<PendingIngestionsWidget />);
    await waitFor(() => expect(screen.getByText('血常规')).toBeInTheDocument());

    const rejectSpy = vi.spyOn(api, 'rejectApproval').mockResolvedValue({ ...pendingRequest, status: 'rejected' });

    fireEvent.click(screen.getByRole('button', { name: /拒绝/i }));
    const input = await screen.findByPlaceholderText('原因（选填）');
    const rejectBtn = screen.getByRole('button', { name: /^拒绝$/ });
    // Empty reason does NOT disable the button anymore
    expect(rejectBtn).toBeEnabled();
    fireEvent.click(rejectBtn);

    await waitFor(() => expect(rejectSpy).toHaveBeenCalledWith('apr_1', ''));
    await waitFor(() => expect(screen.getByText('所有报告已处理')).toBeInTheDocument());
  });

  it('shows view-all link when count exceeds limit', async () => {
    const requests = Array.from({ length: 6 }, (_, i) => ({
      ...pendingRequest,
      id: `apr_${i}`,
      targetId: `mre_${i}`,
      payload: { ...pendingRequest.payload, id: `mre_${i}`, title: `报告 ${i}` },
      createdAt: new Date(Date.now() - i * 60_000).toISOString(),
    }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requests }))
      .mockResolvedValueOnce(jsonResponse({ requests: [] }))
      .mockResolvedValueOnce(jsonResponse(mockPatients()));

    render(<PendingIngestionsWidget limit={5} />);

    await waitFor(() => expect(screen.getByText('待审批的报告（6）')).toBeInTheDocument());
    expect(screen.getByText('查看全部 6 条待审批 → Brain')).toBeInTheDocument();
    expect(screen.queryByText('报告 5')).not.toBeInTheDocument();
  });
});
