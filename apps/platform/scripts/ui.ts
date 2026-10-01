/**
 * 编辑器的浏览器测试（真实 Chromium）：打字同步、拆段 id、工具栏、选区评论、修订采纳、撤销、断线重连。
 *   pnpm --filter @heurion2/platform ui [baseUrl]   （首次运行前：npx playwright install chromium）
 * 需要 server 在跑且页面已构建（pnpm --filter @heurion2/platform build）。会新建一份测试文档，结束后删除。
 */
import { chromium } from 'playwright'

const B = process.argv[2] ?? 'http://127.0.0.1:8787'
const H = { Authorization: `Bearer ${process.env.HEURION_DEV_TOKEN || 'dev'}`, 'Content-Type': 'application/json' }
const api = async (p: string, o: RequestInit = {}): Promise<any> => { const r = await fetch(B + p, { ...o, headers: H }); const t = await r.text(); try { return JSON.parse(t) } catch { return t } }
let failed = 0
const ok = (name: string, cond: boolean, extra = '') => { if (!cond) failed++;  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const doc = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'UI 测试 ' + Date.now(), markdown: '# 标题\n\n第一段。' }) })
const browser = await chromium.launch({ channel: 'chromium' }).catch(() => chromium.launch())
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(B + '/')
await page.click(`li[data-id="${doc.id}"]`)
await page.waitForSelector('.ProseMirror p')
await page.waitForFunction(() => document.getElementById('syncStatus')!.textContent === '已同步')
ok('打开文档并同步', true)
ok('任务队列常驻，空闲时显示「空闲」', await page.locator('#queuePanel.idle').isVisible() && (await page.locator('#queueSummary').innerText()) === '空闲')

