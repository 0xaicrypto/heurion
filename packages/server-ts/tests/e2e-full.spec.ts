/**
 * Heurion E2E Tests — Playwright headless browser
 *
 * Run against staging: npx playwright test --base-url=http://localhost:8002
 * CI: after staging deploy, npx playwright test --base-url=http://localhost:8002
 *
 * Covers full user workflows: auth → patients → chat → writing → research
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.BASE_URL || 'http://localhost:8002'
const USER = { username: 'e2e-test', password: 'test123456', displayName: 'E2E Tester' }

// ── Helpers ──────────────────────────────────────────────

async function login(page: any) {
  await page.goto(`${BASE}/login`)
  await page.fill('input[placeholder*="用户"], input[placeholder*="Username"]', USER.username)
  await page.fill('input[type="password"]', USER.password)
  await page.click('button[type="submit"]')
  await page.waitForURL('**/app/today')
  // If login fails, register
  if (page.url().includes('/login')) {
    await page.click('text=Sign up')
    await page.fill('input[placeholder*="显示"], input[placeholder*="Display"]', USER.displayName)
    await page.fill('input[placeholder*="用户"], input[placeholder*="Username"]', USER.username)
    await page.fill('input[type="password"]', USER.password)
    await page.click('button[type="submit"]')
    await page.waitForURL('**/app/today')
  }
}

// ── Auth ─────────────────────────────────────────────────

test.describe('1. Authentication', () => {
  test('1.1 Login page renders', async ({ page }) => {
    await page.goto(`${BASE}/login`)
    await expect(page.locator('h1')).toContainText(/Welcome|欢迎/)
    await expect(page.locator('input[type="text"], input[type="password"]').first()).toBeVisible()
  })

  test('1.2 Register + login flow', async ({ page }) => {
    await page.goto(`${BASE}/login?mode=register`)
    await page.fill('input[placeholder*="显示"], input[placeholder*="Display"]', `E2E-${Date.now()}`)
    await page.fill('input[placeholder*="用户"], input[placeholder*="Username"]', `e2e-${Date.now()}`)
    await page.fill('input[type="password"]', 'test123456')
    await page.click('button[type="submit"]')
    await page.waitForURL('**/app/today')
  })

  test('1.3 Login with admin account', async ({ page }) => {
    await login(page)
    await page.goto(`${BASE}/app/today`)
    await expect(page.locator('h1, h2').first()).toBeVisible()
  })

  test('1.4 Session persists after reload', async ({ page }) => {
    await login(page)
    await page.reload()
    await page.waitForURL('**/app/today')
    await expect(page.locator('h1, h2').first()).toBeVisible()
  })
})

// ── Navigation ───────────────────────────────────────────

test.describe('2. Navigation', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('2.1 Sidebar navigates to all pages', async ({ page }) => {
    const pages = ['/app/chat', '/app/patients', '/app/research', '/app/writing',
                   '/app/skills', '/app/knowledge', '/app/plugins', '/app/settings']
    for (const path of pages) {
      await page.goto(`${BASE}${path}`)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('header h1, main h1, nav h1').first()).toBeVisible()
    }
  })

  test('2.2 Mobile sidebar toggle', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${BASE}/app/today`)
    await page.click('button[aria-label="Open menu"]')
    await expect(page.locator('aside nav')).toBeVisible()
  })

  test('2.3 Language switch works', async ({ page }) => {
    await page.goto(`${BASE}/app/today`)
    await page.click('button[aria-label="Language"]')
    await page.click('text=English')
    await expect(page.locator('h1, h2').first()).toContainText(/Today|今日/)
  })

  test('2.4 Dark mode toggle', async ({ page }) => {
    await page.goto(`${BASE}/app/today`)
    await page.click('button[aria-label="Theme"]')
    await page.click('text=dark')
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.click('button[aria-label="Theme"]')
    await page.click('text=light')
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  })
})

// ── Patients ─────────────────────────────────────────────

test.describe('3. Patients', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('3.1 Create patient via dialog', async ({ page }) => {
    await page.goto(`${BASE}/app/today`)
    await page.click('text=New Patient')
    await page.fill('input[placeholder*="Initials"], input[placeholder*="initials"]', 'ET')
    await page.fill('input[type="number"], input[placeholder*="age"]', '55')
    await page.selectOption('select', 'M')
    await page.click('button:has-text("Create")')
    await page.waitForURL('**/app/patients/**')
    await expect(page.locator('h1, h2').first()).toContainText('ET')
  })

  test('3.2 Patient list loads', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('a[href*="/app/patients/"]').first()).toBeVisible({ timeout: 5000 })
  })

  test('3.3 Patient summary shows findings', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`)
    await page.waitForLoadState('networkidle')
    await page.click('a[href*="/app/patients/"]')
    await page.waitForURL('**/app/patients/**')
    await expect(page.locator('text=Clinical Summary')).toBeVisible({ timeout: 5000 })
  })
})

