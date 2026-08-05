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
  name?: string;
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
  scope?: 'global' | 'patient';
  patient_hash?: string;
  status?: 'open' | 'closed';
  closed_at?: string;
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

export interface MedicalRecordSections {
  chief_complaint?: string;
  diagnosis?: string;
  treatment_plan?: string;
  physical_exam?: string;
  history_of_present_illness?: string;
  past_medical_history?: string;
  family_history?: string;
  progress_notes?: string;
}

export interface MedicalRecordSummary {
  id: string;
  title: string;
  updated_at: string;
  sections: MedicalRecordSections;
}

export type MedicalRecordEntryType =
  | 'lab'
  | 'imaging'
  | 'pathology'
  | 'ecg'
  | 'note'
  | 'diagnosis'
  | 'medication'
  | 'procedure'
  | 'vaccination'
  | 'allergy';

export type MedicalRecordEntryStatus = 'pending_review' | 'confirmed' | 'rejected';

export interface MedicalRecordEntry {
  id: string;
  patientHash: string;
  type: MedicalRecordEntryType;
  title: string;
  date: string;
  content: string;
  aiSummary?: string;
  sourceFileId?: string;
  sourceStudyId?: string;
  sourceJobId?: string;
  extractedText?: string;
  rawJson?: Record<string, unknown> | null;
  status: MedicalRecordEntryStatus;
  createdBy: 'system' | 'user' | 'agent';
  confirmedAt?: string;
  confirmedBy?: string;
  rejectedReason?: string;
  version: number;
  previousVersionId?: string;
  linkedRecordIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MedicalRecordEntryDraft {
  type: MedicalRecordEntryType;
  title: string;
  date?: string;
  content: string;
  aiSummary?: string;
  sourceFileId?: string;
  sourceStudyId?: string;
  sourceJobId?: string;
  extractedText?: string;
  rawJson?: Record<string, unknown>;
  status?: MedicalRecordEntryStatus;
  createdBy?: 'system' | 'user' | 'agent';
  linkedRecordIds?: string[];
}

export type IngestionJobStatus =
  | 'pending'
  | 'extracting'
  | 'analyzing'
  | 'awaiting_review'
  | 'completed'
  | 'rejected'
  | 'failed';

export interface IngestionJob {
  id: string;
  userId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  patientHash?: string;
  studyId?: string;
  uploadedBy: string;
  extractedText?: string;
  extractedJson?: unknown;
  status: IngestionJobStatus;
  confidence?: 'high' | 'medium' | 'low';
  reasoning?: string;
  resultPayload?: { entries?: MedicalRecordEntry[] } | null;
  retryCount: number;
  failedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  id: string;
  userId: string;
  targetType: string;
  targetId: string;
  status: ApprovalStatus;
  payload?: Record<string, unknown> | null;
  diff?: Record<string, unknown> | null;
  reason?: string;
  actorId?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string;
  createdAt: string;
  entry?: { id: string; patientHash: string; title: string; type: string };
}

export interface BrainStats {
  pending: number;
  confirmedToday: number;
  totalEntries: number;
}

export type MemoryProposalKind = 'fact' | 'article' | 'episode_summary' | 'compaction_summary';

export interface MemoryProposal {
  id: string;
  userId: string;
  scopeType: string;
  patientHash?: string | null;
  studyId?: string | null;
  kind: MemoryProposalKind;
  content: string;
  importance: number;
  confidence: string;
  reason?: string | null;
  sourceRange?: string | null;
  conflictsWith?: string | null;
  status: 'pending' | 'approved' | 'rejected';
  rejectedReason?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
}

export interface MemoryProjection {
  findings?: MemoryFinding[];
  medications?: MemoryFinding[];
  timeline?: MemoryTimelineEvent[];
  medical_record?: MedicalRecordSummary | null;
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

export interface Article {
  id: string;
  title: string;
  content: string;
  sources: string[];
  version: number;
  status: 'current' | 'stale' | 'superseded';
  staleBecause?: string[];
  impact?: ArticleImpact[];
  createdAt: number;
  updatedAt: number;
}

export interface ArticleImpact {
  factId: string;
  status: string;
  content: string;
  message: string;
}

export interface LlmCostDashboard {
  totalCalls: number;
  totalTokens: number;
  totalCostUsd: number;
  byAction: Record<string, number>;
  byModel: Record<string, { calls: number; tokens: number; costUsd: number }>;
}

export interface TelemetryDashboard {
  totalEvents: number;
  router: {
    byIntent: Record<string, number>;
    llmFallbackRate: number;
    ruleHitRate: number;
  };
  kbCommands: Record<string, number>;
  gaps: {
    created: number;
    answered: number;
    ignored: number;
    autoResolved: number;
    resolutionRate: number;
  };
  llmCost: LlmCostDashboard;
}

export interface QueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
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
  | { type: 'context_usage'; history_tokens: number; history_budget: number; history_turns: number; omitted_turns: number; will_compact: boolean }
  | { type: 'compaction_started' }
  | { type: 'compaction_chunk'; text: string }
  | { type: 'doc_updated'; body: string; summary?: string }
  | { type: 'chart_created'; url: string; markdown?: string; chart_type?: string }
  | { type: 'compaction_completed'; history_tokens?: number; history_budget?: number; history_turns?: number }
  | { type: 'tier_classified'; tier: 'T1' | 'T2' | 'T3'; view_kind?: string; anchor?: string }
  | { type: 'context_info'; text: string; kind?: string }
  | { type: 'reasoning_chunk'; text: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'thought'; text: string }
  | { type: 'search_query'; query: string }
  | { type: 'search_results_summary'; text: string }
  | { type: 'image_attached'; url?: string; study_id?: string; caption?: string }
  | { type: 'sidecar_file'; file_id: string; file_name: string; mime_type: string; download_url: string; expires_in: number; knowledge_payload?: { title: string; content: string } }
  | { type: 'final_answer_chunk'; text: string }
  | { type: 'citations'; items: { text: string; source?: string }[] }
  | { type: 'turn_complete'; assistant_event_idx?: number }
  | { type: 'error'; message: string };
