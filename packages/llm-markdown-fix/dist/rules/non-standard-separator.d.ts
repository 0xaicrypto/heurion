import type { MarkdownFixRule } from '../index.js';
/**
 * 非标准分隔行修复 — 把 |--|、---|、|-- 等写成分隔行的形式规范化为
 * 标准 | --- | ... |(标准分隔行原样保留;纯 --- hr 不受影响)。
 */
export declare const fixNonStandardSeparator: MarkdownFixRule;
