/**
 * #1078 — 自动生成 References 列表视图(组件测试)。
 *
 * 用例:
 * 1) 2 篇被正文引用的文献 → 2 条目按编号排序,各带 DOI 链接
 * 2) 删除唯一 marker → 条目消失
 * 3) 同一文献引用两次,删掉一处 → 条目仍在(共享编号)
 * 4) 悬挂引用(id 无记录)→ 不进列表
 * 5) 正文无引用标记 → 整块不渲染(零噪音)
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReferencesList } from './references-list';
import type { DocCitationWire } from '@/lib/api';
import i18n from '@/i18n';

// 固定 zh-CN — 只读提示文案断言(jsdom 语言探测为 en,与 doc-editor-format 同款处理)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const CITE_A: DocCitationWire = {
  id: 'aaa', doi: '10.1000/aaa', title: 'Alpha Paper', authors: ['Zhang S', 'Li Q'],
  journal: 'Nature', year: 2024, source: 'pubmed',
};
const CITE_B: DocCitationWire = {
  id: 'bbb', doi: '10.1000/bbb', title: 'Beta Paper', authors: ['Wang W'],
  journal: 'Science', year: 2023, source: 'crossref',
};

describe('#1078 用例1 两篇被引文献 → 2 条目按编号排序', () => {
  test('各带 DOI 链接与自动生成提示', () => {
    const body = 'Intro cites [cite:bbb] first, then [cite:aaa] later.';
    render(<ReferencesList citations={[CITE_A, CITE_B]} bodyText={body} />);
    const list = screen.getByTestId('references-list');
    // bbb 首现 → [1];aaa → [2](首现顺序,不按传入顺序)
    const entries = screen.getAllByTestId('references-entry');
    expect(entries).toHaveLength(2);
    expect(entries[0].textContent).toContain('Beta Paper');
    expect(entries[0].textContent).toContain('1.');
    expect(entries[1].textContent).toContain('Alpha Paper');
    expect(entries[1].textContent).toContain('2.');
    // data-doi 与 DOI 链接
    expect(entries[0].getAttribute('data-doi')).toBe('10.1000/bbb');
    const links = screen.getAllByTestId(/^references-doi-/);
    expect(links[0].getAttribute('href')).toBe('https://doi.org/10.1000/bbb');
    expect(links[1].getAttribute('href')).toBe('https://doi.org/10.1000/aaa');
    // 只读提示
    expect(list.textContent).toContain('自动生成');
  });
});

describe('#1078 用例2 删除唯一 marker → 条目消失', () => {
  test('bodyText 移除 [cite:aaa] 后整块不渲染', () => {
    const { rerender } = render(
      <ReferencesList citations={[CITE_A]} bodyText="Body cites [cite:aaa] here." />,
    );
    expect(screen.getAllByTestId('references-entry')).toHaveLength(1);
    rerender(<ReferencesList citations={[CITE_A]} bodyText="Body cites nothing here." />);
    expect(screen.queryByTestId('references-entry')).toBeNull();
    expect(screen.queryByTestId('references-list')).toBeNull();
  });
});

describe('#1078 用例3 同一文献引用两次,删掉一处 → 条目仍在', () => {
  test('共享编号,条目不消失', () => {
    const { rerender } = render(
      <ReferencesList citations={[CITE_A]} bodyText="One [cite:aaa] two [cite:aaa]." />,
    );
    const entries = screen.getAllByTestId('references-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].textContent).toContain('1.');
    rerender(<ReferencesList citations={[CITE_A]} bodyText="One [cite:aaa] two." />);
    expect(screen.getAllByTestId('references-entry')).toHaveLength(1);
  });
});

describe('#1078 用例4 悬挂引用不进列表', () => {
  test('id 无 DocCitation 记录 → 跳过;有记录的正常渲染', () => {
    render(<ReferencesList citations={[CITE_A]} bodyText="Cites [cite:ghost] and [cite:aaa]." />);
    const entries = screen.getAllByTestId('references-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].getAttribute('data-doi')).toBe('10.1000/aaa');
  });
});

describe('#1078 用例5 正文无引用标记 → 不渲染', () => {
  test('零噪音', () => {
    render(<ReferencesList citations={[CITE_A, CITE_B]} bodyText="No markers at all." />);
    expect(screen.queryByTestId('references-list')).toBeNull();
  });
});
