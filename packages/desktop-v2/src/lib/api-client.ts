/**
 * ApiClient — real HTTP wrapper around the FastAPI backend.
 *
 * U1.1: replaces the U0 mock with real endpoint coverage:
 * - auth (login)
 * - patients (listPatients)
 * - memory v3 (projection / findings / medications / timeline / citation /
 *              practitioner candidates / pending count / confirm / reject)
 * - chat SSE streaming (sendChat)
 *
 * Dev: requests go to /api/v1/* — Vite proxies to http://localhost:8001.
 * Prod: ``VITE_NEXUS_API`` env (set at build) provides the base URL.
 *
 * Auth: bearer JWT in Authorization header. Token held in memory only;
 * U2 will swap to @tauri-apps/plugin-stronghold for OS-keychain storage.
 */

import type {
  ChatStreamChunk,
  LlmStatus,
  PatientProjection,
  PractitionerCandidate,
  ProvenanceRow,
  StudyInfo,
} from './types';

// import.meta.env is injected by Vite; cast keeps tsc happy without the
// full `/// <reference types="vite/client" />` triple-slash.
//
// baseUrl resolution:
//   1. Build-time VITE_NEXUS_API env, if set (lets ops point at a remote
//      backend without rebuilding the binary).
//   2. http://127.0.0.1:8001 — the sidecar default (src-tauri/lib.rs
//      sets NEXUS_HOST=127.0.0.1, NEXUS_PORT=8001 when spawning).
//
// We CANNOT default to "" (relative URL) because in a bundled .dmg the
// frontend is served from tauri://localhost — relative URLs resolve
// against THAT origin and never reach the Python sidecar. In `pnpm
// tauri dev` we still use 127.0.0.1:8001 (no Vite proxy needed since
// the backend's CORS allows it).
const envBase =
  (import.meta as unknown as { env?: { VITE_NEXUS_API?: string } }).env
    ?.VITE_NEXUS_API;
const baseUrl = envBase && envBase.length > 0 ? envBase : 'http://127.0.0.1:8001';

// ─────────────────────────────────────────────────────────────────────
// Persistent user_id storage (M0)
// ─────────────────────────────────────────────────────────────────────
// We persist the user_id minted by /auth/register so subsequent launches
// reuse the same account via /auth/login instead of minting a fresh one
// every time. localStorage in WKWebView is per-app and survives across
// app launches; it gets wiped only if the OS user clears the app's data.
//
// U2+: switch to @tauri-apps/plugin-stronghold so the id is sealed in
// the OS keychain. For M0, localStorage is sufficient.

const STORAGE_KEY_USER_ID = 'nexus.auth.user_id';

function readUserId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY_USER_ID);
  } catch {
    return null;  // SSR / privacy modes where localStorage is unavailable
  }
}

function writeUserId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY_USER_ID, id);
  } catch {
    /* no-op — sign-in still works for this session, just won't persist */
  }
}

function clearUserId(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_USER_ID);
  } catch {
    /* no-op */
  }
}

class _ApiClient {
  private token: string | null = null;

  setToken(t: string | null) { this.token = t; }
  hasToken() { return this.token !== null; }
  getToken() { return this.token; }

  /** Base URL the client posts to — useful when the UI needs to build
   *  a non-fetch URL (e.g. an <a href> to /dicom-viewer/). */
  get baseUrl() { return baseUrl; }

  private headers(extra?: HeadersInit): Headers {
    const h = new Headers(extra);
    h.set('Accept', 'application/json');
    if (this.token) h.set('Authorization', `Bearer ${this.token}`);
    return h;
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const h = this.headers(init?.headers);
    if (init?.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
    const r = await fetch(`${baseUrl}${path}`, { ...init, headers: h });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new ApiError(r.status, text || r.statusText, path);
    }
    return r.json() as Promise<T>;
  }

  /* ────────────────────────── health ────────────────────────── */

