import { fixSingleLineTables } from './rules/single-line-tables.js';
import { fixTableHeadersAndColumns } from './rules/table-headers-columns.js';
import { fixNonStandardSeparator } from './rules/non-standard-separator.js';
import { fixPunctuationCode } from './rules/punctuation-code.js';
/** 规则注册表: 名称 → 实现(顺序即默认执行顺序)。 */
export const RULES = {
    singleLineTables: fixSingleLineTables,
    tableHeadersColumns: fixTableHeadersAndColumns,
    nonStandardSeparator: fixNonStandardSeparator,
    punctuationCode: fixPunctuationCode,
};
export const DEFAULT_RULES = Object.keys(RULES);
function normalizeOptions(options = {}) {
    return {
        rules: options.rules ?? DEFAULT_RULES,
        maxShortCodeLen: options.maxShortCodeLen ?? 4,
    };
}
/** 主入口: 按管线依次执行启用的规则。 */
export function fixMarkdown(input, options = {}) {
    if (!input)
        return input;
    const opts = normalizeOptions(options);
    let out = input;
    for (const name of opts.rules) {
        const rule = RULES[name];
        if (!rule)
            continue;
        out = rule(out, opts);
    }
    return out;
}
export { fixSingleLineTables, fixTableHeadersAndColumns, fixNonStandardSeparator, fixPunctuationCode };
