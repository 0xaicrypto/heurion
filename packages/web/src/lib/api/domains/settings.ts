import { ApiCore } from './core.js';
import type { LlmStatus, LlmTestResult, LlmUpdateInput, LlmUpdateResult } from '../../types';

export class SettingsApi extends ApiCore {
  /* ────────────────────────── settings ────────────────────────── */

  async getLlmStatus(): Promise<LlmStatus> {
    return this.fetch<LlmStatus>('/api/v1/settings/llm');
  }

  async testLlm(): Promise<LlmTestResult> {
    return this.fetch<LlmTestResult>('/api/v1/settings/llm/test', { method: 'POST' });
  }

  async updateLlmSettings(input: LlmUpdateInput): Promise<LlmUpdateResult> {
    return this.fetch<LlmUpdateResult>('/api/v1/settings/llm', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }


  /* ────────────────────────── MCP integrations (#417) ────────── */

  async listMcpServers(): Promise<{ servers: Array<{ id: string; name: string; url: string; capabilities: string[]; enabled: boolean; has_token: boolean; created_at: string }> }> {
    return this.fetch('/api/v1/settings/mcp-servers');
  }

  async addMcpServer(input: { name: string; url: string; capabilities?: string[]; token?: string }): Promise<{ server: { id: string } }> {
    return this.fetch('/api/v1/settings/mcp-servers', { method: 'POST', body: JSON.stringify(input) });
  }

  async deleteMcpServer(id: string): Promise<{ deleted: boolean }> {
    return this.fetch(`/api/v1/settings/mcp-servers/${id}`, { method: 'DELETE' });
  }

  async testMcpServer(id: string): Promise<{ ok: boolean; tools: Array<{ name: string; description?: string; is_write?: boolean }> }> {
    return this.fetch(`/api/v1/settings/mcp-servers/${id}/test`, { method: 'POST', body: JSON.stringify({}) });
  }

  async callMcpTool(id: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
    return this.fetch(`/api/v1/settings/mcp-servers/${id}/call`, { method: 'POST', body: JSON.stringify({ tool, arguments: args }) });
  }

  /* ────────────────────────── image generation (#419) ────────── */

  async getImageSettings(): Promise<{ base_url: string; model: string; has_key: boolean }> {
    return this.fetch('/api/v1/settings/image');
  }

  async updateImageSettings(input: { base_url?: string; model?: string; api_key?: string }): Promise<{ ok: boolean }> {
    return this.fetch('/api/v1/settings/image', { method: 'PUT', body: JSON.stringify(input) });
  }
}
