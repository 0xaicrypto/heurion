import { test } from '@playwright/test'

/**
 * #1035 诊断探针（临时保留）— 输出登录页浏览器侧真实状态：
 * console/pageerror/响应状态/失败请求/URL/页面文本。
 * 由 e2e-tests workflow 在正式套件前单独运行，输出进 job 日志。
 */
test('#1035-dbg login flow probe', async ({ page }) => {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:8002'
  page.on('console', (m) => console.log('DBG-CONSOLE', m.type(), m.text()))
  page.on('pageerror', (e) => console.log('DBG-PAGE-ERROR', e.message))
  page.on('response', (r) => {
    if (r.url().includes('/api/v1/auth/')) console.log('DBG-AUTH-RESP', r.status(), r.url(), r.request().postData())
  })
  page.on('requestfailed', (r) => console.log('DBG-REQ-FAILED', r.url(), r.failure()?.errorText))
  await page.goto(`${BASE}/login`, { timeout: 10000, waitUntil: 'domcontentloaded' })
  console.log('DBG-url-before', page.url())
  console.log('DBG-html-head', (await page.content()).replace(/\s+/g, ' ').slice(0, 500))
  await page.locator('input[type="text"], input:not([type="password"])').first().fill('hz')
  await page.locator('input[type="password"]').fill('hz123456')
  await page.locator('button[type="submit"]').click()
  await page.waitForTimeout(6000)
  console.log('DBG-url-after', page.url())
  console.log('DBG-body', (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 600))
})
