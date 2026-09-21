/**
 * #1090-5 — 服务端内部调用凭证（internal caller brand）。
 *
 * 背景：comments.router 的 appendCommentReplyInternal 无 HTTP 入口、无鉴权
 * （依赖调用方先完成 doc/comment 归属校验），此前仅靠注释约束「只能内部调用」
 * —— 无类型/运行时强制。
 *
 * 契约：
 *  - InternalCaller 的 key 是 unique symbol，本模块不导出该 symbol → 外部
 *    模块（含测试）无法构造结构兼容的对象字面量，类型上不可伪造；
 *  - 获取凭证的唯一入口是 internalCaller()（本文件只存在于 server-ts 服务端
 *    包，web/worker 等包不会 import）；
 *  - appendCommentReplyInternal 运行时断言 caller 携带 brand（防 JS 调用方
 *    直接传普通对象绕过类型），不合法即抛错，写入不发生。
 *
 * 运行时行为不变：鉴权语义仍由调用方承担（HTTP 路由的 authGuard + 归属
 * 校验先行），本类型化只是把内部契约显式化，不改任何判定逻辑。
 */
const internalCallerBrand = Symbol('internalCallerBrand')
export type InternalCaller = { readonly [internalCallerBrand]: true }

/** 服务端内部代码获取 InternalCaller 凭证的唯一入口（无 HTTP 入口引用）。 */
export function internalCaller(): InternalCaller {
  return { [internalCallerBrand]: true as const }
}

/** 运行时断言：caller 必须由 internalCaller() 签发（普通对象/未传即抛）。 */
export function assertInternalCaller(caller: unknown): asserts caller is InternalCaller {
  if (
    typeof caller !== 'object' ||
    caller === null ||
    (caller as Record<PropertyKey, unknown>)[internalCallerBrand] !== true
  ) {
    throw new Error('appendCommentReplyInternal 只接受服务端内部调用（caller 必须来自 internalCaller()）')
  }
}