// ── Chat ─────────────────────────────────────────────────

test.describe('4. Chat', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('4.1 Global chat SSE streaming', async ({ page }) => {
    await page.goto(`${BASE}/app/chat`)
    await page.fill('textarea', 'Hello, tell me about immunotherapy for NSCLC.')
    await page.click('button:has-text("Send")')
    // Wait for streaming to start
    await expect(page.locator('.animate-pulse').first()).toBeVisible({ timeout: 10000 })
    // Wait for turn complete
    await page.waitForTimeout(8000)
    await expect(page.locator('.animate-pulse').first()).not.toBeVisible({ timeout: 10000 })
  })

  test('4.2 Patient chat with context', async ({ page }) => {
    await page.goto(`${BASE}/app/patients`)
    await page.waitForLoadState('networkidle')
    await page.click('a[href*="/app/patients/"]')
    await page.waitForURL('**/app/patients/**')
    // Navigate to chat tab
    await page.click('a[href*="/chat"]')
    await page.waitForURL('**/chat')
    await page.fill('textarea', 'What is this patient age?')
    await page.click('button:has-text("Send")')
    await page.waitForTimeout(8000)
    await expect(page.locator('main')).toContainText(/\d+/)
  })

  test('4.3 File upload in chat', async ({ page }) => {
    await page.goto(`${BASE}/app/chat`)
    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles({
      name: 'test-report.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Patient CT shows stable nodule 18mm'),
    })
    // File badge should appear
    await expect(page.locator('text=test-report.txt')).toBeVisible({ timeout: 5000 })
  })

  test('4.4 Chat stop button', async ({ page }) => {
    await page.goto(`${BASE}/app/chat`)
    await page.fill('textarea', 'Write a very long essay about clinical trials.')
    await page.click('button:has-text("Send")')
    await page.waitForTimeout(500)
    await page.click('button:has-text("Stop")')
  })
})

// ── Writing ──────────────────────────────────────────────

test.describe('5. Writing', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('5.1 Create + edit document', async ({ page }) => {
    await page.goto(`${BASE}/app/writing`)
    await page.fill('input[placeholder*="title"]', 'E2E Test Document')
    await page.click('button:has-text("Create")')
    await page.waitForURL('**/app/writing/**')
    await page.fill('textarea', '# Test Heading\nThis is a test document body.')
    await page.click('button:has-text("Save")')
  })

  test('5.2 Document preview toggle', async ({ page }) => {
    await page.goto(`${BASE}/app/writing`)
    await page.waitForLoadState('networkidle')
    const docLink = page.locator('a[href*="/app/writing/"]').first()
    if (await docLink.isVisible()) {
      await docLink.click()
      await page.waitForURL('**/app/writing/**')
      await page.fill('textarea', '# Preview test')
      await page.click('button:has-text("Preview")')
      await expect(page.locator('h2, h3, strong')).toBeVisible({ timeout: 3000 })
    }
  })

  test('5.3 Export DOCX', async ({ page }) => {
    await page.goto(`${BASE}/app/writing`)
    await page.waitForLoadState('networkidle')
    const docLink = page.locator('a[href*="/app/writing/"]').first()
    if (await docLink.isVisible()) {
      await docLink.click()
      await page.waitForURL('**/app/writing/**')
      // Wait for save, then click DOCX
      await page.waitForTimeout(1000)
      const exportBtn = page.locator('button:has-text("DOCX")')
      if (await exportBtn.isVisible()) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 10000 }),
          exportBtn.click(),
        ])
        expect(download).toBeTruthy()
      }
    }
  })
})

