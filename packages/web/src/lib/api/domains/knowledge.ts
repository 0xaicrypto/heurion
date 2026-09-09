import { ApiCore } from './core.js';
import type { Summary, SummaryImpact, LlmCostDashboard, QueueMetrics, TelemetryDashboard, MemoryGraphNode, MemoryGraphRelation } from '../../types';

export class KnowledgeApi extends ApiCore {
  /* ────────────────────────── knowledge & facts ────────────────────────── */

  /** #620: 知识库选择器搜索(标题/内容关键词)。 */
  // #620/#628: 选择器返回合成总结(summary)与上传文件(document)
  async getKnowledgePicker(q: string): Promise<{ summaries: Array<{ id: string; title: string; summary: string; updated_at: string; kind: 'summary' | 'document' }> }> {
    return this.fetch(`/api/v1/knowledge/picker?q=${encodeURIComponent(q)}`);
  }

  async getKnowledgeSummaries(): Promise<{summaries: Summary[]}> {
    return this.fetch('/api/v1/knowledge/summaries');
  }

  async getKnowledgeSummary(id: string): Promise<Summary> {
    return this.fetch(`/api/v1/knowledge/summaries/${id}`);
  }

  async createKnowledgeSummary(data: {title: string; content: string; sources?: string[]}): Promise<{id: string}> {
    return this.fetch('/api/v1/knowledge/summaries', { method: 'POST', body: JSON.stringify(data) });
  }

  async regenerateKnowledgeSummary(id: string): Promise<Summary> {
    return this.fetch(`/api/v1/knowledge/summaries/${id}/regenerate`, { method: 'POST' });
  }

  async updateKnowledgeSummary(id: string, data: {title?: string; content?: string}): Promise<Summary> {
    return this.fetch(`/api/v1/knowledge/summaries/${id}`, { method: 'PUT', body: JSON.stringify(data) });
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

  async deleteKnowledgeSummaries(ids: string[]): Promise<{deleted: number}> {
    return this.fetch('/api/v1/knowledge/summaries', { method: 'DELETE', body: JSON.stringify({ ids }) });
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

  /** 服务端:knowledge-stores.router — graph.getVersions(stableId) → MemoryNode[]。 */
  async getNodeVersions(id: string): Promise<{ versions: MemoryGraphNode[] }> {
    return this.fetch(`/api/v1/memory/nodes/${id}/versions`);
  }

  /** 服务端:knowledge-stores.router — SummaryNode.impact(缺省/未知节点为 [])。 */
  async getSummaryImpact(id: string): Promise<{ impact: SummaryImpact[] }> {
    return this.fetch(`/api/v1/memory/summaries/${id}/impact`);
  }

  /** 服务端:knowledge-stores.router — { nodes: MemoryNode[], relations: 可见边(stableId 化) }。 */
  async getMemoryGraph(patientHash?: string, includeSuperseded?: boolean): Promise<{ nodes: MemoryGraphNode[]; relations: MemoryGraphRelation[] }> {
    const params = new URLSearchParams();
    if (patientHash) params.set('patient_hash', patientHash);
    if (includeSuperseded) params.set('include_superseded', 'true');
    const qs = params.toString();
    return this.fetch(`/api/v1/memory/graph${qs ? `?${qs}` : ''}`);
  }

}
