import { describe, test, expect } from 'vitest'
import { OCRImageTool } from '../../src/tools/ocr-tools.js'

describe('OCRImageTool', () => {
  test('#fix file_id 缺失时给出明确报错', async () => {
    const tool = new OCRImageTool({ userId: 'u1', sessionId: 's1' })
    const result = await tool.execute({})
    expect(result.success).toBe(false)
    expect(result.error).toContain('file_id')
  })

  test('#fix 文件不存在时报错带可用 file_id 清单 + PDF/DOCX 引导', async () => {
    const tool = new OCRImageTool({ userId: 'u-ocr-guide-test', sessionId: 's1' })
    const result = await tool.execute({ file_id: 'McNally_Recover_Annals ATS_2026.pdf' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
    // 明确引导:不把 PDF 当图片,提示 import_reference。
    expect(result.error).toContain('import_reference')
    expect(result.error).toContain('ocr_image 只用于图片')
  })
})
