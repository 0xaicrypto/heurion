/**
 * #1066-8/#1141 — pptx 导出图片预算（自 pptx.ts 拆出，文件行数棘轮）。
 */

/** #1066-8: 单次导出内嵌图片总字节预算 — 图片以 base64 data URI 全驻留
 *  pptxgenjs（写文件前无法释放），20MB×30 页最坏 ~800MB 可致 worker OOM。
 *  超预算后跳过后续图片块（log 可观测），封顶内存峰值；仅伤恶意超大 deck
 *  的自身导出，正常 deck 远低于该阈值。可用 PPTX_IMAGE_BUDGET_BYTES 覆盖
 *  （部署调优/测试）。 */
export const MAX_EMBEDDED_IMAGE_BYTES = 100 * 1024 * 1024

/** #1066-8: 解析生效预算（env 覆盖非法值回退默认）。 */
export function resolveImageBudget(): number {
  const raw = Number(process.env.PPTX_IMAGE_BUDGET_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_EMBEDDED_IMAGE_BYTES
}

/** #1066-8: 累计已嵌入字节 + 本张字节是否超预算。 */
export function imageBudgetExceeded(embeddedBytes: number, incomingBytes: number, budget: number = resolveImageBudget()): boolean {
  return embeddedBytes + incomingBytes > budget
}

/** #1141: 图片解析时间预算（镜像 docx 同款）— 远程图串行下载每张最长
 *  10s，数百张可把导出拖到小时级；超预算后不再解析（回退要点渲染，可见）。
 *  PPTX_IMAGE_TIME_BUDGET_MS 可覆盖（测试/部署调优，非法值回退默认）。 */
export const MAX_IMAGE_RESOLVE_MS = 60_000

export function resolveImageTimeBudget(): number {
  const raw = Number(process.env.PPTX_IMAGE_TIME_BUDGET_MS)
  // 0 合法（=立即过期，禁图；测试/极端降级用）；负数/NaN 回退默认。
  return Number.isFinite(raw) && raw >= 0 ? raw : MAX_IMAGE_RESOLVE_MS
}