// 打字 + 回车拆段
await page.click('.ProseMirror p')
await page.keyboard.press('End')
await page.keyboard.type('新增文字')
await page.keyboard.press('Enter')
await page.keyboard.type('第二段')
await wait(900)
let read = await api(`/api/docs/${doc.id}/read`)
ok('打字实时写入服务端', read.includes('第一段。新增文字') && read.includes('第二段'))
const idsInRead = [...read.matchAll(/\{#([a-z0-9]+)\}/g)].map(m => m[1])
ok('回车拆段后块 id 唯一', new Set(idsInRead).size === idsInRead.length, idsInRead.join(','))

// 加粗：选中「第二段」
await page.keyboard.down('Shift'); for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift')
await wait(300)
await page.click('button[data-cmd="bold"]')
await wait(900)
read = await api(`/api/docs/${doc.id}/read`)
ok('工具栏加粗', read.includes('**第二段**'))

// 评论：选中文字 → 浮动按钮 → 评论
await page.click('.ProseMirror h1')
await page.keyboard.press('Meta+ArrowLeft')
await page.keyboard.down('Shift'); await page.keyboard.press('Meta+ArrowRight'); await page.keyboard.up('Shift')
await wait(300)
await page.waitForSelector('#commentFab', { state: 'visible' })
await page.dispatchEvent('#commentFab', 'mousedown')
await page.fill('#newCommentText', '标题改得具体一些')
await page.click('#newCommentSave')
await wait(800)
const d1 = await api(`/api/docs/${doc.id}`)
ok('选区评论创建且锚定在标题上', d1.comments.length === 1 && d1.comments[0].anchor.located && d1.comments[0].anchor.text === '标题', JSON.stringify(d1.comments[0]?.anchor))
ok('评论高亮出现在编辑器里', await page.locator('.ProseMirror mark.comment').count() > 0)

// 跨段落选区：只提示，不能评论（与 Claude Docs 一致）
await page.click('.ProseMirror h1')
await page.keyboard.press('Meta+ArrowUp')
await page.keyboard.down('Shift'); await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.up('Shift')
await wait(300)
ok('跨段落选区只给提示', await page.locator('#commentFab.blocked').isVisible() && (await page.locator('#commentFab').innerText()).includes('一个段落内'))
await page.click('.ProseMirror h1')

// 修订：程序以 suggest 模式提交修改 → 编辑器显示修订条 → 采纳
const p1 = /\{#([a-z0-9]+)\} 第一段/.exec(read)![1]
await api(`/api/docs/${doc.id}/edit`, { method: 'POST', body: JSON.stringify({ base_rev: d1.rev ?? 0, mode: 'suggest', ops: [{ op: 'replace_text', id: p1, find: '第一段', replace: '修订后的第一段' }] }) })
await page.waitForSelector('.suggest-bar', { timeout: 5000 }).catch(() => {})
ok('修订在正文中显示（删 / 增 + 修订条）', await page.locator('[data-suggest="delete"]').count() === 1 && await page.locator('[data-suggest="insert"]').count() === 1 && await page.locator('.suggest-bar').count() === 1)
await page.waitForSelector('#suggestBanner:not([hidden])', { timeout: 5000 }).catch(() => {})
ok('有待采纳修订时正文上方出现修订提示', (await page.locator('#suggestSummary').innerText()).startsWith('1 处待采纳修订'))
ok('右栏不再有「修订」页签', await page.locator('[data-tab="suggestPane"]').count() === 0)
await page.dispatchEvent('.suggest-bar button[data-a="1"]', 'mousedown')
await page.waitForFunction(() => document.querySelectorAll('[data-suggest]').length === 0, null, { timeout: 5000 }).catch(() => {})
read = await api(`/api/docs/${doc.id}/read`)
await page.waitForSelector('#suggestBanner', { state: 'hidden', timeout: 5000 }).catch(() => {})
ok('采纳后修订提示消失', await page.locator('#suggestBanner').isHidden())
ok('就地采纳修订', read.includes('修订后的第一段') && !read.includes('⟨待采纳') && read.includes(`{#${p1}}`), '新块接过原 id')

// 撤销（只撤用户自己的编辑）
await page.click('.ProseMirror h1')
await page.keyboard.press('End')
await page.keyboard.type('X')
await wait(600)
await page.keyboard.press('Meta+z')
await wait(900)
read = await api(`/api/docs/${doc.id}/read`)
ok('⌘Z 撤销自己的输入', !read.includes('标题X'))

// 断线：离线期间编辑，恢复后补齐
await page.context().setOffline(true)
await wait(300)
await page.click('.ProseMirror h1'); await page.keyboard.press('End'); await page.keyboard.type('离线编辑')
await page.context().setOffline(false)
await wait(4000)
read = await api(`/api/docs/${doc.id}/read`)
ok('离线编辑在重连后同步', read.includes('离线编辑'))

// 插图：工具栏选择文件 → 上传为资产 → 插入图块；双击编辑图注
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
await page.click('.ProseMirror h1'); await page.keyboard.press('Meta+ArrowRight')
await page.setInputFiles('#imageInput', { name: '发病率.png', mimeType: 'image/png', buffer: png })
await page.waitForSelector('.ProseMirror figure img', { timeout: 5000 }).catch(() => {})
await wait(900)
read = await api(`/api/docs/${doc.id}/read`)
ok('插入图片（上传为资产）', /!\[发病率\]\(asset:a[a-z0-9]+\)/.test(read))
page.once('dialog', d => void d.accept('图 1 发病率趋势'))
await page.dblclick('.ProseMirror figure')
await wait(900)
read = await api(`/api/docs/${doc.id}/read`)
ok('双击编辑图注', read.includes('"图 1 发病率趋势"'))
const docx = await fetch(`${B}/api/docs/${doc.id}/export.docx`, { headers: H })
ok('导出 docx 含图片', docx.ok && (await docx.arrayBuffer()).byteLength > 0)

// 幻灯片：新建 → 查看器渲染页面与形状；精确预览（有渲染环境时）
const deck = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'UI 幻灯片 ' + Date.now(), kind: 'deck' }) })
await api(`/api/docs/${deck.id}/edit`, { method: 'POST', body: JSON.stringify({ base_rev: 0, ops: [{ op: 'add_slide', after: (await api(`/api/docs/${deck.id}/deck`)).doc.content[0].attrs.id, title: '研究设计', body: '- 多中心随机双盲\n- 17,604 例' }] }) })
await page.reload()
await page.click(`li[data-id="${deck.id}"]`)
await page.waitForSelector('.slide .shape', { timeout: 5000 }).catch(() => {})
ok('幻灯片查看器渲染页面与形状', await page.locator('.slide-wrap').count() === 2 && (await page.locator('.slide').nth(1).innerText()).includes('17,604 例'))
ok('幻灯片显示导出 pptx 按钮', await page.locator('#exportPptxBtn').isVisible())

