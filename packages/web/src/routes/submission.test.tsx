import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { SubmissionWorkbench } from './submission';

vi.mock('@/lib/api', () => ({
  api: {
    listSubmissionDrafts: vi.fn().mockResolvedValue({ drafts: [] }),
    saveSubmissionDraft: vi.fn().mockResolvedValue({ draft: { id: 'd1' }, ok: true }),
    recommendJournals: vi.fn().mockResolvedValue({
      journals: [
        { id: 'jto', name: 'Journal of Thoracic Oncology', impact_factor: 21.0, acceptance_rate: 20, review_weeks: 5, cas_zone: '1区', match_score: 4, reason: 'lung keywords matched' },
        { id: 'lung-cancer', name: 'Lung Cancer', impact_factor: 5.3, acceptance_rate: 32, review_weeks: 6, cas_zone: '2区', match_score: 3, reason: 'lung keywords matched' },
      ],
    }),
    generateCoverLetter: vi.fn().mockResolvedValue({ cover_letter: 'Dear Editor, ...', highlights: [] }),
    listFormatTemplates: vi.fn().mockResolvedValue({
      templates: [
        { id: 'jto-template', journal_name: 'Journal of Thoracic Oncology', journal_id: 'jto', sections: ['Abstract'], reference_style: 'AMA', word_limit: '4000', notes: [] },
      ],
    }),
    prefillTemplate: vi.fn().mockResolvedValue({ template_id: 'jto-template', journal_name: 'JTO', content: '# My Study\n\n## Abstract' }),
  },
  ApiError: class ApiError extends Error {},
}));

describe('SubmissionWorkbench (#362)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recommends journals after entering a title', async () => {
    render(<SubmissionWorkbench embedded />);

    const titleInput = screen.getByLabelText('Title');
    fireEvent.change(titleInput, { target: { value: 'EGFR-mutant NSCLC immunotherapy survival' } });
    fireEvent.change(screen.getByLabelText('Abstract'), { target: { value: 'Retrospective cohort, overall survival' } });

    fireEvent.click(screen.getByText('Recommend journals'));

    expect(await screen.findByText('Journal of Thoracic Oncology')).toBeTruthy();
    expect(screen.getByText(/IF 21/)).toBeTruthy();
    expect(screen.getByText(/Lung Cancer/)).toBeTruthy();
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
