import type { IngestionAnalyzer } from './ingestion.service.js'

export const analyzerRegistry: Record<string, IngestionAnalyzer> = {}

export function registerAnalyzer(mimeType: string, analyzer: IngestionAnalyzer) {
  analyzerRegistry[mimeType] = analyzer
}
