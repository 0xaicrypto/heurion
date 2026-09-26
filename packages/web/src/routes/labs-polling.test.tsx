import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { render } from '@/test/render';
import { LabsPage } from '@/routes/labs';
import i18n from '@/i18n';

/**
 * P1 回归 — labs 页任务轮询不得"第一次就停"。
 *
 * 修复前：effect 用闭包里的初始 jobs=[] 判 hasActive → 首个 tick 后即
 * clearInterval；此后再有 pending/analyzing 任务状态永不刷新。
 */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let jobCalls = 0;

beforeEach(async () => {
  jobCalls = 0;
  fetchMock = vi.fn((url: RequestInfo | URL) => {
    const s = String(url);
    if (s.includes('/api/v1/files/uploads')) return Promise.resolve(jsonResponse([]));
    if (s.includes('/api/v1/ingestion/jobs')) {
      jobCalls++;
      return Promise.resolve(jsonResponse({ jobs: [{
        id: 'ing_1', fileId: 'f1', fileName: 'lab.pdf', mimeType: 'application/pdf',
        patientHash: 'p1', uploadedBy: 'u1', status: 'analyzing', retryCount: 0,
        createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z',
      }] }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('P1 LabsPage 轮询持续性', () => {
  it('首个 tick（pending 任务）后轮询继续，后续 tick 仍刷新状态', async () => {
    render(
      <Routes>
        <Route path="/app/patients/:hash/labs" element={<LabsPage />} />
      </Routes>,
      { initialEntries: ['/app/patients/p1/labs'] },
    );

    // 首个 tick 拉取到仍在分析的 job。
    await waitFor(() => expect(jobCalls).toBeGreaterThanOrEqual(1));

    // 3s 轮询间隔后必须还有第二次请求（修复前 interval 首个 tick 即被清掉）。
    await waitFor(() => expect(jobCalls).toBeGreaterThanOrEqual(2), { timeout: 6000 });
  }, 15000);
});
