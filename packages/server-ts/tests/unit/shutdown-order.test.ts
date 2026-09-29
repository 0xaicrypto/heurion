import { readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'

/**
 * #1146 — 优雅停机顺序:旧实现 app.close() 在最后,排空窗口仍在接收新请求;
 * skill-induction 调度器未纳入 shutdown(关闭后仍可能触发一轮归纳)。
 * main.ts 是启动脚本(无单测导入),这里做源码级顺序守卫。
 */
const src = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf-8')

describe('#1146 优雅停机顺序', () => {
  test('先停止接收新连接(app.server.close),再排空在飞回合', () => {
    const intake = src.indexOf('app.server.close()')
    const drain = src.indexOf('drainActiveTurns')
    expect(intake, 'shutdown 缺少 app.server.close()').toBeGreaterThan(0)
    expect(drain).toBeGreaterThan(0)
    expect(intake, '必须先停接入再排空').toBeLessThan(drain)
  })

  test('skill-induction 调度器纳入 shutdown', () => {
    expect(src).toMatch(/inductionScheduler\?\.stop\(\)/)
  })
})
