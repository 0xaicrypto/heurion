import { BrainApi } from './brain.js';
import type { MemoryProjection } from '../../types';

export class MemoryApi extends BrainApi {
  /* ────────────────────────── memory ────────────────────────── */

  async getMemoryProjection(patientHash: string): Promise<MemoryProjection> {
    return this.fetch<MemoryProjection>(`/api/v1/memory/patient/${patientHash}/projection`);
  }

  async getFindings(patientHash: string): Promise<Array<{node_id: number; node_type: string; content: unknown; weight?: number; encounter_id?: string; updated_at?: number}>> {
    const r = await this.fetch<{findings: Array<{node_id: number; node_type: string; content: unknown; weight?: number; encounter_id?: string; updated_at?: number}>}>(`/api/v1/memory/patient/${patientHash}/findings`);
    return r.findings || [];
  }

  async getMedications(patientHash: string): Promise<Array<{node_id: number; node_type: string; content: unknown; weight?: number; encounter_id?: string; updated_at?: number}>> {
    const r = await this.fetch<{medications: Array<{node_id: number; node_type: string; content: unknown; weight?: number; encounter_id?: string; updated_at?: number}>}>(`/api/v1/memory/patient/${patientHash}/medications`);
    return r.medications || [];
  }

  async getMemoryTimeline(patientHash: string): Promise<Array<{event_id: number; event_type: string; content: string; timestamp: number}>> {
    const r = await this.fetch<{entries: Array<{encounter_id?: string; node_count?: number; last_touched?: number; event_id?: number; event_type?: string; content?: string; timestamp?: number}>}>(`/api/v1/memory/patient/${patientHash}/timeline`);
    return (r.entries || []).map((e, i) => ({
      event_id: e.event_id || i,
      event_type: e.event_type || 'encounter',
      content: e.event_type ? (e.content || '') : `Encounter ${e.encounter_id || ''} (${e.node_count || 0} nodes)`,
      timestamp: e.timestamp || e.last_touched || 0,
    }));
  }

  /* ────────────────────────── memory import/export ────────────────────────── */

  async exportMemory(): Promise<{exported_at: string; facts: number; episodes: number; knowledge: number}> {
    return this.fetch('/api/v1/memory/export');
  }

  async importMemory(data: {facts?: object[]; episodes?: object[]}): Promise<{imported: number}> {
    return this.fetch('/api/v1/memory/import', { method: 'POST', body: JSON.stringify(data) });
  }

  async getExecutionFileDownload(fileId: string): Promise<{ file_id: string; file_name: string; mime_type: string; download_url: string; expires_in: number }> {
    return this.fetch(`/api/v1/execution/files/${fileId}/download`);
  }

  /* ────────────────────────── knowledge gaps + tools ────────────────────────── */

  async getKnowledgeGaps(): Promise<{gaps: Array<{id: string; content: string; status: 'open' | 'answered' | 'ignored'; source: string; createdAt: string; updatedAt: string}>}> {
    return this.fetch('/api/v1/knowledge/gaps');
  }

  async deleteKnowledgeGaps(ids: string[]): Promise<{deleted: number}> {
    return this.fetch('/api/v1/knowledge/gaps', { method: 'DELETE', body: JSON.stringify({ ids }) });
  }

  /* ────────────────────────── chat projection ────────────────────────── */

  async getChatProjection(): Promise<{budget: Array<{layer: string; tokens: number; items: number}>}> {
    return this.fetch('/api/v1/chat/projection');
  }

}
