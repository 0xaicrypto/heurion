import { PluginsApi } from './plugins.js';
import type {
  JournalRecommendation,
  CoverLetterResult,
  FormatTemplate,
  SubmissionDraft,
} from '../../types';

/** #362: submission workflow — journals, cover letter, templates, drafts. */
export class SubmissionApi extends PluginsApi {
  async recommendJournals(input: { title: string; abstract?: string; limit?: number }): Promise<{ journals: JournalRecommendation[]; message?: string }> {
    return this.fetch('/api/v1/submission/recommend-journals', { method: 'POST', body: JSON.stringify(input) });
  }

  async generateCoverLetter(input: {
    title: string;
    abstract?: string;
    authors?: string[];
    journal_name?: string;
    highlights?: string[];
    corresponding_author?: string;
  }): Promise<CoverLetterResult> {
    return this.fetch('/api/v1/submission/cover-letter', { method: 'POST', body: JSON.stringify(input) });
  }

  async listFormatTemplates(): Promise<{ templates: FormatTemplate[] }> {
    return this.fetch('/api/v1/submission/templates');
  }

  async prefillTemplate(input: { template_id: string; title?: string; abstract?: string; authors?: string[] }): Promise<{ template_id: string; journal_name: string; content: string }> {
    return this.fetch('/api/v1/submission/templates/prefill', { method: 'POST', body: JSON.stringify(input) });
  }

  async listSubmissionDrafts(): Promise<{ drafts: SubmissionDraft[] }> {
    return this.fetch('/api/v1/submission/drafts');
  }

  async saveSubmissionDraft(input: Partial<SubmissionDraft> & { article_title: string }): Promise<{ draft: SubmissionDraft; ok: boolean }> {
    return this.fetch('/api/v1/submission/drafts', { method: 'POST', body: JSON.stringify(input) });
  }
}
