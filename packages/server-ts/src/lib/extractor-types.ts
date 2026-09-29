/** #1146 循环依赖:PDF/PPTX 提取共享类型下沉叶子模块 —
 * document-extractor 与 pptx-extractor 互引成环。 */
export interface ExtractedPdfImage {
  mime: string
  dataBase64: string
  page: number
}
