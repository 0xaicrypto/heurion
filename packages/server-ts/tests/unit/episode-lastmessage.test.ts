import { describe, test, expect } from 'vitest'
import { EpisodesStore } from '../../src/evolution/stores.js'
import fs from 'fs'

describe('#737 episode lastMessage 与 summary 隔离', () => {
  test('postTurn 记录最近消息不再覆盖 compaction 摘要', () => {
    const dir = fs.mkdtempSync('/tmp/ep-737-')
    try {
      const store = new EpisodesStore(dir)
      // 模拟 postTurn:空 summary + 最近消息
      store.upsert('s1', '', 1)
      store.recordRecentMessage('s1', '用户消息片段前150字'.repeat(20))
      store.commit()

      // 模拟 compaction runner:LLM 合并摘要写入
      store.upsert('s1', '## Objective\n合并后的会话摘要', 10)
      store.commit()

      const ep = store.all().find((e) => e.sessionId === 's1')!
      expect(ep.summary).toContain('合并后的会话摘要')
      expect(ep.summary.startsWith('用户消息片段')).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('summarizer 更新 summary 后 lastMessage 保留', () => {
    const dir = fs.mkdtempSync('/tmp/ep-737b-')
    try {
      const store = new EpisodesStore(dir)
      store.upsert('s2', '', 3)
      store.recordRecentMessage('s2', '最新一条消息')
      store.commit()

      // session-summarizer / knowledge-synthesis 的 upsert 路径
      store.upsert('s2', '结构化摘要', 4)
      store.commit()
      const ep = store.all().find((e) => e.sessionId === 's2')!
      expect(ep.lastMessage).toBe('最新一条消息')
      expect(ep.summary).toBe('结构化摘要')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('recordRecentMessage 对不存在会话创建骨架记录', () => {
    const dir = fs.mkdtempSync('/tmp/ep-737c-')
    try {
      const store = new EpisodesStore(dir)
      store.recordRecentMessage('s3', 'hi')
      const ep = store.all().find((e) => e.sessionId === 's3')!
      expect(ep.lastMessage).toBe('hi')
      expect(ep.summary).toBe('')
      expect(ep.turnCount).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
