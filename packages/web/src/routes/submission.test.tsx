import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { SubmissionWorkbench } from './submission';
import { setPaperLink } from '@/lib/paper-link';
import type { SubmissionDraft } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  api: {
    listSubmissionDrafts: vi.fn().mockResolvedValue({ drafts: [] }),
    saveSubmissionDraft: vi.fn().mockResolvedValue({ draft: { id: 'd1' }, ok: true }),
    // #848: 三档梯度推荐契约(tiers.reach/match/safety + breakdown)
    recommendJournals: vi.fn().mockResolvedValue({
      engine: 'selection-v2',
      profile_echo: { priority: 'impact', article_type: null, self_pay_oa: false },
      tiers: {
        reach: [],
        match: [
          {
            journal: {
              id: 'jto', name: 'Journal of Thoracic Oncology', issn: null, publisher: null, zh_name: null,
              description: '胸部肿瘤专科旗舰刊',
              metrics: {
                impact_factor: { value: 21.0, asOf: '2025-06', source: 'jcr_snapshot' },
                cas_zone: { value: '1区', asOf: '2025-12', source: 'cas_snapshot' },
                acceptance_rate: { value: 20, asOf: '2025-06', source: 'curated_estimate' },
                review_weeks_median: { value: 5, asOf: '2025-06', source: 'curated_estimate' },
                apc: null, open_alex: null, article_type_distribution: null,
              },
              scope: ['oncology'], article_types: [], oa: false, guide_url: null, similar_works: null,
              warnings: [], logo: { monogram: 'JT', color: '#1d4ed8' },
              freshness: { seed: true, updatedAt: '2026-09-08', stale: false },
            },
            tier: 'match', total_score: 54.8,
            breakdown: [
              { dimension: 'scope', score: 80, evidence: '标题命中 lung / immunotherapy' },
              { dimension: 'impact', score: 58, evidence: 'IF 21.0（jcr_snapshot,截至 2025-06）' },
            ],
          },
          {
            journal: {
              id: 'lung-cancer', name: 'Lung Cancer', issn: null, publisher: null, zh_name: null,
              description: '肺癌专科刊',
              metrics: {
                impact_factor: { value: 5.3, asOf: '2025-06', source: 'jcr_snapshot' },
                cas_zone: { value: '2区', asOf: '2025-12', source: 'cas_snapshot' },
                acceptance_rate: { value: 32, asOf: '2025-06', source: 'curated_estimate' },
                review_weeks_median: { value: 6, asOf: '2025-06', source: 'curated_estimate' },
                apc: null, open_alex: null, article_type_distribution: null,
              },
              scope: ['oncology'], article_types: [], oa: false, guide_url: null, similar_works: null,
              warnings: [], logo: { monogram: 'LC', color: '#0f766e' },
              freshness: { seed: true, updatedAt: '2026-09-08', stale: false },
            },
            tier: 'match', total_score: 43.2,
            breakdown: [{ dimension: 'scope', score: 60, evidence: '标题命中 lung' }],
          },
        ],
        safety: [],
      },
      redline: [],
      warning_list_asof: null,
    }),
    generateCoverLetter: vi.fn().mockResolvedValue({ cover_letter: 'Dear Editor, ...', highlights: [] }),
    listFormatTemplates: vi.fn().mockResolvedValue({
      templates: [
        { id: 'jto-template', journal_name: 'Journal of Thoracic Oncology', journal_id: 'jto', sections: ['Abstract'], reference_style: 'AMA', word_limit: '4000', notes: [] },
      ],
    }),
    prefillTemplate: vi.fn().mockResolvedValue({ template_id: 'jto-template', journal_name: 'JTO', content: '# My Study\n\n## Abstract' }),
    createDoc: vi.fn().mockResolvedValue({ id: 'doc_1', title: 'My Study（JTO 模板）', body: '' }),
    updateDoc: vi.fn().mockResolvedValue({ id: 'doc_1', title: 'My Study（JTO 模板）', body: '# skeleton' }),
  },
  ApiError: class ApiError extends Error {},
}));

