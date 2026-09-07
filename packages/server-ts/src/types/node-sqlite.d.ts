/**
 * node:sqlite 最小类型 shim — @types/node@20 无 node:sqlite 定义(22.5+ 才有),
 * 运行时 Node 22/26 已内置。只声明 url-cache 用到的子集(#859)。
 */
declare module 'node:sqlite' {
  export interface StatementSync {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
  export class DatabaseSync {
    constructor(location: string, options?: Record<string, unknown>)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
