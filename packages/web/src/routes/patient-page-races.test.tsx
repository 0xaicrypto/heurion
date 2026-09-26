import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { render } from '@/test/render';
import { ImagingPage } from '@/routes/imaging';
import { ReportPage } from '@/routes/report-page';
import i18n from '@/i18n';

/**
 * P1 回归 — 换患者后，上一个患者晚到的请求结果不得显示在新患者页面上。
 * 修复前 imaging / report-page 的 effect 无 cancelled 守卫：p1 的慢响应
 * 在切到 p2 之后落地，直接 setStudies/setPatient 覆盖新患者数据。
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

function Nav() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/app/patients/p2/imaging')}>go-p2-imaging</button>;
}
function NavReport() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/app/patients/p2/report')}>go-p2-report</button>;
}

let fetchMock: ReturnType<typeof vi.fn>;
let releaseP1: (v: unknown) => void = () => {};

beforeEach(async () => {
  releaseP1 = () => {};
  fetchMock = vi.fn((url: RequestInfo | URL) => {
    const s = String(url);
    // p1 的两个数据源都延迟（模拟慢响应）。
    if (s.includes('/patients/p1/studies')) return new Promise((r) => { releaseP1 = (data) => r(jsonResponse(data)); });
    if (s.includes('/patients/p1/detail')) return new Promise((r) => { releaseP1 = (data) => r(jsonResponse(data)); });
    if (s.includes('/patients/p2/studies')) {
      return Promise.resolve(jsonResponse([
        { study_id: 's1', modality: 'CT', series_count: 1, created_at: '' },
        { study_id: 's2', modality: 'CT', series_count: 1, created_at: '' },
      ]));
    }
    if (s.includes('/patients/p2/detail')) {
      return Promise.resolve(jsonResponse({ patient_hash: 'p2', initials: 'PAT-B', created_at: '', updated_at: '' }));
    }
    if (s.includes('/api/v1/files/uploads')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('P1 换患者晚到响应隔离', () => {
  it('imaging: p1 慢响应晚于 p2 到达 → 页面仍是 p2 的 studies', async () => {
    render(
      <>
        <Routes>
          <Route path="/app/patients/:hash/imaging" element={<ImagingPage />} />
        </Routes>
        <Nav />
      </>,
      { initialEntries: ['/app/patients/p1/imaging'] },
    );

    // 切到 p2 — 二笔 studies 立即返回。
    fireEvent.click(screen.getByText('go-p2-imaging'));
    await waitFor(() => expect(screen.getByText('2 studies')).toBeInTheDocument());

    // p1 的慢响应此刻才落地 — 不得覆盖 p2。
    releaseP1([
      { study_id: 'old1', modality: 'CT', series_count: 1, created_at: '' },
      { study_id: 'old2', modality: 'CT', series_count: 1, created_at: '' },
      { study_id: 'old3', modality: 'CT', series_count: 1, created_at: '' },
    ]);
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText('2 studies')).toBeInTheDocument();
  });

  it('report: p1 慢响应晚于 p2 到达 → 页面仍是 p2 的患者', async () => {
    render(
      <>
        <Routes>
          <Route path="/app/patients/:hash/report" element={<ReportPage />} />
        </Routes>
        <NavReport />
      </>,
      { initialEntries: ['/app/patients/p1/report'] },
    );

    fireEvent.click(screen.getByText('go-p2-report'));
    await waitFor(() => expect(screen.getByText('PAT-B')).toBeInTheDocument());

    releaseP1({ patient_hash: 'p1', initials: 'PAT-A', created_at: '', updated_at: '' });
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText('PAT-B')).toBeInTheDocument();
    expect(screen.queryByText('PAT-A')).not.toBeInTheDocument();
  });
});
