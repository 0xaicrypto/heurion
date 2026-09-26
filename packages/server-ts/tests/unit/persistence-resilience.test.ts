import { describe, test, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from '../../src/core/event-log.js'
import { EmbeddingIndex, type EmbeddingRecord } from '../../src/memory/embedding-index.js'

/**
 * P1 — 持久化文件原子重写 + 截断行容错。
 *
 * 修复前：
 *  - event_log.jsonl 整体 JSON.parse，崩溃留下的半行让整个账号 EventLog
 *    构造抛错（接口 500）；
 *  - event-log 重写 / embedding index 覆盖写非原子，写入中途崩溃即数据全失。
 */
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'heurion-persist-'))
}

describe('P1 EventLog 截断容错 + 原子重写', () => {
  test('尾部半行不炸构造：有效事件保留、idx 续号正确', async () => {
    const dir = tmp()
    try {
      const first = new EventLog(dir, 'u1')
      first.append({ timestamp: 1, eventType: 'chat', content: 'one', metadata: {}, agentId: 'u1', sessionId: 's1' })
      first.append({ timestamp: 2, eventType: 'chat', content: 'two', metadata: {}, agentId: 'u1', sessionId: 's1' })
      await first.flush()

      const file = join(dir, 'event_log.jsonl')
      const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
      // 模拟崩溃：最后一行只写了一半。
      writeFileSync(file, `${lines[0]}\n${lines[1].slice(0, Math.floor(lines[1].length / 2))}`)

      const recovered = new EventLog(dir, 'u1')
      expect(recovered.count()).toBe(1)
      const appended = recovered.append({ timestamp: 3, eventType: 'chat', content: 'three', metadata: {}, agentId: 'u1', sessionId: 's1' })
      expect(appended.idx).toBe(2)
      await recovered.flush()
      const finalLines = readFileSync(file, 'utf-8').trim().split('\n')
      expect(finalLines.every((l) => { JSON.parse(l); return true })).toBe(true)
      expect(finalLines.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('deleteSession 走原子重写：内容完整且无临时文件残留', async () => {
    const dir = tmp()
    try {
      const log = new EventLog(dir, 'u1')
      log.append({ timestamp: 1, eventType: 'chat', content: 'keep', metadata: {}, agentId: 'u1', sessionId: 'keep' })
      log.append({ timestamp: 2, eventType: 'chat', content: 'drop', metadata: {}, agentId: 'u1', sessionId: 'drop' })
      await log.flush()
      log.deleteSession('drop')
      await log.flush()

      expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
      const reloaded = new EventLog(dir, 'u1')
      expect(reloaded.count()).toBe(1)
      expect(reloaded.query({ limit: 10 })[0].content).toBe('keep')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('P1 EmbeddingIndex 截断容错 + 原子持久化', () => {
  const rec = (over: Partial<EmbeddingRecord> = {}): EmbeddingRecord => ({
    nodeId: 'n1', stableId: 's1', type: 'fact', contentHash: 'h1',
    vector: [0.1, 0.2], model: 'm', norm: 1, updatedAt: 1, ...over,
  })

  test('索引尾部半行不再让整个索引退化为空', () => {
    const dir = tmp()
    try {
      const embDir = join(dir, 'embeddings')
      const file = join(embDir, 'index.jsonl')
      mkdirSync(embDir, { recursive: true })
      writeFileSync(file, `${JSON.stringify(rec())}\n{"nodeId":"n2","stableId":`)
      const idx = new EmbeddingIndex(dir)
      expect(idx.count()).toBe(1)
      expect(idx.all()[0].stableId).toBe('s1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('upsert 原子落盘：重载可解析、无 .tmp 残留', () => {
    const dir = tmp()
    try {
      const idx = new EmbeddingIndex(dir)
      idx.upsert(rec())
      idx.upsert(rec({ nodeId: 'n2', stableId: 's2', contentHash: 'h2' }))
      const embDir = join(dir, 'embeddings')
      expect(readdirSync(embDir).filter((f) => f.includes('.tmp-'))).toEqual([])
      const reloaded = new EmbeddingIndex(dir)
      expect(reloaded.count()).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