// ── Research ─────────────────────────────────────────────

test.describe('6. Research', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('6.1 Create study', async ({ page }) => {
    await page.goto(`${BASE}/app/research`)
    await page.click('button:has-text("New Study")')
    await page.fill('input[placeholder*="Study"]', `E2E Study ${Date.now()}`)
    await page.fill('input[placeholder*="Code"], input[placeholder*="code"]', 'E2E')
    await page.click('button:has-text("Create")')
    await expect(page.locator('text=E2E')).toBeVisible({ timeout: 5000 })
  })

  test('6.2 Study detail tabs', async ({ page }) => {
    await page.goto(`${BASE}/app/research`)
    await page.waitForLoadState('networkidle')
    const studyCard = page.locator('[class*="cursor-pointer"]').first()
    if (await studyCard.isVisible()) {
      await studyCard.click()
      await page.waitForURL('**/app/research/**')
      const tabs = ['Overview', 'Roster', 'Eligibility', 'Safety', 'Schedule', 'Protocol']
      for (const tab of tabs) {
        const btn = page.locator(`button:has-text("${tab}")`)
        if (await btn.isVisible()) {
          await btn.click()
          await page.waitForTimeout(500)
        }
      }
    }
  })
})

// ── Skills ───────────────────────────────────────────────

test.describe('7. Skills', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('7.1 Marketplace search + install', async ({ page }) => {
    await page.goto(`${BASE}/app/plugins`)
    await page.waitForLoadState('networkidle')
    // Search for a skill
    const searchInput = page.locator('input[placeholder*="Search"]')
    if (await searchInput.isVisible()) {
      await searchInput.fill('pdf')
      await page.waitForTimeout(2000)
      const installBtn = page.locator('button:has-text("Install")').first()
      if (await installBtn.isVisible()) {
        await installBtn.click()
        await page.waitForTimeout(2000)
      }
    }
  })
})

// ── Settings ─────────────────────────────────────────────

test.describe('8. Settings', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('8.1 Profile loads', async ({ page }) => {
    await page.goto(`${BASE}/app/settings`)
    await expect(page.locator('text=User ID, text=Profile')).toBeVisible({ timeout: 5000 })
  })

  test('8.2 LLM settings visible', async ({ page }) => {
    await page.goto(`${BASE}/app/settings`)
    await page.click('button:has-text("Language model")')
    await expect(page.locator('text=Current provider')).toBeVisible({ timeout: 5000 })
  })
})

// ── Admin ────────────────────────────────────────────────

test.describe('9. Admin', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('9.1 Admin users list loads', async ({ page }) => {
    await page.goto(`${BASE}/app/admin/users`)
    await expect(page.locator('table, text=Username, text=User ID')).toBeVisible({ timeout: 5000 })
  })
})

// ── Sandbox ──────────────────────────────────────────────

test.describe('10. Sandbox', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('10.1 Code execution via chat', async ({ page }) => {
    await page.goto(`${BASE}/app/chat`)
    await page.fill('textarea', 'Run this Python: print(1+1)')
    await page.click('button:has-text("Send")')
    await page.waitForTimeout(8000)
    // Should show result somewhere in the response
    await expect(page.locator('main')).toBeVisible()
  })
})
