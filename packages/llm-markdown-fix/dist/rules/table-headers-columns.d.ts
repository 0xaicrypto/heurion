import type { MarkdownFixRule } from '../index.js';
/**
 * 表头/分隔/数据列数一致性修复:
 *  - 表头行缺前导 |(如 'On-Chain Reality| Asset |')→ 补全
 *  - 表头列数与分隔行不一致 → 以分隔行列数为准(表头截取/补齐)
 */
export declare const fixTableHeadersAndColumns: MarkdownFixRule;
