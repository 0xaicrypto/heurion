import { describe, test, expect } from 'vitest'
import { normalizeFileDownloadTokens } from '@heurion/contracts'

/**
 * #1128 — 下载 URL token 归一化(server/web 共用同一实现)。
 * 四种存量形态(canonical ± token、旧版 /files/:id/download ± token)必须
 * 归一到同一形式;无关路径不受影响。
 */
describe('#1128 normalizeFileDownloadTokens', () => {
  const canonical = '/api/v1/files/download/f_abc-123'

  test('canonical + token / canonical 裸形态 → 同一无 token 形式', () => {
    expect(normalizeFileDownloadTokens(`${canonical}?token=abc.def`)).toBe(canonical)
    expect(normalizeFileDownloadTokens(canonical)).toBe(canonical)
  })

  test('旧版 /files/:id/download (±token) → canonical 无 token', () => {
    expect(normalizeFileDownloadTokens('/api/v1/files/f_abc-123/download')).toBe(canonical)
    expect(normalizeFileDownloadTokens('/api/v1/files/f_abc-123/download?token=old')).toBe(canonical)
  })

  test('preview-page / 其他路径不受影响', () => {
    const preview = '/api/v1/files/preview-page/f_1?token=x'
    expect(normalizeFileDownloadTokens(preview)).toBe(preview)
    expect(normalizeFileDownloadTokens('见 /api/v1/docs/doc_1 正文')).toBe('见 /api/v1/docs/doc_1 正文')
  })

  test('幂等:归一化两次结果相同', () => {
    const once = normalizeFileDownloadTokens(`${canonical}?token=t`)
    expect(normalizeFileDownloadTokens(once)).toBe(once)
  })
})
