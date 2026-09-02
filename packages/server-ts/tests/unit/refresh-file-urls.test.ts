import { describe, test, expect } from 'vitest'
import { refreshFileUrls, verifyChartToken, issueChartToken } from '../../src/common/chart-token.js'

/**
 * #fix: 文档图片 URL 自愈 — 读取文档时统一重写 body/deck 里的文件 URL：
 * 旧版 generate_image 坏链 → canonical+token；过期/陈旧 token → 重签。
 */
describe('refreshFileUrls (#fix)', () => {
  const uid = 'user_u1'

  test('rewrites the legacy broken generate_image shape to canonical + valid token', () => {
    const inBody = '前言\n\n![示意图](/api/v1/files/img_1718000000_ab12.png/download)\n\n正文。'
    const out = refreshFileUrls(inBody, uid)
    expect(out).toMatch(/!\[示意图\]\(\/api\/v1\/files\/download\/img_1718000000_ab12\.png\?token=[^)]+\)/)
    const m = out.match(/token=([^\s)")]+)/)!
    expect(verifyChartToken('img_1718000000_ab12.png', m[1])).toBe(uid)
  })

  test('re-signs expired/stale tokens on canonical URLs', () => {
    const expired = issueChartToken('chart_1.svg', uid, -1000)
    const inBody = `![图](/api/v1/files/download/chart_1.svg?token=${expired})`
    const out = refreshFileUrls(inBody, uid)
    const m = out.match(/token=([^\s)")]+)/)!
    expect(m[1]).not.toBe(expired)
    expect(verifyChartToken('chart_1.svg', m[1])).toBe(uid)
    expect(out).toContain('/api/v1/files/download/chart_1.svg?token=')
  })

  test('adds a token to tokenless canonical URLs', () => {
    const out = refreshFileUrls('![]( /api/v1/files/download/scene_9.svg )'.replace(' ( ', '(').replace(' )', ')'), uid)
    expect(out).toMatch(/token=/)
  })

  test('leaves non-file text and other endpoints untouched', () => {
    const text = [
      '![外链](https://example.com/a.png?token=keepme)',
      '<img src="/api/v1/files/upload-chunk">',
      '参考 /api/v1/files/preview-page/p_1.png?token=abc 与 /api/v1/files/doc_1/content',
    ].join('\n')
    expect(refreshFileUrls(text, uid)).toBe(text)
  })

  test('plain text without file urls short-circuits untouched', () => {
    expect(refreshFileUrls('# 标题\n\n正文', uid)).toBe('# 标题\n\n正文')
    expect(refreshFileUrls('', uid)).toBe('')
  })

  test('deck JSON round-trip keeps structure while rewriting urls', () => {
    const deck = { slides: [{ title: '结果', blocks: [
      { type: 'image', text: '图 1', url: '/api/v1/files/img_x_1.png/download', caption: '图 1' },
      { type: 'bullet', text: '要点' },
    ] }] }
    const out = JSON.parse(refreshFileUrls(JSON.stringify(deck), uid))
    expect(out.slides[0].blocks[1].text).toBe('要点')
    expect(out.slides[0].blocks[0].url).toMatch(/^\/api\/v1\/files\/download\/img_x_1\.png\?token=/)
  })
})
