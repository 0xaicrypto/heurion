import { describe, test, expect } from 'vitest'
import { extractEntities, extractRelations, ClinicalEntity } from '../src/patients/graph-extractor'

describe('P5 — Dual-Track Graph Extraction', () => {
  describe('extractEntities — rule-based (Track 1)', () => {
    test('extracts diagnosis from text', () => {
      const text = 'Patient diagnosed with NSCLC Stage IIIA, EGFR exon19 deletion'
      const entities = extractEntities(text)
      expect(entities.some(e => e.type === 'diagnosis' && e.content.includes('NSCLC'))).toBe(true)
      expect(entities.some(e => e.type === 'finding' && e.content.includes('EGFR'))).toBe(true)
    })

    test('extracts lab values', () => {
      const text = 'Lab results: CEA 3.2 ng/mL (normal), WBC 7.5, CRP 12'
      const entities = extractEntities(text)
      expect(entities.some(e => e.type === 'lab_result' && e.content.includes('CEA'))).toBe(true)
      expect(entities.some(e => e.type === 'lab_result' && e.content.includes('CRP'))).toBe(true)
    })

    test('extracts imaging findings', () => {
      const text = 'CT chest shows RUL nodule 18mm, no pleural effusion'
      const entities = extractEntities(text)
      expect(entities.some(e => e.type === 'imaging' && e.content.includes('nodule'))).toBe(true)
    })

    test('extracts medications', () => {
      const text = 'Continue Osimertinib 80mg daily. Added dexamethasone 4mg BID.'
      const entities = extractEntities(text)
      const medFinder = (e: ClinicalEntity) => e.type === 'medication'
      expect(entities.some(e => medFinder(e) && e.content.includes('Osimertinib'))).toBe(true)
      expect(entities.some(e => medFinder(e) && e.content.includes('dexamethasone'))).toBe(true)
    })

    test('returns empty for no clinical content', () => {
      expect(extractEntities('Hello world')).toEqual([])
      expect(extractEntities('')).toEqual([])
    })

    test('includes confidence scores', () => {
      const entities = extractEntities('NSCLC with EGFR T790M mutation')
      for (const e of entities) {
        expect(e.confidence).toBeGreaterThan(0)
        expect(e.confidence).toBeLessThanOrEqual(1)
      }
    })
  })

  describe('extractRelations — Track 1', () => {
    test('extracts Finding→measuredIn→Study relations', () => {
      const entities: ClinicalEntity[] = [
        { type: 'finding', content: 'RUL nodule 18mm', confidence: 0.9 },
        { type: 'imaging', content: 'CT scan July 2026', confidence: 0.95 },
      ]
      const relations = extractRelations(entities, 'CT scan July 2026 showed RUL nodule 18mm')
      expect(relations.length).toBeGreaterThan(0)
      expect(relations[0]).toHaveProperty('from')
      expect(relations[0]).toHaveProperty('to')
      expect(relations[0]).toHaveProperty('relation')
    })
  })
})
