import { describe, test, expect } from 'vitest';
import { extractKeywords, overlapScore } from '../../src/retrieval/text-overlap.js';

/** #1010: 引用池"当前场景相关"排序的关键词重叠工具。 */
describe('#1010 text-overlap', () => {
  test('extractKeywords: 拉丁词 + CJK bigram', () => {
    const kws = extractKeywords('EGFR TKI 耐药机制');
    expect(kws).toContain('egfr');
    expect(kws).toContain('tki');
    expect(kws).toContain('耐药');
    expect(kws).toContain('药机');
    expect(kws).toContain('机制');
  });

  test('overlapScore: 命中加权，未命中 0', () => {
    const kws = extractKeywords('EGFR 耐药');
    expect(overlapScore(kws, 'EGFR TKI 耐药机制综述')).toBeGreaterThan(0);
    expect(overlapScore(kws, '心血管疾病指南')).toBe(0);
  });

  test('空文本不产生关键词', () => {
    expect(extractKeywords('')).toEqual([]);
  });
});
