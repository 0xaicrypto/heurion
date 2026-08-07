import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import type { ApprovalRequest, AuditLogEntry, IngestionJob, MedicalRecordEntry } from './types';

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

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Brain 2.0 api-client', () => {
  const entry: MedicalRecordEntry = {
    id: 'mre_abc',
    patientHash: 'p1',
    type: 'lab',
    title: 'CBC',
    date: '2026-07-30T00:00:00.000Z',
    content: 'WBC 11.2',
    status: 'pending_review',
    createdBy: 'system',
    version: 1,
    linkedRecordIds: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  };

  it('listMedicalRecordEntries calls GET /api/v1/patients/:hash/medical-records with filters', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ records: [entry] }));

    const res = await api.listMedicalRecordEntries('p1', { type: 'lab', status: 'pending_review' });

    expect(res.records).toEqual([entry]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/patients/p1/medical-records?type=lab&status=pending_review',
      expect.any(Object),
    );
  });

  it('listMedicalRecordEntries omits query string when no filters', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ records: [] }));
    await api.listMedicalRecordEntries('p1');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/patients/p1/medical-records', expect.any(Object));
  });

  it('createMedicalRecordEntry POSTs JSON body with Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(entry, 201));
    const draft = { type: 'lab' as const, title: 'CBC', content: 'WBC 11.2' };

    const res = await api.createMedicalRecordEntry('p1', draft);

    expect(res.id).toBe('mre_abc');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(draft);
    const headers = init.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBeNull();
  });

  it('updateMedicalRecordEntry uses PATCH with partial data', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...entry, status: 'confirmed' }));

    await api.updateMedicalRecordEntry('p1', 'mre_abc', { status: 'confirmed' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'confirmed' });
  });

  it('deleteMedicalRecordEntry uses DELETE', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deleted: true }));

    await api.deleteMedicalRecordEntry('p1', 'mre_abc');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/patients/p1/medical-records/mre_abc',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('listPendingApprovals calls GET /api/v1/approvals/pending', async () => {
    const request: ApprovalRequest = {
      id: 'apr_1',
      userId: 'u1',
      targetType: 'MedicalRecordEntry',
      targetId: 'mre_abc',
      status: 'pending',
      createdAt: '2026-07-30T00:00:00.000Z',
    };
    fetchMock.mockResolvedValue(jsonResponse({ requests: [request] }));

    const res = await api.listPendingApprovals({ targetType: 'MedicalRecordEntry' });

    expect(res.requests).toEqual([request]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/approvals/pending?targetType=MedicalRecordEntry',
      expect.any(Object),
    );
  });

  it('confirmApproval POSTs to /api/v1/approvals/:id/confirm', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'apr_1', status: 'approved' }));

    await api.confirmApproval('apr_1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/approvals/apr_1/confirm',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejectApproval sends reason in body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'apr_1', status: 'rejected', reason: 'duplicate' }));

    await api.rejectApproval('apr_1', 'duplicate');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'duplicate' });
  });

  it('listAuditLogs passes filters as query params', async () => {
    const log: AuditLogEntry = {
      id: 'log_1',
      actor: 'u1',
      action: 'approval.confirmed',
      targetType: 'MedicalRecordEntry',
      targetId: 'mre_abc',
      createdAt: '2026-07-30T00:00:00.000Z',
    };
    fetchMock.mockResolvedValue(jsonResponse({ logs: [log] }));

    const res = await api.listAuditLogs({ targetType: 'MedicalRecordEntry', actor: 'u1' });

    expect(res.logs).toEqual([log]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/audit?targetType=MedicalRecordEntry&actor=u1',
      expect.any(Object),
    );
  });

  it('listIngestionJobs calls GET /api/v1/ingestion/jobs with patient_hash', async () => {
    const job: IngestionJob = {
      id: 'ing_1',
      userId: 'u1',
      fileId: 'f1',
      fileName: 'cbc.pdf',
      mimeType: 'application/pdf',
      patientHash: 'p1',
      uploadedBy: 'u1',
      status: 'awaiting_review',
      confidence: 'high',
      retryCount: 0,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [job] }));

    const res = await api.listIngestionJobs('p1');

    expect(res.jobs).toEqual([job]);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/ingestion/jobs?patient_hash=p1', expect.any(Object));
  });

  it('getIngestionJobStatus fetches a single job', async () => {
    const job: IngestionJob = {
      id: 'ing_1',
      userId: 'u1',
      fileId: 'f1',
      fileName: 'cbc.pdf',
      mimeType: 'application/pdf',
      uploadedBy: 'u1',
      status: 'failed',
      failedReason: 'no analyzer',
      retryCount: 0,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    fetchMock.mockResolvedValue(jsonResponse(job));

    const res = await api.getIngestionJobStatus('ing_1');

    expect(res.status).toBe('failed');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/ingestion/jobs/ing_1', expect.any(Object));
  });

  it('rejects on 4xx/5xx with ApiError carrying status and message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Entry not found' }, 404));

    await expect(api.listMedicalRecordEntries('p1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      path: '/api/v1/patients/p1/medical-records',
    });
    const err = await api.listMedicalRecordEntries('p1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).messageText).toBe('Entry not found');
  });
});
