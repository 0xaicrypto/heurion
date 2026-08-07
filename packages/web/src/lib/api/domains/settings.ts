import { AuthApi } from './auth.js';
import type { LlmStatus, LlmTestResult, LlmUpdateInput, LlmUpdateResult } from '../../types';

export class SettingsApi extends AuthApi {
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

}
