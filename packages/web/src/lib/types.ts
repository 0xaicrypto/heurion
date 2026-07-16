/**
 * Backend-shaped types for the web UI.
 *
 * These are intentionally minimal for M0 (login + chat). Expand as more
 * desktop-v2 features are migrated.
 */

export type UserRole = 'admin' | 'user';

export interface AuthSession {
  token: string;
  userId: string;
  role: UserRole;
  displayName: string;
  expiresInSeconds: number;
}

export interface AuthError {
  code: string;
  message: string;
}

export type ProviderKind = 'gemini' | 'openai' | 'anthropic' | 'kimi' | 'deepseek';

export interface LlmStatus {
  provider: ProviderKind;
  model: string;
  envFilePath: string;
  envFileExists: boolean;
  hasGeminiKey: boolean;
  hasOpenaiKey: boolean;
  hasAnthropicKey: boolean;
  hasKimiKey: boolean;
  hasDeepseekKey: boolean;
  advisory: string | null;
  activeKeySource?: 'db' | 'env' | 'none' | null;
  activeKeyPreview?: string;
  activeKeyLength?: number;
}

export interface LlmTestResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs?: number;
  error?: string;
  diagnosis?: 'key_missing' | 'key_invalid' | 'quota_exceeded' | 'network' | 'other' | null;
}

export interface PublicConfig {
  appName: string;
  apiVersion: number;
  minClientApiVersion: number;
  defaultProvider?: ProviderKind;
  billingEnabled: boolean;
}

export interface LlmUpdateInput {
  provider?: ProviderKind;
  model?: string;
  gemini_api_key?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  kimi_api_key?: string;
  deepseek_api_key?: string;
}

export interface LlmUpdateResult {
  ok: boolean;
  env_file_path: string;
  written_keys: string[];
  status: LlmStatus;
}

export interface UserProfile {
  user_id: string;
  display_name: string;
  created_at: string;
  updated_at?: string;
  email?: string;
  organization?: string;
  intended_use?: string;
  status?: string;
  tier?: string;
}

export interface Patient {
  patient_hash: string;
  initials?: string;
  mrn?: string;
  age_value?: number;
  age_group?: string;
  sex?: string;
  chief_complaint?: string;
  notes?: string;
  created_at: string;
  updated_at?: string;
  study_count: number;
  latest_study_date?: string;
  latest_modality?: string;
  last_seen_at?: string;
  source?: 'manual' | 'dicom';
}

export interface PatientDetail extends Patient {
  archive?: { archived_at?: string };
}

export interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
  archived?: boolean;
  is_default?: boolean;
  message_count?: number;
}

export interface AgentState {
  user_id: string;
  chain_agent_id?: string;
  chain_register_tx?: string;
  network?: string;
  on_chain: boolean;
  memory_count: number;
  anchored_count: number;
  pending_anchor_count: number;
  failed_anchor_count: number;
  total_anchor_count: number;
  last_anchor?: string;
  last_chain_event?: string;
  server_time: string;
}

export interface TimelineEvent {
  kind: string;
  timestamp: string;
  summary: string;
  sync_id?: string;
  anchor_id?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryFinding {
  node_id: string;
  node_type: string;
  content: string;
  weight?: number;
  encounter_id?: string;
  updated_at?: string;
}

export interface MemoryTimelineEvent {
  event_id: string;
  event_type: string;
  content: string;
  timestamp: string;
}

export interface MemoryProjection {
  findings?: MemoryFinding[];
  medications?: MemoryFinding[];
  timeline?: MemoryTimelineEvent[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  sync_id?: string;
  attachments?: unknown[];
  message_kind?: string;
  metadata?: Record<string, unknown>;
}

export interface AdminUser {
  user_id: string;
  username: string;
  role: string;
  created_at: string;
  disabled_at?: string | null;
  last_login_at?: string;
  has_password: boolean;
}

export interface SendChatOptions {
  text: string;
  sessionId?: string;
  patientHash?: string | null;
  attachments?: unknown[];
  scope?: { kind: string; ref: string };
  skills?: string[];
}

export type ChatStreamChunk =
  | { type: 'turn_started'; event_idx: number; patient_hash: string | null }
  | { type: 'tier_classified'; tier: 'T1' | 'T2' | 'T3'; view_kind?: string; anchor?: string }
  | { type: 'context_info'; text: string; kind?: string }
  | { type: 'reasoning_chunk'; text: string }
  | { type: 'search_query'; query: string }
  | { type: 'search_results_summary'; text: string }
  | { type: 'image_attached'; url?: string; study_id?: string; caption?: string }
  | { type: 'final_answer_chunk'; text: string }
  | { type: 'citations'; items: { text: string; source?: string }[] }
  | { type: 'turn_complete'; assistant_event_idx?: number }
  | { type: 'error'; message: string };
