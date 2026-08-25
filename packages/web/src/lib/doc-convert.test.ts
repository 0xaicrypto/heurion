import { describe, test, expect } from 'vitest';
import { markdownToHtml, htmlToMarkdown } from './doc-convert';

describe('doc conversion layer (md ⇄ HTML)', () => {
  test('#1 markdown loads as structured HTML (headings, lists, tables)', () => {
    const md = '# 标题\n\n- 项一\n- 项二\n\n| 药物 | 剂量 |\n|---|---|\n| A | 100mg |';
    const html = markdownToHtml(md);
    expect(html).toContain('<h1');
    expect(html).toContain('<ul');
    expect(html).toContain('<table');
    expect(html).toContain('<tr');
  });

  test('#2 editor content converts back to markdown (table + bold survive)', () => {
    const html = '<h2>结论</h2><p><strong>加粗</strong>文本</p><table><thead><tr><th>药物</th><th>剂量</th></tr></thead><tbody><tr><td>A</td><td>100mg</td></tr></tbody></table>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('## 结论');
    expect(md).toContain('**加粗**');
    expect(md).toContain('|');
    expect(md).toContain('100mg');
  });

  test('#3 round-trip: md → html → md keeps core structure', () => {
    const md = '# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const rt = htmlToMarkdown(markdownToHtml(md));
    expect(rt).toContain('# 标题');
    expect(rt).toContain('| 1 | 2 |');
  });

  test('empty / plain text passes through', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('纯文本')).toContain('纯文本');
    expect(htmlToMarkdown('<p>纯文本</p>').trim()).toBe('纯文本');
  });

  test('#4 块公式 $$...$$ → block-math 节点(KaTeX 渲染),回写还原', () => {
    const md = '# 标题\n\n公式如下：\n\n$$E = mc^2$$\n\n正文。';
    const html = markdownToHtml(md);
    expect(html).toContain('data-type="block-math"');
    expect(html).toContain('data-latex="E = mc^2"');
    // 特殊字符(& <)被转义,marked 不会破坏节点。
    const html2 = markdownToHtml('$$a & b < c$$');
    expect(html2).toContain('data-latex="a &amp; b &lt; c"');
    // 回写还原。
    expect(htmlToMarkdown(html)).toContain('$$E = mc^2$$');
  });

  test('#5 行内公式 $...$ → inline-math 节点;转义 \\$ 不受影响', () => {
    const html = markdownToHtml('成本 $5 且 $x^2$ 是公式');
    expect(html).toContain('data-type="inline-math"');
    expect(html).toContain('data-latex="x^2"');
    expect(html).not.toContain('data-latex="5');
    // 转义美元符保持字面。
    const html2 = markdownToHtml('价格 \\$100 美元');
    expect(html2).not.toContain('data-type="inline-math"');
    expect(html2).toContain('$100');
  });
});
