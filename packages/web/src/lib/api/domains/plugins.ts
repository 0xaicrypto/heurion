import { ApiCore, ApiError } from './core.js';


export class PluginsApi extends ApiCore {
  /* ────────────────────────── workflows / plugins ────────────────────────── */

  async listWorkflows(): Promise<{workflows: Array<{workflow_id: string; name: string; description?: string; created_at: string; archived?: boolean}>}> {
    return this.fetch('/api/v1/workflows');
  }

  async listWorkflowPacks(): Promise<{packs: Array<{pack_id: string; name: string; description: string; workflow_count: number}>}> {
    return this.fetch('/api/v1/workflows/packs');
  }

  async installWorkflowPack(packId: string): Promise<{workflow_id: string; name: string}> {
    return this.fetch(`/api/v1/workflows/packs/${packId}/install`, { method: 'POST' });
  }

  async getWorkflowRuns(workflowId?: string, limit = 50): Promise<{runs: Array<{run_id: string; workflow_id: string; status: string; started_at: string; completed_at?: string}>}> {
    const q = workflowId ? `?workflow_id=${workflowId}&limit=${limit}` : `?limit=${limit}`;
    return this.fetch(`/api/v1/workflows/runs${q}`);
  }

  /* ────────────────────────── plugin marketplace ────────────────────────── */

  async listPluginCatalog(query?: string, source?: string): Promise<{plugins: Array<{id: string; name: string; version: string; description: string; category: string; author: {name: string}; tags: string[]; runtime: string; source: string; installed: boolean}>}> {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (source) params.set('source', source);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.fetch(`/api/v1/plugins/catalog${qs}`);
  }

  private pluginPath(id: string) {
    return id.replace('/', '/');
  }

  async getPluginCatalogItem(id: string): Promise<{id: string; manifest: Record<string, unknown>; installed: boolean; enabled: boolean}> {
    return this.fetch(`/api/v1/plugins/catalog/${this.pluginPath(id)}`);
  }

  async installPlugin(pluginId: string, version?: string): Promise<{pluginId: string; name: string; version: string; description: string; author: string; enabled: boolean; installedAt: string}> {
    return this.fetch('/api/v1/plugins/install', { method: 'POST', body: JSON.stringify({ pluginId, version }) });
  }

  async uninstallPlugin(id: string): Promise<{uninstalled: boolean}> {
    return this.fetch(`/api/v1/plugins/${this.pluginPath(id)}`, { method: 'DELETE' });
  }

  async enablePlugin(id: string): Promise<{enabled: boolean}> {
    return this.fetch(`/api/v1/plugins/${this.pluginPath(id)}/enable`, { method: 'POST' });
  }

  async disablePlugin(id: string): Promise<{enabled: boolean}> {
    return this.fetch(`/api/v1/plugins/${this.pluginPath(id)}/disable`, { method: 'POST' });
  }

  async listInstalledPlugins(): Promise<{plugins: Array<{pluginId: string; name: string; version: string; description: string; author: string; enabled: boolean; installedAt: string; updatedAt: string; config: Record<string, unknown>}>}> {
    return this.fetch('/api/v1/plugins/installed');
  }

  async listInstalledUIPlugins(): Promise<{plugins: Array<{pluginId: string; name: string; ui: {bundle_url: string; integrity?: string; extension_points: Array<{type: string; id: string; target?: string; label?: string}>}}>}> {
    return this.fetch('/api/v1/plugins/installed-ui');
  }

  async getPluginSettings(id: string): Promise<{schema: Record<string, unknown>; values: Record<string, unknown>}> {
    return this.fetch(`/api/v1/plugins/${this.pluginPath(id)}/settings`);
  }

  async savePluginSettings(id: string, values: Record<string, unknown>): Promise<{saved: boolean}> {
    return this.fetch(`/api/v1/plugins/${this.pluginPath(id)}/settings`, { method: 'PUT', body: JSON.stringify(values) });
  }

