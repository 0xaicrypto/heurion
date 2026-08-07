export {
  type CompactionCtx,
  type ExtractedFact,
  EXTRACTION_RULES,
  MIN_COMPACT_EVENTS,
  MIN_EXTRACT_EVENTS,
  MAX_RELATED_FACTS,
  MAX_EVENT_CHARS,
  buildContextBlock,
  parseExtractionResult,
} from './budget.js'
export { getInFlightCompaction, ensureSessionCompaction } from './state.js'
export { extractAndProposeFacts, runSessionCompaction, extractSegment, flushUnextracted } from './runner.js'
