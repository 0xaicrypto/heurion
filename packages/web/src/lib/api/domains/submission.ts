import { ApiCore } from './core.js';
import type {
  RecommendJournalsResult,
  JournalRecordDto,
  GuideRequirementsDto,
  PrecheckResult,
  CoverLetterResult,
  FormatTemplate,
  SubmissionDraft,
} from '../../types';

/** #362: submission workflow — journals, cover letter, templates, drafts. */
export class SubmissionApi extends ApiCore {
  /** #850: SelectionProfile → 三档梯度推荐(冲/稳/保)+ 红线区。 */
  async recommendJournals(input: {
    title: string;
    abstract?: string;
    article_type?: string;
    priority?: 'impact' | 'speed' | 'acceptance';
    self_pay_oa?: boolean;
    language?: 'en' | 'zh';
  }): Promise<RecommendJournalsResult> {
    return this.fetch('/api/v1/submission/recommend-journals', { method: 'POST', body: JSON.stringify(input) });
  }

  /** #849: 期刊检索/目录。 */
  async searchJournals(q: string): Promise<{ total: number; journals: JournalRecordDto[] }> {
    return this.fetch(`/api/v1/submission/journals?q=${encodeURIComponent(q)}`);
  }

  /** #852: 期刊详情(OpenAlex/DOAJ 动态富化,失败回落 seed)。 */
  async getJournal(id: string): Promise<{ journal: JournalRecordDto }> {
    return this.fetch(`/api/v1/submission/journals/${encodeURIComponent(id)}`);
  }

  /** #851: Guide for Authors 抓取 + 结构化抽取(降级返回 ok:false)。 */
  async fetchGuideForAuthors(journalId: string): Promise<{ ok: boolean; requirements?: GuideRequirementsDto; reason?: string; manual_url?: string | null }> {
    return this.fetch('/api/v1/submission/guide-for-authors', { method: 'POST', body: JSON.stringify({ journal_id: journalId }) });
  }

  /** #851: 投稿前检查单(文档 vs 该刊要求)。 */
  async precheck(input: { journal_id: string; doc_id?: string; text?: string }): Promise<PrecheckResult> {
    return this.fetch('/api/v1/submission/precheck', { method: 'POST', body: JSON.stringify(input) });
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

  async getSubmissionChecklist(): Promise<{ checks: Array<{ id: string; label: string; ok: boolean }>; passed: number; total: number; ready: boolean }> {
    return this.fetch('/api/v1/submission/checklist');
  }

  async updateSubmissionStatus(status: SubmissionDraft['status']): Promise<{ draft: SubmissionDraft; ok: boolean }> {
    return this.fetch('/api/v1/submission/status', { method: 'POST', body: JSON.stringify({ status }) });
  }
}
