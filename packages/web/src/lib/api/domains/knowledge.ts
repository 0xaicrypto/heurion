import { WritingApi } from './writing.js';
import type { Article, LlmCostDashboard, QueueMetrics, TelemetryDashboard } from '../../types';

export class KnowledgeApi extends WritingApi {
  /* ────────────────────────── knowledge & facts ────────────────────────── */

  async getKnowledgeArticles(): Promise<{articles: Article[]}> {
    return this.fetch('/api/v1/knowledge/articles');
  }

  async getKnowledgeArticle(id: string): Promise<Article> {
    return this.fetch(`/api/v1/knowledge/articles/${id}`);
  }

  async createKnowledgeArticle(data: {title: string; content: string; sources?: string[]}): Promise<{id: string}> {
    return this.fetch('/api/v1/knowledge/articles', { method: 'POST', body: JSON.stringify(data) });
  }

  async regenerateKnowledgeArticle(id: string): Promise<Article> {
    return this.fetch(`/api/v1/knowledge/articles/${id}/regenerate`, { method: 'POST' });
  }

  async updateKnowledgeArticle(id: string, data: {title?: string; content?: string}): Promise<Article> {
    return this.fetch(`/api/v1/knowledge/articles/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async getKnowledgeTelemetryDashboard(from?: string, to?: string): Promise<TelemetryDashboard> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    return this.fetch(`/api/v1/knowledge/telemetry/dashboard${qs ? `?${qs}` : ''}`);
  }

  async getAdminLlmCostDashboard(from?: string, to?: string): Promise<LlmCostDashboard> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    return this.fetch(`/api/v1/admin/telemetry/llm-cost${qs ? `?${qs}` : ''}`);
  }

  async getEvolutionQueueMetrics(): Promise<{type: string; metrics: QueueMetrics}> {
    return this.fetch('/api/v1/evolution/queue');
  }

  async deleteKnowledgeArticles(ids: string[]): Promise<{deleted: number}> {
    return this.fetch('/api/v1/knowledge/articles', { method: 'DELETE', body: JSON.stringify({ ids }) });
  }

  async getFacts(): Promise<{facts: Array<{id: string; category: string; importance: number; content: string; count: number; sourceType: string; patientHash?: string; studyId?: string; createdAt: number; updatedAt: number; lastSeenAt: number}>}> {
    return this.fetch('/api/v1/facts');
  }

  async updateFact(id: string, patch: Partial<{content: string; category: string; importance: number; sourceType: string}>): Promise<{fact: object}> {
    return this.fetch(`/api/v1/facts/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
  }

  async deleteFact(id: string): Promise<{deleted: boolean}> {
    return this.fetch(`/api/v1/facts/${id}`, { method: 'DELETE' });
  }

  async deleteFacts(ids: string[]): Promise<{deleted: number}> {
    return this.fetch('/api/v1/knowledge/facts', { method: 'DELETE', body: JSON.stringify({ ids }) });
  }

  async getNodeVersions(id: string): Promise<{versions: any[]}> {
    return this.fetch(`/api/v1/memory/nodes/${id}/versions`);
  }

  async getArticleImpact(id: string): Promise<{impact: any[]}> {
    return this.fetch(`/api/v1/memory/articles/${id}/impact`);
  }

  async getMemoryGraph(patientHash?: string, includeSuperseded?: boolean): Promise<{nodes: any[]; relations: any[]}> {
    const params = new URLSearchParams();
    if (patientHash) params.set('patient_hash', patientHash);
    if (includeSuperseded) params.set('include_superseded', 'true');
    const qs = params.toString();
    return this.fetch(`/api/v1/memory/graph${qs ? `?${qs}` : ''}`);
  }

}
