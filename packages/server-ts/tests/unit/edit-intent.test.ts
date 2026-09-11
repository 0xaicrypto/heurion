import { describe, test, expect } from 'vitest'
import {
  DOC_EDIT_INTENT_RE,
  DOC_EDIT_INTENT_ZH_WORDS,
  DOC_EDIT_INTENT_EN_WORDS,
  EDIT_MARKERS,
  EDIT_VETO_ZH_WORDS,
  EDIT_VETO_EN_WORDS,
  PLAN_RELAY_RE,
  CONFIRM_SIGNAL_ZH_WORDS,
} from '../../src/common/edit-intent.js'
import { CONFIRM_RULE } from '../../src/modules/chat/writing-prompts.js'

/**
 * #984 — 编辑意图词表单一来源。
 * 约定:补词必须同步加断言 — 词表数组逐词命中是回归锁(漏词返工 #977
 * 家族的机制性防复发:任何新词条进入数组即被本文件强制验证)。
 */

describe('#984 DOC_EDIT_INTENT_RE 双语逐词命中(单一来源回归锁)', () => {
  test('中文词表逐词命中', () => {
    for (const w of DOC_EDIT_INTENT_ZH_WORDS) {
      expect(DOC_EDIT_INTENT_RE.test(w), `中文词未命中: ${w}`).toBe(true)
    }
  })

  test('英文词表逐词命中(含原前缀匹配形态)', () => {
    for (const w of DOC_EDIT_INTENT_EN_WORDS) {
      expect(DOC_EDIT_INTENT_RE.test(w), `英文词未命中: ${w}`).toBe(true)
    }
    // 前缀词的派生形态(restructur/reorgan 沿用原正则的匹配语义)
    expect(DOC_EDIT_INTENT_RE.test('please restructure the outline')).toBe(true)
    expect(DOC_EDIT_INTENT_RE.test('reorganise the sections')).toBe(true)
  })

  test('非编辑意图不命中(负例)', () => {
    expect(DOC_EDIT_INTENT_RE.test('文档讲了什么')).toBe(false)
    expect(DOC_EDIT_INTENT_RE.test('这个表格怎么来的')).toBe(false)
    expect(DOC_EDIT_INTENT_RE.test('what does this chart mean')).toBe(false)
  })

  test('确认词家族与 CONFIRM_RULE 文案同源(文案改动必须过词表)', () => {
    // CONFIRM_RULE 由词表构建 — 文案必须逐词包含确认词(漏词即此处断言失败)。
    for (const w of CONFIRM_SIGNAL_ZH_WORDS) {
      expect(CONFIRM_RULE.includes(w), `CONFIRM_RULE 文案缺确认词: ${w}`).toBe(true)
    }
  })
})

describe('#984 EDIT_MARKERS(sidecar 否决词)逐词命中', () => {
  test('中文否决词逐词命中', () => {
    for (const w of EDIT_VETO_ZH_WORDS) {
      expect(EDIT_MARKERS.test(w), `否决词未命中: ${w}`).toBe(true)
    }
  })

  test('英文否决词逐词命中', () => {
    for (const w of EDIT_VETO_EN_WORDS) {
      expect(EDIT_MARKERS.test(w), `否决词未命中: ${w}`).toBe(true)
    }
    expect(EDIT_MARKERS.test('please rewrite this paragraph')).toBe(true)
  })

  test('讨论语不命中否决(负例)', () => {
    expect(EDIT_MARKERS.test('这个表格怎么来的')).toBe(false)
    expect(EDIT_MARKERS.test('why is this so')).toBe(false)
  })
})

describe('#984 PLAN_RELAY_RE 接力触发词(与确认信号同源)', () => {
  test('继续/接着/下一步/重试第 K 步/开始/按此计划/go', () => {
    for (const t of ['继续', '接着做', '下一步', '重试第 3 步', '开始', '开始吧', '按此计划', 'go']) {
      expect(PLAN_RELAY_RE.test(t), `接力词未命中: ${t}`).toBe(true)
    }
    expect(PLAN_RELAY_RE.test('帮我导出 docx')).toBe(false)
  })
})