  /**
   * Probe the backend. Returns one of:
   *   - 'ok'         — /healthz answered 200.
   *   - 'unreachable'— network/CORS failure (fetch threw). The Tauri
   *                    sidecar is not running, or you're in `pnpm dev`
   *                    without a separate FastAPI on :8001.
   *   - 'unhealthy'  — backend answered but with a non-2xx (auth, 5xx).
   *
   * Used by the chat send path to turn opaque "TypeError: Load failed"
   * into an actionable banner. Never throws.
   */
  async health(): Promise<'ok' | 'unreachable' | 'unhealthy'> {
    try {
      const r = await fetch(`${baseUrl}/healthz`, {
        method: 'GET',
        // Health endpoint is open; no auth header needed.
        // Short timeout so a hung TCP doesn't block the UI for 30s.
        signal: AbortSignal.timeout(2500),
      });
      return r.ok ? 'ok' : 'unhealthy';
    } catch {
      return 'unreachable';
    }
  }

  /* ────────────────────────── auth ────────────────────────── */

  /**
   * M0 auth mode — single-input "sign in", no password.
   *
   * Backend endpoints:
   *   POST /api/v1/auth/register {display_name} → {user_id, jwt_token}
   *   POST /api/v1/auth/login    {user_id}      → {jwt_token}
   *
   * Flow:
   *   1. First-time on this machine OR no cached user_id → register a
   *      new account with the display name. Persist user_id locally
   *      under STORAGE_KEY_USER_ID so the next launch reuses it.
   *   2. Subsequent launches → call /login with the cached user_id.
   *      If the backend's user table got reset (404 from /login),
   *      transparently fall back to /register and persist the new id.
   *
   * Storage: localStorage in M0. WKWebView persists this per-app in
   * ~/Library/WebKit/... — survives across launches, gets wiped only
   * if the OS user nukes the app's webview data. U2+: switch to
   * @tauri-apps/plugin-stronghold for OS keychain storage.
   *
   * `_password` is kept in the signature so existing call sites
   * compile unchanged; we ignore it.
   */
  async login(displayName: string, _password: string): Promise<{ access_token: string }> {
    interface RegisterResponse {
      user_id: string;
      jwt_token: string;
      created_at: string;
    }
    interface LoginResponse {
      jwt_token: string;
      expires_in_seconds: number;
    }

    const cachedUserId = readUserId();

    // Path A: try login with the cached user_id.
    if (cachedUserId) {
      try {
        const r = await this.fetch<LoginResponse>('/api/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({ user_id: cachedUserId }),
        });
        return { access_token: r.jwt_token };
      } catch (err) {
        // 404 = user_id no longer exists on this backend (DB reset, or
        // user switched servers). 400 = malformed cached id. Either way,
        // fall through to fresh register. For other errors (5xx, network)
        // bubble up so the UI can show a real message.
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
          clearUserId();
          // fallthrough
        } else {
          throw err;
        }
      }
    }

    // Path B: no cached id, or cached id was invalid → register fresh.
    const r = await this.fetch<RegisterResponse>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ display_name: displayName }),
    });
    writeUserId(r.user_id);
    return { access_token: r.jwt_token };
  }

  /** Clear the cached user_id. Used by Settings → "Sign out / forget me". */
  forgetUserId() {
    clearUserId();
    this.token = null;
  }

  /* ────────────────────────── patients ────────────────────────── */

  /**
   * Manually register a patient (no DICOM yet).
   *
   * Backend hashes either the MRN or (initials | age | sex) to mint a
   * stable patient_hash. At least one of (initials, mrn) is required —
   * the dialog enforces this client-side.
   *
   * Returns the patient_hash so the caller can immediately navigate to
   * the patient's page or bind the active chat session to it.
   */
  async createManualPatient(input: {
    initials?:        string;
    mrn?:             string;
    age?:             number;     // numeric — backend buckets to age_group
    sex?:             'M' | 'F' | 'O' | '';
    chiefComplaint?:  string;
    notes?:           string;
    sessionId?:       string;
  }): Promise<{ patientHash: string; ageGroup: string }> {
    interface Resp { patient_hash: string; age_group: string }
    const body = {
      initials:        input.initials        ?? '',
      mrn:             input.mrn             ?? '',
      age:             input.age             ?? 0,
      sex:             input.sex             ?? '',
      chief_complaint: input.chiefComplaint  ?? '',
      notes:           input.notes           ?? '',
      session_id:      input.sessionId       ?? '',
    };
    const r = await this.fetch<Resp>('/api/v1/dicom/patients/register-manual', {
      method: 'POST',
      body:   JSON.stringify(body),
    });
    return { patientHash: r.patient_hash, ageGroup: r.age_group };
  }

  /* ────────────────────────── DICOM studies ────────────────────────── */

  /** List all DICOM studies for a patient (newest-first). Series list
   *  is NOT joined — call ``getStudy`` for that. */
  async listPatientStudies(patientHash: string): Promise<StudyInfo[]> {
    interface RawSeries {
      series_id: string;
      series_instance_uid: string;
      series_number: number | null;
      modality: string;
      body_part: string;
      series_description: string;
      default_wl: number | null;
      default_ww: number | null;
      instance_count: number;
    }
    interface Raw {
      study_id: string;
      study_instance_uid: string;
      study_date: string;
      study_description: string;
      modality: string;
      patient_hash: string;
      patient_age_group: string;
      patient_sex: string;
      series: RawSeries[];
      created_at: number;
    }
    const raw = await this.fetch<Raw[]>(
      `/api/v1/dicom/patients/${encodeURIComponent(patientHash)}/studies`,
    );
    return raw.map((r) => ({
      studyId:           r.study_id,
      studyInstanceUid:  r.study_instance_uid,
      studyDate:         r.study_date,
      studyDescription:  r.study_description,
      modality:          r.modality,
      patientHash:       r.patient_hash,
      patientAgeGroup:   r.patient_age_group,
      patientSex:        r.patient_sex,
      series:            (r.series ?? []).map((s) => ({
        seriesId:          s.series_id,
        seriesInstanceUid: s.series_instance_uid,
        seriesNumber:      s.series_number,
        modality:          s.modality,
        bodyPart:          s.body_part,
        seriesDescription: s.series_description,
        defaultWl:         s.default_wl,
        defaultWw:         s.default_ww,
        instanceCount:     s.instance_count,
      })),
      createdAt:         r.created_at,
    }));
  }

  /** Full study with series joined. */
  async getStudy(studyId: string): Promise<StudyInfo> {
    interface RawSeries {
      series_id: string;
      series_instance_uid: string;
      series_number: number | null;
      modality: string;
      body_part: string;
      series_description: string;
      default_wl: number | null;
      default_ww: number | null;
      instance_count: number;
    }
    interface Raw {
      study_id: string;
      study_instance_uid: string;
      study_date: string;
      study_description: string;
      modality: string;
      patient_hash: string;
      patient_age_group: string;
      patient_sex: string;
      series: RawSeries[];
      created_at: number;
    }
    const r = await this.fetch<Raw>(
      `/api/v1/dicom/studies/${encodeURIComponent(studyId)}`,
    );
    return {
      studyId:           r.study_id,
      studyInstanceUid:  r.study_instance_uid,
      studyDate:         r.study_date,
      studyDescription:  r.study_description,
      modality:          r.modality,
      patientHash:       r.patient_hash,
      patientAgeGroup:   r.patient_age_group,
      patientSex:        r.patient_sex,
      series:            (r.series ?? []).map((s) => ({
        seriesId:          s.series_id,
        seriesInstanceUid: s.series_instance_uid,
        seriesNumber:      s.series_number,
        modality:          s.modality,
        bodyPart:          s.body_part,
        seriesDescription: s.series_description,
        defaultWl:         s.default_wl,
        defaultWw:         s.default_ww,
        instanceCount:     s.instance_count,
      })),
      createdAt:         r.created_at,
    };
  }

  /** Build the absolute URL of a render. Bearer-auth required, so use
   *  this for fetch() and pipe into a blob; ``<img src>`` won't work
   *  cross-origin without a query-token endpoint. */
  renderUrl(
    studyId: string, seriesId: string,
    opts?: { kind?: 'slice' | 'mip' | 'grid'; slice?: number; window?: string },
  ): string {
    const q = new URLSearchParams();
    if (opts?.kind)   q.set('kind',   opts.kind);
    if (opts?.slice !== undefined) q.set('slice',  String(opts.slice));
    if (opts?.window) q.set('window', opts.window);
    const qs = q.toString();
    return (
      `${baseUrl}/api/v1/dicom/studies/${encodeURIComponent(studyId)}` +
      `/series/${encodeURIComponent(seriesId)}/render` +
      (qs ? `?${qs}` : '')
    );
  }

  /** Fetch a render as a blob URL (object URL). Caller is responsible
   *  for URL.revokeObjectURL when the image unmounts. */
  async renderBlobUrl(
    studyId: string, seriesId: string,
    opts?: { kind?: 'slice' | 'mip' | 'grid'; slice?: number; window?: string },
  ): Promise<string> {
    const r = await fetch(this.renderUrl(studyId, seriesId, opts), {
      headers: this.headers(),
    });
    if (!r.ok) throw new ApiError(r.status, await r.text().catch(() => r.statusText), '/render');
    const blob = await r.blob();
    return URL.createObjectURL(blob);
  }

  /** Delete a patient. Returns per-table row counts removed (server
   *  also un-binds chat sessions instead of deleting them). 404 if no
   *  rows for this user matched the hash. */
  async deletePatient(patientHash: string): Promise<{
    patientHash: string;
    deleted: Record<string, number>;
  }> {
    interface Raw { patient_hash: string; deleted: Record<string, number> }
    const r = await this.fetch<Raw>(
      `/api/v1/dicom/patients/${encodeURIComponent(patientHash)}`,
      { method: 'DELETE' },
    );
    return { patientHash: r.patient_hash, deleted: r.deleted };
  }

  /** Upload a DICOM zip (or any file) via multipart. Returns the
   *  file_id + study_id (populated once the background DICOM parse
   *  finishes — call ``getPrerenderProgress(file_id)`` to poll).
   *  ``onProgress`` reports raw upload bytes via XHR; the post-upload
   *  DICOM parse is reported separately by the polling endpoint. */
  async uploadFile(
    file: File | Blob,
    filename: string,
    options?: {
      sessionId?: string;
      onProgress?: (loaded: number, total: number) => void;
    },
  ): Promise<{
    fileId: string;
    name: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    dicomStatus: string;
    dicomStudyId: string;
  }> {
    interface Raw {
      file_id: string;
      name: string;
      mime: string;
      size_bytes: number;
      sha256: string;
      dicom_status: string;
      dicom_study_id: string;
    }
    // We use XHR (not fetch) so we can report upload progress, which
    // matters for multi-gigabyte DICOM zips.
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file, filename);
      if (options?.sessionId) form.append('session_id', options.sessionId);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${baseUrl}/api/v1/files/upload`);
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      if (options?.onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) options.onProgress!(e.loaded, e.total);
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const raw = JSON.parse(xhr.responseText) as Raw;
            resolve({
              fileId:       raw.file_id,
              name:         raw.name,
              mime:         raw.mime,
              sizeBytes:    raw.size_bytes,
              sha256:       raw.sha256,
              dicomStatus:  raw.dicom_status,
              dicomStudyId: raw.dicom_study_id,
            });
          } catch (e) {
            reject(new ApiError(xhr.status, `bad JSON: ${e}`, '/api/v1/files/upload'));
          }
        } else {
          reject(new ApiError(xhr.status, xhr.responseText || xhr.statusText, '/api/v1/files/upload'));
        }
      };
      xhr.onerror  = () => reject(new TypeError('upload network error'));
      xhr.onabort  = () => reject(new ApiError(0, 'aborted', '/api/v1/files/upload'));
      xhr.send(form);
    });
  }

  /** Poll a DICOM zip's post-upload background parse. */
  async getPrerenderProgress(fileId: string): Promise<{
    state: 'queued' | 'parsing' | 'rendering' | 'done' | 'error' | 'unknown';
    stage: string;
    current: number;
    total: number;
    percent: number;
    studyId: string;
    error: string;
  }> {
    interface Raw {
      state: string; stage: string; current: number; total: number;
      percent: number; study_id: string; preview_dir: string; error: string;
    }
    const r = await this.fetch<Raw>(
      `/api/v1/files/${encodeURIComponent(fileId)}/prerender-progress`,
    );
    return {
      state:   r.state as any,
      stage:   r.stage,
      current: r.current,
      total:   r.total,
      percent: r.percent,
      studyId: r.study_id,
      error:   r.error,
    };
  }

  async listPatients() {
    interface Raw {
      patient_hash: string;
      patient_age_group: string | null;
      patient_sex: string | null;
      study_count: number;
      latest_study_date: string | null;
      latest_modality: string | null;
      last_seen_at: number;
      initials?: string;
      mrn?: string;
      sequence_number?: number;
      created_at?: number;
    }
    const raw = await this.fetch<Raw[]>('/api/v1/dicom/patients');
    return raw.map((r) => ({
      patientHash:     r.patient_hash,
      ageGroup:        r.patient_age_group ?? '',
      sex:             (r.patient_sex as 'M' | 'F' | '') ?? '',
      studyCount:      r.study_count ?? 0,
      latestStudyDate: r.latest_study_date ?? '',
      latestModality:  r.latest_modality ?? '',
      lastSeenAt:      r.last_seen_at ?? 0,
      initials:        r.initials ?? '',
      mrn:             r.mrn ?? '',
      sequenceNumber:  r.sequence_number ?? 0,
      createdAt:       r.created_at ?? 0,
    }));
  }

  /* ────────────────────────── memory v3 ────────────────────────── */

  async getPatientProjection(patientHash: string): Promise<PatientProjection> {
    interface Raw {
      patient_hash: string;
      findings: any[]; medications: any[]; differentials: any[];
      studies: any[]; semantic_facts: any[];
      unresolved_conflict_count: number;
    }
    const r = await this.fetch<Raw>(
      `/api/v1/memory/patient/${encodeURIComponent(patientHash)}/projection`,
    );
    const cast = (n: any) => ({
      nodeId: n.node_id, nodeType: n.node_type, content: n.content,
      weight: n.weight, encounterId: n.encounter_id, updatedAt: n.updated_at,
    });
    return {
      patientHash: r.patient_hash,
      findings: r.findings.map(cast),
      medications: r.medications.map(cast),
      differentials: r.differentials.map(cast),
      studies: r.studies.map(cast),
      semanticFacts: r.semantic_facts.map(cast),
      unresolvedConflictCount: r.unresolved_conflict_count,
    };
  }

  async getCitation(nodeId: number): Promise<ProvenanceRow> {
    interface Raw {
      node_id: number; source_kind: string; source_ref: string;
      source_locator: any; evidence_quote: string;
      extraction_model: string; extraction_prompt_id: string;
      confidence: number; redaction_version: string;
      extracted_at: number; extracted_by_user: string;
      superseded_by_node: number | null; retracted_at: number | null;
    }
    const r = await this.fetch<Raw>(
      `/api/v1/memory/citation/${nodeId}`,
    );
    return {
      nodeId: r.node_id,
      sourceKind: r.source_kind as ProvenanceRow['sourceKind'],
      sourceRef: r.source_ref,
      sourceLocator: r.source_locator,
      evidenceQuote: r.evidence_quote,
      extractionModel: r.extraction_model,
      extractionPromptId: r.extraction_prompt_id,
      confidence: r.confidence,
      redactionVersion: r.redaction_version,
      extractedAt: r.extracted_at,
      extractedByUser: r.extracted_by_user,
      supersededByNode: r.superseded_by_node,
      retractedAt: r.retracted_at,
    };
  }

  /* ────────────────────────── practitioner ────────────────────────── */

  async listPractitionerCandidates(): Promise<PractitionerCandidate[]> {
    interface Raw { candidates: any[]; }
    const r = await this.fetch<Raw>('/api/v1/memory/practitioner/candidates');
    return r.candidates.map((c) => ({
      factKind: c.fact_kind,
      patternKey: c.pattern_key,
      patternValue: c.pattern_value,
      observedCount: c.observed_count,
      distinctPatientCount: c.distinct_patient_count,
      confidence: c.confidence,
      firstObservedAt: c.first_observed_at,
      lastReinforcedAt: c.last_reinforced_at,
    }));
  }

  async practitionerPendingCount(): Promise<number> {
    const r = await this.fetch<{ count: number }>(
      '/api/v1/memory/practitioner/pending_count',
    );
    return r.count;
  }

  async confirmPractitionerFact(factKind: string, patternKey: string) {
    return this.fetch(
      `/api/v1/memory/practitioner/${encodeURIComponent(factKind)}/${encodeURIComponent(patternKey)}/confirm`,
      { method: 'POST' },
    );
  }

  async rejectPractitionerFact(factKind: string, patternKey: string, reason?: string) {
    const qs = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    return this.fetch(
      `/api/v1/memory/practitioner/${encodeURIComponent(factKind)}/${encodeURIComponent(patternKey)}/reject${qs}`,
      { method: 'POST' },
    );
  }

  /* ────────────────────────── export / restore ────────────────────────── */

  /**
   * Trigger a full self-contained export (FHIR R5 + JSON + SQL dump).
   * Returns the path on disk where the bundle was written and the row
   * counts for the toast. Backend writes to ~/Documents/Nexus Archive/.
   *
   * If the endpoint isn't deployed yet, the caller gets a 404 ApiError
   * and surfaces a "ships in M3.3 finalize" message — no silent failure.
   */
  async exportBundle(): Promise<{
    bundlePath: string;
    bytes: number;
    counts: Record<string, number>;
    createdAt: number;
  }> {
    interface Raw {
      bundle_path: string;
      bytes: number;
      counts: Record<string, number>;
      created_at: number;
    }
    const r = await this.fetch<Raw>('/api/v1/export/bundle', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return {
      bundlePath: r.bundle_path,
      bytes:      r.bytes,
      counts:     r.counts,
      createdAt:  r.created_at,
    };
  }

  /** Resolve the on-disk path of the user's archive folder.
   *  Backend computes this from $HOME / Documents / Nexus Archive. */
  async archiveFolder(): Promise<string> {
    const r = await this.fetch<{ path: string }>('/api/v1/export/archive_path');
    return r.path;
  }

  /* ────────────────────────── settings · LLM ────────────────────────── */

  /** Read LLM settings from the backend; if the endpoint is missing
   *  (stale binary), fall back to a direct Tauri IPC read of the .env
   *  file so the UI still shows what's on disk. */
  async getLlmSettings(): Promise<LlmStatus> {
    interface Raw {
      provider: string;
      model: string;
      env_file_path: string;
      env_file_exists: boolean;
      has_gemini_key: boolean;
      has_openai_key: boolean;
      has_anthropic_key: boolean;
      advisory: string | null;
    }
    try {
      const r = await this.fetch<Raw>('/api/v1/settings/llm');
      return {
        provider:        r.provider as LlmStatus['provider'],
        model:           r.model,
        envFilePath:     r.env_file_path,
        envFileExists:   r.env_file_exists,
        hasGeminiKey:    r.has_gemini_key,
        hasOpenaiKey:    r.has_openai_key,
        hasAnthropicKey: r.has_anthropic_key,
        advisory:        r.advisory,
      };
    } catch (e) {
      // Backend 404 / 5xx → try Tauri's direct-from-disk read.
      const ipc = await tauriInvoke<Raw>('llm_env_status');
      if (ipc) {
        return {
          provider:        ipc.provider as LlmStatus['provider'],
          model:           ipc.model,
          envFilePath:     ipc.env_file_path,
          envFileExists:   ipc.env_file_exists,
          hasGeminiKey:    ipc.has_gemini_key,
          hasOpenaiKey:    ipc.has_openai_key,
          hasAnthropicKey: ipc.has_anthropic_key,
          advisory:        ipc.advisory,
        };
      }
      throw e;
    }
  }

  async putLlmSettings(input: {
    provider?: 'gemini' | 'openai' | 'anthropic';
    model?: string;
    geminiApiKey?: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
  }): Promise<{ ok: boolean; writtenKeys: string[]; status: LlmStatus; viaFallback?: boolean }> {
    interface Raw {
      ok: boolean;
      env_file_path: string;
      written_keys: string[];
      status: {
        provider: string;
        model: string;
        env_file_path: string;
        env_file_exists: boolean;
        has_gemini_key: boolean;
        has_openai_key: boolean;
        has_anthropic_key: boolean;
        advisory: string | null;
      };
    }
    const body: Record<string, string> = {};
    if (input.provider)        body.provider          = input.provider;
    if (input.model)           body.model             = input.model;
    if (input.geminiApiKey)    body.gemini_api_key    = input.geminiApiKey;
    if (input.openaiApiKey)    body.openai_api_key    = input.openaiApiKey;
    if (input.anthropicApiKey) body.anthropic_api_key = input.anthropicApiKey;
    try {
      const r = await this.fetch<Raw>('/api/v1/settings/llm', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      return {
        ok: r.ok,
        writtenKeys: r.written_keys,
        status: {
          provider:        r.status.provider as LlmStatus['provider'],
          model:           r.status.model,
          envFilePath:     r.status.env_file_path,
          envFileExists:   r.status.env_file_exists,
          hasGeminiKey:    r.status.has_gemini_key,
          hasOpenaiKey:    r.status.has_openai_key,
          hasAnthropicKey: r.status.has_anthropic_key,
          advisory:        r.status.advisory,
        },
      };
    } catch (e) {
      // Backend endpoint missing (stale binary) → write the .env via
      // Tauri IPC directly. This is THE fallback that makes Save work
      // before the user rebuilds; once the new sidecar comes up it
      // reads the same file.
      const updates: Record<string, string> = {};
      if (input.provider)        updates.DEFAULT_LLM_PROVIDER = input.provider;
      if (input.model)           updates.DEFAULT_LLM_MODEL    = input.model;
      if (input.geminiApiKey)    updates.GEMINI_API_KEY       = input.geminiApiKey;
      if (input.openaiApiKey)    updates.OPENAI_API_KEY       = input.openaiApiKey;
      if (input.anthropicApiKey) updates.ANTHROPIC_API_KEY    = input.anthropicApiKey;

      const ipc = await tauriInvoke<Raw>('llm_env_write', { updates });
      if (!ipc) {
        // Neither path available — we're in browser-only dev with no
        // Tauri runtime AND no backend. Surface the original error.
        throw e;
      }
      return {
        ok: ipc.ok,
        writtenKeys: ipc.written_keys,
        viaFallback: true,
        status: {
          provider:        ipc.status.provider as LlmStatus['provider'],
          model:           ipc.status.model,
          envFilePath:     ipc.status.env_file_path,
          envFileExists:   ipc.status.env_file_exists,
          hasGeminiKey:    ipc.status.has_gemini_key,
          hasOpenaiKey:    ipc.status.has_openai_key,
          hasAnthropicKey: ipc.status.has_anthropic_key,
          advisory:        ipc.status.advisory,
        },
      };
    }
  }

  /** Kick the sidecar (kill + respawn) so a freshly-written .env is
   *  picked up without quitting the app. No-op when not in Tauri. */
  async restartSidecar(): Promise<boolean> {
    const r = await tauriInvoke<string>('restart_sidecar');
    return r === 'restarted';
  }

  /* ────────────────────────── chat (SSE) ────────────────────────── */

  /**
   * Stream a chat turn. Returns an async iterable of typed chunks.
   *
   * The backend emits `data: {...}\n\n` SSE messages; this method parses
   * them into ChatStreamChunk objects.
   */
  async *sendChat(
    text: string,
    sessionId: string,
    patientHash: string | null,
  ): AsyncIterable<ChatStreamChunk> {
    const r = await fetch(`${baseUrl}/api/v1/agent/chat`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text, session_id: sessionId, patient_hash: patientHash }),
    });
    if (!r.ok || !r.body) {
      throw new ApiError(r.status, await r.text().catch(() => r.statusText),
                         '/api/v1/agent/chat');
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      // SSE messages are separated by blank lines.
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              yield JSON.parse(line.slice(6)) as ChatStreamChunk;
            } catch {
              /* malformed payload; skip */
            }
          }
        }
      }
    }
  }
}

/**
 * Lazy Tauri IPC invoke. Returns ``null`` when not running inside the
 * Tauri shell (e.g. plain ``pnpm dev`` in a browser tab) so callers
 * can ``if (r) { ... } else fall back to HTTP``. We dynamic-import
 * ``@tauri-apps/api/core`` so the bundle still loads cleanly outside
 * Tauri — the import itself throws there.
 */
async function tauriInvoke<T>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T | null> {
  try {
    const mod = await import('@tauri-apps/api/core');
    if (mod && typeof mod.invoke === 'function') {
      return (await mod.invoke(cmd, args)) as T;
    }
  } catch {
    /* not running under Tauri — fall through */
  }
  return null;
}

export class ApiError extends Error {
  constructor(public status: number, body: string, public path: string) {
    super(`API ${status} on ${path}: ${body}`);
  }
}

export const api = new _ApiClient();
