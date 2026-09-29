/**
 * #1149 — 环境配置解析（自 index.ts 拆出，纯函数可测）。
 * 审计问题：`EMBEDDING_BATCH_SIZE=0` → embed 循环 `i += 0` 死循环；
 * 非数字 → NaN → 空批次、dimensions 0、HTTP 200。正整数校验 + 回退。
 */
export function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[embedding-server] ${name}=${JSON.stringify(raw)} is not a positive integer — falling back to ${fallback}`)
    return fallback
  }
  return n
}