// 幻灯片评论：一个段落内的文字 / 跨段落提示 / 单击整个形状
const selectIn = (from: string, to: string) => page.evaluate(([a, b]) => {
  // 不用具名内部函数：tsx 会注入浏览器里没有的 __name
  const r = document.createRange()
  r.setStart(document.querySelector(a!)!, 0)
  const end = document.querySelector(b!)!
  r.setEnd(end, end.childNodes.length)
  getSelection()!.removeAllRanges(); getSelection()!.addRange(r)
  document.querySelector(a!)!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}, [from, to])
const bodyP = (i: number) => `.slide-wrap:nth-child(2) .shape:not(.selected) p[data-p="${i}"]`
await selectIn(bodyP(1), bodyP(1))
await page.waitForSelector('#commentFab', { state: 'visible' })
ok('幻灯片段落内选区可评论', !(await page.locator('#commentFab.blocked').isVisible()))
await page.dispatchEvent('#commentFab', 'mousedown')
await page.fill('#newCommentText', '补充入组标准')
await page.click('#newCommentSave')
await wait(800)
let dk = await api(`/api/docs/${deck.id}`)
ok('段落评论锚定在该段文字上', dk.comments.length === 1 && dk.comments[0].anchor.located && dk.comments[0].anchor.text === '17,604 例', JSON.stringify(dk.comments[0]?.anchor))
await selectIn(bodyP(0), bodyP(1))
await wait(300)
ok('幻灯片跨段落选区只给提示', await page.locator('#commentFab.blocked').isVisible())
await page.evaluate(() => getSelection()!.removeAllRanges())
const titleShape = page.locator('.slide-wrap:nth-child(2) .shape').filter({ hasText: '研究设计' })
await titleShape.click()
await wait(300)
ok('单击形状：选中整个形状', await page.locator('.shape.selected').count() === 1 && (await page.locator('#commentFab').innerText()) === '评论此形状')
await page.dispatchEvent('#commentFab', 'mousedown')
ok('整形状评论引用显示（整个形状）', (await page.locator('#newCommentQuote').innerText()) === '（整个形状）')
await page.fill('#newCommentText', '标题改成英文')
await page.click('#newCommentSave')
await wait(800)
dk = await api(`/api/docs/${deck.id}`)
const whole = dk.comments.find((c: any) => c.replies?.[0]?.text === '标题改成英文' || c.snippet === '')
ok('整形状评论锚定整个形状', !!whole && whole.anchor.located && whole.anchor.text === '研究设计', JSON.stringify(whole?.anchor))
await page.click('.slide-wrap:nth-child(2) [data-precise]')
const rendered = await page.waitForSelector('.slide-png', { timeout: 5000 }).then(() => page.waitForFunction(() => { const i = document.querySelector('.slide-png') as HTMLImageElement | null; return i && i.complete && i.naturalWidth > 0 }, null, { timeout: 120_000 }).then(() => true).catch(() => false)).catch(() => false)
ok('精确预览（LibreOffice 渲染）', rendered)
await api(`/api/docs/${deck.id}`, { method: 'DELETE' })

ok('页面无脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
await api(`/api/docs/${doc.id}`, { method: 'DELETE' })
process.exit(failed === 0 ? 0 : 1)
