import { describe, it, expect } from 'vitest'
import {
  refUnresolvedHint,
  refSourceRule,
  emptyDocRule,
  selectionRule,
  documentRules,
  EXPANSION_RULE,
  CITATION_RULE,
  REVISION_RULE,
  ACTION_RULE,
} from '../../src/modules/chat/writing-prompts.js'

describe('writing-prompts (#699 — 文档场景规则可单测)', () => {
  it('refUnresolvedHint 仅在无正文时给出 import_reference 引导', () => {
    const hint = refUnresolvedHint(true, '## Reference Materials\n(no body)')
    expect(hint).toContain('import_reference')
    expect(hint).toContain('不要用 ocr_image')
    expect(refUnresolvedHint(false, '')).toBe('')
    expect(refUnresolvedHint(true, '[已解析上传文件正文] body')).toBe('')
  })

  it('refSourceRule 仅在有参考材料时禁止复制 old_text', () => {
    expect(refSourceRule(true)).toContain('old_text 禁止从 Reference Materials 复制')
    expect(refSourceRule(false)).toBe('')
  })

  it('emptyDocRule 空文档时分步润色指令(写回后连做,不逐段确认)', () => {
    expect(emptyDocRule(true)).toContain('当前文档正文为空')
    expect(emptyDocRule(true)).toContain('已完成第 1/N 段')
    expect(emptyDocRule(true)).toContain('不要停下来等用户确认')
    expect(emptyDocRule(false)).toBe('')
  })

  it('selectionRule 选中即引用 — 逐字复制', () => {
    expect(selectionRule('some text')).toContain('逐字复制')
    expect(selectionRule(null)).toBe('')
  })

  it('documentRules 短文档档:允许整篇可见 + 禁带序号', () => {
    const r = documentRules({ docFits: true, selection: 'sel', docBodyEmpty: false })
    expect(r).toContain('文档已完整展示')
    expect(r).toContain('逐字复制')
    expect(r).not.toContain('一次只处理一个段落')
    expect(r).toContain('逐字复制')
  })

  it('documentRules 长文档档:逐段纪律 + full_text 限制 + 进度播报', () => {
    const r = documentRules({ docFits: false, selection: null, docBodyEmpty: false })
    expect(r).toContain('一次只处理一个段落')
    expect(r).toContain('full_text')
    expect(r).toContain('已完成 第 i/N 段')
  })

  it('#867 带选区回合:焦点规则让位于选区(消除矛盾指令)', () => {
    const r = documentRules({ docFits: false, selection: '选中的文字', docBodyEmpty: false, selectionSection: { index: 5, title: '统计方法' } })
    expect(r).toContain('本回合以用户选中文本为准')
    expect(r).toContain('第 5 段「统计方法」')
    // 矛盾的「只能编辑当前编辑段落」不再出现
    expect(r).not.toContain('只能编辑「当前编辑段落」范围内的原文')
  })

  it('#872 批量模式:长文档档含自动连做指令', () => {
    const r = documentRules({ docFits: false, selection: null, docBodyEmpty: false })
    expect(r).toContain('批量模式')
    expect(r).toContain('不要每段停下等确认')
  })

  it('documentRules 空文档档包含 emptyDocRule + 扩写纪律', () => {
    const r = documentRules({ docFits: true, selection: null, docBodyEmpty: true })
    expect(r).toContain('当前文档正文为空')
    expect(r).toContain(EXPANSION_RULE.slice(0, 20))
  })

  it('常量规则锚点 — 扩写纪律/引用纪律不被回归删除', () => {
    expect(EXPANSION_RULE).toContain('禁止单轮生成整篇文档')
    expect(CITATION_RULE).toContain('search_citation')
    expect(CITATION_RULE).toContain('严禁编造')
  })

  it('#fix 2026-09 行动优先 — 两种文档档位都注入,治确认太极', () => {
    expect(ACTION_RULE).toContain('立即调用 edit_document')
    expect(ACTION_RULE).toContain('严禁只输出方案/计划/确认话术而不调用工具')
    const short = documentRules({ docFits: true, selection: null, docBodyEmpty: false })
    const long = documentRules({ docFits: false, selection: null, docBodyEmpty: false })
    expect(short).toContain('行动优先')
    expect(long).toContain('行动优先')
    // 扩写:大纲后同回合写第一节,不等确认
    expect(EXPANSION_RULE).toContain('不要输出大纲后停下等确认')
  })

  it('#fix 2026-09 修订意见 — ≤2 条直接执行,≥3 条才计划表', () => {
    expect(REVISION_RULE).toContain('1-2 条明确的修改意见时,直接逐条调用 edit_document 执行')
    expect(REVISION_RULE).toContain('不要先输出计划表等待确认')
    expect(REVISION_RULE).toContain('≥3 条')
    expect(REVISION_RULE).toContain('跳过计划立即执行')
  })

  it('#893 批量写回 — 不再限定每轮一次 edit_document(事故根因②)', () => {
    expect(EXPANSION_RULE).toContain('一轮内可按序调用多次 edit_document')
    expect(EXPANSION_RULE).not.toContain('每轮只调用一次')
    expect(EXPANSION_RULE).not.toContain('下一轮继续下一节')
    expect(REVISION_RULE).toContain('一轮内可按序调用多次 edit_document')
    expect(REVISION_RULE).not.toContain('每轮一次')
    // 「每完成一处播报一行进度」的精神保留
    expect(EXPANSION_RULE).toContain('每完成一处用一行播报进度')
    expect(REVISION_RULE).toContain('每完成一处播报「意见 N/共 M 已落实」')
  })
})
