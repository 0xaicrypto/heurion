import { describe, test, expect } from 'vitest'
import { classifyQuery, QueryIntent, routeQuery } from '../src/retrieval/query-router'

describe('P3 — Query Router', () => {
  describe('classifyQuery — rule layer', () => {
    test('patient age/name query → sql', () => {
      expect(classifyQuery('ZL 的年龄是多少？')).toBe('sql')
      expect(classifyQuery('患者的性别是什么')).toBe('sql')
      expect(classifyQuery('What is the patient name')).toBe('sql')
    })

    test('patient list → sql', () => {
      expect(classifyQuery('我有几个患者')).toBe('sql')
      expect(classifyQuery('list all my patients')).toBe('sql')
    })

    test('file reference → file', () => {
      expect(classifyQuery('#文件 CT报告')).toBe('file')
      expect(classifyQuery('查看上传的CT报告')).toBe('file')
    })

    test('semantic/clinical question → vector', () => {
      expect(classifyQuery('NSCLC 免疫治疗有什么进展')).toBe('vector')
      expect(classifyQuery('EGFR突变的管理策略')).toBe('vector')
      expect(classifyQuery('what are the latest immunotherapy options')).toBe('vector')
    })

    test('default → mixed', () => {
      expect(classifyQuery('帮我总结一下 ZL 的情况')).toBe('mixed')
    })
  })

  describe('classifyQuery — fallback', () => {
    test('empty string → mixed', () => {
      expect(classifyQuery('')).toBe('mixed')
    })
  })

  describe('routeQuery shape', () => {
    test('returns routes array per intent', () => {
      const r1 = routeQuery('ZL的年龄', 'sql')
      expect(r1).toContain('sql')
      expect(r1).not.toContain('vector')

      const r2 = routeQuery('免疫治疗进展', 'vector')
      expect(r2).toContain('vector')
      expect(r2).not.toContain('sql')

      const r3 = routeQuery('总结ZL情况', 'mixed')
      expect(r3).toContain('sql')
      expect(r3).toContain('vector')
    })
  })
})
