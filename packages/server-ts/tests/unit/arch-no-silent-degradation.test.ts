import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * #746/#730 回归锁:文件链路曾是 `(prisma as any).fileIndex` + 空 catch
 * 静默吞 TypeError 的重灾区(FileIndex 表缺失时查重/索引/列表全部静默失效)。
 * 现在 FileIndex 是 typed model — 本测试防止该模式回流。
 */
function read(p: string): string {
  return fs.readFileSync(path.resolve(__dirname, p), 'utf-8')
}

describe('#746 文件链路禁用静默降级模式', () => {
  const filesDir = path.resolve(__dirname, '../../src/modules/files')
  const chatCtxFiles = [
    '../../src/modules/chat/chat-context.ts',
    '../../src/modules/chat/conversation-turn.ts',
    '../../src/tools/render-chart-tool.ts',
    '../../src/tools/edit-document-tool.ts',
  ]

  test('modules/files 无 (prisma as any) 动态访问', () => {
    const offenders = fs.readdirSync(filesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({ f, src: fs.readFileSync(path.join(filesDir, f), 'utf-8') }))
      .filter(({ src }) => /as any\)\.(fileIndex|filePipelineJob)/.test(src))
    expect(offenders.map((o) => o.f)).toEqual([])
  })

  test('FileIndex 访问点不再引用 "table may not exist" 式吞错', () => {
    for (const rel of ['../../src/modules/files/files.service.ts', ...chatCtxFiles]) {
      const src = read(rel)
      expect(src.includes('FileIndex table may not exist')).toBe(false)
      expect(src.includes('fileIndex may not exist')).toBe(false)
    }
  })
})
