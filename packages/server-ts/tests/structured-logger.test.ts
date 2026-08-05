import { describe, test, expect, vi, afterEach } from 'vitest'
import { makeLogger } from '../src/common/logger.js'

describe('structured logger (§5.5 #198)', () => {
  afterEach(() => vi.restoreAllMocks())

  test('emits JSON lines with level/ts/msg/module', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    makeLogger('memory.embedding').info('embedding unavailable', { reason: 'fetch failed' })
    const line = JSON.parse(spy.mock.calls[0][0])
    expect(line.level).toBe('info')
    expect(line.msg).toBe('embedding unavailable')
    expect(line.module).toBe('memory.embedding')
    expect(line.reason).toBe('fetch failed')
    expect(line.ts).toBeTruthy()
  })

  test('warn/error route to the right console level', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    makeLogger('compaction').warn('proposal skipped', { reason: 'x' })
    makeLogger('chat').error('boom')
    expect(JSON.parse(warn.mock.calls[0][0]).level).toBe('warn')
    expect(JSON.parse(err.mock.calls[0][0]).level).toBe('error')
  })
})
