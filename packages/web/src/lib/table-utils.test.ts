import { describe, test, expect } from 'vitest';
import { recoverTables } from './table-utils';

describe('recoverTables', () => {
  test('B: pipe rows without a delimiter row get one injected', () => {
    const input = '| 药物 | 剂量 |\n| A | 100mg |\n| B | 200mg |';
    const out = recoverTables(input);
    const lines = out.split('\n');
    expect(lines[1]).toBe('| --- | --- |');
    expect(lines[0]).toBe('| 药物 | 剂量 |');
    expect(lines[2]).toBe('| A | 100mg |');
  });

  test('B: delimiter already present → untouched', () => {
    const input = '| 药物 | 剂量 |\n|---|---|\n| A | 100mg |';
    expect(recoverTables(input)).toBe(input);
  });

  test('C: blank lines added around the table', () => {
    const input = '| 药物 | 剂量 |\n|---|---|\n| A | 100mg |\n结论：使用 A';
    const out = recoverTables(input);
    expect(out).toContain('100mg |\n\n结论：使用 A');
    expect(out.startsWith('| 药物')).toBe(true);
  });

  test('E: blank line added before a table glued to a paragraph', () => {
    const input = '以下是方案：\n| 药物 | 剂量 |\n|---|---|\n| A | 100mg |';
    const out = recoverTables(input);
    expect(out).toContain('以下是方案：\n\n| 药物');
  });

  test('D: HTML table converts to GFM with text content only', () => {
    const input =
      '<table><tr><th>药物</th><th>剂量</th></tr><tr><td>A</td><td>100mg</td></tr></table>';
    const out = recoverTables(input);
    expect(out).not.toContain('<table>');
    expect(out).toContain('| 药物 | 剂量 |');
    expect(out).toContain('| --- | --- |');
    expect(out).toContain('| A | 100mg |');
  });

  test('D: HTML table with <br> inside cells', () => {
    const input = '<table><tr><td>行1<br>行2</td><td>v</td></tr></table>';
    const out = recoverTables(input);
    expect(out).toContain('| 行1 行2 | v |');
  });

  test('normal text with pipes is untouched', () => {
    const input = '这段话里有 | 竖线，但不是一个表格';
    expect(recoverTables(input)).toBe(input);
  });

  test('single pipe row without a delimiter stays text (not enough rows)', () => {
    const input = '| 只有一行 |';
    expect(recoverTables(input)).toBe(input);
  });
});

test('delimiter column count is aligned to the header (LLM common)', () => {
  const input = '| 药物 | 剂量 | 备注 |\n|---|---|\n| A | 100mg | 常用 |';
  const out = recoverTables(input);
  const lines = out.split('\n');
  expect(lines[1]).toBe('| --- | --- | --- |');
});
