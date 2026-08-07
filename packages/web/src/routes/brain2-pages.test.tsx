import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { render } from '@/test/render';
import { MedicalRecordsPage } from '@/routes/medical-records';
import { LabsPage } from '@/routes/labs';
import { AuditPage } from '@/routes/audit';
import { api } from '@/lib/api';
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

const entry = {
  id: 'mre_1',
  patientHash: 'p1',
  type: 'lab' as const,
  title: '血常规',
  date: '2026-07-30T00:00:00.000Z',
  content: '白细胞 12.3×10⁹/L (偏高)',
  aiSummary: 'WBC 偏高，提示感染可能',
  status: 'confirmed' as const,
  createdBy: 'system' as const,
  version: 1,
  linkedRecordIds: [],
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
};

const pendingEntry = { ...entry, id: 'mre_2', title: '胸部CT', type: 'imaging' as const, status: 'pending_review' as const, version: 2, content: '右肺上叶磨玻璃结节 8mm', aiSummary: undefined };

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MedicalRecordsPage (timeline)', () => {
  it('renders entries as a timeline with type/status badges and abnormal-value highlighting', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [entry, pendingEntry] }));

    render(
      <Routes>
        <Route path="/app/patients/:hash/records" element={<MedicalRecordsPage />} />
      </Routes>,
      { initialEntries: ['/app/patients/p1/records'] },
    );

    await waitFor(() => expect(screen.getByText('血常规')).toBeInTheDocument());
    expect(screen.getByText('胸部CT')).toBeInTheDocument();
    const timeline = within(screen.getByTestId('entries-timeline'));
    expect(timeline.getByText('lab')).toBeInTheDocument();
    expect(timeline.getByText('imaging')).toBeInTheDocument();
    expect(timeline.getByText('confirmed')).toBeInTheDocument();
    expect(timeline.getByText('pending_review')).toBeInTheDocument();
    // Abnormal value highlighted (in content and AI summary)
    expect(screen.getAllByText('偏高', { selector: 'mark' }).length).toBeGreaterThanOrEqual(1);
  });

  it('filters by status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [entry, pendingEntry] }));

    render(
      <Routes>
        <Route path="/app/patients/:hash/records" element={<MedicalRecordsPage />} />
      </Routes>,
      { initialEntries: ['/app/patients/p1/records'] },
    );
    await waitFor(() => expect(screen.getByText('血常规')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('按状态筛选'), { target: { value: 'confirmed' } });

    expect(screen.getByText('血常规')).toBeInTheDocument();
    expect(screen.queryByText('胸部CT')).not.toBeInTheDocument();
  });

  it('creates a new entry via the form (PATCH/versioning path on edit)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [] }));
    const createSpy = vi.spyOn(api, 'createMedicalRecordEntry').mockResolvedValue(entry);

    render(
      <Routes>
        <Route path="/app/patients/:hash/records" element={<MedicalRecordsPage />} />
      </Routes>,
      { initialEntries: ['/app/patients/p1/records'] },
    );
    await waitFor(() => expect(screen.getByText('暂无病历条目')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /新建条目/ }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '血常规' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'WBC 11.2' } });
    fireEvent.click(screen.getByRole('button', { name: /^保存$/ }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ type: 'note', title: '血常规', content: 'WBC 11.2', status: 'confirmed', createdBy: 'user' }),
    ));
  });

  it('edits an entry with PATCH (versioned update)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [entry] }));
    const updateSpy = vi.spyOn(api, 'updateMedicalRecordEntry').mockResolvedValue(entry);

    render(
      <Routes>
        <Route path="/app/patients/:hash/records" element={<MedicalRecordsPage />} />
      </Routes>,
      { initialEntries: ['/app/patients/p1/records'] },
    );
    await waitFor(() => expect(screen.getByText('血常规')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('编辑'));
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'WBC 12.5 (偏高)' } });
    fireEvent.click(screen.getByRole('button', { name: /^保存$/ }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(
      'p1',
      'mre_1',
      expect.objectContaining({ content: 'WBC 12.5 (偏高)' }),
    ));
  });
});

describe('LabsPage (ingestion status)', () => {
  it('shows ingestion job status incl. failure reasons', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([])) // uploads
      .mockResolvedValueOnce(jsonResponse({ jobs: [
        { id: 'ing_1', fileId: 'f1', fileName: 'lab.pdf', mimeType: 'application/pdf', patientHash: 'p1', uploadedBy: 'u1', status: 'awaiting_review', confidence: 'high', retryCount: 0, createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z' },
        { id: 'ing_2', fileId: 'f2', fileName: 'broken.dcm', mimeType: 'application/dicom', patientHash: 'p1', uploadedBy: 'u1', status: 'failed', failedReason: 'analysis failed after 3 attempts: parse error', retryCount: 3, createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z' },
      ] }));

    render(
      <Routes>
        <Route path="/app/patients/:hash/labs" element={<LabsPage />} />
      </Routes>,
      { initialEntries: ['/app/patients/p1/labs'] },
    );

    await waitFor(() => expect(screen.getByText('AI 分析状态')).toBeInTheDocument());
    expect(screen.getByText('lab.pdf')).toBeInTheDocument();
    expect(screen.getByText('awaiting_review')).toBeInTheDocument();
    expect(screen.getByText('待审批')).toBeInTheDocument();
    expect(screen.getByText('broken.dcm')).toBeInTheDocument();
    expect(screen.getByText(/analysis failed after 3 attempts/)).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();
  });
});

describe('AuditPage', () => {
  it('lists audit records with filters', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ logs: [
      { id: 'log_1', actor: 'user_a', action: 'approval.confirmed', targetType: 'MedicalRecordEntry', targetId: 'mre_1', createdAt: '2026-07-30T00:00:00.000Z', entry: { id: 'mre_1', patientHash: 'p1', title: '血常规', type: 'lab' } },
      { id: 'log_2', actor: 'user_b', action: 'approval.rejected', targetType: 'MedicalRecordEntry', targetId: 'mre_2', reason: '重复报告', createdAt: '2026-07-30T01:00:00.000Z' },
    ] }));

    render(<AuditPage />);

    await waitFor(() => expect(screen.getByText('审计日志')).toBeInTheDocument());
    const auditList = within(screen.getByTestId('audit-list'));
    expect(auditList.getByText('approval.confirmed')).toBeInTheDocument();
    expect(auditList.getByText('approval.rejected')).toBeInTheDocument();
    expect(auditList.getByText('user_a')).toBeInTheDocument();
    expect(auditList.getByText('重复报告')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('按操作筛选'), { target: { value: 'approval.confirmed' } });
    expect(auditList.queryByText('approval.rejected')).not.toBeInTheDocument();
  });

  it('shows empty state', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ logs: [] }));

    render(<AuditPage />);

    await waitFor(() => expect(screen.getByText('暂无审计记录')).toBeInTheDocument());
  });
});
