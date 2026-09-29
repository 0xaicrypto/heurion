/**
 * #1155 — 领域错误类型:全局 handler 按 statusCode 统一映射,新代码不再
 * 手写 404/409/403 响应;带 code 便于客户端分支(与 P2002 分支互不影响)。
 */
export class DomainError extends Error {
  readonly statusCode: number
  readonly code: string
  constructor(message: string, statusCode: number, code: string) {
    super(message)
    this.name = new.target.name
    this.statusCode = statusCode
    this.code = code
  }
}

export class NotFoundError extends DomainError {
  constructor(message = 'Not found') { super(message, 404, 'NOT_FOUND') }
}
export class ConflictError extends DomainError {
  constructor(message = 'Conflict') { super(message, 409, 'CONFLICT') }
}
export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden') { super(message, 403, 'FORBIDDEN') }
}
export class ValidationError extends DomainError {
  constructor(message = 'Validation failed') { super(message, 400, 'VALIDATION') }
}
