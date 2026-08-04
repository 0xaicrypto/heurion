import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { boundToolOutput, cleanupToolOutputs, toolOutputDir } from '../src/tools/tool-output-store.js'
import { ToolRegistry, type ToolContext } from '../src/tools/tool-registry.js'
import { BaseTool, type ToolResult } from '../src/tools/base-tool.js'

/**
 * T1 — bounded tool output（#101）。超限 → head+tail 采样 + marker + 落盘。
 */
describe('T1 bounded tool output', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-out-'))
    process.env.TWIN_BASE_DIR = tmpDir
  })

  afterEach(() => {
    delete process.env.TWIN_BASE_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const smallOutput = 'a\nb\nc'

  test('#1 输出 ≤ 限制 → 原样返回，不落盘', () => {
    const { bounded, truncated, filePath } = boundToolOutput(smallOutput, { userId: 'u1' })
    expect(bounded).toBe(smallOutput)
    expect(truncated).toBe(false)
    expect(filePath).toBeNull()
    // No files written
    const dir = toolOutputDir()
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []
    expect(files.length).toBe(0)
  })

  test('#2 超行数 → head+tail 采样 + marker，完整结果落盘', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line_${i}`)
    const output = lines.join('\n')
    const { bounded, truncated, filePath } = boundToolOutput(output, { userId: 'u1' })

    expect(truncated).toBe(true)
    expect(bounded).toContain('line_0')          // head 保留
    expect(bounded).toContain('line_2999')       // tail 保留
    expect(bounded).toContain('output truncated') // marker

    // 完整结果落盘
    expect(filePath).not.toBeNull()
    expect(fs.existsSync(filePath!)).toBe(true)
    expect(fs.readFileSync(filePath!, 'utf-8')).toBe(output)
  })

  test('#3 超字节 → 按字节截断且 UTF-8 安全', () => {
    // 100KB of 3-byte CJK chars — well over the 50KB limit
    const big = '中'.repeat(40000)
    const { bounded, truncated, filePath } = boundToolOutput(big, { userId: 'u1' })

    expect(truncated).toBe(true)
    expect(Buffer.byteLength(bounded, 'utf-8')).toBeLessThanOrEqual(50 * 1024)
    // UTF-8 safe: no replacement chars at the cut boundary
    expect(bounded.includes('\uFFFD')).toBe(false)
    expect(fs.existsSync(filePath!)).toBe(true)
  })

  test('#4 marker 路径存在可读且内容完整', () => {
    const output = Array.from({ length: 5000 }, (_, i) => `row_${i}`).join('\n')
    const { bounded, filePath } = boundToolOutput(output, { userId: 'u1' })
    const markerMatch = bounded.match(/saved to (\S+)/)
    expect(markerMatch).toBeTruthy()
    expect(markerMatch![1].trim()).toBe(filePath)
    expect(fs.existsSync(filePath!)).toBe(true)
  })

  test('#5 清理任务删除 7 天前的文件', () => {
    // Outputs are stored under per-user subdirectories
    const userDir = path.join(toolOutputDir(), 'u1')
    fs.mkdirSync(userDir, { recursive: true })
    const oldFile = path.join(userDir, 'tool_old')
    fs.writeFileSync(oldFile, 'x')
    const oldTime = Date.now() - 8 * 24 * 3600 * 1000
    fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime))
    const newFile = path.join(userDir, 'tool_new')
    fs.writeFileSync(newFile, 'y')

    const removed = cleanupToolOutputs()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.existsSync(newFile)).toBe(true)
  })

  test('#6 结构化输出经 registry 同样受限', async () => {
    class BigTool extends BaseTool {
      get name() { return 'big_tool' }
      get description() { return 'returns a huge structured dump' }
      get parameters() { return { type: 'object', properties: {} } }
      async execute(): Promise<ToolResult> {
        const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i, value: `v${i}` }))
        return { success: true, output: JSON.stringify(rows) }
      }
    }
    const ctx = { userId: 'u1' } as unknown as ToolContext
    const registry = new ToolRegistry(ctx)
    registry.register(new BigTool())

    const result = await registry.execute('big_tool', {})
    expect(result.success).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.output).toContain('output truncated')
    expect(fs.existsSync(result.fullOutputPath!)).toBe(true)
  })
})
