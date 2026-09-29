/**
 * #1146 — 审批错误类型（自 approval.service 拆出，文件行数棘轮）。
 * 路由此前 catch-all → 404，DB/应用失败被谎报为 "找不到"；statusCode
 * 同时供全局错误处理器兜底。
 */
export class ApprovalNotFoundError extends Error {
  readonly statusCode = 404
  constructor(message: string) { super(message); this.name = 'ApprovalNotFoundError' }
}
export class ApprovalForbiddenError extends Error {
  readonly statusCode = 403
  constructor(message: string) { super(message); this.name = 'ApprovalForbiddenError' }
}
export class ApprovalInputError extends Error {
  readonly statusCode = 400
  constructor(message: string) { super(message); this.name = 'ApprovalInputError' }
}