  async validatePluginManifest(manifest: Record<string, unknown>): Promise<{valid: boolean; errors: string[]}> {
    return this.fetch('/api/v1/plugins/validate-manifest', { method: 'POST', body: JSON.stringify(manifest) });
  }

  async installPluginFromUrl(url: string): Promise<{valid: boolean; pluginId?: string; installed?: Record<string, unknown>; errors?: string[]; error?: string}> {
    return this.fetch('/api/v1/plugins/install-from-url', { method: 'POST', body: JSON.stringify({ url }) });
  }

  async installPluginUpload(file: File): Promise<{valid: boolean; pluginId?: string; installed?: Record<string, unknown>; errors?: string[]; error?: string}> {
    const formData = new FormData();
    formData.append('manifest', file);
    return this.fetch('/api/v1/plugins/install-upload', { method: 'POST', body: formData });
  }

  async getPluginAuditLogs(options?: {pluginId?: string; status?: string; limit?: number; offset?: number}): Promise<{
    logs: Array<{
      id: string;
      pluginId: string;
      toolName: string;
      jobId: string;
      status: string;
      durationMs: number;
      inputSummary?: string;
      errorMessage?: string;
      createdAt: string;
    }>;
    total: number;
  }> {
    const params = new URLSearchParams();
    if (options?.pluginId) params.set('pluginId', options.pluginId);
    if (options?.status) params.set('status', options.status);
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.fetch(`/api/v1/plugins/audit-logs${query ? `?${query}` : ''}`);
  }

  async getExecutionJobStatus(jobId: string): Promise<{
    job_id: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'unknown';
    created_at: number;
    result?: Record<string, unknown>;
    error?: string;
  } | null> {
    return this.fetch(`/api/v1/execution/jobs/${jobId}`);
  }

  /* ────────────────────────── DICOM render ────────────────────────── */

  async renderDicomSlice(studyId: string, seriesIndex: number, sliceIndex: number, preset?: string): Promise<Blob> {
    const params = new URLSearchParams({ index: String(sliceIndex), format: 'png' });
    if (preset) params.set('preset', preset);
    const r = await fetch(`/api/v1/dicom/studies/${studyId}/series/${seriesIndex}/render?${params}`, {
      headers: this.headers(),
    });
    if (!r.ok) throw new ApiError(r.status, await r.text().catch(() => ''), '/render');
    return r.blob();
  }

  async sendToAgent(studyId: string, seriesIndex: number, sliceIndex: number, note?: string): Promise<{ok: boolean}> {
    return this.fetch('/api/v1/dicom/send-to-agent', { method: 'POST', body: JSON.stringify({ study_id: studyId, series_index: seriesIndex, slice_index: sliceIndex, note }) });
  }

  /* ────────────────────────── schedule ────────────────────────── */

  async listSchedule(limit = 50): Promise<{tasks: Array<{task_id: string; kind: string; fire_at: string; payload: Record<string,unknown>; patient_hash?: string; session_id?: string}>}> {
    return this.fetch(`/api/v1/schedule/list?limit=${limit}`);
  }

  async cancelTask(taskId: string): Promise<{task_id: string}> {
    return this.fetch(`/api/v1/schedule/${taskId}`, { method: 'DELETE' });
  }

  /* ────────────────────────── export ────────────────────────── */

  async exportBundle(): Promise<{bundle_path: string; size_bytes: number; created_at: string; counts: Record<string,number>}> {
    return this.fetch('/api/v1/export/bundle', { method: 'POST' });
  }

  /* ────────────────────────── file manager ────────────────────────── */

  async listFiles(limit = 200): Promise<{files: Array<{file_id: string; name: string; mime: string; size_bytes: number; created_at: string}>}> {
    return this.fetch(`/api/v1/files?limit=${limit}`);
  }

  async deleteFile(fileId: string): Promise<void> {
    return this.fetch(`/api/v1/files/${fileId}`, { method: 'DELETE' });
  }

  async deleteFiles(ids: string[]): Promise<{deleted: number}> {
    return this.fetch('/api/v1/files/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) });
  }

  // #420: parallel deep analysis — SSE stream of sub-agent activity + final answer.

}
