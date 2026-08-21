/**
 * 表头/分隔/数据列数一致性修复:
 *  - 表头行缺前导 |(如 'On-Chain Reality| Asset |')→ 补全
 *  - 表头列数与分隔行不一致 → 以分隔行列数为准(表头截取/补齐)
 */
export const fixTableHeadersAndColumns = (md) => {
    const lines = md.split('\n');
    const isSeparator = (l) => /^\s*\|?[-:]+\|?[-: |]*$/.test(l) && l.includes('-');
    const isHr = (l) => /^\s*-{3,}\s*$/.test(l);
    const colCount = (l) => Math.max(0, (l.match(/\|/g) || []).length - 1);
    let forceCols = null;
    return lines.map((line, i) => {
        const next = i + 1 < lines.length ? lines[i + 1] : '';
        const prev = i > 0 ? lines[i - 1] : '';
        // 1) 表头行缺前导 | 且下一行是分隔行 → 补前导 |,并强制分隔行列数
        //    与表头一致(模型可能少写一列分隔)。
        if (line.includes('|') && !line.trim().startsWith('|') && isSeparator(next) && !isHr(next)) {
            const header = '| ' + line.trim();
            forceCols = Math.max(1, colCount(header));
            return header;
        }
        // 2) 分隔行(非 hr,处于表格上下文)→ 若被强制重写或非标准,规范列数。
        if (isSeparator(line) && !isHr(line) && (forceCols != null || prev.includes('|') || next.includes('|'))) {
            if (forceCols != null) {
                const n = forceCols;
                forceCols = null;
                return `| ${Array(n).fill('---').join(' | ')} |`;
            }
        }
        forceCols = null;
        return line;
    }).join('\n');
};
