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

import { reuseLocalFileTokens } from './file-url-tokens'

/**
 * #1134 — 审阅 diff 的 next 复用本地 token:消除 token 轮换造成的假改动;
 * 本地没有的新文件(AI 生成图)保留 incoming token 供渲染。
 */
describe('#1134 reuseLocalFileTokens', () => {
  test('同 fileId 用本地旧 token 替换 incoming 新 token(diff 无 token 噪音)', () => {
    const local = '图 /api/v1/files/download/f_1?token=old_sig'
    const incoming = '图 /api/v1/files/download/f_1?token=new_sig\n\n新增段落'
    const out = reuseLocalFileTokens(local, incoming)
    expect(out).toContain('/api/v1/files/download/f_1?token=old_sig')
    expect(out).not.toContain('new_sig')
    expect(out).toContain('新增段落')
  })

  test('本地没有的文件 id 保留 incoming token;本地无 token 时原样返回', () => {
    const local = '图 /api/v1/files/download/f_1?token=old'
    const incoming = '图 /api/v1/files/download/f_1?token=new 新图 /api/v1/files/download/f_2?token=f2'
    const out = reuseLocalFileTokens(local, incoming)
    expect(out).toContain('f_1?token=old')
    expect(out).toContain('f_2?token=f2')
    expect(reuseLocalFileTokens('无链接正文', incoming)).toBe(incoming)
  })
})
