import { describe, test, expect } from 'vitest'
import { collectDocImageLinks, rewriteDocImageUrls, fileIdFromUrl } from '../../src/tools/fix-document-images-tool.js'
import { issueChartToken, verifyChartToken } from '../../src/common/chart-token.js'

const USER = 'user_xl5ac9ty0s'

describe('fileIdFromUrl', () => {
  test('canonical 形状', () => {
    expect(fileIdFromUrl('/api/v1/files/download/chart_1.svg?token=a.b.c')).toEqual({ fileId: 'chart_1.svg', shape: 'canonical' })
  })
  test('legacy 坏链形状', () => {
    expect(fileIdFromUrl('/api/v1/files/chart_1.svg/download')).toEqual({ fileId: 'chart_1.svg', shape: 'legacy' })
  })
  test('非文件链接返回 null', () => {
    expect(fileIdFromUrl('/api/v1/files/preview-page/x')).toBeNull()
    expect(fileIdFromUrl('https://example.com/a.png')).toBeNull()
  })
})

describe('collectDocImageLinks', () => {
  const doc = [
    '正文前段',
    '',
    '**图1：剂量对比**',
    '',
    `![图1：剂量对比](/api/v1/files/download/chart_111.svg?token=${issueChartToken('chart_111.svg', USER)})`,
    '',
    '![图2](/api/v1/files/chart_222.svg/download)',
    '',
    '裸链接 /api/v1/files/download/chart_333.png?token=x.y.z 出现在文字中',
  ].join('\n')

  test('三种形状全收集,按 fileId 去重,markdown 带出 alt', () => {
    const links = collectDocImageLinks(doc)
    expect(links.map((l) => l.fileId).sort()).toEqual(['chart_111.svg', 'chart_222.svg', 'chart_333.png'])
    expect(links.find((l) => l.fileId === 'chart_111.svg')?.alt).toBe('图1：剂量对比')
    expect(links.find((l) => l.fileId === 'chart_222.svg')?.shape).toBe('legacy')
  })

  test('无文件链接的文本返回空', () => {
    expect(collectDocImageLinks('普通正文,没有链接')).toEqual([])
  })
})

describe('rewriteDocImageUrls(判定逻辑: 在库修 URL / 缺失上报 / 有效保留)', () => {
  const fileId = 'chart_1.svg'
  const canonical = (token: string) => `/api/v1/files/download/${fileId}?token=${token}`
  const existsAll = () => true
  const existsNone = () => false

  test('旧版坏链 + 文件在库 → 改写 canonical + 新签 token', () => {
    const res = rewriteDocImageUrls(`图 ![a](/api/v1/files/${fileId}/download) 尾`, USER, existsAll)
    expect(res.fixed).toEqual([fileId])
    expect(res.text).toContain(`/api/v1/files/download/${fileId}?token=`)
    expect(res.text).not.toContain(`/api/v1/files/${fileId}/download`)
  })

  test('改写后的 URL 可通过 verifyChartToken 校验', () => {
    const res = rewriteDocImageUrls(`/api/v1/files/${fileId}/download`, USER, existsAll)
    const token = res.text.split('?token=')[1]
    expect(verifyChartToken(fileId, token)).toBe(USER)
  })

  test('token 失效 + 文件在库 → 重签', () => {
    const res = rewriteDocImageUrls(canonical('1.bad.sig'), USER, existsAll)
    expect(res.fixed).toEqual([fileId])
    expect(res.text).not.toBe(canonical('1.bad.sig'))
  })

  test('token 有效 + 文件在库 → 原样保留(不产生无意义版本)', () => {
    const url = canonical(issueChartToken(fileId, USER))
    const res = rewriteDocImageUrls(url, USER, existsAll)
    expect(res.valid).toEqual([fileId])
    expect(res.fixed).toEqual([])
    expect(res.text).toBe(url)
  })

  test('文件不在库 → 链接保持原样并上报 missing(即使 token 失效)', () => {
    const url = canonical('1.bad.sig')
    const res = rewriteDocImageUrls(url, USER, existsNone)
    expect(res.missing).toEqual([fileId])
    expect(res.fixed).toEqual([])
    expect(res.text).toBe(url)
  })

  test('混合场景: 在库的修,缺失的报', () => {
    const doc = `![图1](/api/v1/files/download/chart_ok.svg?token=${issueChartToken('chart_ok.svg', USER)}) 和 ![图2](/api/v1/files/chart_gone.svg/download)`
    const res = rewriteDocImageUrls(doc, USER, (id) => id === 'chart_ok.svg')
    expect(res.valid).toEqual(['chart_ok.svg'])
    expect(res.missing).toEqual(['chart_gone.svg'])
    expect(res.text).toBe(doc)
  })
})