describe('SubmissionWorkbench (#362)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recommends journals after entering a title (#848 三档契约)', async () => {
    render(<SubmissionWorkbench embedded />);

    const titleInput = screen.getByLabelText('Title');
    fireEvent.change(titleInput, { target: { value: 'EGFR-mutant NSCLC immunotherapy survival' } });
    fireEvent.change(screen.getByLabelText('Abstract'), { target: { value: 'Retrospective cohort, overall survival' } });

    fireEvent.click(screen.getByText('Recommend journals'));

    expect(await screen.findByText('Journal of Thoracic Oncology')).toBeTruthy();
    expect(screen.getByText(/IF 21/)).toBeTruthy();
    expect(screen.getByText(/Lung Cancer/)).toBeTruthy();
    // 结构化 breakdown 可展开(D4)
    fireEvent.click(screen.getAllByText(/为什么推荐|Why recommended|Why/i)[0]);
    expect(await screen.findByText(/标题命中/)).toBeTruthy();
  });

  it('generates a cover letter in the cover tab', async () => {
    render(<SubmissionWorkbench embedded />);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My study' } });
    fireEvent.click(screen.getByText('Cover letter'));
    fireEvent.click(screen.getByText('Generate cover letter'));

    expect(await screen.findByDisplayValue(/Dear Editor/)).toBeTruthy();
  });

  it('lists and prefills templates', async () => {
    render(<SubmissionWorkbench embedded />);

    fireEvent.click(screen.getByText('Templates'));

    expect(await screen.findByText('Journal of Thoracic Oncology')).toBeTruthy();
    fireEvent.click(screen.getByText('Prefill'));
    expect(await screen.findByText(/My Study/)).toBeTruthy();
  });

  it('applies a template to the Write tab (creates a Doc with the skeleton) (#382)', async () => {
    const { api } = await import('@/lib/api');
    render(<SubmissionWorkbench embedded />);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My EGFR study' } });
    fireEvent.click(screen.getByText('Templates'));

    await waitFor(() => {
      expect(screen.getByText('Journal of Thoracic Oncology')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Apply to writing'));

    await waitFor(() => {
      expect(api.createDoc).toHaveBeenCalledWith(expect.stringContaining('Journal of Thoracic Oncology'));
      expect(api.updateDoc).toHaveBeenCalled();
    });
    expect(screen.getByText(/Doc created/)).toBeTruthy();
  });

  it('only the applied template card shows the applied hint (#382 fix)', async () => {
    render(<SubmissionWorkbench embedded />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My study' } });
    fireEvent.click(screen.getByText('Templates'));

    await waitFor(() => {
      expect(screen.getByText('Journal of Thoracic Oncology')).toBeTruthy();
    });
    fireEvent.click(screen.getAllByText('Apply to writing')[0]);

    await waitFor(() => {
      expect(screen.getAllByText(/Doc created/)).toHaveLength(1);
    });
  });

  it('autosave carries the linked paper doc_id (#902)', async () => {
    const { api } = await import('@/lib/api');
    setPaperLink({ docId: 'doc_42', title: 'Linked paper', abstract: '', updatedAt: Date.now() });
    try {
      render(<SubmissionWorkbench embedded />);

      // 等挂载恢复完成（paper link 标题回填）后再改标题 — 否则 restore
      // 的 setTitle 会覆盖测试输入。
      const titleInput = screen.getByLabelText('Title');
      await waitFor(() => expect(titleInput).toHaveValue('Linked paper'));
      fireEvent.change(titleInput, { target: { value: 'EGFR study' } });

      // 800ms 防抖后 autosave — 载荷须带上 paper-link 的 docId（#726 按
      // docId 隔离草稿；缺 doc_id 会错误命中旧草稿）。
      await waitFor(
        () => {
          expect(api.saveSubmissionDraft).toHaveBeenCalledWith(
            expect.objectContaining({ doc_id: 'doc_42', article_title: 'EGFR study' }),
          );
        },
        { timeout: 2500 },
      );
    } finally {
      localStorage.removeItem('nexus.paper.link');
    }
  });

  // 复审 #5（覆盖竞态）回归: persist() 每次保存都产生新的 draft 对象引用，
  // CoverTab 的回填 effect 若只 guard「当前值为空」，用户刚清空的字段会被
  // 服务端旧值复活（后到覆盖先到）。
  it('does not resurrect a cleared cover field when autosave produces a new draft object (复审 #5)', async () => {
    const { api } = await import('@/lib/api');
    vi.mocked(api.listSubmissionDrafts).mockResolvedValueOnce({
      drafts: [makeDraft({ target_journal: 'Stale Journal', cover_letter: 'Stale letter' })],
    });
    // 服务端部分更新语义：persist({}) 不携带 target_journal/cover_letter 时
    // 保留旧值 — 每次保存都返回【新对象】（新引用 + 同样旧内容）。
    vi.mocked(api.saveSubmissionDraft).mockImplementation(async (input) => ({
      draft: makeDraft({ article_title: input.article_title, target_journal: 'Stale Journal', cover_letter: 'Stale letter' }),
      ok: true,
    }));
    try {
      render(<SubmissionWorkbench embedded />);

      const titleInput = screen.getByLabelText('Title');
      await waitFor(() => expect(titleInput).toHaveValue('EGFR study'));

      fireEvent.click(screen.getByText('Cover letter'));
      // 正当同步路径：进入 cover tab 时从服务端草稿回填。
      const journalInput = await screen.findByDisplayValue('Stale Journal');

      // 用户清空字段（touched）→ 之后任何保存产生的新 draft 都不得覆盖回来。
      fireEvent.change(journalInput, { target: { value: '' } });
      expect(journalInput).toHaveValue('');

      fireEvent.change(titleInput, { target: { value: 'EGFR study v2' } });
      await waitFor(
        () => expect(api.saveSubmissionDraft).toHaveBeenCalledWith(expect.objectContaining({ article_title: 'EGFR study v2' })),
        { timeout: 2500 },
      );
      // 新 draft 对象已到达（保存已解析）— 静置一拍让 effect 跑完再断言。
      await waitFor(() => expect(titleInput).toHaveValue('EGFR study v2'));
      expect(screen.getByPlaceholderText('Target journal (optional)')).toHaveValue('');
    } finally {
      vi.mocked(api.saveSubmissionDraft).mockReset();
      vi.mocked(api.saveSubmissionDraft).mockResolvedValue({ draft: makeDraft(), ok: true });
    }
  });

  // 正当场景守护：用户未触碰 cover 字段时，服务端生成/更新的草稿仍会回填
  // （draft 引用变化 → effect 同步空字段）。
  it('still syncs untouched cover fields from a newly persisted server draft (复审 #5 legit case)', async () => {
    const { api } = await import('@/lib/api');
    // 服务端在保存时「生成」了 cover letter（autosave 不携带 cover_letter，
    // 回包携带 — 模拟服务端侧内容更新）。
    vi.mocked(api.saveSubmissionDraft).mockImplementation(async (input) => ({
      draft: makeDraft({ article_title: input.article_title, cover_letter: 'Server-generated letter' }),
      ok: true,
    }));
    try {
      render(<SubmissionWorkbench embedded />);

      // 先切到 cover tab（此时 draft 为 null，字段为空且未被触碰），
      // 再改标题触发 autosave — 新 draft 到达后应同步回填空字段。
      fireEvent.click(screen.getByText('Cover letter'));
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'EGFR study' } });

      await waitFor(
        () => expect(api.saveSubmissionDraft).toHaveBeenCalled(),
        { timeout: 2500 },
      );
      expect(await screen.findByDisplayValue('Server-generated letter')).toBeTruthy();
    } finally {
      vi.mocked(api.saveSubmissionDraft).mockReset();
      vi.mocked(api.saveSubmissionDraft).mockResolvedValue({ draft: makeDraft(), ok: true });
    }
  });
});

function makeDraft(patch: Partial<SubmissionDraft> = {}): SubmissionDraft {
  return {
    id: 'd1',
    article_title: 'EGFR study',
    authors: [],
    status: 'draft',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...patch,
  };
}
