import { describe, test, expect } from 'vitest'
import {
  EDIT_CLAIM_RE,
  detectUnbackedEditClaim,
  countClaimedEditItems,
  detectTextOnlyPlan,
} from '../../src/modules/chat/edit-reconciliation.js'

/**
 * #985 — 声明-执行对账单一模块(三套实现合并 + 双语)。
 * 英文回复的对账安全网:edit_document 等工具 description 是英文,模型英文
 * 回复时此前 countClaimedEditItems/EDIT_CLAIM_RE 只认中文 → 对账形同虚设。
 */

describe('#985 detectUnbackedEditClaim 双语声明识别', () => {
  test('中文声明(原词表保持)', () => {
    expect(detectUnbackedEditClaim('已修改完成，正文已更新。')).toBe(true)
    expect(detectUnbackedEditClaim('已插入第三章内容')).toBe(true)
    expect(detectUnbackedEditClaim('格式已整理并重构完毕')).toBe(true)
    expect(detectUnbackedEditClaim('已应用新格式')).toBe(true)
  })

  test('英文声明(生产缺口形态)', () => {
    expect(detectUnbackedEditClaim('All comments have been addressed.')).toBe(true)
    expect(detectUnbackedEditClaim('The edits are done — 1/3 sections updated.')).toBe(true)
    expect(detectUnbackedEditClaim('Section 2 is completed and written back.')).toBe(true)
    expect(detectUnbackedEditClaim('Changes applied to the methods section.')).toBe(true)
  })

  test('非声明负例(双语)', () => {
    expect(detectUnbackedEditClaim('文档未做任何修改。')).toBe(false)
    expect(detectUnbackedEditClaim('我先看看再答复你')).toBe(false)
    expect(detectUnbackedEditClaim('Let me check and get back to you.')).toBe(false)
  })
})

describe('#985 countClaimedEditItems 双语进度计数', () => {
  test('中文进度格式保持(生产样本回归锁)', () => {
    const reply = [
      '已完成全部修改：',
      '| 原意见 | 实际改动 | 章节 |',
      '|---|---|---|',
      '| 缺样本量 | 新增样本量段落 | Methods |',
      '| 讨论薄弱 | 更新讨论段落 | Discussion |',
    ].join('\n')
    expect(countClaimedEditItems(reply)).toBe(2)
    expect(countClaimedEditItems('已完成 3/5：PFS、OS、安全性；剩余 2 节')).toBe(3)
    expect(countClaimedEditItems('意见 2/共 5 已落实')).toBe(2)
    expect(countClaimedEditItems('已完成 1/5：Introduction')).toBe(1)
    expect(countClaimedEditItems('这是一段普通的说明文字。')).toBe(0)
  })

  test('英文进度形态(生产缺口:英文回复对账失效)', () => {
    expect(countClaimedEditItems('1/3 completed: Introduction.')).toBe(1)
    expect(countClaimedEditItems('Completed 2/3 sections — Methods updated.')).toBe(2)
    expect(countClaimedEditItems('3 of 5 comments addressed.')).toBe(3)
    // 英文修订对照表行计数
    const reply = [
      'Revision table:',
      '| Original comment | Change | Section |',
      '|---|---|---|',
      '| Missing sample size | Added sample size paragraph | Methods |',
      '| Weak discussion | Updated discussion | Discussion |',
    ].join('\n')
    expect(countClaimedEditItems(reply)).toBe(2)
  })

  test('英文普通说明不计数(负例)', () => {
    expect(countClaimedEditItems('Here is a plain explanation of the results.')).toBe(0)
  })
})

describe('#985 detectTextOnlyPlan(#979 text_plan 守卫提取,单一出口)', () => {
  test('≥3 编号步骤 + 任务语境 → hit', () => {
    const plan = ['计划如下：', '1. 填充 Introduction', '2. 补全 Methods', '3. 修改 Conclusion'].join('\n')
    const r = detectTextOnlyPlan(plan)
    expect(r.numberedStepLines).toBe(3)
    expect(r.hit).toBe(true)
  })

  test('对照表形态 → tableLike hit', () => {
    const r = detectTextOnlyPlan('整改计划对照表如下：| 原意见 | 实际改动 |')
    expect(r.tableLike).toBe(true)
    expect(r.hit).toBe(true)
  })

  test('普通编号列表(非任务语境)不命中', () => {
    const r = detectTextOnlyPlan('1. 第一句话。\n2. 第二句话。')
    expect(r.hit).toBe(false)
  })

  test('英文 text-plan 形态(新增 — 英文计划表此前逃过守卫)', () => {
    const r = detectTextOnlyPlan('Here is the action plan:\n1. Fill Introduction\n2. Fill Methods\n3. Update Discussion')
    expect(r.numberedStepLines).toBe(3)
    expect(r.hit).toBe(true)
  })
})
