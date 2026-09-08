import { describe, test, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import { imageBlockSchema } from '@heurion/contracts'
import { resolveImage } from '../src/handlers/common.js'
import { isKnownJobType } from '../src/job-types.js'

/**
 * #900 — asset:// 图片引用的路径穿越防护：
 * contracts 层 schema 拒绝恶意 asset:// ref（../ 等），worker resolveImage
 * 再做 basename + resolve-inside-dir 双保险（纵深防御）。
 * #901 — worker 入口未知 job type 拒绝（isKnownJobType 守卫，路由据此 400）。
 */

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => Buffer.from('svg-bytes')),
}))

// resolveImage 内部 `await import('node:fs/promises')` — 拦截 readFile 以观察
// 实际读取路径；穿越 ref 必须在读盘前就被拒绝。
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))

const ASSET_DIR = '/opt/heurion/assets'

beforeEach(() => {
  mocks.readFile.mockClear()
  process.env.ASSET_DIR = ASSET_DIR
})

describe('#900 asset:// 路径穿越', () => {
  test('contracts schema: 恶意 asset:// ref 被拒,合法文件名与非 asset ref 放行', () => {
    expect(imageBlockSchema.safeParse({ type: 'image', ref: 'asset://../../../.env' }).success).toBe(false)
    expect(imageBlockSchema.safeParse({ type: 'image', ref: 'asset://../../etc/passwd' }).success).toBe(false)
    // 子目录/分隔符/反斜杠/NUL 一律不放行（ref 必须是裸文件名）。
    expect(imageBlockSchema.safeParse({ type: 'image', ref: 'asset://sub/chart.svg' }).success).toBe(false)
    expect(imageBlockSchema.safeParse({ type: 'image', ref: 'asset://..\\.env' }).success).toBe(false)
    expect(imageBlockSchema.safeParse({ type: 'image', ref: `asset://x\0.svg` }).success).toBe(false)
    expect(imageBlockSchema.safeParse({ type: 'image', ref: 'asset://chart_x.svg' }).success).toBe(true)
    // 非 asset:// ref（inline 数据字符串 / http URL）不受影响。
    expect(imageBlockSchema.safeParse({ type: 'image', ref: 'data:image/png;base64,AAAA' }).success).toBe(true)
    expect(imageBlockSchema.safeParse({ type: 'image', ref: 'https://cdn.example.com/fig.png' }).success).toBe(true)
  })

  test('resolveImage: 穿越/分隔符 ref 被拒且不触发任何读盘', async () => {
    expect(await resolveImage({ type: 'image', ref: 'asset://../../../.env' })).toBeNull()
    expect(await resolveImage({ type: 'image', ref: 'asset://../../etc/passwd' })).toBeNull()
    expect(await resolveImage({ type: 'image', ref: 'asset://sub/chart.svg' })).toBeNull()
    expect(await resolveImage({ type: 'image', ref: 'asset://a\\b.svg' })).toBeNull()
    expect(await resolveImage({ type: 'image', ref: 'asset://' })).toBeNull()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  test('resolveImage: 合法文件名解析到资产目录内（resolve+前缀双保险）', async () => {
    const img = await resolveImage({ type: 'image', ref: 'asset://chart_x.svg', caption: 'Fig 1' })
    expect(img?.data.toString()).toBe('svg-bytes')
    expect(img?.caption).toBe('Fig 1')
    const target = String(mocks.readFile.mock.calls[0][0])
    expect(path.resolve(target)).toBe(path.resolve(ASSET_DIR, 'chart_x.svg'))
    // 防御性兜底：解析结果必须仍在资产目录前缀内。
    expect(path.resolve(target).startsWith(path.resolve(ASSET_DIR) + path.sep)).toBe(true)
  })
})

describe('#901 未知 job type 入口拒绝', () => {
  test('全部契约 render type 合法;插件命名空间遗留形式/任意未知 type 被拒', () => {
    for (const t of [
      'sidecar.generate_pptx',
      'sidecar.generate_docx',
      'sidecar.render_table',
      'sidecar.render_plot',
      'sidecar.convert_to_pdf',
      'sidecar.preview_file',
      'sidecar.render_figure',
    ]) {
      expect(isKnownJobType(t)).toBe(true)
    }
    expect(isKnownJobType('sidecar.heurion/pptx.generate_pptx')).toBe(false)
    expect(isKnownJobType('make_file')).toBe(false)
    expect(isKnownJobType('')).toBe(false)
  })
})
