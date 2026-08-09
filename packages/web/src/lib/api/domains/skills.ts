import { ApiCore } from './core.js';


export class SkillsApi extends ApiCore {
  /* ────────────────────────── skills ────────────────────────── */

  async listSkills(): Promise<{skills: Array<{name: string; title: string; description: string; version: string; author: string; enabled?: boolean}>}> {
    return this.fetch('/api/v1/skills');
  }

  async searchSkills(query: string, source = 'official'): Promise<{results: Array<{identifier: string; name: string; description: string; source: string; installed: boolean; version?: string; author?: string}>}> {
    const q = query ? `&query=${encodeURIComponent(query)}` : '';
    return this.fetch(`/api/v1/skills/search?source=${source}${q}`);
  }

  async installSkill(identifier: string): Promise<{name: string}> {
    return this.fetch('/api/v1/skills/install', { method: 'POST', body: JSON.stringify({ identifier }) });
  }

  async toggleSkill(name: string, enabled: boolean): Promise<{name: string; enabled: boolean}> {
    return this.fetch(`/api/v1/skills/${name}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
  }

  async uninstallSkill(name: string): Promise<{ok: boolean; name: string}> {
    return this.fetch(`/api/v1/skills/${name}`, { method: 'DELETE' });
  }

  /* ────────────────────────── skills marketplace ────────────────────────── */

  async searchGitHubSkills(query?: string): Promise<{skills: Array<{identifier: string; name: string; description: string; source: string; repo: string; author: string; installed: boolean; version: string}>; total: number}> {
    const qs = query ? `?query=${encodeURIComponent(query)}` : ''
    return this.fetch(`/api/v1/skills/github${qs}`);
  }

  async resolveKnowledgeGap(gapId: string): Promise<{resolved: boolean}> {
    return this.fetch(`/api/v1/knowledge/gaps/${gapId}/resolve`, { method: 'POST' });
  }

  async answerKnowledgeGap(gapId: string, answer: string): Promise<{resolved: boolean}> {
    return this.fetch(`/api/v1/knowledge/gaps/${gapId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    });
  }

  async ignoreKnowledgeGap(gapId: string): Promise<{ignored: boolean}> {
    return this.fetch(`/api/v1/knowledge/gaps/${gapId}/ignore`, { method: 'POST' });
  }

  async getKnowledgeTools(): Promise<{tools: Array<{id: string; name: string; description: string; language: string; enabled: boolean; createdAt: number}>}> {
    return this.fetch('/api/v1/knowledge/tools');
  }

  async deleteKnowledgeTools(ids: string[]): Promise<{deleted: number}> {
    return this.fetch('/api/v1/knowledge/tools', { method: 'DELETE', body: JSON.stringify({ ids }) });
  }

}
