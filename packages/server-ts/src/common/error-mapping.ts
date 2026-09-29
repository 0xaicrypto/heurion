/**
 * #1155 — 错误 → HTTP 映射单点。app.ts 全局 handler 只负责日志与响应,
 * 映射规则集中在此,单位可测。
 * 返回 null = 5xx/未知错误(调用方记录日志并回通用文案,不回传内部细节)。
 */
import { ZodError } from 'zod'
import { DomainError } from './errors.js'

export interface HttpErrorShape {
  status: number
  body: Record<string, unknown>
}

export function mapErrorToHttp(err: unknown): HttpErrorShape | null {
  if (err instanceof ZodError) {
    return { status: 400, body: { error: 'Validation failed', details: err.errors } }
  }
  const status = (err as { statusCode?: number })?.statusCode
  const code = (err as { code?: string })?.code
  // #1138: P2002 唯一约束冲突 → 409。
  if (code === 'P2002') {
    return { status: 409, body: { error: 'Resource already exists (unique constraint)' } }
  }
  // #fix: 超限上传(multipart fileSize=100MB) → 413 + 可读提示。
  if (code === 'FST_REQ_FILE_TOO_LARGE' || status === 413) {
    return { status: 413, body: { error: '上传文件超过 100MB 上限,请压缩后再试 (file exceeds the 100MB upload limit)' } }
  }
  // #1138: Fastify 自带 4xx 保留原状态码与可读信息,不落成 500。
  if (status && status >= 400 && status < 500) {
    const message = (err instanceof Error && err.message) || 'Bad request'
    const body: Record<string, unknown> = { error: message }
    // #1155: 领域错误带稳定 code,客户端可按 code 分支。
    if (err instanceof DomainError) body.code = err.code
    return { status, body }
  }
  return null
}
