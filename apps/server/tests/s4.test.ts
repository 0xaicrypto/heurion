import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/db.ts'
import { syncFileComments } from '../src/docs/office-comments.ts'
import { ensureDocxParaIds } from '../src/docs/office.ts'
import { DocFiles } from '../src/docs/workspace.ts'

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const W14_NS = `xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"`

function docx(body: string, comments?: string) {
  const entries: Record<string, Uint8Array> = {
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W_NS} ${W14_NS}><w:body>${body}</w:body></w:document>`),
  }
  if (comments) entries['word/comments.xml'] = strToU8(`<?xml version="1.0"?><w:comments ${W_NS} ${W14_NS}>${comments}</w:comments>`)
  return zipSync(entries)
}

describe('编辑器文件内评论同步', () => {
  it('Collabora 写入的文件评论 → 评论表（锚点=所在段落 paraId），重复保存不重复导入', () => {
    const store = new Store(':memory:')
    store.createDoc('d', 'Paper', 'docx')

    const body =
      '<w:p w14:paraId="AAAA0001"><w:r><w:t>研究背景</w:t></w:r>' +
      '<w:commentRangeStart w:id="1"/>' +
      '<w:r><w:t>与意义</w:t></w:r><w:commentRangeEnd w:id="1"/></w:p>' +
      '<w:p w14:paraId="BBBB0002"><w:r><w:t>方法</w:t></w:r></w:p>'
    const commentsXml = '<w:comment w:id="1" w:author="张三"><w:p><w:r><w:t>这段需要补 RCT</w:t></w:r></w:p></w:comment>'

    const r1 = syncFileComments(store, 'd', docx(body, commentsXml))
    expect(r1.imported).toBe(1)
    const row = store.listComments('d')[0]!
    expect(row.anchor.para_id).toBe('AAAA0001')
    expect(row.anchor.text_snippet).toBe('这段需要补 RCT')
    expect(row.replies).toEqual([{ id: expect.any(String), comment_id: row.id, role: 'user', text: '这段需要补 RCT', created_at: expect.any(String) }])

    const r2 = syncFileComments(store, 'd', docx(body, commentsXml))
    expect(r2.imported).toBe(0) // file_comment_id 去重
    expect(store.listComments('d')).toHaveLength(1)
  })

  it('无 comments.xml 的包 no-op；引用范围在表格内段落也能锚定', () => {
    const store = new Store(':memory:')
    store.createDoc('d', 'Paper', 'docx')
    expect(syncFileComments(store, 'd', docx('<w:p w14:paraId="AAAA0001"><w:r><w:t>x</w:t></w:r></w:p>')).imported).toBe(0)

    const body =
      '<w:tbl><w:tr><w:tc><w:p w14:paraId="CCCC0003"><w:commentRangeStart w:id="7"/>' +
      '<w:r><w:t>表格数据</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    const commentsXml = '<w:comment w:id="7" w:author="李四"><w:p><w:r><w:t>核对这一格</w:t></w:r></w:p></w:comment>'
    syncFileComments(store, 'd', docx(body, commentsXml))
    expect(store.listComments('d')[0]!.anchor.para_id).toBe('CCCC0003')
  })
})

describe('用户保存提取 user_ops（S5 合并输入）', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'h2-s4-'))
    const store = new Store(':memory:')
    const files = new DocFiles(store, join(dir, 'ws'), join(dir, 'versions'))
    store.createDoc('d', 'Paper', 'docx')
    return { store, files }
  }

  const body = '<w:p><w:r><w:t>一</w:t></w:r></w:p><w:p><w:r><w:t>二</w:t></w:r></w:p>'

  it('编辑面保存落 user 版本 + meta.user_ops；上传不产 user_ops', () => {
    const { store, files } = setup()
    files.importUpload('d', 'docx', docx(body))
    const v1ids = [...strFromU8(unzipSync(files.readVersion('d', 1))['word/document.xml']!).matchAll(/w14:paraId="([0-9A-F]{8})"/g)].map(m => m[1]!)

    // 模拟 Collabora 保存：剥 id 重生成 + 改一段文字
    const loXml = strFromU8(unzipSync(files.readVersion('d', 1))['word/document.xml']!)
      .replaceAll(/ w14:paraId="[0-9A-F]{8}"/g, '')
      .replace('<w:t>二</w:t>', '<w:t>二改</w:t>')
    const v2 = files.saveUserSave('d', docx(loXml), '编辑保存')
    expect(v2.source).toBe('user')
    expect(v2.meta?.user_ops).toBeDefined()
    expect(v2.meta!.user_ops!.added).toHaveLength(1)   // 段二：Collabora 换新 id + 改文字 → add
    expect(v2.meta!.user_ops!.removed).toHaveLength(1) // 旧 id 消失
    expect(v2.meta!.user_ops!.modified).toHaveLength(0)
    // 未触碰段落（一）id 被对齐重建保留
    const v2ids = [...strFromU8(unzipSync(files.readVersion('d', 2))['word/document.xml']!).matchAll(/w14:paraId="([0-9A-F]{8})"/g)].map(m => m[1]!)
    expect(v2ids).toContain(v1ids[0])

    const v3 = files.importUpload('d', 'docx', docx(body))
    expect(v3.meta?.user_ops).toBeUndefined() // upload 不产 user_ops
  })
})

describe('AI 回合期间用户推进（S5：docx 三方合并 / deck 丢弃）', () => {
  function makePool(files: DocFiles, aiText: string, userText: string) {
    return {
      isBusy: () => false,
      liveSession: () => 's',
      run: async (_docId: string, _prompt: string, onNotification: (n: unknown, s: string) => void) => {
        // 模拟 dsh 改工作区文件的同时，用户保存推进 head
        writeFileSync(files.workspaceFile('d', 'docx'), docx(`<w:p><w:r><w:t>${aiText}</w:t></w:r></w:p>`))
        files.saveUserSave('d', docx(`<w:p><w:r><w:t>${userText}</w:t></w:r></w:p>`), '用户保存')
        return { sessionId: 's', finalResponse: '完成', events: [] }
      },
      close: async () => {},
    }
  }

  it('docx：AI 的未锚定新增节点被覆盖记录（用户赢），合并版落库', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-guard-'))
    const store = new Store(':memory:')
    const files = new DocFiles(store, join(dir, 'ws'), join(dir, 'versions'))
    store.createDoc('d', 'Paper', 'docx')
    const body = '<w:p><w:r><w:t>一</w:t></w:r></w:p><w:p><w:r><w:t>二</w:t></w:r></w:p>'

    const { TurnService } = await import('../src/docs/turn.ts')
    const events: unknown[] = []
    const pool = makePool(files, 'AI 的新版本', '用户抢先保存')
    const turns = new TurnService(store, files, pool as never)
    files.importUpload('d', 'docx', docx(body))

    await turns.run('d', '帮我改', e => events.push(e))
    const merge = events.find(e => (e as { type: string }).type === 'merge_result') as { overridden: Array<{ text: string }> } | undefined
    expect(merge?.overridden.some(o => o.text.includes('AI 的新版本'))).toBe(true) // 用户赢
    // 合并版落库：v3 字节 = 用户 v2 字节（AI 无可落地改动）
    expect(store.getDoc('d')!.head_seq).toBe(3)
    const v3 = strFromU8(unzipSync(files.readVersion('d', 3))['word/document.xml']!)
    expect(v3).toContain('用户抢先保存')
    expect(v3).not.toContain('AI 的新版本')
  })

  it('pptx：形状级并行暂缓 → 维持丢弃 + 提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h2-guard2-'))
    const store = new Store(':memory:')
    const files = new DocFiles(store, join(dir, 'ws'), join(dir, 'versions'))
    store.createDoc('d', 'Deck', 'pptx')

    const { TurnService } = await import('../src/docs/turn.ts')
    const events: unknown[] = []
    const pool = {
      isBusy: () => false,
      liveSession: () => 's',
      run: async () => {
        writeFileSync(files.workspaceFile('d', 'pptx'), zipSync({ 'ppt/slides/slide1.xml': strToU8('<p:sld/>') }))
        files.saveUserSave('d', zipSync({ 'ppt/slides/slide1.xml': strToU8('<p:sld/>') }), '用户保存')
        return { sessionId: 's', finalResponse: '完成', events: [] }
      },
      close: async () => {},
    }
    const turns = new TurnService(store, files, pool as never)
    files.importUpload('d', 'pptx', zipSync({ 'ppt/slides/slide1.xml': strToU8('<p:sld/>') }))

    await turns.run('d', '帮我改', e => events.push(e))
    const errors = events.filter(e => (e as { type: string }).type === 'error') as Array<{ message: string }>
    expect(errors.some(e => e.message.includes('手动更新') && e.message.includes('已丢弃'))).toBe(true)
    expect(store.getDoc('d')!.head_seq).toBe(2)
    expect(store.listVersions('d')).toHaveLength(2)
  })
})
