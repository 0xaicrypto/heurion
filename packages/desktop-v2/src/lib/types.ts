/**
 * Backend-shaped types (mirror of memory_router_v2.py + chat_router_v2.py).
 *
 * Per nexus-ux-redesign-v2.md §8 these mirror what the FastAPI server
 * returns. Keep in sync by hand for now; future task could autogenerate
 * via OpenAPI.
 */

export interface ProvenanceRow {
  nodeId: number;
  sourceKind: 'study' | 'chat' | 'lab' | 'manual';
  sourceRef: string;
  sourceLocator: Record<string, unknown>;
  evidenceQuote: string;
  extractionModel: string;
  extractionPromptId: string;
  confidence: number;
  redactionVersion: string;
  extractedAt: number;
  extractedByUser: string;
  supersededByNode: number | null;
  retractedAt: number | null;
}

export interface GraphNodeOut {
  nodeId: number;
  nodeType: string;
  content: Record<string, unknown>;
  weight: number;
  encounterId: string | null;
  updatedAt: number;
}

export interface PatientProjection {
  patientHash: string;
  findings: GraphNodeOut[];
  medications: GraphNodeOut[];
  differentials: GraphNodeOut[];
  studies: GraphNodeOut[];
  semanticFacts: GraphNodeOut[];
  unresolvedConflictCount: number;
}

export interface PractitionerCandidate {
  factKind: 'style' | 'workflow' | 'practice' | 'calibration';
  patternKey: string;
  patternValue: Record<string, unknown>;
  observedCount: number;
  distinctPatientCount: number;
  confidence: number;
  firstObservedAt: number;
  lastReinforcedAt: number;
}

export type TierKind = 'T1' | 'T2' | 'T3';

export interface SeriesInfo {
  seriesId: string;
  seriesInstanceUid: string;
  seriesNumber: number | null;
  modality: string;
  bodyPart: string;
  seriesDescription: string;
  defaultWl: number | null;
  defaultWw: number | null;
  instanceCount: number;
}

export interface StudyInfo {
  studyId: string;
  studyInstanceUid: string;
  studyDate: string;
  studyDescription: string;
  modality: string;
  patientHash: string;
  patientAgeGroup: string;
  patientSex: string;
  series: SeriesInfo[];
  createdAt: number;
}

/** Active LLM configuration as reported by /api/v1/settings/llm. The
 *  per-provider booleans are presence flags only — the keys themselves
 *  never leave the server. ``advisory`` is non-null when the active
 *  provider has no key configured, so the UI can render a banner. */
export interface LlmStatus {
  provider: 'gemini' | 'openai' | 'anthropic';
  model: string;
  envFilePath: string;
  envFileExists: boolean;
  hasGeminiKey: boolean;
  hasOpenaiKey: boolean;
  hasAnthropicKey: boolean;
  advisory: string | null;
}

export interface CitationRef {
  node_id: number;
  kind: string;
}

export type ChatStreamChunk =
  | { type: 'turn_started'; event_idx: number; patient_hash: string | null }
  | { type: 'tier_classified'; tier: TierKind; view_kind?: string; anchor?: string }
  | { type: 'reasoning_chunk'; text: string }
  | { type: 'search_query'; tool: string; query: string }
  | { type: 'search_results_summary'; count: number; preview: string }
  | { type: 'image_attached'; image_sha256s: string[] }
  | { type: 'final_answer_chunk'; text: string }
  | { type: 'citations'; refs: CitationRef[] }
  | { type: 'conflict_in_answer'; conflict_id: string; finding_label: string }
  | { type: 'turn_complete'; assistant_event_idx?: number }
  | { type: 'error'; message: string };
