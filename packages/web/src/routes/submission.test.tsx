import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { SubmissionWorkbench } from './submission';

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
