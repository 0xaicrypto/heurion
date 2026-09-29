import { describe, test, expect } from 'vitest'
import { z } from 'zod'
import { mapErrorToHttp } from '../../src/common/error-mapping.js'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../src/common/errors.js'

/**
 * #1155 — 错误→HTTP 映射单点（全局 handler 的规则集中可测）。
 * 修复前映射散落在 app.ts 内联；领域错误类型此前不存在。
 */
describe('#1155 error mapping', () => {
  test('DomainError 子类 → 原状态码 + 稳定 code', () => {
    expect(mapErrorToHttp(new NotFoundError('x'))).toEqual({ status: 404, body: { error: 'x', code: 'NOT_FOUND' } })
    expect(mapErrorToHttp(new ConflictError('x'))).toEqual({ status: 409, body: { error: 'x', code: 'CONFLICT' } })
    expect(mapErrorToHttp(new ForbiddenError('x'))).toEqual({ status: 403, body: { error: 'x', code: 'FORBIDDEN' } })
    expect(mapErrorToHttp(new ValidationError('x'))).toEqual({ status: 400, body: { error: 'x', code: 'VALIDATION' } })
  })

  test('ZodError → 400 + details', () => {
    const parsed = z.object({ a: z.string() }).safeParse({})
    if (parsed.success) throw new Error('unreachable')
    const mapped = mapErrorToHttp(parsed.error)
    expect(mapped?.status).toBe(400)
    expect(mapped?.body.error).toBe('Validation failed')
  })

  test('P2002 → 409;超限 → 413;Fastify 4xx 保留状态码(无 code 字段)', () => {
    expect(mapErrorToHttp({ code: 'P2002' })).toEqual({ status: 409, body: { error: 'Resource already exists (unique constraint)' } })
    expect(mapErrorToHttp({ code: 'FST_REQ_FILE_TOO_LARGE' })?.status).toBe(413)
    expect(mapErrorToHttp(Object.assign(new Error('bad json'), { statusCode: 400 }))).toEqual({ status: 400, body: { error: 'bad json' } })
  })

  test('5xx/未知 → null（调用方记日志 + 通用文案）', () => {
    expect(mapErrorToHttp(new Error('db down'))).toBeNull()
    expect(mapErrorToHttp({ statusCode: 500 })).toBeNull()
  })
})
