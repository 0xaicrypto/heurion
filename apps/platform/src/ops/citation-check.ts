/** 正文里不该出现的「手写引用」特征（AI 写入硬拦截；人类编辑事后提示）。 */

export const DOI = /\b10\.\d{4,9}\/[^\s"<>)\]]+/i
export const PMID = /\bPMID\s*[:：]?\s*\d{5,9}\b/i
/** 手写参考文献条目：作者缩写 + et al / 期刊年份卷期。 */
export const REFERENCE_ENTRY = /(\bet al\b\.?.{0,200}\b(19|20)\d{2}\b)|(\b(19|20)\d{2}\s*;\s*\d+\s*(\(\d+\))?\s*:\s*\d+)/i

export function manualCitation(text: string): boolean {
  return DOI.test(text) || PMID.test(text) || REFERENCE_ENTRY.test(text)
}
