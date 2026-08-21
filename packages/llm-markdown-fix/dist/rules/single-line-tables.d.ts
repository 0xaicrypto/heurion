import type { MarkdownFixRule } from '../index.js';
/**
 * 单行表格展开 — 模型常把整个表格挤成一行
 * (On-Chain Reality| Asset |...| |---|---| | WETH |...|| WMNT |...)。
 * 检测"管道密集 + 分隔段"的行,按分隔段/表头列数拆分为标准多行表格。
 */
export declare const fixSingleLineTables: MarkdownFixRule;
