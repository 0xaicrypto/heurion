import { describe, test, expect, vi } from 'vitest'
import { SCHEMA_VERSION } from '@heurion/contracts'

vi.mock('../src/storage.js', () => ({
  saveFile: vi.fn(async (buffer: Buffer, name: string, mime: string) => ({ fileId: 'f1', fileName: name, mimeType: mime })),
}))

import { renderTable } from '../src/handlers/table.js'

/**
 * #928 render_table CJK 字体降级 — 此前 table.ts 无条件 doc.font('cjk'),
 * 而缺字体部署(无 DroidSansFallbackFull.ttf,或仅有 pdfkit 无法嵌入的
 * .ttc 集合)里 'cjk' 未注册 → PDFFontFactory 读 'cjk' 文件 ENOENT,
 * render_table 整体必败。现在 applyCjkFont 返回成败,draw 回调条件使用。
 *
 * 本机/常规 CI 无上述 Linux 字体路径 → 走 hasCjk=false 分支(回归主场景);
 * 装有该字体的环境走 hasCjk=true 分支,两条路径都必须渲染成功。
 */
describe('#928 render_table 字体降级', () => {
  test('无论 CJK 字体是否可用,合法 payload 都渲染出非空 PDF', async () => {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      title: '入组患者基线(中文表头)',
      headers: ['患者', '年龄', '分组'],
      rows: [
        ['张三', '58', '试验组'],
        ['李四', '62', '对照组'],
      ],
    }
    const res = await renderTable(payload)
    expect(res.fileName).toBe('table.pdf')
    const { saveFile } = await import('../src/storage.js')
    const buf = (saveFile as any).mock.calls[0][0] as Buffer
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(500)
  })
})
